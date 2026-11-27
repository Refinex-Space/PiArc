//! Large file downloads for Core (ADR-0097): HTTPS only, every hop's host checked against the
//! caller's list, public addresses only when connecting directly (the same address check as
//! WebFetch, connecting to the checked address), the user's proxy through `CONNECT`,
//! certificates verified with the platform's trust store, the body streamed to a file, never
//! more bytes than expected, the whole file hashed once complete (a resumed file included),
//! resumable with `Range`, and cancellable at any point. A file that does not match its size and SHA-256 is removed.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use http::header::{CONNECTION, CONTENT_LENGTH, CONTENT_RANGE, HOST, LOCATION, RANGE, USER_AGENT};
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::fetch::{Resolve, SystemResolver};
use crate::ssrf::{self, Allowlist};

/// Most redirects one download follows.
pub const MAX_REDIRECTS: u8 = 5;
/// How long connecting, a proxy handshake or a stalled read may take.
const STALL: Duration = Duration::from_secs(30);

/// Why a download failed. Codes go to the client (`error` of a model status).
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    /// Not an `https:` URL, or a hop to a host the caller does not allow.
    #[error("refused URL ({0})")]
    Refused(&'static str),
    /// A direct connection would reach a private or local address.
    #[error("refused address")]
    Blocked,
    /// Name resolution or connection failed.
    #[error("network error: {0}")]
    Network(String),
    /// The proxy refused (`407` needs credentials PiArc does not keep).
    #[error("the proxy refused the connection (HTTP {0})")]
    Proxy(u16),
    /// Certificate or TLS failure.
    #[error("TLS failed: {0}")]
    Tls(String),
    /// An HTTP status other than success or redirect.
    #[error("HTTP {0}")]
    Status(u16),
    /// More bytes than expected, or a length header that says so.
    #[error("the server sent more data than expected")]
    TooLarge,
    /// The body ended before the expected size.
    #[error("the download ended early")]
    Truncated,
    /// Size or SHA-256 did not match.
    #[error("the downloaded file does not match its checksum")]
    Checksum,
    /// Too many redirects.
    #[error("too many redirects")]
    Redirects,
    /// Writing the file failed (disk full, permissions).
    #[error("cannot write the download: {0}")]
    Disk(String),
    /// Cancelled by the caller.
    #[error("cancelled")]
    Cancelled,
}

impl DownloadError {
    /// The stable code clients show (`network`, `checksum`, `diskFull`, `cancelled`…).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(_) | Self::Blocked => "refused",
            Self::Network(_) | Self::Status(_) | Self::Truncated | Self::Redirects => "network",
            Self::Proxy(_) => "proxy",
            Self::Tls(_) => "tls",
            Self::TooLarge | Self::Checksum => "checksum",
            // "No space left on device" (Unix), "There is not enough space on the disk" (Windows).
            Self::Disk(message) if message.contains("space") => "diskFull",
            Self::Disk(_) => "disk",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One file to download.
pub struct DownloadJob<'a> {
    /// The first URL (`https:`).
    pub url: &'a str,
    /// Where to write it; a partial file there is resumed.
    pub dest: &'a Path,
    /// Exact size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256.
    pub sha256: &'a str,
    /// Whether a hop may go to this host.
    pub allows_host: &'a (dyn Fn(&str) -> bool + Send + Sync),
    /// `http://host:port` or `https://host:port` of the proxy, if any.
    pub proxy: Option<&'a str>,
}

/// Any byte stream a request can run over.
trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// A boxed [`Io`] that is itself `AsyncRead + AsyncWrite`.
struct Stream(Box<dyn Io>);

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.0).poll_shutdown(cx)
    }
}

/// Downloads files.
pub struct Downloader {
    resolver: Arc<dyn Resolve>,
    tls: Arc<rustls::ClientConfig>,
    allow: Allowlist,
    user_agent: String,
}

