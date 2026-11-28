//! A mock OAuth authorization server (T29): the two sign-in flows of the settings window, for
//! the Agent Host's test OAuth provider (`--test-oauth-provider` with `flow`).
//!
//! - Authorization code: `GET /authorize?redirect_uri=…&state=…` redirects to the loopback
//!   `redirect_uri` with `code` (approve) or `error=access_denied` (deny). Only loopback
//!   `http://127.0.0.1:<port>/…` redirect URIs are accepted.
//! - Device code: `POST /device` returns `{ deviceCode, userCode, verificationUri, intervalMs,
//!   expiresInSeconds }`; `POST /token` with `grantType: "device_code"` answers
//!   `authorization_pending` for the first [`PENDING_POLLS`] polls, then a token (approve),
//!   `access_denied` (deny) or `expired_token` (expire).
//! - `POST /token` with `authorization_code` or `refresh_token` issues tokens as JSON
//!   `{ accessToken, refreshToken, expiresInMs, label }`; refresh tokens rotate.
//!
//! Token values are random per server: tests use them as the needles of the plaintext scan.

use std::collections::hash_map::RandomState;
use std::convert::Infallible;
use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex, PoisonError};

use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// Polls answered `authorization_pending` before the device code flow decides (by default; see
/// [`MockAuthServer::set_pending_polls`]).
pub const PENDING_POLLS: usize = 2;

/// How the server answers the user's decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthBehavior {
    /// The user approves.
    Approve,
    /// The user refuses (`access_denied`).
    Deny,
    /// The device code expires before approval (`expired_token`); the authorization code flow
    /// treats it like approve.
    Expire,
}

