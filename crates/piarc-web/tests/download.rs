//! Model downloads (ADR-0097) against a local HTTPS server with a test CA
//! (`tests/fixtures/tls/`): verified files, redirects only to allowed hosts, the address check
//! on direct connections, the proxy's `CONNECT`, `Range` resume, size and checksum failures,
//! and cancellation.
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_web::download::{DownloadError, DownloadJob, Downloader};
use piarc_web::{Allowlist, Resolve};
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

const CA: &[u8] = include_bytes!("fixtures/tls/ca.pem");
const SERVER_CERT: &[u8] = include_bytes!("fixtures/tls/server.pem");
const SERVER_KEY: &[u8] = include_bytes!("fixtures/tls/server.key");

/// Test names → loopback; anything else is unknown.
struct Names(HashMap<String, IpAddr>);

impl Names {
    fn loopback(names: &[&str]) -> Arc<Self> {
        Arc::new(Self(
            names
                .iter()
                .map(|n| ((*n).to_owned(), IpAddr::from([127, 0, 0, 1])))
                .collect(),
        ))
    }
}

impl Resolve for Names {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        _port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>> {
        let answer = self.0.get(host).copied();
        Box::pin(async move {
            answer
                .map(|ip| vec![ip])
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown test name"))
        })
    }
}

/// One request as the server saw it.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    host: String,
    range: Option<String>,
}

type Route = Box<dyn Fn(&Seen, u16) -> Option<Vec<u8>> + Send + Sync>;

struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

/// An HTTPS server for `models.test`, `cdn.models.test` and `other.test`: one request per
/// connection, `route` gives the raw response (`None` holds the connection open).
async fn serve(route: Route) -> Server {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from_pem_slice(SERVER_CERT).unwrap()],
        PrivateKeyDer::from_pem_slice(SERVER_KEY).unwrap(),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let route = Arc::new(route);
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, route, log) = (acceptor.clone(), route.clone(), log.clone());
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let Some(head) = read_head(&mut tls).await else {
                    return;
                };
                let seen = parse(&head);
                log.lock().unwrap().push(seen.clone());
                match route(&seen, port) {
                    Some(response) => {
                        let _ = tls.write_all(&response).await;
                        let _ = tls.shutdown().await;
                    }
                    None => tokio::time::sleep(Duration::from_secs(60)).await,
                }
            });
        }
    });
    Server { port, seen }
}

async fn read_head(stream: &mut (impl AsyncRead + Unpin)) -> Option<String> {
    let mut head = Vec::new();
    let mut buf = [0_u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

fn parse(head: &str) -> Seen {
    let mut lines = head.lines();
    let path = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_owned();
    let header = |name: &str| {
        head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_owned())
        })
    };
    Seen {
        path,
        host: header("host").unwrap_or_default(),
        range: header("range"),
    }
}

