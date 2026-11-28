//! Small HTTPS requests whose answer Core reads into memory (ADR-0102: the Pi package market's
//! catalog): the same connection as [`crate::download`] (hosts checked on every hop, `https:`
//! only, the user's proxy through `CONNECT`, otherwise a checked address), `GET` with
//! `Accept-Encoding: identity`, at most [`crate::download::MAX_REDIRECTS`] redirects, a body
//! never longer than the caller's bound, a stalled read and the whole request both timed out,
//! and cancellable at any point. Retrying is the caller's choice ([`GetError::retryable`]).

use std::sync::Arc;
use std::time::Duration;

use http::Request;
use http::header::{
    ACCEPT, ACCEPT_ENCODING, CONNECTION, CONTENT_ENCODING, CONTENT_LENGTH, HOST, LOCATION,
    RETRY_AFTER, USER_AGENT,
};
use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use tokio_util::sync::CancellationToken;

use crate::connect::{Connector, STALL, host_header, platform_tls, target, trusting_tls};
use crate::download::{DownloadError, MAX_REDIRECTS};
use crate::fetch::{Resolve, SystemResolver};
use crate::ssrf::Allowlist;

/// Why a request failed. [`GetError::code`] is the stable code clients show.
#[derive(Debug, thiserror::Error)]
pub enum GetError {
    /// Not an `https:` URL, a hop to a host the caller does not allow, or a bad proxy address.
    #[error("refused URL ({0})")]
    Refused(&'static str),
    /// A direct connection would reach a private or local address.
    #[error("refused address")]
    Blocked,
    /// Name resolution, connection or reading failed.
    #[error("network error: {0}")]
    Network(String),
    /// The proxy refused the tunnel.
    #[error("the proxy refused the connection (HTTP {0})")]
    Proxy(u16),
    /// The proxy could not be reached.
    #[error("cannot reach the proxy: {0}")]
    ProxyUnreachable(String),
    /// Certificate or TLS failure.
    #[error("TLS failed: {0}")]
    Tls(String),
    /// An HTTP status other than success or redirect; `retry_after` from `Retry-After`.
    #[error("HTTP {status}")]
    Status {
        status: u16,
        retry_after: Option<Duration>,
    },
    /// The body (or its declared length) is over the caller's bound.
    #[error("the answer is larger than {0} bytes")]
    TooLarge(usize),
    /// The server compressed the body although PiArc asked for none.
    #[error("the answer is encoded ({0})")]
    Encoding(String),
    /// Too many redirects.
    #[error("too many redirects")]
    Redirects,
    /// The whole request took longer than allowed.
    #[error("timed out")]
    Timeout,
    /// Cancelled by the caller.
    #[error("cancelled")]
    Cancelled,
}

impl GetError {
    /// The stable code clients show: `refused`, `network`, `proxy`, `tls`, `notFound`,
    /// `status`, `tooLarge`, `timeout`, `cancelled`.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(_) | Self::Blocked => "refused",
            Self::Network(_) | Self::Redirects | Self::Encoding(_) => "network",
            Self::Proxy(_) | Self::ProxyUnreachable(_) => "proxy",
            Self::Tls(_) => "tls",
            Self::Status { status: 404, .. } => "notFound",
            Self::Status { .. } => "status",
            Self::TooLarge(_) => "tooLarge",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
        }
    }

    /// Whether trying again may help: network failures, timeouts, `429` and `5xx`. A proxy
    /// failure is not retried (it is the user's setting to fix).
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::Network(_) | Self::Timeout => true,
            Self::Status { status, .. } => *status == 429 || *status >= 500,
            _ => false,
        }
    }

    /// The server's `Retry-After`, when it sent one.
    #[must_use]
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Status { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

impl From<DownloadError> for GetError {
    fn from(error: DownloadError) -> Self {
        match error {
            DownloadError::Refused(what) => Self::Refused(what),
            DownloadError::Blocked => Self::Blocked,
            DownloadError::Proxy(status) => Self::Proxy(status),
            DownloadError::ProxyUnreachable(why) => Self::ProxyUnreachable(why),
            DownloadError::Tls(message) => Self::Tls(message),
            DownloadError::Redirects => Self::Redirects,
            DownloadError::Cancelled => Self::Cancelled,
            other => Self::Network(other.to_string()),
        }
    }
}

/// One request.
pub struct GetJob<'a> {
    /// The first URL (`https:`).
    pub url: &'a str,
    /// Whether a hop may go to this host.
    pub allows_host: &'a (dyn Fn(&str) -> bool + Send + Sync),
    /// `http://host:port` or `https://host:port` of the proxy, if any.
    pub proxy: Option<&'a str>,
    /// Most body bytes read; more is [`GetError::TooLarge`].
    pub max_bytes: usize,
    /// The `Accept` header.
    pub accept: &'a str,
    /// The whole request, redirects included.
    pub timeout: Duration,
}

/// Makes requests.
pub struct Getter {
    connector: Connector,
}

