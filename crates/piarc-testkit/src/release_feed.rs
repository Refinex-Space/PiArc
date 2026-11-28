//! A mock of GitHub's release downloads over HTTPS (ADR-0111): in-app update tests and L4 point
//! Core's update feed at it. Files come from a directory laid out `<dir>/<version>/<name>`.
//!
//! Routes, like GitHub's (`<releases>` is `https://localhost:<port>/releases`):
//! `/releases/latest/download/<name>` redirects to `/releases/download/v<latest>/<name>`, which
//! redirects to `https://127.0.0.1:<port>/assets/<version>/<name>` (another host, as GitHub's
//! `release-assets.githubusercontent.com`), which serves the file (`Range: bytes=N-` honoured).
//! Unknown paths answer 404.
//!
//! Controls (tests call them directly; the `piarc-mock-releases` binary reads them from
//! stdin): `latest <version>`, `offline` / `online`, `status <path prefix> <code>`,
//! `slow <bytes per 50 ms>` (0: at once), `requests`.

use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt as _, Full};
use hyper::body::{Body, Bytes, Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

/// The feed's host (the server certificate covers it); it must resolve to loopback.
pub const FEED_HOST: &str = "localhost";
/// The assets' host.
pub const ASSET_HOST: &str = "127.0.0.1";

#[derive(Default)]
struct Controls {
    latest: String,
    offline: bool,
    status: Vec<(String, u16)>,
    slow: usize,
}

struct State {
    dir: PathBuf,
    port: u16,
    asset_host: String,
    controls: Mutex<Controls>,
    requests: Mutex<Vec<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The running mock; dropping it stops the server.
pub struct MockReleases {
    state: Arc<State>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockReleases {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockReleases {
    /// Serves `dir` on `127.0.0.1:<port>` (0: a free port) with `latest` as the latest release.
    ///
    /// # Errors
    ///
    /// The port cannot be bound or the certificate does not load.
    pub async fn start(dir: &Path, latest: &str, port: u16) -> std::io::Result<Self> {
        Self::start_with_asset_host(dir, latest, port, ASSET_HOST).await
    }

    /// Like [`start`](Self::start), with downloads redirected to `asset_host` (a name the
    /// certificate covers): tests that route both hosts through a proxy use a non-loopback one.
    ///
    /// # Errors
    ///
    /// The port cannot be bound or the certificate does not load.
    pub async fn start_with_asset_host(
        dir: &Path,
        latest: &str,
        port: u16,
        asset_host: &str,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(State {
            dir: dir.to_path_buf(),
            port,
            asset_host: asset_host.to_owned(),
            controls: Mutex::new(Controls {
                latest: latest.to_owned(),
                ..Controls::default()
            }),
            requests: Mutex::default(),
        });
        let acceptor = tokio_rustls::TlsAcceptor::from(crate::npm_registry::server_tls()?);
        let task = tokio::spawn(accept(listener, acceptor, Arc::clone(&state)));
        Ok(Self { state, task })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.state.port
    }

    /// `https://localhost:<port>/releases`: the feed Core is pointed at.
    #[must_use]
    pub fn releases(&self) -> String {
        format!("https://{FEED_HOST}:{}/releases", self.state.port)
    }

    /// Request paths in arrival order.
    #[must_use]
    pub fn requests(&self) -> Vec<String> {
        lock(&self.state.requests).clone()
    }

    /// Applies one control line; answers `requests` as JSON, others with `ok`.
    ///
    /// # Errors
    ///
    /// An unknown or malformed control.
    pub fn control(&self, line: &str) -> Result<String, String> {
        let mut words = line.split_whitespace();
        let mut controls = lock(&self.state.controls);
        match (words.next(), words.next(), words.next()) {
            (Some("latest"), Some(version), None) => controls.latest = version.to_owned(),
            (Some("offline"), None, None) => controls.offline = true,
            (Some("online"), None, None) => controls.offline = false,
            (Some("status"), Some(prefix), Some(code)) => {
                let code = code.parse().map_err(|_| format!("bad status {code:?}"))?;
                controls.status.push((prefix.to_owned(), code));
            }
            (Some("slow"), Some(bytes), None) => {
                controls.slow = bytes.parse().map_err(|_| format!("bad size {bytes:?}"))?;
            }
            (Some("requests"), None, None) => {
                drop(controls);
                return serde_json::to_string(&self.requests()).map_err(|e| e.to_string());
            }
            _ => return Err(format!("unknown control {line:?}")),
        }
        Ok("ok".to_owned())
    }
}

async fn accept(listener: TcpListener, acceptor: tokio_rustls::TlsAcceptor, state: Arc<State>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let (acceptor, state) = (acceptor.clone(), Arc::clone(&state));
        tokio::spawn(async move {
            if lock(&state.controls).offline {
                return;
            }
            let Ok(tls) = acceptor.accept(tcp).await else {
                return;
            };
            let service = service_fn(move |request| handle(Arc::clone(&state), request));
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(tls), service)
                .await;
        });
    }
}

type Reply = Response<BoxBody<Bytes, Infallible>>;

fn status(code: StatusCode) -> Reply {
    Response::builder()
        .status(code)
        .body(Full::new(Bytes::new()).boxed())
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new()).boxed()))
}

