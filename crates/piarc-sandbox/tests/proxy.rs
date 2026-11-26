//! The sandbox network proxy against a local upstream, with an injected resolver: no external
//! network (T11-A04, T11-A06).
//!
//! Names resolve to documentation addresses (203.0.113.0/24); the test network connects those
//! to the local upstream servers, so the proxy's loopback check sees public addresses while
//! the bytes stay on this machine.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use piarc_ports::BoxFuture;
use piarc_sandbox::proxy::{
    Allowlist, BrowserPolicy, DENIED_HEADER, DenyReason, Network, NetworkProxy, ProxyHooks,
    ProxyLimits, Refused,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The documentation address standing in for the HTTP upstream.
const HTTP_IP: [u8; 4] = [203, 0, 113, 10];
/// The documentation address standing in for the echo (tunnel) upstream.
const ECHO_IP: [u8; 4] = [203, 0, 113, 20];

struct TestNetwork {
    names: HashMap<&'static str, IpAddr>,
    /// Address → local port that really serves it.
    routes: HashMap<IpAddr, u16>,
}

impl Network for TestNetwork {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> BoxFuture<'a, io::Result<Vec<SocketAddr>>> {
        Box::pin(async move {
            let ip = match host.parse::<IpAddr>() {
                Ok(ip) => ip,
                Err(_) => *self
                    .names
                    .get(host)
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown host"))?,
            };
            Ok(vec![SocketAddr::new(ip, port)])
        })
    }

    fn connect(&self, addr: SocketAddr) -> BoxFuture<'_, io::Result<TcpStream>> {
        let port = self.routes.get(&addr.ip()).copied();
        Box::pin(async move {
            let port = port.ok_or_else(|| {
                io::Error::new(io::ErrorKind::ConnectionRefused, "no route in the test")
            })?;
            TcpStream::connect(("127.0.0.1", port)).await
        })
    }
}