impl Getter {
    /// A client with the system resolver and the platform's trust store.
    ///
    /// # Errors
    ///
    /// [`GetError::Tls`] when the platform verifier cannot be set up.
    pub fn new() -> Result<Self, GetError> {
        Ok(Self::with_parts(
            Arc::new(SystemResolver),
            platform_tls().map_err(GetError::Tls)?,
            Allowlist::default(),
        ))
    }

    /// A client with chosen parts (tests: a resolver mapping names to local servers, a TLS
    /// configuration trusting a test CA, an allowlist admitting the local addresses).
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
                user_agent: format!("PiArc/{}", env!("CARGO_PKG_VERSION")),
            },
        }
    }

    /// A client that trusts only the roots in `ca_pem` (PEM): development builds' and tests'
    /// local registries, never a release build's network.
    ///
    /// # Errors
    ///
    /// The PEM holds no usable certificate.
    pub fn trusting(
        ca_pem: &[u8],
        resolver: Arc<dyn Resolve>,
        allow: Allowlist,
    ) -> Result<Self, GetError> {
        let tls = trusting_tls(ca_pem).map_err(GetError::Tls)?;
        Ok(Self::with_parts(resolver, tls, allow))
    }

    /// `GET job.url`, answering the body of the final successful response.
    ///
    /// # Errors
    ///
    /// See [`GetError`].
    pub async fn get(
        &self,
        job: &GetJob<'_>,
        cancel: &CancellationToken,
    ) -> Result<Bytes, GetError> {
        tokio::select! {
            () = cancel.cancelled() => Err(GetError::Cancelled),
            result = tokio::time::timeout(job.timeout, self.fetch(job)) => {
                result.unwrap_or(Err(GetError::Timeout))
            }
        }
    }

    async fn fetch(&self, job: &GetJob<'_>) -> Result<Bytes, GetError> {
        let mut url = target(job.url, job.allows_host)?;
        for _ in 0..=MAX_REDIRECTS {
            let stream = self.connector.open(&url, job.proxy).await?;
            let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
                .await
                .map_err(|e| GetError::Network(e.to_string()))?;
            let driver = tokio::spawn(conn);
            let path = match url.query() {
                Some(q) => format!("{}?{q}", url.path()),
                None => url.path().to_owned(),
            };
            let request = Request::builder()
                .uri(path)
                .header(HOST, host_header(&url))
                .header(USER_AGENT, &self.connector.user_agent)
                .header(ACCEPT, job.accept)
                .header(ACCEPT_ENCODING, "identity")
                .header(CONNECTION, "close")
                .body(Empty::<Bytes>::new())
                .map_err(|e| GetError::Network(e.to_string()))?;
            let response = tokio::time::timeout(STALL, sender.send_request(request))
                .await
                .map_err(|_| GetError::Network("timed out".into()))?
                .map_err(|e| GetError::Network(e.to_string()))?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(GetError::Status {
                        status: status.as_u16(),
                        retry_after: None,
                    })?;
                let next = url
                    .join(location)
                    .map_err(|_| GetError::Refused("redirect location"))?;
                driver.abort();
                url = target(next.as_str(), job.allows_host)?;
                continue;
            }
            if let Err(error) = refuse(&response, job.max_bytes) {
                driver.abort();
                return Err(error);
            }
            let body = read_body(response.into_body(), job.max_bytes).await;
            driver.abort();
            return body;
        }
        Err(GetError::Redirects)
    }
}

/// The error a final response stands for: a failure status, an encoding, a declared length
/// over the bound.
fn refuse(response: &http::Response<hyper::body::Incoming>, max: usize) -> Result<(), GetError> {
    let headers = response.headers();
    let status = response.status();
    if !status.is_success() {
        let retry_after = headers
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        return Err(GetError::Status {
            status: status.as_u16(),
            retry_after,
        });
    }
    if let Some(encoding) = headers
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.eq_ignore_ascii_case("identity"))
    {
        return Err(GetError::Encoding(encoding.to_owned()));
    }
    if headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|length| length > max as u64)
    {
        return Err(GetError::TooLarge(max));
    }
    Ok(())
}

async fn read_body(mut body: hyper::body::Incoming, max: usize) -> Result<Bytes, GetError> {
    let mut out = Vec::new();
    loop {
        let frame = match tokio::time::timeout(STALL, body.frame()).await {
            Err(_) => return Err(GetError::Network("stalled".into())),
            Ok(None) => break,
            Ok(Some(frame)) => frame.map_err(|e| GetError::Network(e.to_string()))?,
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        if out.len() + data.len() > max {
            return Err(GetError::TooLarge(max));
        }
        out.extend_from_slice(&data);
    }
    Ok(Bytes::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_retries() {
        let status = |status| GetError::Status {
            status,
            retry_after: None,
        };
        assert_eq!(status(404).code(), "notFound");
        assert!(status(503).retryable());
        assert!(status(429).retryable());
        assert!(!status(404).retryable());
        assert!(!GetError::Proxy(407).retryable());
        assert_eq!(GetError::Proxy(407).code(), "proxy");
        assert!(GetError::Timeout.retryable());
        assert_eq!(GetError::TooLarge(1).code(), "tooLarge");
        assert_eq!(
            GetError::from(DownloadError::Blocked).code(),
            "refused",
            "a direct connection to a local address"
        );
    }
}