impl AuthBehavior {
    /// `approve`, `deny` or `expire`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "approve" => Some(Self::Approve),
            "deny" => Some(Self::Deny),
            "expire" => Some(Self::Expire),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct State {
    behavior: AuthBehavior,
    seed: String,
    codes: Vec<String>,
    device_codes: Vec<String>,
    polls: usize,
    pending_polls: usize,
    /// Access and refresh tokens issued, oldest first.
    issued: Vec<(String, String)>,
}

/// A running mock authorization server on `127.0.0.1`.
pub struct MockAuthServer {
    port: u16,
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

impl MockAuthServer {
    /// Starts the server on `port` (0: a free one).
    ///
    /// # Errors
    ///
    /// The port cannot be bound.
    pub async fn start(behavior: AuthBehavior, port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(Mutex::new(State {
            behavior,
            seed: random_hex(),
            codes: Vec::new(),
            device_codes: Vec::new(),
            polls: 0,
            pending_polls: PENDING_POLLS,
            issued: Vec::new(),
        }));
        let shared = Arc::clone(&state);
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let state = Arc::clone(&shared);
                tokio::spawn(async move {
                    let service =
                        service_fn(move |request| answer(Arc::clone(&state), port, request));
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Ok(Self { port, state, task })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    #[must_use]
    pub fn authorize_url(&self) -> String {
        self.url("/authorize")
    }

    #[must_use]
    pub fn device_url(&self) -> String {
        self.url("/device")
    }

    #[must_use]
    pub fn token_url(&self) -> String {
        self.url("/token")
    }

    /// Every access and refresh token issued so far.
    #[must_use]
    pub fn issued(&self) -> Vec<String> {
        self.lock()
            .issued
            .iter()
            .flat_map(|(a, r)| [a.clone(), r.clone()])
            .collect()
    }

    /// Changes the user's decision for the next sign-in.
    pub fn set_behavior(&self, behavior: AuthBehavior) {
        let mut state = self.lock();
        state.behavior = behavior;
        state.polls = 0;
    }

    /// How many polls of a device code answer `authorization_pending` (100 ms apart) before the
    /// decision: long enough for a person, or a UI test, to see the code.
    pub fn set_pending_polls(&self, polls: usize) {
        self.lock().pending_polls = polls;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for MockAuthServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn respond(status: u16, body: &Value) -> hyper::Response<Full<Bytes>> {
    hyper::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap_or_default()
}

fn redirect(location: &str) -> hyper::Response<Full<Bytes>> {
    hyper::Response::builder()
        .status(302)
        .header("location", location)
        .body(Full::new(Bytes::new()))
        .unwrap_or_default()
}

fn query(uri: &hyper::Uri, name: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn issue(state: &mut State) -> Value {
    let generation = state.issued.len() + 1;
    let access = format!("piarc-t29-access-{}-{generation}", state.seed);
    let refresh = format!("piarc-t29-refresh-{}-{generation}", state.seed);
    state.issued.push((access.clone(), refresh.clone()));
    json!({
        "accessToken": access,
        "refreshToken": refresh,
        "expiresInMs": 3_600_000,
        "label": format!("t29-gen-{generation}"),
    })
}

fn token(state: &mut State, request: &Value) -> hyper::Response<Full<Bytes>> {
    let refused = |error: &str| respond(400, &json!({ "error": error }));
    match request["grantType"].as_str() {
        Some("authorization_code") => {
            let code = request["code"].as_str().unwrap_or_default();
            if let Some(i) = state.codes.iter().position(|c| c == code) {
                state.codes.remove(i);
                respond(200, &issue(state))
            } else {
                refused("invalid_grant")
            }
        }
        Some("device_code") => {
            let code = request["deviceCode"].as_str().unwrap_or_default();
            if !state.device_codes.iter().any(|c| c == code) {
                return refused("invalid_grant");
            }
            if state.polls < state.pending_polls {
                state.polls += 1;
                return refused("authorization_pending");
            }
            state.device_codes.retain(|c| c != code);
            match state.behavior {
                AuthBehavior::Approve => respond(200, &issue(state)),
                AuthBehavior::Deny => refused("access_denied"),
                AuthBehavior::Expire => refused("expired_token"),
            }
        }
        Some("refresh_token") => {
            let current = state.issued.last().map(|(_, r)| r.clone());
            if current.as_deref() == request["refreshToken"].as_str() && current.is_some() {
                respond(200, &issue(state))
            } else {
                refused("invalid_grant")
            }
        }
        _ => refused("unsupported_grant_type"),
    }
}

async fn answer(
    state: Arc<Mutex<State>>,
    port: u16,
    request: hyper::Request<Incoming>,
) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let body = request
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
    let response = match (method.as_str(), uri.path()) {
        ("GET", "/authorize") => {
            let (Some(target), Some(given)) = (query(&uri, "redirect_uri"), query(&uri, "state"))
            else {
                return Ok(respond(400, &json!({ "error": "invalid_request" })));
            };
            if !target.starts_with("http://127.0.0.1:") {
                return Ok(respond(400, &json!({ "error": "invalid_redirect_uri" })));
            }
            if state.behavior == AuthBehavior::Deny {
                redirect(&format!("{target}?error=access_denied&state={given}"))
            } else {
                let code = format!("piarc-t29-code-{}", random_hex());
                state.codes.push(code.clone());
                redirect(&format!("{target}?code={code}&state={given}"))
            }
        }
        ("POST", "/device") => {
            let code = format!("piarc-t29-device-{}", random_hex());
            state.device_codes.push(code.clone());
            state.polls = 0;
            respond(
                200,
                &json!({
                    "deviceCode": code,
                    "userCode": "PIAR-C029",
                    "verificationUri": format!("http://127.0.0.1:{port}/device/verify"),
                    "intervalMs": 100,
                    "expiresInSeconds": 600,
                }),
            )
        }
        ("POST", "/token") => {
            let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            token(&mut state, &request)
        }
        _ => respond(404, &json!({ "error": "not_found" })),
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_query_values() {
        assert_eq!(
            percent_decode("http%3A%2F%2F127.0.0.1%3A5%2Fcallback"),
            "http://127.0.0.1:5/callback"
        );
        assert_eq!(percent_decode("a+b%zz"), "a b%zz");
    }
}