fn redirect(location: &str) -> Reply {
    Response::builder()
        .status(StatusCode::FOUND)
        .header("location", location)
        .body(Full::new(Bytes::new()).boxed())
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

fn plain_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

async fn handle(state: Arc<State>, request: Request<Incoming>) -> Result<Reply, Infallible> {
    let path = request.uri().path().to_owned();
    lock(&state.requests).push(path.clone());
    let (code, latest, slow) = {
        let c = lock(&state.controls);
        let code = c
            .status
            .iter()
            .find(|(prefix, _)| path.starts_with(prefix.as_str()))
            .map(|(_, code)| *code);
        (code, c.latest.clone(), c.slow)
    };
    if let Some(code) = code {
        return Ok(status(
            StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        ));
    }
    if let Some(name) = path.strip_prefix("/releases/latest/download/") {
        if latest.is_empty() || !plain_name(name) {
            return Ok(status(StatusCode::NOT_FOUND));
        }
        return Ok(redirect(&format!("/releases/download/v{latest}/{name}")));
    }
    if let Some(rest) = path.strip_prefix("/releases/download/v")
        && let Some((version, name)) = rest.split_once('/')
        && plain_name(version)
        && plain_name(name)
    {
        return Ok(redirect(&format!(
            "https://{}:{}/assets/{version}/{name}",
            state.asset_host, state.port
        )));
    }
    if let Some(rest) = path.strip_prefix("/assets/")
        && let Some((version, name)) = rest.split_once('/')
        && plain_name(version)
        && plain_name(name)
    {
        let Ok(bytes) = tokio::fs::read(state.dir.join(version).join(name)).await else {
            return Ok(status(StatusCode::NOT_FOUND));
        };
        let from = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes="))
            .and_then(|v| v.strip_suffix('-'))
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|from| *from < bytes.len());
        return Ok(file_reply(Bytes::from(bytes), from, slow));
    }
    Ok(status(StatusCode::NOT_FOUND))
}

fn file_reply(bytes: Bytes, from: Option<usize>, slow: usize) -> Reply {
    let total = bytes.len();
    let (code, body) = match from {
        Some(from) => (StatusCode::PARTIAL_CONTENT, bytes.slice(from..)),
        None => (StatusCode::OK, bytes),
    };
    let mut builder = Response::builder()
        .status(code)
        .header("content-type", "application/octet-stream")
        .header("content-length", body.len());
    if let Some(from) = from {
        builder = builder.header(
            "content-range",
            format!("bytes {from}-{}/{total}", total.saturating_sub(1)),
        );
    }
    let body = if slow == 0 {
        Full::new(body).boxed()
    } else {
        SlowBody::new(body, slow).boxed()
    };
    builder
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// A body that sends `chunk` bytes every 50 ms (L4 sees download progress).
struct SlowBody {
    data: Bytes,
    chunk: usize,
    sleep: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl SlowBody {
    fn new(data: Bytes, chunk: usize) -> Self {
        Self {
            data,
            chunk,
            sleep: None,
        }
    }
}

impl Body for SlowBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if self.data.is_empty() {
            return Poll::Ready(None);
        }
        if let Some(sleep) = self.sleep.as_mut()
            && sleep.as_mut().poll(cx).is_pending()
        {
            return Poll::Pending;
        }
        self.sleep = Some(Box::pin(tokio::time::sleep(Duration::from_millis(50))));
        let take = self.chunk.min(self.data.len());
        let piece = self.data.split_to(take);
        Poll::Ready(Some(Ok(Frame::data(piece))))
    }
}
