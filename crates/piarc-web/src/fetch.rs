//! One WebFetch request: resolve, check every address ([`crate::ssrf`]), connect to a checked
//! address (never resolving again, so DNS rebinding cannot swap it), HTTP/1.1 with TLS for
//! `https:`, same-site redirects followed with the same checks, a cross-site redirect returned.
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use http::header::{
    ACCEPT, ACCEPT_ENCODING, CONNECTION, CONTENT_ENCODING, CONTENT_TYPE, HOST, LOCATION, USER_AGENT,
};
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::convert::{Content, convert};
use crate::ssrf::{self, Allowlist};
use crate::{FetchError, FetchLimits};

/// Resolves a host name to addresses. The system resolver in production; tests map names to
/// chosen addresses to exercise rebinding and internal-name cases.
pub trait Resolve: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;
}

/// `getaddrinfo` through tokio's blocking pool.
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async move {
            let mut addresses: Vec<IpAddr> = tokio::net::lookup_host((host, port))
                .await?
                .map(|a| a.ip())
                .collect();
            addresses.dedup();
            Ok(addresses)
        })
    }
}

/// A successful fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    /// The URL whose response this is (after same-site redirects).
    pub url: String,
    pub status: u16,
    pub content_type: Option<String>,
    /// Body bytes read (at most `max_body_bytes`).
    pub bytes: u64,
    /// The body was longer than `max_body_bytes` and was cut.
    pub body_truncated: bool,
    pub content: Content,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Content(Fetched),
    /// A redirect to another site: not followed. The model may fetch `to` itself, which is a
    /// new tool call with its own permission decision.
    Redirect {
        from: String,
        to: String,
        status: u16,
    },
}

/// Fetches with fixed limits, allowlist, resolver and TLS configuration.
pub struct Fetcher {
    limits: FetchLimits,
    allow: Allowlist,
    resolver: Arc<dyn Resolve>,
    tls: Arc<rustls::ClientConfig>,
    user_agent: String,
}

struct Response {
    status: StatusCode,
    location: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
    truncated: bool,
}

