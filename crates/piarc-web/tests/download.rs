//! Model downloads (ADR-0097) against a local HTTPS server with a test CA
//! (`tests/fixtures/tls/`, `*.test.*`): verified files, redirects only to allowed hosts, the address check
//! on direct connections, the proxy's `CONNECT`, `Range` resume, size and checksum failures,
//! and cancellation.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use piarc_web::Allowlist;
use piarc_web::download::{DownloadError, DownloadJob, Downloader};
use tokio_util::sync::CancellationToken;

mod support;
use support::{Names, ok, proxy, redirect, serve, sha256, tls};

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
