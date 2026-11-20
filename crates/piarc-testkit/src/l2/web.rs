//! The local web server of WebFetch scenarios (T29): serves the scenario's `web.pages` on
//! `127.0.0.1`. `{{web}}` in page bodies, redirect targets and the endpoints' tool call
//! arguments becomes `http://127.0.0.1:<port>`, `{{web_alt}}` the same server under the host name
//! `localhost` (another host for permission rules and redirects). Core reaches it through
//! WebFetch's allowlist, which the runner sets for these scenarios only.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::Value;
use tokio::net::TcpListener;

/// One page of the scenario's web server.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebPage {
    /// The HTTP status; 200 when absent.
    #[serde(default = "ok")]
    pub status: u16,
    /// `Content-Type`; `text/html; charset=utf-8` when absent.
    #[serde(default)]
    pub content_type: Option<String>,
    /// The body.
    #[serde(default)]
    pub body: String,
    /// `body` repeated this many times (a page over a limit).
    #[serde(default)]
    pub repeat: Option<usize>,
    /// `Location` of a redirect.
    #[serde(default)]
    pub location: Option<String>,
}

fn ok() -> u16 {
    200
}

/// The scenario's web server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebSpec {
    /// Pages by path (with a leading `/`).
    pub pages: BTreeMap<String, WebPage>,
}

/// A running server; stops when dropped.
pub struct WebServer {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for WebServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `text` with the server's placeholders filled in.
#[must_use]
pub fn fill(text: &str, port: u16) -> String {
    text.replace("{{web}}", &format!("http://127.0.0.1:{port}"))
        .replace("{{web_alt}}", &format!("http://localhost:{port}"))
}

/// Fills the placeholders in every string of `value`.
pub fn fill_value(value: &mut Value, port: u16) {
    match value {
        Value::String(s) => *s = fill(s, port),
        Value::Array(items) => items.iter_mut().for_each(|v| fill_value(v, port)),
        Value::Object(map) => map.values_mut().for_each(|v| fill_value(v, port)),
        _ => {}
    }
}

fn respond(page: Option<&WebPage>, port: u16) -> hyper::Response<Full<Bytes>> {
    let Some(page) = page else {
        return hyper::Response::builder()
            .status(404)
            .body(Full::new(Bytes::from_static(b"not found")))
            .unwrap_or_default();
    };
    let body = fill(&page.body, port).repeat(page.repeat.unwrap_or(1));
    let mut response = hyper::Response::builder().status(page.status).header(
        "content-type",
        page.content_type
            .as_deref()
            .unwrap_or("text/html; charset=utf-8"),
    );
    if let Some(location) = &page.location {
        response = response.header("location", fill(location, port));
    }
    response
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_default()
}

/// Starts the server for `spec`.
///
/// # Errors
///
/// No port could be bound.
pub async fn start(spec: &WebSpec) -> std::io::Result<WebServer> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let pages = Arc::new(spec.pages.clone());
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let pages = Arc::clone(&pages);
            tokio::spawn(async move {
                let service = service_fn(move |request: hyper::Request<Incoming>| {
                    let page = pages.get(request.uri().path()).cloned();
                    async move { Ok::<_, Infallible>(respond(page.as_ref(), port)) }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(WebServer { port, task })
}
