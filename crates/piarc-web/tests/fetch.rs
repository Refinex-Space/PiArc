//! Fetches against a local HTTP server: conversion, redirects, limits, and the address checks
//! with a resolver that maps test names to chosen addresses (T29-A03, A04).
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_web::{Allowlist, Blocked, FetchError, FetchLimits, Fetcher, Format, Outcome, Resolve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Answers each name with the next address list in its queue (the last one repeats).
#[derive(Default)]
struct Names(Mutex<HashMap<String, Vec<Vec<IpAddr>>>>);

impl Names {
    fn with(entries: &[(&str, &[&[&str]])]) -> Arc<Self> {
        let names = Self::default();
        for (name, answers) in entries {
            let answers = answers
                .iter()
                .map(|list| list.iter().map(|a| a.parse().unwrap()).collect())
                .collect();
            names.0.lock().unwrap().insert((*name).to_owned(), answers);
        }
        Arc::new(names)
    }
}

impl Resolve for Names {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        _port: u16,
    ) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>> {
        let mut names = self.0.lock().unwrap();
        let answer = names.get_mut(host).map(|queue| {
            if queue.len() > 1 {
                queue.remove(0)
            } else {
                queue[0].clone()
            }
        });
        Box::pin(async move {
            answer.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown test name"))
        })
    }
}

type Route = Box<dyn Fn(&str, u16) -> Option<Vec<u8>> + Send + Sync>;

/// A one-request-per-connection HTTP/1.1 server; `route(path, port)` gives the raw response,
/// `None` holds the connection open without answering.
async fn serve(route: Route) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let route = Arc::new(route);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let route = route.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut buf = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    head.extend_from_slice(&buf[..n]);
                }
                let text = String::from_utf8_lossy(&head);
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                match route(&path, port) {
                    Some(response) => {
                        let _ = stream.write_all(&response).await;
                        let _ = stream.shutdown().await;
                    }
                    None => tokio::time::sleep(Duration::from_secs(30)).await,
                }
            });
        }
    });
    port
}

fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

const PAGE: &str = "<html><body><h1>Local page</h1><p>Hello <em>there</em>.</p></body></html>";

fn site() -> Route {
    Box::new(|path, port| {
        Some(match path {
            "/page" => response("200 OK", &[("content-type", "text/html")], PAGE.as_bytes()),
            "/same" => response("302 Found", &[("location", "/page")], b""),
            "/loop" => response("302 Found", &[("location", "/loop")], b""),
            "/cross" => response(
                "301 Moved Permanently",
                &[("location", &format!("http://other.test:{port}/page"))],
                b"",
            ),
            "/rebind" => response(
                "302 Found",
                &[("location", &format!("http://rebind.test:{port}/page"))],
                b"",
            ),
            "/big" => response(
                "200 OK",
                &[("content-type", "text/plain")],
                &vec![b'a'; 4096],
            ),
            "/long" => response(
                "200 OK",
                &[("content-type", "text/plain")],
                "字".repeat(300).as_bytes(),
            ),
            "/gzip" => response("200 OK", &[("content-encoding", "gzip")], b"\x1f\x8b"),
            "/png" => response("200 OK", &[("content-type", "image/png")], b"\x89PNG"),
            "/missing" => response(
                "404 Not Found",
                &[("content-type", "text/plain")],
                b"no such page",
            ),
            "/slow" => return None,
            _ => response("500 Internal Server Error", &[], b""),
        })
    })
}

fn tls() -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth(),
    )
}

fn fetcher(names: Arc<Names>, allow: &[&str], limits: FetchLimits) -> Fetcher {
    let allow = Allowlist::new(&allow.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).unwrap();
    Fetcher::with_parts(limits, allow, names, tls())
}

fn local(allow: &[&str]) -> Fetcher {
    fetcher(
        Names::with(&[
            ("site.test", &[&["127.0.0.1"]]),
            ("other.test", &[&["127.0.0.1"]]),
        ]),
        allow,
        FetchLimits::default(),
    )
}

async fn get(f: &Fetcher, url: &str) -> Result<Outcome, FetchError> {
    f.fetch(url, &CancellationToken::new()).await
}

fn content(outcome: Outcome) -> piarc_web::Fetched {
    match outcome {
        Outcome::Content(c) => c,
        Outcome::Redirect { to, .. } => panic!("unexpected redirect to {to}"),
    }
}

#[tokio::test]
async fn fetches_and_converts_through_the_allowlist() {
    let port = serve(site()).await;
    let f = local(&["127.0.0.1"]);
    let page = content(
        get(&f, &format!("http://site.test:{port}/page"))
            .await
            .unwrap(),
    );
    assert_eq!(page.status, 200);
    assert_eq!(page.content.format, Format::Markdown);
    assert!(
        page.content.text.contains("# Local page"),
        "{}",
        page.content.text
    );
    assert!(page.content.text.contains("_there_") || page.content.text.contains("*there*"));
    let missing = content(
        get(&f, &format!("http://127.0.0.1:{port}/missing"))
            .await
            .unwrap(),
    );
    assert_eq!(
        (missing.status, missing.content.text.as_str()),
        (404, "no such page")
    );
}

