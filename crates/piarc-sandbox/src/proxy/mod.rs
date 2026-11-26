//! The local HTTP proxy that is a sandboxed command's only way out (architecture section 6.10).
//!
//! - Listens on `127.0.0.1` on a random port; one proxy per session, stopped when its
//!   [`NetworkProxy`] is dropped (open tunnels and requests end with it).
//! - Plain HTTP requests in absolute form (`GET http://host/path`) are forwarded; `CONNECT
//!   host:port` opens a TCP tunnel (HTTPS, or anything else the client speaks). TLS is never
//!   inspected, so the decision rests on the host name the client asks for.
//! - A host must be in the [`Allowlist`]. It is then resolved once, and refused when any
//!   address is loopback, unspecified, link-local or a cloud metadata address
//!   ([`blocked_reason`]); the connection goes to the checked addresses, so a second lookup
//!   cannot swap them (DNS rebinding).
//! - A host outside the allowlist is put to [`ProxyHooks::unlisted`] (T39: Core holds the
//!   connection while the user answers the network-domain approval card); a `false` answer
//!   refuses it. The allowlist can change while the proxy runs ([`NetworkProxy::set_allowlist`]):
//!   the next connection uses the new one.
//! - A refusal is `403 Forbidden` with the reason in the `x-piarc-proxy-denied` header
//!   (`not-allowed` or `blocked-address`) and in the text body, and is reported to
//!   [`ProxyHooks::refused`] (Core writes it to the audit); a failed lookup or connection is
//!   `502 Bad Gateway`.
//! - Limits ([`ProxyLimits`], R1 I54): at most a number of client connections at once (the
//!   accept loop waits for a free slot instead of exhausting file descriptors), a deadline for a
//!   request's head, for connecting upstream and for a tunnel without traffic; a failed accept
//!   backs off instead of spinning. A forwarded request's `Host` is the one of its target, so
//!   a client cannot name an allowed host and ask another virtual host behind it.
//! - Private addresses (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are reachable when
//!   an allowed name resolves to them: internal mirrors and registries live there. The
//!   allowlist should only name hosts the user trusts (architecture section 6.10).
//!
//! - A browser proxy ([`NetworkProxy::start_browser`], ADR-0088) lets every host through and
//!   checks the resolved addresses with a [`BrowserPolicy`] instead: loopback only behind a
//!   local name, never PiArc's own ports.
//!
//! Name resolution and outgoing connections go through [`Network`], so tests can point
//! public-looking addresses at a local upstream server.

mod address;
mod allowlist;
mod browser;

use std::convert::Infallible;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HOST, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::{TokioIo, TokioTimer};
use piarc_ports::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub use address::blocked_reason;
pub use allowlist::{Allowlist, InvalidEntry};
pub use browser::BrowserPolicy;

/// The header that carries the reason of a refusal.
pub const DENIED_HEADER: &str = "x-piarc-proxy-denied";

/// Name resolution and outgoing TCP connections.
pub trait Network: Send + Sync {
    /// The addresses of `host` (a name or an IP literal) with `port`.
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, io::Result<Vec<SocketAddr>>>;

    /// A TCP connection to `addr`.
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'_, io::Result<TcpStream>>;
}

/// The operating system's resolver and sockets.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemNetwork;

impl Network for SystemNetwork {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, io::Result<Vec<SocketAddr>>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }

    fn connect(&self, addr: SocketAddr) -> BoxFuture<'_, io::Result<TcpStream>> {
        Box::pin(TcpStream::connect(addr))
    }
}

/// Names mapped to servers on this machine (tests and the development build's L4 only): a
/// mapped name resolves to a documentation address (203.0.113.0/24, so the proxy's loopback
/// check sees a public address) and connections to it go to `127.0.0.1:<port>`; every other
/// name fails to resolve. Bytes never leave the machine.
#[derive(Debug, Clone, Default)]
pub struct MappedNetwork {
    names: Vec<(String, u16)>,
}

impl MappedNetwork {
    /// Maps each `(name, local port)`.
    #[must_use]
    pub fn new(names: Vec<(String, u16)>) -> Self {
        Self { names }
    }