/// An HTTP server answering `<method> <target> host=<Host>`.
async fn http_upstream() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.expect("accepts");
            tokio::spawn(async move {
                let service = hyper::service::service_fn(|request: hyper::Request<_>| async move {
                    let host = request
                        .headers()
                        .get(hyper::header::HOST)
                        .and_then(|h| h.to_str().ok())
                        .unwrap_or("-")
                        .to_owned();
                    let text = format!("{} {} host={host}", request.method(), request.uri());
                    Ok::<_, Infallible>(hyper::Response::new(Full::new(Bytes::from(text))))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    port
}

/// A TCP server that echoes what it reads.
async fn echo_upstream() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.expect("accepts");
            tokio::spawn(async move {
                let (mut read, mut write) = stream.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    port
}

async fn proxy(allow: &[&str]) -> NetworkProxy {
    proxy_with(allow, None, ProxyLimits::default()).await
}

async fn proxy_with(
    allow: &[&str],
    hooks: Option<Arc<dyn ProxyHooks>>,
    limits: ProxyLimits,
) -> NetworkProxy {
    let http = http_upstream().await;
    let echo = echo_upstream().await;
    let names = HashMap::from([
        ("registry.npmjs.org", IpAddr::from(HTTP_IP)),
        ("api.github.com", IpAddr::from(HTTP_IP)),
        ("github.com", IpAddr::from(HTTP_IP)),
        ("evil.test", IpAddr::from(HTTP_IP)),
        ("tunnel.example.org", IpAddr::from(ECHO_IP)),
        ("deep.tunnel.example.org", IpAddr::from(ECHO_IP)),
        ("localhost.example.org", IpAddr::from([127, 0, 0, 1])),
        ("metadata.example.org", IpAddr::from([169, 254, 169, 254])),
        ("v6-loopback.example.org", "::1".parse().expect("ip")),
    ]);
    let routes = HashMap::from([(IpAddr::from(HTTP_IP), http), (IpAddr::from(ECHO_IP), echo)]);
    let allowlist = Allowlist::new(allow).expect("valid allowlist");
    let network = Arc::new(TestNetwork { names, routes });
    match hooks {
        Some(hooks) => NetworkProxy::start_with(allowlist, network, hooks, limits).await,
        None => NetworkProxy::start(allowlist, network).await,
    }
    .expect("proxy starts")
}

/// Answers unlisted hosts from a list and records what it was asked and told.
#[derive(Default)]
struct Recorder {
    allow: Vec<&'static str>,
    asked: std::sync::Mutex<Vec<String>>,
    refused: std::sync::Mutex<Vec<Refused>>,
}

impl ProxyHooks for Recorder {
    fn unlisted<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a, bool> {
        self.asked
            .lock()
            .expect("asked")
            .push(format!("{host}:{port}"));
        let allowed = self.allow.contains(&host);
        Box::pin(async move { allowed })
    }

    fn refused(&self, refused: &Refused) {
        self.refused.lock().expect("refused").push(refused.clone());
    }
}

/// A response's status line, headers (lower-case names) and body.
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Reads one response head from `stream`; returns it and the bytes read past it.
async fn read_head(stream: &mut TcpStream) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let mut data = Vec::new();
    let mut buf = [0_u8; 4096];
    let end = loop {
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        let n = stream.read(&mut buf).await.expect("reads");
        assert!(n > 0, "connection closed in the head: {data:?}");
        data.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8_lossy(&data[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    (status, headers, data[end + 4..].to_vec())
}

/// Sends a plain HTTP request through the proxy (`Connection: close`) and reads the reply.
async fn http_get(proxy: &NetworkProxy, url: &str, host: &str) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .expect("connects to the proxy");
    let request = format!("GET {url} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("writes");
    let (status, headers, mut body) = read_head(&mut stream).await;
    stream.read_to_end(&mut body).await.expect("reads the body");
    Reply {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// Opens a `CONNECT` tunnel; on success echoes a line through it.
async fn connect(proxy: &NetworkProxy, authority: &str) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .expect("connects to the proxy");
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("writes");
    let (status, headers, rest) = read_head(&mut stream).await;
    let body = if status == 200 {
        assert!(rest.is_empty());
        stream
            .write_all(b"ping through the tunnel\n")
            .await
            .expect("writes");
        let mut echoed = vec![0_u8; 24];
        stream.read_exact(&mut echoed).await.expect("echo");
        String::from_utf8_lossy(&echoed).into_owned()
    } else {
        let length: usize = headers
            .iter()
            .find(|(n, _)| n == "content-length")
            .and_then(|(_, v)| v.parse().ok())
            .expect("a refusal has a length");
        let mut body = rest;
        while body.len() < length {
            let mut buf = [0_u8; 1024];
            let n = stream.read(&mut buf).await.expect("reads");
            assert!(n > 0);
            body.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&body).into_owned()
    };
    Reply {
        status,
        headers,
        body,
    }
}

#[tokio::test]
async fn http_to_an_exact_entry_is_forwarded_in_origin_form() {
    let proxy = proxy(&["registry.npmjs.org"]).await;
    let reply = http_get(
        &proxy,
        "http://registry.npmjs.org/left-pad?x=1",
        "registry.npmjs.org",
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, "GET /left-pad?x=1 host=registry.npmjs.org");
}

#[tokio::test]
async fn http_to_a_wildcard_subdomain_is_forwarded() {
    let proxy = proxy(&["*.github.com"]).await;
    let reply = http_get(&proxy, "http://api.github.com/repos", "api.github.com").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, "GET /repos host=api.github.com");
}

#[tokio::test]
async fn http_outside_the_allowlist_is_refused_with_a_reason() {
    let proxy = proxy(&["*.github.com", "registry.npmjs.org"]).await;
    for (url, host) in [
        ("http://evil.test/steal", "evil.test"),
        // A wildcard does not cover the bare domain.
        ("http://github.com/", "github.com"),
    ] {
        let reply = http_get(&proxy, url, host).await;
        assert_eq!(reply.status, 403, "{url}");
        assert_eq!(reply.header(DENIED_HEADER), Some("not-allowed"), "{url}");
        assert_eq!(
            reply.body,
            format!("PiArc sandbox proxy: {host} is not in the sandbox network allowlist\n")
        );
    }
}

#[tokio::test]
async fn connect_to_an_exact_entry_tunnels_bytes() {
    let proxy = proxy(&["tunnel.example.org"]).await;
    let reply = connect(&proxy, "tunnel.example.org:443").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, "ping through the tunnel\n");
}

#[tokio::test]
async fn connect_to_a_wildcard_subdomain_tunnels_bytes() {
    let proxy = proxy(&["*.example.org"]).await;
    let reply = connect(&proxy, "deep.tunnel.example.org:443").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, "ping through the tunnel\n");
}

#[tokio::test]
async fn connect_outside_the_allowlist_is_refused_with_a_reason() {
    let proxy = proxy(&["registry.npmjs.org"]).await;
    let reply = connect(&proxy, "tunnel.example.org:443").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.header(DENIED_HEADER), Some("not-allowed"));
    assert_eq!(
        reply.body,
        "PiArc sandbox proxy: tunnel.example.org is not in the sandbox network allowlist\n"
    );
}

#[tokio::test]
async fn names_resolving_to_loopback_or_metadata_are_refused() {
    let proxy = proxy(&["*.example.org", "127.0.0.1", "169.254.169.254"]).await;
    let cases = [
        ("localhost.example.org", "127.0.0.1", "loopback address"),
        ("v6-loopback.example.org", "::1", "loopback address"),
        (
            "metadata.example.org",
            "169.254.169.254",
            "link-local address (cloud metadata)",
        ),
        // Allowed IP literals are checked the same way.
        ("127.0.0.1", "127.0.0.1", "loopback address"),
        (
            "169.254.169.254",
            "169.254.169.254",
            "link-local address (cloud metadata)",
        ),
    ];
    for (host, ip, reason) in cases {
        let expected = format!("PiArc sandbox proxy: {host} resolves to {ip}, a {reason}\n");
        let reply = connect(&proxy, &format!("{host}:443")).await;
        assert_eq!(reply.status, 403, "CONNECT {host}");
        assert_eq!(reply.header(DENIED_HEADER), Some("blocked-address"));
        assert_eq!(reply.body, expected);
        let reply = http_get(&proxy, &format!("http://{host}/latest/meta-data/"), host).await;
        assert_eq!(reply.status, 403, "GET {host}");
        assert_eq!(reply.header(DENIED_HEADER), Some("blocked-address"));
        assert_eq!(reply.body, expected);
    }
}

#[tokio::test]
async fn requests_that_are_not_proxy_requests_are_rejected() {
    let proxy = proxy(&["registry.npmjs.org"]).await;
    let reply = http_get(&proxy, "/origin-form", "registry.npmjs.org").await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.header(DENIED_HEADER), None);
}

#[tokio::test]
async fn dropping_the_proxy_closes_its_port() {
    let proxy = proxy(&[]).await;
    let port = proxy.port();
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());
    drop(proxy);
    // The accept loop notices the cancellation on its next poll.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
        assert!(std::time::Instant::now() < deadline, "still listening");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// T39-A05: a changed allowlist applies to the next connection of the running proxy.
#[tokio::test]
async fn a_new_allowlist_applies_to_the_next_connection() {
    let proxy = proxy(&["registry.npmjs.org"]).await;
    let reply = http_get(&proxy, "http://evil.test/", "evil.test").await;
    assert_eq!(reply.status, 403);
    proxy.set_allowlist(Allowlist::new(["evil.test"]).expect("valid"));
    let reply = http_get(&proxy, "http://evil.test/", "evil.test").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let reply = http_get(&proxy, "http://registry.npmjs.org/", "registry.npmjs.org").await;
    assert_eq!(reply.status, 403, "the old entry is gone");
}

/// T39-A14 (proxy side): a host outside the allowlist is put to the hooks; their answer
/// decides that one connection, and every refusal is reported.
#[tokio::test]
async fn unlisted_hosts_are_asked_about_and_refusals_reported() {
    let hooks = Arc::new(Recorder {
        allow: vec!["tunnel.example.org", "localhost.example.org"],
        ..Recorder::default()
    });
    let proxy = proxy_with(
        &["registry.npmjs.org"],
        Some(hooks.clone()),
        ProxyLimits::default(),
    )
    .await;
    let reply = connect(&proxy, "tunnel.example.org:443").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let reply = http_get(&proxy, "http://evil.test/x", "evil.test").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.header(DENIED_HEADER), Some("not-allowed"));
    let reply = http_get(&proxy, "http://registry.npmjs.org/", "registry.npmjs.org").await;
    assert_eq!(reply.status, 200, "listed hosts are not asked about");
    let reply = connect(&proxy, "localhost.example.org:443").await;
    assert_eq!(
        reply.status, 403,
        "an allowed name still may not reach loopback"
    );
    assert_eq!(
        *hooks.asked.lock().expect("asked"),
        [
            "tunnel.example.org:443",
            "evil.test:80",
            "localhost.example.org:443"
        ]
    );
    let refused: Vec<(String, u16, DenyReason)> = hooks
        .refused
        .lock()
        .expect("refused")
        .iter()
        .map(|r| (r.host.clone(), r.port, r.reason))
        .collect();
    assert_eq!(
        refused,
        [
            ("evil.test".to_owned(), 80, DenyReason::NotAllowed),
            (
                "localhost.example.org".to_owned(),
                443,
                DenyReason::BlockedAddress
            ),
        ]
    );
}

/// R1 I54: a forwarded request carries its target's host, not the one the client wrote.
#[tokio::test]
async fn a_forwarded_request_carries_the_targets_host() {
    let proxy = proxy(&["registry.npmjs.org"]).await;
    let reply = http_get(&proxy, "http://registry.npmjs.org/a", "evil.test").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(reply.body, "GET /a host=registry.npmjs.org");
}

/// R1 I54: a tunnel without traffic is closed after the idle limit.
#[tokio::test]
async fn an_idle_tunnel_is_closed() {
    let limits = ProxyLimits {
        idle_timeout: std::time::Duration::from_millis(300),
        ..ProxyLimits::default()
    };
    let proxy = proxy_with(
        &["tunnel.example.org"],
        Some(Arc::new(Recorder::default())),
        limits,
    )
    .await;
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .expect("connects");
    stream
        .write_all(
            b"CONNECT tunnel.example.org:443 HTTP/1.1\r\nHost: tunnel.example.org:443\r\n\r\n",
        )
        .await
        .expect("writes");
    let (status, _, _) = read_head(&mut stream).await;
    assert_eq!(status, 200);
    let mut buf = [0_u8; 16];
    let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf))
        .await
        .expect("the tunnel closes before the safety net");
    assert_eq!(read.expect("reads"), 0, "closed without data");
}

