//! Large file downloads for Core (ADR-0097): HTTPS only, every hop's host checked against the
//! caller's list, public addresses only when connecting directly (the same address check as
//! WebFetch, connecting to the checked address), the user's proxy through `CONNECT`,
//! certificates verified with the platform's trust store, the body streamed to a file, never
//! more bytes than expected, the whole file hashed once complete (a resumed file included),
//! resumable with `Range`, and cancellable at any point. A file that does not match its size and SHA-256 is removed.

use std::io;
use std::path::Path;
use std::sync::Arc;

use http::header::{CONNECTION, CONTENT_LENGTH, CONTENT_RANGE, HOST, LOCATION, RANGE, USER_AGENT};
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::connect::{Connector, STALL, host_header, platform_tls, target};
use crate::fetch::{Resolve, SystemResolver};
use crate::ssrf::Allowlist;

/// Most redirects one download follows.
pub const MAX_REDIRECTS: u8 = 5;

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
    /// The proxy could not be reached (never a reason to connect directly).
    #[error("cannot reach the proxy: {0}")]
    ProxyUnreachable(String),
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
            Self::Proxy(_) | Self::ProxyUnreachable(_) => "proxy",
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

/// Downloads files.
pub struct Downloader {
    connector: Connector,
}

impl Downloader {
    /// A downloader with the system resolver and the platform's trust store.
    ///
    /// # Errors
    ///
    /// [`DownloadError::Tls`] when the platform verifier cannot be set up.
    pub fn new() -> Result<Self, DownloadError> {
        Ok(Self::with_parts(
            Arc::new(SystemResolver),
            platform_tls().map_err(DownloadError::Tls)?,
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
            connector: Connector {
                resolver,
                tls,
                allow,
                user_agent: format!("PiArc-ModelDownload/{}", env!("CARGO_PKG_VERSION")),
            },
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
            let stream = self.connector.open(&url, job.proxy).await?;
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
                .header(USER_AGENT, &self.connector.user_agent)
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