    fn address_of(index: usize) -> IpAddr {
        IpAddr::from([203, 0, 113, u8::try_from(index % 250).unwrap_or(0) + 1])
    }
}

impl Network for MappedNetwork {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, io::Result<Vec<SocketAddr>>> {
        let found = self
            .names
            .iter()
            .position(|(name, _)| name.eq_ignore_ascii_case(host));
        Box::pin(async move {
            let index = found
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown test host"))?;
            Ok(vec![SocketAddr::new(Self::address_of(index), port)])
        })
    }

    fn connect(&self, addr: SocketAddr) -> BoxFuture<'_, io::Result<TcpStream>> {
        let port = (0..self.names.len())
            .find(|&i| Self::address_of(i) == addr.ip())
            .map(|i| self.names[i].1);
        Box::pin(async move {
            let port = port.ok_or_else(|| {
                io::Error::new(io::ErrorKind::ConnectionRefused, "no mapped test server")
            })?;
            TcpStream::connect(("127.0.0.1", port)).await
        })
    }
}

/// Why the proxy refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    /// The host is not in the allowlist and was not allowed when asked.
    NotAllowed,
    /// The host resolves to a loopback, link-local or metadata address.
    BlockedAddress,
}

impl DenyReason {
    /// The value of [`DENIED_HEADER`].
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAllowed => "not-allowed",
            Self::BlockedAddress => "blocked-address",
        }
    }
}

/// A request the proxy refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// The host the client asked for.
    pub host: String,
    /// Its port.
    pub port: u16,
    /// Why.
    pub reason: DenyReason,
    /// The text the client got.
    pub message: String,
}

/// What the proxy asks and tells its owner.
pub trait ProxyHooks: Send + Sync {
    /// Whether one connection to `host:port`, outside the allowlist, may go ahead. The
    /// connection waits for the answer.
    fn unlisted<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a, bool>;

    /// The proxy refused a request.
    fn refused(&self, refused: &Refused);
}

/// Hooks that refuse every host outside the allowlist and record nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyUnlisted;

impl ProxyHooks for DenyUnlisted {
    fn unlisted<'a>(&'a self, _host: &'a str, _port: u16) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }

    fn refused(&self, _refused: &Refused) {}
}

/// The proxy's limits (R1 I54).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyLimits {
    /// Client connections served at once; more wait in the listen queue.
    pub max_connections: usize,
    /// Time to read a request's head.
    pub header_timeout: Duration,
    /// Time to connect to the upstream.
    pub connect_timeout: Duration,
    /// A tunnel without bytes in either direction for this long is closed.
    pub idle_timeout: Duration,
}

impl Default for ProxyLimits {
    fn default() -> Self {
        Self {
            max_connections: 256,
            header_timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(600),
        }
    }
}

/// A running proxy; dropping it stops the proxy and every connection through it.
pub struct NetworkProxy {
    port: u16,
    stop: CancellationToken,
    allowlist: Arc<RwLock<Allowlist>>,
    browser: Option<Arc<RwLock<BrowserPolicy>>>,
}