fn ok(body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

fn redirect(to: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn tls() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(CA).unwrap())
        .unwrap();
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// A downloader whose test names resolve to loopback, which the allowlist admits.
fn downloader() -> Downloader {
    Downloader::with_parts(
        Names::loopback(&["models.test", "cdn.models.test", "other.test"]),
        tls(),
        Allowlist::new(&["127.0.0.1".to_owned()]).unwrap(),
    )
}

fn models_hosts(host: &str) -> bool {
    host == "models.test" || host == "cdn.models.test"
}

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("piarc download {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self) -> PathBuf {
        self.0.join("models").join("model.onnx")
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn fetch(
    downloader: &Downloader,
    url: &str,
    dest: &Path,
    body: &[u8],
    proxy: Option<&str>,
) -> Result<Vec<u64>, DownloadError> {
    let progress = Mutex::new(Vec::new());
    let job = DownloadJob {
        url,
        dest,
        size: body.len() as u64,
        sha256: &sha256(body),
        allows_host: &models_hosts,
        proxy,
    };
    downloader
        .download(&job, &CancellationToken::new(), &|bytes| {
            progress.lock().unwrap().push(bytes);
        })
        .await?;
    Ok(progress.into_inner().unwrap())
}

fn body() -> Vec<u8> {
    (0..3_000_000_u32).map(|i| (i % 251) as u8).collect()
}

#[tokio::test]
async fn a_verified_file_arrives_with_progress() {
    let content = body();
    let served = content.clone();
    let server = serve(Box::new(move |_, _| Some(ok(&served)))).await;
    let dir = Dir::new("plain");
    let url = format!("https://models.test:{}/m/model.onnx?rev=1", server.port);
    let progress = fetch(&downloader(), &url, &dir.file(), &content, None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(dir.file()).unwrap(), content);
    assert_eq!(progress.first(), Some(&0));
    assert_eq!(progress.last(), Some(&(content.len() as u64)));
    assert!(progress.len() >= 3, "{progress:?}");
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen[0].path, "/m/model.onnx?rev=1");
    assert_eq!(seen[0].host, format!("models.test:{}", server.port));
}

#[tokio::test]
async fn redirects_follow_allowed_hosts_only() {
    let content = b"weights".to_vec();
    let served = content.clone();
    let server = serve(Box::new(move |seen, port| {
        Some(match seen.path.as_str() {
            "/allowed" => redirect(&format!("https://cdn.models.test:{port}/blob")),
            "/elsewhere" => redirect(&format!("https://other.test:{port}/blob")),
            "/plain-http" => redirect(&format!("http://cdn.models.test:{port}/blob")),
            _ => ok(&served),
        })
    }))
    .await;
    let dir = Dir::new("redirects");
    let base = format!("https://models.test:{}", server.port);
    fetch(
        &downloader(),
        &format!("{base}/allowed"),
        &dir.file(),
        &content,
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dir.file()).unwrap(), content);
    let refused = fetch(
        &downloader(),
        &format!("{base}/elsewhere"),
        &dir.0.join("b"),
        &content,
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(DownloadError::Refused("host"))),
        "{refused:?}"
    );
    let refused = fetch(
        &downloader(),
        &format!("{base}/plain-http"),
        &dir.0.join("c"),
        &content,
        None,
    )
    .await;
    assert!(
        matches!(refused, Err(DownloadError::Refused("not https"))),
        "{refused:?}"
    );
    assert!(
        !server
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.host.starts_with("other.test"))
    );
}

#[tokio::test]
async fn a_direct_connection_to_a_local_address_is_refused() {
    let server = serve(Box::new(|_, _| Some(ok(b"x")))).await;
    let dir = Dir::new("blocked");
    let strict = Downloader::with_parts(
        Names::loopback(&["models.test"]),
        tls(),
        Allowlist::default(),
    );
    let url = format!("https://models.test:{}/x", server.port);
    let result = fetch(&strict, &url, &dir.file(), b"x", None).await;
    assert!(matches!(result, Err(DownloadError::Blocked)), "{result:?}");
    assert!(server.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_wrong_checksum_or_extra_bytes_remove_the_file() {
    let server = serve(Box::new(|seen, _| {
        Some(match seen.path.as_str() {
            "/tampered" => ok(b"tampered!"),
            _ => ok(b"far more bytes than the manifest says"),
        })
    }))
    .await;
    let dir = Dir::new("checksum");
    let base = format!("https://models.test:{}", server.port);
    let result = fetch(
        &downloader(),
        &format!("{base}/tampered"),
        &dir.file(),
        b"original!",
        None,
    )
    .await;
    assert!(matches!(result, Err(DownloadError::Checksum)), "{result:?}");
    assert!(!dir.file().exists());
    let result = fetch(
        &downloader(),
        &format!("{base}/large"),
        &dir.file(),
        b"short",
        None,
    )
    .await;
    assert!(matches!(result, Err(DownloadError::TooLarge)), "{result:?}");
    assert!(!dir.file().exists());
}

#[tokio::test]
async fn a_partial_file_resumes_with_range() {
    let content = body();
    let served = content.clone();
    let server = serve(Box::new(move |seen, _| {
        let from: usize = seen
            .range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|r| r.parse().ok())?;
        let rest = &served[from..];
        let mut out = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            served.len() - 1,
            served.len(),
            rest.len()
        )
        .into_bytes();
        out.extend_from_slice(rest);
        Some(out)
    }))
    .await;
    let dir = Dir::new("resume");
    std::fs::create_dir_all(dir.file().parent().unwrap()).unwrap();
    std::fs::write(dir.file(), &content[..1_000_000]).unwrap();
    let url = format!("https://models.test:{}/m", server.port);
    let progress = fetch(&downloader(), &url, &dir.file(), &content, None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(dir.file()).unwrap(), content);
    assert_eq!(progress.first(), Some(&1_000_000));
    assert_eq!(
        server.seen.lock().unwrap()[0].range.as_deref(),
        Some("bytes=1000000-")
    );
}