impl Downloader {
    /// A downloader with the system resolver and the platform's trust store.
    ///
    /// # Errors
    ///
    /// [`DownloadError::Tls`] when the platform verifier cannot be set up.
    pub fn new() -> Result<Self, DownloadError> {
        use rustls_platform_verifier::BuilderVerifierExt as _;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .and_then(|b| b.with_platform_verifier())
            .map_err(|e| DownloadError::Tls(e.to_string()))?
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self::with_parts(
            Arc::new(SystemResolver),
            Arc::new(tls),
            Allowlist::default(),
        ))
    }

    /// A downloader with chosen parts (tests: a resolver mapping names to local servers, a
    /// TLS configuration trusting a test CA, an allowlist admitting the local addresses).
    #[must_use]
    pub fn with_parts(
        resolver: Arc<dyn Resolve>,
        tls: Arc<rustls::ClientConfig>,
        allow: Allowlist,
    ) -> Self {
        Self {
            resolver,
            tls,
            allow,
            user_agent: format!("PiArc-ModelDownload/{}", env!("CARGO_PKG_VERSION")),
        }
    }

    /// Downloads `job` into `job.dest`, calling `progress` with the bytes on disk.
    ///
    /// # Errors
    ///
    /// See [`DownloadError`]. A checksum failure removes the file; other failures keep the
    /// partial file for a later resume.
    pub async fn download(
        &self,
        job: &DownloadJob<'_>,
        cancel: &CancellationToken,
        progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<(), DownloadError> {
        let have = match tokio::fs::metadata(job.dest).await {
            Ok(meta) if meta.len() <= job.size => meta.len(),
            Ok(_) => {
                remove(job.dest).await;
                0
            }
            Err(_) => 0,
        };
        progress(have);
        if have < job.size {
            tokio::select! {
                () = cancel.cancelled() => return Err(DownloadError::Cancelled),
                result = self.fetch(job, have, progress) => result?,
            }
        }
        let digest = hash_file(job.dest)
            .await
            .map_err(|e| DownloadError::Disk(e.to_string()))?;
        if digest != job.sha256 {
            remove(job.dest).await;
            return Err(DownloadError::Checksum);
        }
        Ok(())
    }

    async fn fetch(
        &self,
        job: &DownloadJob<'_>,
        have: u64,
        progress: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<(), DownloadError> {
        let mut url = target(job.url, job.allows_host)?;
        for _ in 0..=MAX_REDIRECTS {
            let stream = self.open(&url, job.proxy).await?;
            let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
                .await
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            let driver = tokio::spawn(conn);
            let path = match url.query() {
                Some(q) => format!("{}?{q}", url.path()),
                None => url.path().to_owned(),
            };
            let mut request = Request::builder()
                .uri(path)
                .header(HOST, host_header(&url))
                .header(USER_AGENT, &self.user_agent)
                .header(CONNECTION, "close");
            if have > 0 {
                request = request.header(RANGE, format!("bytes={have}-"));
            }
            let request = request
                .body(Empty::<Bytes>::new())
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            let response = tokio::time::timeout(STALL, sender.send_request(request))
                .await
                .map_err(|_| DownloadError::Network("timed out".into()))?
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(DownloadError::Status(status.as_u16()))?;
                let next = url
                    .join(location)
                    .map_err(|_| DownloadError::Refused("redirect location"))?;
                driver.abort();
                url = target(next.as_str(), job.allows_host)?;
                continue;
            }
            let resumed = match status {
                StatusCode::PARTIAL_CONTENT if have > 0 => {
                    let range = response
                        .headers()
                        .get(CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default();
                    if !range.starts_with(&format!("bytes {have}-")) {
                        driver.abort();
                        return Err(DownloadError::Status(206));
                    }
                    true
                }
                StatusCode::OK => false,
                other => {
                    driver.abort();
                    return Err(DownloadError::Status(other.as_u16()));
                }
            };
            let start = if resumed { have } else { 0 };
            if let Some(length) = response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                && start + length > job.size
            {
                driver.abort();
                return Err(DownloadError::TooLarge);
            }
            let result = write_body(response.into_body(), job, start, progress).await;
            driver.abort();
            return result;
        }
        Err(DownloadError::Redirects)
    }

    /// A connection to `url`'s host: through the proxy, or directly to a checked address;
    /// then TLS.
    async fn open(&self, url: &Url, proxy: Option<&str>) -> Result<Stream, DownloadError> {
        let host = url.host_str().unwrap_or_default().to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        let tcp = match proxy {
            Some(proxy) => self.tunnel(proxy, &host, port).await?,
            None => self.direct(url, &host, port).await?,
        };
        let name = match url.host() {
            Some(Host::Ipv4(ip)) => rustls::pki_types::ServerName::IpAddress(IpAddr::V4(ip).into()),
            Some(Host::Ipv6(ip)) => rustls::pki_types::ServerName::IpAddress(IpAddr::V6(ip).into()),
            _ => rustls::pki_types::ServerName::try_from(host.clone())
                .map_err(|_| DownloadError::Refused("host name"))?,
        };
        let tls = tokio::time::timeout(
            STALL,
            tokio_rustls::TlsConnector::from(self.tls.clone()).connect(name, tcp),
        )
        .await
        .map_err(|_| DownloadError::Network("TLS handshake timed out".into()))?
        .map_err(|e| DownloadError::Tls(e.to_string()))?;
        Ok(Stream(Box::new(tls)))
    }

    async fn direct(&self, url: &Url, host: &str, port: u16) -> Result<Stream, DownloadError> {
        let addresses = match url.host() {
            Some(Host::Ipv4(ip)) => vec![IpAddr::V4(ip)],
            Some(Host::Ipv6(ip)) => vec![IpAddr::V6(ip)],
            _ => self
                .resolver
                .resolve(host, port)
                .await
                .map_err(|e| DownloadError::Network(e.to_string()))?,
        };
        let checked =
            ssrf::check(host, &addresses, &self.allow).map_err(|_| DownloadError::Blocked)?;
        let mut last = None;
        for ip in checked {
            match tokio::time::timeout(STALL, TcpStream::connect(SocketAddr::new(ip, port))).await {
                Ok(Ok(stream)) => return Ok(Stream(Box::new(stream))),
                Ok(Err(e)) => last = Some(e.to_string()),
                Err(_) => last = Some("timed out".into()),
            }
        }
        Err(DownloadError::Network(
            last.unwrap_or_else(|| "no address".into()),
        ))
    }

    /// `CONNECT host:port` through the proxy (an address the user or system chose, so not
    /// address-checked); an `https:` proxy is reached over TLS first.
    async fn tunnel(&self, proxy: &str, host: &str, port: u16) -> Result<Stream, DownloadError> {
        let proxy = Url::parse(proxy).map_err(|_| DownloadError::Refused("proxy"))?;
        let proxy_host = proxy
            .host_str()
            .ok_or(DownloadError::Refused("proxy"))?
            .to_owned();
        let proxy_port = proxy
            .port_or_known_default()
            .ok_or(DownloadError::Refused("proxy"))?;
        let tcp =
            tokio::time::timeout(STALL, TcpStream::connect((proxy_host.as_str(), proxy_port)))
                .await
                .map_err(|_| DownloadError::Network("proxy timed out".into()))?
                .map_err(|e| DownloadError::Network(e.to_string()))?;
        let mut stream = if proxy.scheme() == "https" {
            let name = rustls::pki_types::ServerName::try_from(proxy_host.clone())
                .map_err(|_| DownloadError::Refused("proxy"))?;
            let tls = tokio_rustls::TlsConnector::from(self.tls.clone())
                .connect(name, tcp)
                .await
                .map_err(|e| DownloadError::Tls(e.to_string()))?;
            Stream(Box::new(tls))
        } else if proxy.scheme() == "http" {
            Stream(Box::new(tcp))
        } else {
            return Err(DownloadError::Refused("proxy scheme"));
        };
        let authority = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        let request = format!(
            "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: {}\r\n\r\n",
            self.user_agent
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| DownloadError::Network(e.to_string()))?;
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > 8192 {
                return Err(DownloadError::Proxy(0));
            }
            let read = tokio::time::timeout(STALL, stream.read(&mut byte))
                .await
                .map_err(|_| DownloadError::Network("proxy timed out".into()))?
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            if read == 0 {
                return Err(DownloadError::Proxy(0));
            }
            head.push(byte[0]);
        }
        let status = String::from_utf8_lossy(&head)
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        if status == 200 {
            Ok(stream)
        } else {
            Err(DownloadError::Proxy(status))
        }
    }
}

