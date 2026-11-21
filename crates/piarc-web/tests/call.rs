//! `Fetcher::call` against a local server: method, headers and body arrive; a configured
//! address may be loopback, a public one may not; no redirect is followed; the body bound
//! holds (T38, ADR-0055).
use std::sync::Arc;

use piarc_web::{Allowlist, Call, FetchError, FetchLimits, Fetcher, Method, Reach, SystemResolver};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Answers one request per connection with `status` and a body echoing the request.
async fn echo(status: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() < end + 4 + length {
                        continue;
                    }
                    let body = text.replace("\r\n", "\n");
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nLocation: /elsewhere\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
            });
        }
    });
    port
}

fn fetcher(max_body: usize) -> (Fetcher, usize) {
    let limits = FetchLimits::default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth(),
    );
    (
        Fetcher::with_parts(
            limits,
            Allowlist::new(&[]).unwrap(),
            Arc::new(SystemResolver),
            tls,
        ),
        max_body,
    )
}

fn post(port: u16, max_body_bytes: usize) -> Call {
    Call {
        method: Method::Post,
        url: format!("http://127.0.0.1:{port}/hook?x=1"),
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("X-Token".into(), "t-1".into()),
        ],
        body: br#"{"hook_event_name":"Stop"}"#.to_vec(),
        max_body_bytes,
    }
}

#[tokio::test]
async fn configured_addresses_get_the_request_as_written() {
    let port = echo("200 OK").await;
    let (fetcher, max) = fetcher(64 * 1024);
    let reply = fetcher
        .call(
            &post(port, max),
            Reach::Configured,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    let echoed = String::from_utf8_lossy(&reply.body).to_lowercase();
    assert!(echoed.starts_with("post /hook?x=1 http/1.1"), "{echoed}");
    assert!(echoed.contains("x-token: t-1"));
    assert!(echoed.contains("content-type: application/json"));
    assert!(echoed.contains("accept-encoding: identity"));
    assert!(echoed.ends_with(r#"{"hook_event_name":"stop"}"#));
    assert!(!reply.truncated);
}

#[tokio::test]
async fn public_reach_refuses_loopback_and_redirects_are_returned() {
    let port = echo("302 Found").await;
    let (fetcher, max) = fetcher(64 * 1024);
    let refused = fetcher
        .call(&post(port, max), Reach::Public, &CancellationToken::new())
        .await;
    assert!(
        matches!(refused, Err(FetchError::Blocked { .. })),
        "{refused:?}"
    );
    let redirect = fetcher
        .call(
            &post(port, max),
            Reach::Configured,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(redirect.status, 302);
}

#[tokio::test]
async fn the_body_bound_cuts_the_response() {
    let port = echo("200 OK").await;
    let (fetcher, _) = fetcher(0);
    let reply = fetcher
        .call(
            &post(port, 16),
            Reach::Configured,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.body.len(), 16);
    assert!(reply.truncated);
}