#[tokio::test]
async fn cancelling_stops_a_stalled_download() {
    let server = serve(Box::new(|_, _| None)).await;
    let dir = Dir::new("cancel");
    let url = format!("https://models.test:{}/m", server.port);
    let cancel = CancellationToken::new();
    let job = DownloadJob {
        url: &url,
        dest: &dir.file(),
        size: 10,
        sha256: &sha256(b"0123456789"),
        allows_host: &models_hosts,
        proxy: None,
    };
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        canceller.cancel();
    });
    let started = std::time::Instant::now();
    let result = downloader().download(&job, &cancel, &|_| {}).await;
    assert!(
        matches!(result, Err(DownloadError::Cancelled)),
        "{result:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// An HTTP proxy answering `CONNECT` with `status`; on 200 it tunnels to the local server.
async fn proxy(status: u16, upstream: u16) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let Some(head) = read_head(&mut client).await else {
                    return;
                };
                log.lock()
                    .unwrap()
                    .push(head.lines().next().unwrap_or_default().to_owned());
                let reason = if status == 200 {
                    "Connection established"
                } else {
                    "Refused"
                };
                let _ = client
                    .write_all(format!("HTTP/1.1 {status} {reason}\r\n\r\n").as_bytes())
                    .await;
                if status == 200 {
                    let mut server = TcpStream::connect(("127.0.0.1", upstream)).await.unwrap();
                    pipe(&mut client, &mut server).await;
                }
            });
        }
    });
    (port, requests)
}

async fn pipe(
    a: &mut (impl AsyncRead + AsyncWrite + Unpin),
    b: &mut (impl AsyncRead + AsyncWrite + Unpin),
) {
    let _ = tokio::io::copy_bidirectional(a, b).await;
}

#[tokio::test]
async fn the_proxy_carries_the_download_through_connect() {
    let content = body();
    let served = content.clone();
    let server = serve(Box::new(move |_, _| Some(ok(&served)))).await;
    let (port, requests) = proxy(200, server.port).await;
    let dir = Dir::new("proxy");
    // No name resolves and no local address is admitted: only the proxy can reach the server.
    let behind_proxy = Downloader::with_parts(Names::loopback(&[]), tls(), Allowlist::default());
    let url = format!("https://models.test:{}/m", server.port);
    fetch(
        &behind_proxy,
        &url,
        &dir.file(),
        &content,
        Some(&format!("http://127.0.0.1:{port}")),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dir.file()).unwrap(), content);
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        [format!("CONNECT models.test:{} HTTP/1.1", server.port)]
    );
}

#[tokio::test]
async fn a_proxy_refusal_is_reported() {
    let (port, _) = proxy(407, 1).await;
    let dir = Dir::new("proxy refused");
    let result = fetch(
        &downloader(),
        "https://models.test:443/m",
        &dir.file(),
        b"x",
        Some(&format!("http://127.0.0.1:{port}")),
    )
    .await;
    assert!(
        matches!(result, Err(DownloadError::Proxy(407))),
        "{result:?}"
    );
    assert_eq!(result.unwrap_err().code(), "proxy");
}
