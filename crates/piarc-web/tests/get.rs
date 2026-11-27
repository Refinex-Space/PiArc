//! `Getter` (ADR-0102): small HTTPS answers read into memory over the download connection —
//! allowed hosts on every hop, a body bound, the proxy through `CONNECT` with no direct
//! connection, status codes with `Retry-After`, encodings refused, the overall timeout and
//! cancellation.

use std::time::{Duration, Instant};

use piarc_web::Allowlist;
use piarc_web::get::{GetError, GetJob, Getter};
use tokio_util::sync::CancellationToken;

mod support;
use support::{Names, ok, proxy, redirect, serve, tls};

fn getter() -> Getter {
    Getter::with_parts(
        Names::loopback(&["models.test", "cdn.models.test", "other.test"]),
        tls(),
        Allowlist::new(&["127.0.0.1".to_owned()]).unwrap(),
    )
}

fn models(host: &str) -> bool {
    host == "models.test" || host == "cdn.models.test"
}

async fn get(
    getter: &Getter,
    url: &str,
    max: usize,
    proxy: Option<&str>,
) -> Result<Vec<u8>, GetError> {
    getter
        .get(
            &GetJob {
                url,
                allows_host: &models,
                proxy,
                max_bytes: max,
                accept: "application/json",
                timeout: Duration::from_secs(10),
            },
            &CancellationToken::new(),
        )
        .await
        .map(|b| b.to_vec())
}

fn response(head: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "{head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

#[tokio::test]
async fn an_answer_arrives_and_asks_for_no_encoding() {
    let server = serve(Box::new(|_, _| Some(ok(br#"{"ok":true}"#)))).await;
    let url = format!("https://models.test:{}/-/v1/search?text=a", server.port);
    let body = get(&getter(), &url, 1024, None).await.unwrap();
    assert_eq!(body, br#"{"ok":true}"#);
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen[0].path, "/-/v1/search?text=a");
}

#[tokio::test]
async fn redirects_stay_on_allowed_hosts() {
    let server = serve(Box::new(|seen, port| {
        Some(match seen.path.as_str() {
            "/a" => redirect(&format!("https://cdn.models.test:{port}/b")),
            "/b" => ok(b"b"),
            _ => redirect(&format!("https://other.test:{port}/c")),
        })
    }))
    .await;
    let base = format!("https://models.test:{}", server.port);
    assert_eq!(
        get(&getter(), &format!("{base}/a"), 16, None)
            .await
            .unwrap(),
        b"b"
    );
    let off = get(&getter(), &format!("{base}/x"), 16, None).await;
    assert!(matches!(off, Err(GetError::Refused("host"))), "{off:?}");
    assert!(matches!(
        get(
            &getter(),
            &format!("http://models.test:{}/a", server.port),
            16,
            None
        )
        .await,
        Err(GetError::Refused("not https"))
    ));
}

#[tokio::test]
async fn bodies_over_the_bound_are_refused() {
    let server = serve(Box::new(|seen, _| {
        Some(if seen.path == "/declared" {
            ok(&[b'x'; 64])
        } else {
            // No length header: the body itself is counted.
            let mut out = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
            out.extend_from_slice(&[b'y'; 64]);
            out
        })
    }))
    .await;
    let base = format!("https://models.test:{}", server.port);
    for path in ["/declared", "/streamed"] {
        let result = get(&getter(), &format!("{base}{path}"), 32, None).await;
        assert!(
            matches!(result, Err(GetError::TooLarge(32))),
            "{path}: {result:?}"
        );
    }
}

#[tokio::test]
async fn statuses_carry_retry_after_and_encodings_are_refused() {
    let server = serve(Box::new(|seen, _| {
        Some(match seen.path.as_str() {
            "/busy" => response("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7", b""),
            "/gone" => response("HTTP/1.1 404 Not Found", b""),
            _ => response("HTTP/1.1 200 OK\r\nContent-Encoding: gzip", b"\x1f\x8b"),
        })
    }))
    .await;
    let base = format!("https://models.test:{}", server.port);
    let busy = get(&getter(), &format!("{base}/busy"), 64, None)
        .await
        .unwrap_err();
    assert!(busy.retryable());
    assert_eq!(busy.retry_after(), Some(Duration::from_secs(7)));
    let gone = get(&getter(), &format!("{base}/gone"), 64, None)
        .await
        .unwrap_err();
    assert_eq!(gone.code(), "notFound");
    assert!(!gone.retryable());
    let gzip = get(&getter(), &format!("{base}/gz"), 64, None)
        .await
        .unwrap_err();
    assert!(matches!(gzip, GetError::Encoding(_)), "{gzip:?}");
}

#[tokio::test]
async fn a_direct_connection_to_a_local_address_is_refused() {
    let server = serve(Box::new(|_, _| Some(ok(b"x")))).await;
    let strict = Getter::with_parts(
        Names::loopback(&["models.test"]),
        tls(),
        Allowlist::default(),
    );
    let result = get(
        &strict,
        &format!("https://models.test:{}/", server.port),
        8,
        None,
    )
    .await;
    assert!(matches!(result, Err(GetError::Blocked)), "{result:?}");
}

#[tokio::test]
async fn the_proxy_carries_every_request_and_its_failure_is_not_a_direct_connection() {
    let server = serve(Box::new(|_, _| Some(ok(b"via proxy")))).await;
    let (port, requests) = proxy(200, server.port).await;
    // No name resolves and no local address is admitted: only the proxy can reach the server.
    let behind = Getter::with_parts(Names::loopback(&[]), tls(), Allowlist::default());
    let url = format!("https://models.test:{}/p", server.port);
    let via = format!("http://127.0.0.1:{port}");
    assert_eq!(
        get(&behind, &url, 64, Some(&via)).await.unwrap(),
        b"via proxy"
    );
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        [format!("CONNECT models.test:{} HTTP/1.1", server.port)]
    );
    let (refusing, _) = proxy(407, 1).await;
    let refused = get(
        &getter(),
        &url,
        64,
        Some(&format!("http://127.0.0.1:{refusing}")),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code(), "proxy");
    assert!(!refused.retryable());
    assert_eq!(server.seen.lock().unwrap().len(), 1, "no direct request");
}

#[tokio::test]
async fn the_whole_request_times_out_and_cancels() {
    // `None`: the server holds the connection open without answering.
    let server = serve(Box::new(|_, _| None)).await;
    let url = format!("https://models.test:{}/slow", server.port);
    let started = Instant::now();
    let timed_out = getter()
        .get(
            &GetJob {
                url: &url,
                allows_host: &models,
                proxy: None,
                max_bytes: 8,
                accept: "*/*",
                timeout: Duration::from_millis(300),
            },
            &CancellationToken::new(),
        )
        .await;
    assert!(matches!(timed_out, Err(GetError::Timeout)), "{timed_out:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.cancel();
    });
    let cancelled = getter()
        .get(
            &GetJob {
                url: &url,
                allows_host: &models,
                proxy: None,
                max_bytes: 8,
                accept: "*/*",
                timeout: Duration::from_secs(10),
            },
            &cancel,
        )
        .await;
    assert!(
        matches!(cancelled, Err(GetError::Cancelled)),
        "{cancelled:?}"
    );
}
