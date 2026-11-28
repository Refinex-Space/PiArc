//! A local OAuth token endpoint for the credential tests: `POST /token` with JSON
//! `{ grantType: "authorization_code", code }` or `{ grantType: "refresh_token", refreshToken }`.
//!
//! Refresh tokens rotate: each refresh returns a new pair and invalidates the old refresh token,
//! so a second refresh with the same token fails as a real provider's would. Token values are
//! random per server; tests use them as the needles of the plaintext scan. Every token has a
//! non-secret label (`gen-1`, `gen-2`, ...) that requests carry as `x-piarc-test-token`.

use std::collections::hash_map::RandomState;
use std::convert::Infallible;
use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// One issued token pair.
#[derive(Debug, Clone)]
pub struct Issued {
    pub access: String,
    pub refresh: String,
    pub label: String,
}

#[derive(Debug, Default)]
struct State {
    seed: String,
    code: String,
    issued: Vec<Issued>,
    /// `(grant type, accepted)` per request, in arrival order.
    calls: Vec<(String, bool)>,
}

pub struct TokenServer {
    pub url: String,
    pub code: String,
    /// How long the first token stays valid: below pi-ai's five-minute refresh window, so the
    /// first request refreshes it.
    pub first_validity: Duration,
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

fn random_hex() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    format!(
        "{:016x}{:016x}",
        hasher.finish(),
        RandomState::new().build_hasher().finish()
    )
}

impl TokenServer {
    /// Starts the server; refreshes take `refresh_delay`, which widens the window in which
    /// concurrent requests would refresh twice without the lock.
    pub async fn start(refresh_delay: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/token", listener.local_addr().expect("address"));
        let code = format!("piarc-t08-code-{}", random_hex());
        let state = Arc::new(Mutex::new(State {
            seed: random_hex(),
            code: code.clone(),
            ..State::default()
        }));
        let first_validity = Duration::from_secs(120);
        let shared = Arc::clone(&state);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let state = Arc::clone(&shared);
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        answer(Arc::clone(&state), request, refresh_delay, first_validity)
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self {
            url,
            code,
            first_validity,
            state,
            task,
        }
    }

    pub fn issued(&self) -> Vec<Issued> {
        self.state.lock().expect("lock").issued.clone()
    }

    pub fn calls(&self) -> Vec<(String, bool)> {
        self.state.lock().expect("lock").calls.clone()
    }
}

impl Drop for TokenServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn answer(
    state: Arc<Mutex<State>>,
    request: hyper::Request<Incoming>,
    refresh_delay: Duration,
    first_validity: Duration,
) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
    let body = request
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let grant = request["grantType"].as_str().unwrap_or_default().to_owned();
    if grant == "refresh_token" {
        tokio::time::sleep(refresh_delay).await;
    }
    let mut state = state.lock().expect("lock");
    let accepted = match grant.as_str() {
        "authorization_code" => request["code"] == state.code.as_str(),
        "refresh_token" => state
            .issued
            .last()
            .is_some_and(|last| request["refreshToken"] == last.refresh.as_str()),
        _ => false,
    };
    state.calls.push((grant, accepted));
    if !accepted {
        let response = hyper::Response::builder()
            .status(400)
            .body(Full::new(Bytes::from_static(
                br#"{"error":"invalid_grant"}"#,
            )))
            .expect("response");
        return Ok(response);
    }
    let generation = state.issued.len() + 1;
    let issued = Issued {
        access: format!("piarc-t08-access-{}-{generation}", state.seed),
        refresh: format!("piarc-t08-refresh-{}-{generation}", state.seed),
        label: format!("gen-{generation}"),
    };
    state.issued.push(issued.clone());
    let validity = if generation == 1 {
        first_validity
    } else {
        Duration::from_secs(3600)
    };
    let token = json!({
        "accessToken": issued.access,
        "refreshToken": issued.refresh,
        "expiresInMs": u64::try_from(validity.as_millis()).expect("fits"),
        "label": issued.label,
    });
    Ok(hyper::Response::new(Full::new(Bytes::from(
        token.to_string(),
    ))))
}
