//! Shared helpers for the integration tests: a minimal HTTP/1.1 client that keeps partial
//! bodies, and SSE parsing.

#![allow(
    dead_code,
    reason = "each test binary uses a different subset of the helpers"
)]

use std::net::SocketAddr;

use http_body_util::BodyExt as _;
use hyper::body::Bytes;
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use piarc_testkit::{Scenario, ScenarioLibrary, Script};
use serde_json::Value;
use tokio::net::TcpStream;

/// A response as the client saw it.
pub struct Reply {
    pub status: u16,
    pub headers: hyper::HeaderMap,
    /// Every body byte received before the end or the failure.
    pub body: String,
    /// Set when the body ended with a transport error instead of a clean end.
    pub body_error: Option<String>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("the body is JSON")
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

/// Sends one request on a fresh connection and reads the whole body, keeping whatever
/// arrived before a disconnect.
pub async fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Reply {
    let stream = TcpStream::connect(address)
        .await
        .expect("connect to the mock");
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .expect("HTTP handshake");
    // The connection future ends with an error when the server drops the connection;
    // the body stream below reports that to the test.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut request = hyper::Request::builder()
        .method(method)
        .uri(path)
        .header("host", address.to_string())
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request
        .body(http_body_util::Full::new(Bytes::from(body.to_owned())))
        .expect("a valid request");
    let response = sender.send_request(request).await.expect("a response head");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let mut incoming = response.into_body();
    let mut bytes = Vec::new();
    let mut body_error = None;
    while let Some(frame) = incoming.frame().await {
        match frame {
            Ok(frame) => {
                if let Some(data) = frame.data_ref() {
                    bytes.extend_from_slice(data);
                }
            }
            Err(error) => {
                body_error = Some(error.to_string());
                break;
            }
        }
    }
    Reply {
        status,
        headers,
        body: String::from_utf8(bytes).expect("the body is UTF-8"),
        body_error,
    }
}

/// POST to `path` with an optional scenario header.
pub async fn post(address: SocketAddr, path: &str, scenario: Option<&str>, body: &Value) -> Reply {
    let headers: Vec<(&str, &str)> = scenario
        .map(|selector| vec![("x-piarc-scenario", selector)])
        .unwrap_or_default();
    send(address, "POST", path, &headers, &body.to_string()).await
}

/// One server-sent event.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub name: Option<String>,
    pub data: String,
}

impl Event {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.data).expect("event data is JSON")
    }
}

/// Parses complete SSE events (blocks ending in a blank line).
pub fn parse_sse(body: &str) -> Vec<Event> {
    body.split("\n\n")
        .filter(|block| !block.is_empty())
        .map(|block| {
            let mut event = Event {
                name: None,
                data: String::new(),
            };
            for line in block.lines() {
                if let Some(name) = line.strip_prefix("event: ") {
                    event.name = Some(name.to_owned());
                } else if let Some(data) = line.strip_prefix("data: ") {
                    event.data.push_str(data);
                }
            }
            event
        })
        .collect()
}

/// Builds a library from inline YAML scenarios.
pub fn library(yaml_scenarios: &[&str]) -> ScenarioLibrary {
    let mut library = ScenarioLibrary::new();
    for (index, yaml) in yaml_scenarios.iter().enumerate() {
        let scenario = Scenario::from_yaml_str(&format!("inline-{index}"), yaml)
            .expect("the inline scenario is valid");
        library.insert(scenario).expect("ids are unique");
    }
    library
}

/// A script from inline YAML (`validation` and `steps`).
pub fn script(yaml: &str) -> Script {
    serde_saphyr::from_str(yaml).expect("the inline script is valid")
}