/// R1 I54: a client that never finishes its request head is disconnected.
#[tokio::test]
async fn a_slow_request_head_is_cut_off() {
    let limits = ProxyLimits {
        header_timeout: std::time::Duration::from_millis(300),
        ..ProxyLimits::default()
    };
    let proxy = proxy_with(&[], Some(Arc::new(Recorder::default())), limits).await;
    let mut stream = TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .expect("connects");
    stream
        .write_all(b"GET http://evil.test/ HTTP/1.1\r\n")
        .await
        .expect("writes");
    let mut rest = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut rest),
    )
    .await
    .expect("the proxy closes before the safety net")
    .expect("reads");
}

/// A browser partition's proxy (ADR-0088): names resolve as listed, loopback and private
/// addresses are served by the local HTTP upstream.
async fn browser_proxy(denied_ports: Vec<u16>) -> NetworkProxy {
    let http = http_upstream().await;
    let loopback = IpAddr::from([127, 0, 0, 1]);
    let private = IpAddr::from([10, 0, 0, 5]);
    let names = HashMap::from([
        ("docs.example", IpAddr::from(HTTP_IP)),
        ("wiki.corp", private),
        ("nas.test", private),
        ("app.test", loopback),
        ("web.localhost", loopback),
        ("rebind.example", loopback),
        ("metadata.example", IpAddr::from([169, 254, 169, 254])),
    ]);
    let routes = HashMap::from([
        (IpAddr::from(HTTP_IP), http),
        (loopback, http),
        (private, http),
    ]);
    let policy = BrowserPolicy {
        local_names: Allowlist::new(["*.test"]).expect("valid"),
        denied_ports,
    };
    NetworkProxy::start_browser(
        policy,
        Arc::new(TestNetwork { names, routes }),
        Arc::new(Recorder::default()),
        ProxyLimits::default(),
    )
    .await
    .expect("proxy starts")
}