impl std::fmt::Debug for NetworkProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkProxy")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl NetworkProxy {
    /// Starts a proxy on `127.0.0.1` with a random port that refuses every host outside
    /// `allowlist`. Must be called inside a tokio runtime.
    ///
    /// # Errors
    ///
    /// The listening socket cannot be opened.
    pub async fn start(allowlist: Allowlist, network: Arc<dyn Network>) -> io::Result<Self> {
        Self::start_with(
            allowlist,
            network,
            Arc::new(DenyUnlisted),
            ProxyLimits::default(),
        )
        .await
    }

    /// Like [`NetworkProxy::start`], asking `hooks` about hosts outside the allowlist and
    /// telling them about refusals.
    ///
    /// # Errors
    ///
    /// The listening socket cannot be opened.
    pub async fn start_with(
        allowlist: Allowlist,
        network: Arc<dyn Network>,
        hooks: Arc<dyn ProxyHooks>,
        limits: ProxyLimits,
    ) -> io::Result<Self> {
        Self::spawn(allowlist, None, network, hooks, limits).await
    }

    /// Starts a browser partition's proxy (ADR-0088): every host passes, the resolved
    /// addresses are checked with `policy`. Must be called inside a tokio runtime.
    ///
    /// # Errors
    ///
    /// The listening socket cannot be opened.
    pub async fn start_browser(
        policy: BrowserPolicy,
        network: Arc<dyn Network>,
        hooks: Arc<dyn ProxyHooks>,
        limits: ProxyLimits,
    ) -> io::Result<Self> {
        let browser = Arc::new(RwLock::new(policy));
        Self::spawn(Allowlist::default(), Some(browser), network, hooks, limits).await
    }

    async fn spawn(
        allowlist: Allowlist,
        browser: Option<Arc<RwLock<BrowserPolicy>>>,
        network: Arc<dyn Network>,
        hooks: Arc<dyn ProxyHooks>,
        limits: ProxyLimits,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0)).await?;
        let port = listener.local_addr()?.port();
        let stop = CancellationToken::new();
        let allowlist = Arc::new(RwLock::new(allowlist));
        let shared = Arc::new(Shared {
            allowlist: Arc::clone(&allowlist),
            browser: browser.clone(),
            network,
            hooks,
            limits,
        });
        tokio::spawn(accept_loop(listener, shared, stop.clone()));
        Ok(Self {
            port,
            stop,
            allowlist,
            browser,
        })
    }

    /// The port on `127.0.0.1`.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Replaces the allowlist: connections opened from now on use it.
    pub fn set_allowlist(&self, allowlist: Allowlist) {
        *self
            .allowlist
            .write()
            .unwrap_or_else(PoisonError::into_inner) = allowlist;
    }

    /// Replaces a browser proxy's policy; does nothing on a sandbox proxy.
    pub fn set_browser_policy(&self, policy: BrowserPolicy) {
        if let Some(browser) = &self.browser {
            *browser.write().unwrap_or_else(PoisonError::into_inner) = policy;
        }
    }
}

impl Drop for NetworkProxy {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Shared {
    allowlist: Arc<RwLock<Allowlist>>,
    browser: Option<Arc<RwLock<BrowserPolicy>>>,
    network: Arc<dyn Network>,
    hooks: Arc<dyn ProxyHooks>,
    limits: ProxyLimits,
}

impl Shared {
    fn allows(&self, host: &str) -> bool {
        self.allowlist
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .allows(host)
    }

    fn browser_policy(&self) -> Option<BrowserPolicy> {
        self.browser.as_ref().map(|policy| {
            policy
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
    }
}

/// How long the accept loop pauses after a failed accept (for example too many open files),
/// doubling up to the maximum while the failures go on.
const ACCEPT_BACKOFF: (Duration, Duration) = (Duration::from_millis(10), Duration::from_secs(1));

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, stop: CancellationToken) {
    let slots = Arc::new(Semaphore::new(shared.limits.max_connections));
    let mut backoff = ACCEPT_BACKOFF.0;
    loop {
        let slot = tokio::select! {
            () = stop.cancelled() => return,
            slot = Arc::clone(&slots).acquire_owned() => match slot {
                Ok(slot) => slot,
                Err(_) => return,
            },
        };
        let stream = tokio::select! {
            () = stop.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    backoff = ACCEPT_BACKOFF.0;
                    stream
                }
                // A failed accept concerns that one client; pause, then keep serving.
                Err(_) => {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(ACCEPT_BACKOFF.1);
                    continue;
                }
            },
        };
        let (shared, stop) = (shared.clone(), stop.clone());
        tokio::spawn(async move {
            let _slot = slot;
            let for_service = stop.clone();
            let header_timeout = shared.limits.header_timeout;
            let service = hyper::service::service_fn(move |request| {
                let (shared, stop) = (shared.clone(), for_service.clone());
                async move { Ok::<_, Infallible>(handle(request, &shared, stop).await) }
            });
            let connection = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(header_timeout)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::select! {
                () = stop.cancelled() => {}
                // A client that breaks the protocol or goes away ends only its connection.
                _ = connection => {}
            }
        });
    }
}