/// `text` as a fetch target: `http:` or `https:` with a host and no credentials.
pub fn parse_target(text: &str) -> Result<Url, FetchError> {
    let url =
        Url::parse(text.trim()).map_err(|e| FetchError::InvalidUrl(format!("{text}: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::InvalidUrl(format!(
            "{text}: only http and https URLs can be fetched"
        )));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(FetchError::InvalidUrl(format!(
            "{text}: the URL has no host"
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::InvalidUrl(format!(
            "{text}: URLs with credentials cannot be fetched"
        )));
    }
    Ok(url)
}

/// The host a permission rule for `text` is matched against (`WebFetch(domain:…)`): the
/// parsed URL's host, lowercase, IPv6 in brackets; `None` when `text` is not a fetch target.
/// The same parser decides where [`Fetcher::fetch`] connects, so the two cannot disagree.
pub fn rule_host(text: &str) -> Option<String> {
    parse_target(text)
        .ok()?
        .host_str()
        .map(str::to_ascii_lowercase)
}

/// Same site: same host and port, and no downgrade from `https:` to `http:`.
fn same_site(from: &Url, to: &Url) -> bool {
    let upgrade = from.scheme() == "http" && to.scheme() == "https";
    from.host_str() == to.host_str()
        && (from.scheme() == to.scheme()
            && from.port_or_known_default() == to.port_or_known_default()
            || upgrade && from.port().is_none() && to.port().is_none())
}

fn host_header(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

impl Fetcher {
    /// A fetcher verifying certificates with the platform's trust store.
    pub fn new(limits: FetchLimits, allow: Allowlist) -> Result<Self, FetchError> {
        use rustls_platform_verifier::BuilderVerifierExt as _;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .and_then(|b| b.with_platform_verifier())
            .map_err(|e| FetchError::Tls(e.to_string()))?
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self::with_parts(
            limits,
            allow,
            Arc::new(SystemResolver),
            Arc::new(tls),
        ))
    }

    pub fn with_parts(
        limits: FetchLimits,
        allow: Allowlist,
        resolver: Arc<dyn Resolve>,
        tls: Arc<rustls::ClientConfig>,
    ) -> Self {
        Self {
            limits,
            allow,
            resolver,
            tls,
            user_agent: format!("PiArc-WebFetch/{}", env!("CARGO_PKG_VERSION")),
        }
    }

    pub fn limits(&self) -> &FetchLimits {
        &self.limits
    }

    /// Fetches `url` within the total timeout; `cancel` stops it at any point.
    pub async fn fetch(
        &self,
        url: &str,
        cancel: &CancellationToken,
    ) -> Result<Outcome, FetchError> {
        let timeout = self.limits.timeout;
        tokio::select! {
            () = cancel.cancelled() => Err(FetchError::Cancelled),
            result = tokio::time::timeout(timeout, self.run(url)) => {
                result.unwrap_or(Err(FetchError::Timeout(timeout)))
            }
        }
    }

    async fn run(&self, text: &str) -> Result<Outcome, FetchError> {
        let mut current = parse_target(text)?;
        for _ in 0..=self.limits.max_redirects {
            let response = self.request(&current).await?;
            if response.status.is_redirection()
                && let Some(location) = &response.location
            {
                let next = current
                    .join(location)
                    .map_err(|e| {
                        FetchError::Http(format!("invalid redirect location {location:?}: {e}"))
                    })
                    .and_then(|u| parse_target(u.as_str()))?;
                if same_site(&current, &next) {
                    current = next;
                    continue;
                }
                return Ok(Outcome::Redirect {
                    from: current.into(),
                    to: next.into(),
                    status: response.status.as_u16(),
                });
            }
            let content = convert(
                response.content_type.as_deref(),
                &response.body,
                self.limits.max_content_chars,
            )?;
            return Ok(Outcome::Content(Fetched {
                url: current.into(),
                status: response.status.as_u16(),
                content_type: response.content_type,
                bytes: response.body.len() as u64,
                body_truncated: response.truncated,
                content,
            }));
        }
        Err(FetchError::TooManyRedirects(self.limits.max_redirects))
    }

    /// The checked addresses of `url`'s host.
    async fn addresses(&self, url: &Url) -> Result<(Vec<IpAddr>, u16), FetchError> {
        let host = url.host_str().unwrap_or_default().to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        let resolved = match url.host() {
            Some(Host::Ipv4(ip)) => vec![IpAddr::V4(ip)],
            Some(Host::Ipv6(ip)) => vec![IpAddr::V6(ip)],
            Some(Host::Domain(name)) => {
                self.resolver
                    .resolve(name, port)
                    .await
                    .map_err(|e| FetchError::Resolve {
                        host: host.clone(),
                        reason: e.to_string(),
                    })?
            }
            None => {
                return Err(FetchError::InvalidUrl(format!(
                    "{url}: the URL has no host"
                )));
            }
        };
        if resolved.is_empty() {
            return Err(FetchError::Resolve {
                host,
                reason: "no addresses".into(),
            });
        }
        let checked = ssrf::check(&host, &resolved, &self.allow)
            .map_err(|(ip, why)| FetchError::Blocked { host, ip, why })?;
        Ok((checked, port))
    }

    async fn connect(&self, url: &Url) -> Result<TcpStream, FetchError> {
        let (addresses, port) = self.addresses(url).await?;
        let mut last = None;
        for ip in addresses {
            match TcpStream::connect(SocketAddr::new(ip, port)).await {
                Ok(stream) => return Ok(stream),
                Err(e) => last = Some(e),
            }
        }
        Err(FetchError::Connect {
            host: host_header(url),
            reason: last.map_or_else(|| "no address".into(), |e| e.to_string()),
        })
    }

    async fn request(&self, url: &Url) -> Result<Response, FetchError> {
        let tcp = self.connect(url).await?;
        if url.scheme() == "https" {
            let name = match url.host() {
                Some(Host::Ipv4(ip)) => {
                    rustls::pki_types::ServerName::IpAddress(IpAddr::V4(ip).into())
                }
                Some(Host::Ipv6(ip)) => {
                    rustls::pki_types::ServerName::IpAddress(IpAddr::V6(ip).into())
                }
                _ => rustls::pki_types::ServerName::try_from(
                    url.host_str().unwrap_or_default().to_owned(),
                )
                .map_err(|e| FetchError::InvalidUrl(e.to_string()))?,
            };
            let tls = tokio_rustls::TlsConnector::from(self.tls.clone())
                .connect(name, tcp)
                .await
                .map_err(|e| FetchError::Tls(format!("{}: {e}", host_header(url))))?;
            self.exchange(url, tls).await
        } else {
            self.exchange(url, tcp).await
        }
    }

    async fn exchange<S>(&self, url: &Url, stream: S) -> Result<Response, FetchError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let http = |e: hyper::Error| FetchError::Http(format!("{}: {e}", host_header(url)));
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(http)?;
        let driver = tokio::spawn(conn);
        let path = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_owned(),
        };
        let request = Request::get(path)
            .header(HOST, host_header(url))
            .header(USER_AGENT, &self.user_agent)
            .header(
                ACCEPT,
                "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5",
            )
            .header(ACCEPT_ENCODING, "identity")
            .header(CONNECTION, "close")
            .body(Empty::<Bytes>::new())
            .map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
        let result = async {
            let response = sender.send_request(request).await.map_err(http)?;
            let header = |name| {
                response
                    .headers()
                    .get(name)
                    .and_then(|v: &http::HeaderValue| v.to_str().ok())
                    .map(str::to_owned)
            };
            if let Some(encoding) =
                header(CONTENT_ENCODING).filter(|e| !e.eq_ignore_ascii_case("identity"))
            {
                return Err(FetchError::UnsupportedEncoding(encoding));
            }
            let status = response.status();
            let location = header(LOCATION);
            let content_type = header(CONTENT_TYPE);
            let mut body = response.into_body();
            let mut bytes = Vec::new();
            let mut truncated = false;
            if !status.is_redirection() {
                while let Some(frame) = body.frame().await {
                    let frame = frame.map_err(http)?;
                    let Ok(data) = frame.into_data() else {
                        continue;
                    };
                    let room = self.limits.max_body_bytes - bytes.len();
                    if data.len() > room {
                        bytes.extend_from_slice(&data[..room]);
                        truncated = true;
                        break;
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            Ok(Response {
                status,
                location,
                content_type,
                body: bytes,
                truncated,
            })
        }
        .await;
        driver.abort();
        result
    }
}

impl Default for FetchLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: 10 * 1024 * 1024,
            max_content_chars: 100_000,
            timeout: Duration::from_secs(60),
            max_redirects: 10,
        }
    }
}