/// `text` as a download target: `https:` to an allowed host, no credentials.
fn target(
    text: &str,
    allows_host: &(dyn Fn(&str) -> bool + Send + Sync),
) -> Result<Url, DownloadError> {
    let url = Url::parse(text).map_err(|_| DownloadError::Refused("URL"))?;
    if url.scheme() != "https" {
        return Err(DownloadError::Refused("not https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(DownloadError::Refused("credentials"));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() || !allows_host(&host) {
        return Err(DownloadError::Refused("host"));
    }
    Ok(url)
}

fn host_header(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

async fn write_body(
    mut body: hyper::body::Incoming,
    job: &DownloadJob<'_>,
    start: u64,
    progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DownloadError> {
    let disk = |e: io::Error| DownloadError::Disk(e.to_string());
    if let Some(parent) = job.dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(disk)?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(start > 0)
        .truncate(start == 0)
        .open(job.dest)
        .await
        .map_err(disk)?;
    let mut written = start;
    let mut reported = start;
    loop {
        let frame = match tokio::time::timeout(STALL, body.frame()).await {
            Err(_) => return Err(DownloadError::Network("stalled".into())),
            Ok(None) => break,
            Ok(Some(frame)) => frame.map_err(|e| DownloadError::Network(e.to_string()))?,
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if written + data.len() as u64 > job.size {
            drop(file);
            remove(job.dest).await;
            return Err(DownloadError::TooLarge);
        }
        file.write_all(&data).await.map_err(disk)?;
        written += data.len() as u64;
        if written - reported >= 1 << 20 || written == job.size {
            progress(written);
            reported = written;
        }
    }
    file.flush().await.map_err(disk)?;
    file.sync_all().await.map_err(disk)?;
    if written != job.size {
        return Err(DownloadError::Truncated);
    }
    Ok(())
}

async fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

async fn remove(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modelscope(host: &str) -> bool {
        host == "modelscope.cn" || host.ends_with(".modelscope.cn")
    }

    #[test]
    fn only_https_to_allowed_hosts_without_credentials() {
        assert!(target("https://modelscope.cn/x", &modelscope).is_ok());
        assert!(target("https://cdn-lfs-cn-1.modelscope.cn/x", &modelscope).is_ok());
        assert!(matches!(
            target("http://modelscope.cn/x", &modelscope),
            Err(DownloadError::Refused("not https"))
        ));
        assert!(matches!(
            target("https://evil.example/x", &modelscope),
            Err(DownloadError::Refused("host"))
        ));
        assert!(matches!(
            target("https://modelscope.cn.evil.example/x", &modelscope),
            Err(DownloadError::Refused("host"))
        ));
        assert!(matches!(
            target("https://u:p@modelscope.cn/x", &modelscope),
            Err(DownloadError::Refused("credentials"))
        ));
        assert!(matches!(
            target("file:///etc/passwd", &modelscope),
            Err(DownloadError::Refused("not https"))
        ));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(DownloadError::Checksum.code(), "checksum");
        assert_eq!(DownloadError::Cancelled.code(), "cancelled");
        assert_eq!(
            DownloadError::Disk("No space left on device".into()).code(),
            "diskFull"
        );
        assert_eq!(DownloadError::Proxy(407).code(), "proxy");
    }
}