type ProxyBody = BoxBody<Bytes, hyper::Error>;

async fn handle(
    request: Request<Incoming>,
    shared: &Shared,
    stop: CancellationToken,
) -> Response<ProxyBody> {
    if request.method() == Method::CONNECT {
        tunnel(request, shared, stop).await
    } else {
        forward(request, shared).await
    }
}

/// Why the proxy will not serve a request.
struct Refusal {
    status: StatusCode,
    reason: Option<&'static str>,
    message: String,
}

impl Refusal {
    fn denied(reason: &'static str, message: String) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            reason: Some(reason),
            message,
        }
    }

    fn bad_gateway(message: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            reason: None,
            message,
        }
    }

    fn into_response(self) -> Response<ProxyBody> {
        refusal(self.status, self.reason, &self.message)
    }
}

/// The checked addresses a request may go to.
async fn check(shared: &Shared, host: &str, port: u16) -> Result<Vec<SocketAddr>, Refusal> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let refuse = |reason: DenyReason, message: String| {
        shared.hooks.refused(&Refused {
            host: host.to_owned(),
            port,
            reason,
            message: message.clone(),
        });
        Refusal::denied(reason.as_str(), message)
    };
    let browser = shared.browser_policy();
    if browser.is_none() && !shared.allows(host) && !shared.hooks.unlisted(host, port).await {
        return Err(refuse(
            DenyReason::NotAllowed,
            format!("{host} is not in the sandbox network allowlist"),
        ));
    }
    let addrs = match shared.network.resolve(host, port).await {
        Ok(addrs) if !addrs.is_empty() => addrs,
        Ok(_) => return Err(Refusal::bad_gateway(format!("{host} has no address"))),
        Err(error) => {
            return Err(Refusal::bad_gateway(format!(
                "cannot resolve {host}: {error}"
            )));
        }
    };
    if let Some((addr, reason)) = addrs.iter().find_map(|addr| {
        match &browser {
            Some(policy) => policy.blocked_reason(host, *addr),
            None => blocked_reason(addr.ip()),
        }
        .map(|reason| (addr, reason))
    }) {
        return Err(refuse(
            DenyReason::BlockedAddress,
            format!("{host} resolves to {}, a {reason}", addr.ip()),
        ));
    }
    Ok(addrs)
}

async fn connect(shared: &Shared, addrs: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = io::Error::other("no address to connect to");
    for &addr in addrs {
        let attempt =
            tokio::time::timeout(shared.limits.connect_timeout, shared.network.connect(addr));
        match attempt.await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last = error,
            Err(_) => last = io::Error::new(io::ErrorKind::TimedOut, "connecting timed out"),
        }
    }
    Err(last)
}

async fn tunnel(
    request: Request<Incoming>,
    shared: &Shared,
    stop: CancellationToken,
) -> Response<ProxyBody> {
    let Some((host, port)) = request
        .uri()
        .authority()
        .map(|a| (a.host().to_owned(), a.port_u16().unwrap_or(443)))
    else {
        return refusal(StatusCode::BAD_REQUEST, None, "CONNECT needs host:port");
    };
    let addrs = match check(shared, &host, port).await {
        Ok(addrs) => addrs,
        Err(refused) => return refused.into_response(),
    };
    let mut upstream = match connect(shared, &addrs).await {
        Ok(stream) => stream,
        Err(error) => return bad_gateway(&format!("cannot connect to {host}:{port}: {error}")),
    };
    let idle = shared.limits.idle_timeout;
    tokio::spawn(async move {
        let Ok(upgraded) = hyper::upgrade::on(request).await else {
            return;
        };
        let activity = Activity::new();
        let mut client = Tracked::new(TokioIo::new(upgraded), &activity);
        let mut upstream = Tracked::new(&mut upstream, &activity);
        tokio::select! {
            () = stop.cancelled() => {}
            () = activity.idle_for(idle) => {}
            // Either side closing or failing ends the tunnel; nothing to report.
            _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {}
        }
    });
    Response::new(empty())
}

