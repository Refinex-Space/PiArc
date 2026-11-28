//! The connection under Core's own HTTPS requests (ADR-0097, ADR-0102): every hop's host
//! checked against the caller's list, `https:` only, no credentials in the URL; through the
//! user's proxy with `CONNECT` (the proxy address is the user's or the system's, so it is not
//! address-checked), otherwise directly to an address `ssrf::check` admitted (resolve, check,
//! connect to the checked IP: no second lookup); then TLS with the configured roots.
//! [`crate::download`] and [`crate::get`] run over it.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use url::{Host, Url};

use crate::download::DownloadError;
use crate::fetch::Resolve;
use crate::ssrf::{self, Allowlist};

/// How long connecting, a proxy handshake or a stalled read may take.
pub(crate) const STALL: Duration = Duration::from_secs(30);

/// Any byte stream a request can run over.
pub(crate) trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// A boxed [`Io`] that is itself `AsyncRead + AsyncWrite`.
pub(crate) struct Stream(pub(crate) Box<dyn Io>);

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

/// A TLS configuration trusting the platform's store (`rustls-platform-verifier`), HTTP/1.1.
///
/// # Errors
///
/// The platform verifier cannot be set up.
pub(crate) fn platform_tls() -> Result<Arc<rustls::ClientConfig>, String> {
    use rustls_platform_verifier::BuilderVerifierExt as _;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_platform_verifier())
        .map_err(|e| e.to_string())?
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(tls))
}

/// Opens connections for one client (its resolver, TLS roots, address allowlist and
/// `User-Agent`).
pub(crate) struct Connector {
    pub(crate) resolver: Arc<dyn Resolve>,
    pub(crate) tls: Arc<rustls::ClientConfig>,
    pub(crate) allow: Allowlist,
    pub(crate) user_agent: String,
}

impl Connector {
    /// A connection to `url`'s host: through the proxy, or directly to a checked address;
    /// then TLS.
    pub(crate) async fn open(
        &self,
        url: &Url,
        proxy: Option<&str>,
    ) -> Result<Stream, DownloadError> {
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
                .map_err(|_| DownloadError::ProxyUnreachable("timed out".into()))?
                .map_err(|e| DownloadError::ProxyUnreachable(e.to_string()))?;
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
pub(crate) fn target(
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

pub(crate) fn host_header(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}