#[tokio::test]
async fn internal_addresses_are_refused_without_the_allowlist() {
    let port = serve(site()).await;
    let f = local(&[]);
    for url in [
        format!("http://127.0.0.1:{port}/page"),
        format!("http://[::1]:{port}/page"),
        format!("http://[::ffff:127.0.0.1]:{port}/page"),
        format!("http://site.test:{port}/page"),
        "http://10.0.0.1/".to_owned(),
        "http://169.254.169.254/latest/meta-data/".to_owned(),
        "http://0.0.0.0/".to_owned(),
        "http://[fe80::1]/".to_owned(),
        "http://[fd00::1]/".to_owned(),
    ] {
        let error = get(&f, &url).await.unwrap_err();
        assert!(
            matches!(error, FetchError::Blocked { .. }),
            "{url}: {error}"
        );
        assert_eq!(
            error.to_error_object().data.details.unwrap()["reason"],
            "blockedAddress"
        );
    }
    // A name with one internal address among public ones is refused as a whole.
    let mixed = fetcher(
        Names::with(&[("mixed.test", &[&["93.184.215.14", "192.168.1.20"]])]),
        &[],
        FetchLimits::default(),
    );
    let error = get(&mixed, "http://mixed.test/").await.unwrap_err();
    assert!(
        matches!(
            error,
            FetchError::Blocked {
                why: Blocked::Private,
                ..
            }
        ),
        "{error}"
    );
}

#[tokio::test]
async fn every_redirect_is_checked_again() {
    let port = serve(site()).await;
    // rebind.test answers loopback (allowlisted) first and a private address on the next
    // lookup: the same-site hop must resolve and check again.
    let names = Names::with(&[
        ("site.test", &[&["127.0.0.1"]]),
        ("rebind.test", &[&["127.0.0.1"], &["10.9.9.9"]]),
    ]);
    let f = fetcher(names, &["127.0.0.1"], FetchLimits::default());
    let error = get(&f, &format!("http://rebind.test:{port}/rebind"))
        .await
        .unwrap_err();
    assert!(
        matches!(&error, FetchError::Blocked { ip, .. } if ip.to_string() == "10.9.9.9"),
        "{error}"
    );
}

#[tokio::test]
async fn same_site_redirects_are_followed_and_cross_site_ones_returned() {
    let port = serve(site()).await;
    let f = local(&["127.0.0.1"]);
    let page = content(
        get(&f, &format!("http://site.test:{port}/same"))
            .await
            .unwrap(),
    );
    assert_eq!(page.url, format!("http://site.test:{port}/page"));
    match get(&f, &format!("http://site.test:{port}/cross"))
        .await
        .unwrap()
    {
        Outcome::Redirect { from, to, status } => {
            assert_eq!(from, format!("http://site.test:{port}/cross"));
            assert_eq!(to, format!("http://other.test:{port}/page"));
            assert_eq!(status, 301);
        }
        Outcome::Content(c) => panic!("followed a cross-site redirect to {}", c.url),
    }
    let error = get(&f, &format!("http://site.test:{port}/loop"))
        .await
        .unwrap_err();
    assert!(matches!(error, FetchError::TooManyRedirects(10)), "{error}");
}

#[tokio::test]
async fn limits_cut_or_stop_with_clear_errors() {
    let port = serve(site()).await;
    let names = Names::with(&[("site.test", &[&["127.0.0.1"]])]);
    let limits = FetchLimits {
        max_body_bytes: 1000,
        max_content_chars: 100,
        timeout: Duration::from_millis(500),
        max_redirects: 10,
    };
    let f = fetcher(names, &["127.0.0.1"], limits);
    let big = content(
        get(&f, &format!("http://site.test:{port}/big"))
            .await
            .unwrap(),
    );
    assert!(big.body_truncated && big.bytes == 1000);
    let long = content(
        get(&f, &format!("http://site.test:{port}/long"))
            .await
            .unwrap(),
    );
    assert!(long.content.truncated && long.content.text.chars().count() == 100);
    assert_eq!(long.content.total_chars, 300);
    let error = get(&f, &format!("http://site.test:{port}/slow"))
        .await
        .unwrap_err();
    assert!(matches!(error, FetchError::Timeout(_)), "{error}");
    assert!(error.to_string().contains("did not finish"));
    let error = get(&f, &format!("http://site.test:{port}/gzip"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, FetchError::UnsupportedEncoding(_)),
        "{error}"
    );
    let error = get(&f, &format!("http://site.test:{port}/png"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, FetchError::UnsupportedContent(_)),
        "{error}"
    );
}

#[tokio::test]
async fn invalid_targets_and_cancellation() {
    let port = serve(site()).await;
    let f = local(&["127.0.0.1"]);
    for url in [
        "file:///etc/passwd",
        "ftp://site.test/",
        "http://user:pw@site.test/",
        "not a url",
    ] {
        assert!(
            matches!(get(&f, url).await, Err(FetchError::InvalidUrl(_))),
            "{url}"
        );
    }
    let cancel = CancellationToken::new();
    let url = format!("http://site.test:{port}/slow");
    let slow = f.fetch(&url, &cancel);
    cancel.cancel();
    assert!(matches!(slow.await, Err(FetchError::Cancelled)));
    assert_eq!(
        piarc_web::rule_host("HTTPS://Docs.Example.COM:8443/a?b#c").as_deref(),
        Some("docs.example.com")
    );
    assert_eq!(
        piarc_web::rule_host("http://[::1]:80/").as_deref(),
        Some("[::1]")
    );
    assert_eq!(piarc_web::rule_host("http://a@b.test/"), None);
}