/// When a tunnel last moved bytes.
#[derive(Clone)]
struct Activity {
    origin: Instant,
    /// Milliseconds since `origin`.
    last: Arc<AtomicU64>,
}

impl Activity {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            last: Arc::default(),
        }
    }

    fn touch(&self) {
        let now = u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last.store(now, Ordering::Relaxed);
    }

    /// Completes once no bytes moved for `limit`.
    async fn idle_for(&self, limit: Duration) {
        loop {
            let last = Duration::from_millis(self.last.load(Ordering::Relaxed));
            let quiet = self.origin.elapsed().saturating_sub(last);
            if quiet >= limit {
                return;
            }
            tokio::time::sleep(limit - quiet).await;
        }
    }
}

/// A stream whose reads mark the tunnel active.
struct Tracked<S> {
    inner: S,
    activity: Activity,
}

impl<S> Tracked<S> {
    fn new(inner: S, activity: &Activity) -> Self {
        Self {
            inner,
            activity: activity.clone(),
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Tracked<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Tracked<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Hop-by-hop headers, which describe one connection and are not forwarded (RFC 9110 7.6.1).
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "proxy-connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
];

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<HeaderName> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    for name in listed {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

async fn forward(request: Request<Incoming>, shared: &Shared) -> Response<ProxyBody> {
    let uri = request.uri();
    let (Some("http"), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
        return refusal(
            StatusCode::BAD_REQUEST,
            None,
            "the proxy takes absolute http:// requests and CONNECT",
        );
    };
    let (host, port) = (
        authority.host().to_owned(),
        authority.port_u16().unwrap_or(80),
    );
    let authority = authority.clone();
    let addrs = match check(shared, &host, port).await {
        Ok(addrs) => addrs,
        Err(refused) => return refused.into_response(),
    };
    let stream = match connect(shared, &addrs).await {
        Ok(stream) => stream,
        Err(error) => return bad_gateway(&format!("cannot connect to {host}:{port}: {error}")),
    };
    let (mut sender, connection) =
        match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
            Ok(pair) => pair,
            Err(error) => return bad_gateway(&format!("{host}:{port}: {error}")),
        };
    // Ends when the response body has been read or the upstream goes away.
    tokio::spawn(connection);
    let (mut parts, body) = request.into_parts();
    let origin_form = parts
        .uri
        .path_and_query()
        .map_or_else(|| "/".to_owned(), ToString::to_string);
    parts.uri = match origin_form.parse::<Uri>() {
        Ok(uri) => uri,
        Err(_) => return refusal(StatusCode::BAD_REQUEST, None, "unusable request target"),
    };
    strip_hop_by_hop(&mut parts.headers);
    // The target's host, whatever the client wrote: the allowlist judged the target, and a
    // different `Host` would reach another virtual host on the same server (R1 I54).
    match HeaderValue::from_str(authority.as_str()) {
        Ok(value) => {
            parts.headers.insert(HOST, value);
        }
        Err(_) => return refusal(StatusCode::BAD_REQUEST, None, "unusable request target"),
    }
    match sender.send_request(Request::from_parts(parts, body)).await {
        Ok(response) => {
            let (mut parts, body) = response.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            Response::from_parts(parts, body.boxed())
        }
        Err(error) => bad_gateway(&format!("{host}:{port}: {error}")),
    }
}

fn empty() -> ProxyBody {
    Empty::new().map_err(|never| match never {}).boxed()
}

fn refusal(status: StatusCode, reason: Option<&'static str>, message: &str) -> Response<ProxyBody> {
    let body = Full::new(Bytes::from(format!("PiArc sandbox proxy: {message}\n")))
        .map_err(|never| match never {})
        .boxed();
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    if let Some(reason) = reason {
        headers.insert(DENIED_HEADER, HeaderValue::from_static(reason));
    }
    response
}

fn bad_gateway(message: &str) -> Response<ProxyBody> {
    refusal(StatusCode::BAD_GATEWAY, None, message)
}
