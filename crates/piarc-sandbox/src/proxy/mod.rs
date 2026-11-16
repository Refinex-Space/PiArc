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
//! - A refusal is `403 Forbidden` with the reason in the `x-piarc-proxy-denied` header
//!   (`not-allowed` or `blocked-address`) and in the text body; a failed lookup or connection is
//!   `502 Bad Gateway`.
//!
//! Name resolution and outgoing connections go through [`Network`], so tests can point
//! public-looking addresses at a local upstream server.

mod address;
mod allowlist;

use std::convert::Infallible;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HOST, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use piarc_ports::BoxFuture;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

pub use address::blocked_reason;
pub use allowlist::{Allowlist, InvalidEntry};

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

/// A running proxy; dropping it stops the proxy and every connection through it.
#[derive(Debug)]
pub struct NetworkProxy {
    port: u16,
    stop: CancellationToken,
}

impl NetworkProxy {
    /// Starts a proxy on `127.0.0.1` with a random port. Must be called inside a tokio
    /// runtime.
    ///
    /// # Errors
    ///
    /// The listening socket cannot be opened.
    pub async fn start(allowlist: Allowlist, network: Arc<dyn Network>) -> io::Result<Self> {
        let listener = TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0)).await?;
        let port = listener.local_addr()?.port();
        let stop = CancellationToken::new();
        let shared = Arc::new(Shared { allowlist, network });
        tokio::spawn(accept_loop(listener, shared, stop.clone()));
        Ok(Self { port, stop })
    }

    /// The port on `127.0.0.1`.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for NetworkProxy {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Shared {
    allowlist: Allowlist,
    network: Arc<dyn Network>,
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, stop: CancellationToken) {
    loop {
        let stream = tokio::select! {
            () = stop.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                // A failed accept (for example too many open files) concerns that one
                // client; keep serving the others.
                Err(_) => continue,
            },
        };
        let (shared, stop) = (shared.clone(), stop.clone());
        tokio::spawn(async move {
            let for_service = stop.clone();
            let service = hyper::service::service_fn(move |request| {
                let (shared, stop) = (shared.clone(), for_service.clone());
                async move { Ok::<_, Infallible>(handle(request, &shared, stop).await) }
            });
            let connection = hyper::server::conn::http1::Builder::new()
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
    if !shared.allowlist.allows(host) {
        return Err(Refusal::denied(
            "not-allowed",
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
    if let Some((addr, reason)) = addrs
        .iter()
        .find_map(|addr| blocked_reason(addr.ip()).map(|reason| (addr, reason)))
    {
        return Err(Refusal::denied(
            "blocked-address",
            format!("{host} resolves to {}, a {reason}", addr.ip()),
        ));
    }
    Ok(addrs)
}

async fn connect(shared: &Shared, addrs: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = io::Error::other("no address to connect to");
    for &addr in addrs {
        match shared.network.connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error,
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
    tokio::spawn(async move {
        let Ok(upgraded) = hyper::upgrade::on(request).await else {
            return;
        };
        let mut client = TokioIo::new(upgraded);
        tokio::select! {
            () = stop.cancelled() => {}
            // Either side closing or failing ends the tunnel; nothing to report.
            _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {}
        }
    });
    Response::new(empty())
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
    if !parts.headers.contains_key(HOST)
        && let Ok(value) = HeaderValue::from_str(authority.as_str())
    {
        parts.headers.insert(HOST, value);
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