#[tokio::test]
async fn thr16_a_browser_proxy_lets_public_names_through_and_private_ones_only_when_local() {
    let proxy = browser_proxy(Vec::new()).await;
    for host in ["docs.example", "203.0.113.10", "nas.test"] {
        let reply = http_get(&proxy, &format!("http://{host}/page"), host).await;
        assert_eq!(reply.status, 200, "{host}");
    }
    // A name outside the local development names leading into the LAN is DNS rebinding.
    let reply = http_get(&proxy, "http://wiki.corp/page", "wiki.corp").await;
    assert_eq!(reply.status, 403);
}

#[tokio::test]
async fn thr16_a_browser_proxy_reaches_loopback_only_behind_local_names() {
    let proxy = browser_proxy(Vec::new()).await;
    for host in ["app.test", "web.localhost", "localhost", "127.0.0.1"] {
        let target = if host == "localhost" {
            "127.0.0.1"
        } else {
            host
        };
        let reply = http_get(&proxy, &format!("http://{target}/"), host).await;
        assert_eq!(reply.status, 200, "{host}");
    }
    let reply = http_get(&proxy, "http://rebind.example/", "rebind.example").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.header(DENIED_HEADER), Some("blocked-address"));
    assert!(reply.body.contains("not local"), "{}", reply.body);
    let reply = connect(&proxy, "metadata.example:443").await;
    assert_eq!(reply.status, 403);
    assert_eq!(reply.header(DENIED_HEADER), Some("blocked-address"));
}

#[tokio::test]
async fn thr16_a_browser_proxy_refuses_piarc_ports_and_takes_a_new_policy() {
    let proxy = browser_proxy(vec![4100]).await;
    let reply = connect(&proxy, "app.test:4100").await;
    assert_eq!(reply.status, 403);
    assert!(reply.body.contains("PiArc itself"), "{}", reply.body);
    proxy.set_browser_policy(BrowserPolicy::default());
    let reply = http_get(&proxy, "http://app.test/", "app.test").await;
    assert_eq!(reply.status, 403, "*.test is no longer a local name");
}
