//! Test servers shared by the HTTPS client tests: an HTTPS server with a test CA
//! (`fixtures/tls/`), a resolver mapping test names to loopback, and a `CONNECT` proxy.

#![allow(dead_code, reason = "each test file uses part of the helpers")]

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_web::Resolve;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CA: &[u8] = include_bytes!("../fixtures/tls/ca.test.crt");
const SERVER_CERT: &[u8] = include_bytes!("../fixtures/tls/server.test.crt");
const SERVER_KEY: &[u8] = include_bytes!("../fixtures/tls/server.test.key");

/// Test names → loopback; anything else is unknown.
pub struct Names(HashMap<String, IpAddr>);

impl Names {
    pub fn loopback(names: &[&str]) -> Arc<Self> {
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
pub struct Seen {
    pub path: String,
    pub host: String,
    pub range: Option<String>,
}

pub type Route = Box<dyn Fn(&Seen, u16) -> Option<Vec<u8>> + Send + Sync>;

pub struct Server {
    pub port: u16,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

/// An HTTPS server for `models.test`, `cdn.models.test` and `other.test`: one request per
/// connection, `route` gives the raw response (`None` holds the connection open).
pub async fn serve(route: Route) -> Server {
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

pub async fn read_head(stream: &mut (impl AsyncRead + Unpin)) -> Option<String> {
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

pub fn parse(head: &str) -> Seen {
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

pub fn ok(body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

pub fn redirect(to: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn tls() -> Arc<rustls::ClientConfig> {
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

/// An HTTP proxy answering `CONNECT` with `status`; on 200 it tunnels to the local server.
pub async fn proxy(status: u16, upstream: u16) -> (u16, Arc<Mutex<Vec<String>>>) {
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

pub async fn pipe(
    a: &mut (impl AsyncRead + AsyncWrite + Unpin),
    b: &mut (impl AsyncRead + AsyncWrite + Unpin),
) {
    let _ = tokio::io::copy_bidirectional(a, b).await;
}
