//! A Streamable HTTP MCP server with its own OAuth authorization server (T36), written by hand
//! against the specifications (MCP 2025-11-25 "Transports" and "Authorization", RFC 9728,
//! RFC 8414, RFC 7591, RFC 7636, RFC 6749), independent of pi-mcp's client.
//!
//! - `POST /mcp`: JSON-RPC requests answered with `application/json` (`initialize`,
//!   `tools/list`, `tools/call`, `ping`); notifications get 202. `GET /mcp` is 405 (no
//!   server stream). With OAuth, a request without a valid bearer token gets 401 and
//!   `WWW-Authenticate: Bearer resource_metadata="…"`.
//! - `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728) and
//!   `GET /.well-known/oauth-authorization-server` (RFC 8414).
//! - `POST /register` (dynamic client registration), `GET /authorize` (authorization code with
//!   PKCE S256; approve redirects with `code` and `iss`, deny with `error=access_denied`),
//!   `POST /token` (form: `authorization_code` checks the verifier against the challenge,
//!   `refresh_token` rotates).
//!
//! Tools: `echo` (`text`) answers `<name> echoes "<text>" (token <label>)` with the label of
//! the access token used (`gen-<n>`), `whoami`. Token values are random per server: tests use
//! them as the needles of the plaintext scan.

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
use sha2::{Digest as _, Sha256};
use tokio::net::TcpListener;

use crate::auth_server::AuthBehavior;

#[derive(Debug, Clone)]
struct Code {
    code: String,
    challenge: String,
    redirect_uri: String,
    client_id: String,
}

#[derive(Debug, Clone)]
struct Token {
    access: String,
    refresh: String,
    label: String,
    /// The access token is accepted.
    live: bool,
    /// The refresh token can be used once.
    refreshable: bool,
}

#[derive(Debug)]
struct State {
    name: String,
    oauth: bool,
    behavior: AuthBehavior,
    seed: String,
    clients: Vec<(String, Vec<String>)>,
    codes: Vec<Code>,
    tokens: Vec<Token>,
    expires_in: u64,
    /// JSON-RPC methods received, with the token label that authorized them.
    calls: Vec<(String, Option<String>)>,
}

/// A running HTTP MCP fixture server on `127.0.0.1`.
pub struct MockMcpServer {
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

/// Base64url without padding (RFC 7636's `BASE64URL-ENCODE`).
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            let index = (n >> (18 - 6 * i)) & 0x3f;
            out.push(char::from(ALPHABET[index as usize]));
        }
    }
    out
}

impl MockMcpServer {
    /// Starts server `name` on a free port; `oauth` protects `/mcp` with bearer tokens.
    ///
    /// # Errors
    ///
    /// The port cannot be bound.
    pub async fn start(name: &str, oauth: bool) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(Mutex::new(State {
            name: name.to_owned(),
            oauth,
            behavior: AuthBehavior::Approve,
            seed: random_hex(),
            clients: Vec::new(),
            codes: Vec::new(),
            tokens: Vec::new(),
            expires_in: 3_600,
            calls: Vec::new(),
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

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The MCP endpoint, `http://127.0.0.1:<port>/mcp`.
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    /// How the user answers the next authorization page.
    pub fn set_behavior(&self, behavior: AuthBehavior) {
        self.lock().behavior = behavior;
    }

    /// The access tokens issued from now on expire after `seconds` (`expires_in`).
    pub fn set_expires_in(&self, seconds: u64) {
        self.lock().expires_in = seconds;
    }

    /// Stops accepting the current access tokens; their refresh tokens still work.
    pub fn expire_access(&self) {
        for token in &mut self.lock().tokens {
            token.live = false;
        }
    }

    /// Revokes every token: the user has to sign in again.
    pub fn revoke_all(&self) {
        for token in &mut self.lock().tokens {
            token.live = false;
            token.refreshable = false;
        }
    }

    /// Every access and refresh token issued.
    #[must_use]
    pub fn issued(&self) -> Vec<String> {
        self.lock()
            .tokens
            .iter()
            .flat_map(|t| [t.access.clone(), t.refresh.clone()])
            .collect()
    }

    /// The JSON-RPC methods received with the label of the token that authorized each.
    #[must_use]
    pub fn calls(&self) -> Vec<(String, Option<String>)> {
        self.lock().calls.clone()
    }
}

impl Drop for MockMcpServer {
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

fn empty(status: u16) -> hyper::Response<Full<Bytes>> {
    hyper::Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .unwrap_or_default()
}

fn redirect(location: &str) -> hyper::Response<Full<Bytes>> {
    hyper::Response::builder()
        .status(302)
        .header("location", location)
        .body(Full::new(Bytes::new()))
        .unwrap_or_default()
}

/// `application/x-www-form-urlencoded` or a query string.
fn form(text: &str) -> Vec<(String, String)> {
    text.split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
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

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn issue(state: &mut State) -> Value {
    let generation = state.tokens.len() + 1;
    let token = Token {
        access: format!("piarc-t36-access-{}-{generation}", state.seed),
        refresh: format!("piarc-t36-refresh-{}-{generation}", state.seed),
        label: format!("gen-{generation}"),
        live: true,
        refreshable: true,
    };
    let body = json!({
        "access_token": token.access,
        "token_type": "Bearer",
        "expires_in": state.expires_in,
        "refresh_token": token.refresh,
    });
    state.tokens.push(token);
    body
}

fn token(state: &mut State, body: &[u8]) -> hyper::Response<Full<Bytes>> {
    let fields = form(&String::from_utf8_lossy(body));
    let refused = |error: &str| respond(400, &json!({ "error": error }));
    match field(&fields, "grant_type") {
        Some("authorization_code") => {
            let code = field(&fields, "code").unwrap_or_default();
            let Some(i) = state.codes.iter().position(|c| c.code == code) else {
                return refused("invalid_grant");
            };
            let grant = state.codes.remove(i);
            let verifier = field(&fields, "code_verifier").unwrap_or_default();
            let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
            if challenge != grant.challenge
                || field(&fields, "redirect_uri") != Some(grant.redirect_uri.as_str())
                || field(&fields, "client_id") != Some(grant.client_id.as_str())
            {
                return refused("invalid_grant");
            }
            respond(200, &issue(state))
        }
        Some("refresh_token") => {
            let given = field(&fields, "refresh_token").unwrap_or_default();
            let Some(old) = state
                .tokens
                .iter_mut()
                .find(|t| t.refresh == given && t.refreshable)
            else {
                return refused("invalid_grant");
            };
            // Rotation: the refresh token works once.
            old.refreshable = false;
            old.live = false;
            respond(200, &issue(state))
        }
        _ => refused("unsupported_grant_type"),
    }
}

fn authorize(state: &mut State, port: u16, uri: &hyper::Uri) -> hyper::Response<Full<Bytes>> {
    let fields = form(uri.query().unwrap_or_default());
    let get = |name: &str| field(&fields, name).map(str::to_owned);
    let (Some(client), Some(target), Some(given), Some(challenge)) = (
        get("client_id"),
        get("redirect_uri"),
        get("state"),
        get("code_challenge"),
    ) else {
        return respond(400, &json!({ "error": "invalid_request" }));
    };
    let registered = state
        .clients
        .iter()
        .any(|(id, uris)| id == &client && uris.contains(&target));
    if !registered
        || get("code_challenge_method").as_deref() != Some("S256")
        || get("response_type").as_deref() != Some("code")
    {
        return respond(400, &json!({ "error": "invalid_request" }));
    }
    let issuer = percent_encode(&format!("http://127.0.0.1:{port}"));
    let joiner = if target.contains('?') { '&' } else { '?' };
    let given = percent_encode(&given);
    if state.behavior == AuthBehavior::Deny {
        return redirect(&format!(
            "{target}{joiner}error=access_denied&state={given}&iss={issuer}"
        ));
    }
    let code = format!("piarc-t36-code-{}", random_hex());
    state.codes.push(Code {
        code: code.clone(),
        challenge,
        redirect_uri: target.clone(),
        client_id: client,
    });
    redirect(&format!(
        "{target}{joiner}code={code}&state={given}&iss={issuer}"
    ))
}

fn metadata(port: u16, path: &str) -> Option<Value> {
    let base = format!("http://127.0.0.1:{port}");
    match path {
        "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp" => {
            Some(json!({
                "resource": format!("{base}/mcp"),
                "authorization_servers": [base],
                "bearer_methods_supported": ["header"],
            }))
        }
        "/.well-known/oauth-authorization-server" => Some(json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "authorization_response_iss_parameter_supported": true,
        })),
        _ => None,
    }
}

fn register(state: &mut State, body: &[u8]) -> hyper::Response<Full<Bytes>> {
    let request: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let uris: Vec<String> = request["redirect_uris"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_str().map(str::to_owned))
        .collect();
    if uris.is_empty() {
        return respond(400, &json!({ "error": "invalid_redirect_uri" }));
    }
    let id = format!("piarc-t36-client-{}", state.clients.len() + 1);
    state.clients.push((id.clone(), uris.clone()));
    let mut answer = request;
    answer["client_id"] = json!(id);
    answer["redirect_uris"] = json!(uris);
    answer["token_endpoint_auth_method"] = json!("none");
    respond(201, &answer)
}

/// The label of a live token in `authorization`, if any.
fn bearer(state: &State, authorization: Option<&str>) -> Option<String> {
    let token = authorization?.strip_prefix("Bearer ")?;
    state
        .tokens
        .iter()
        .find(|t| t.access == token && t.live)
        .map(|t| t.label.clone())
}

fn rpc(state: &mut State, message: &Value, label: Option<&str>) -> Option<Value> {
    let id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match message["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-11-25"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": state.name, "version": "0.0.0" },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [
            { "name": "echo", "description": format!("Echoes text back from {}.", state.name),
              "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } },
            { "name": "whoami", "description": format!("Names {}.", state.name),
              "inputSchema": { "type": "object", "properties": {} } },
        ]}),
        "tools/call" => {
            let text = params["arguments"]["text"].as_str().unwrap_or_default();
            let who = label.map_or_else(String::new, |l| format!(" (token {l})"));
            let reply = match params["name"].as_str() {
                Some("whoami") => format!("{}{who}", state.name),
                _ => format!("{} echoes \"{text}\"{who}", state.name),
            };
            json!({ "content": [{ "type": "text", "text": reply }] })
        }
        method => {
            return Some(json!({ "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") } }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn mcp(
    state: &mut State,
    port: u16,
    authorization: Option<&str>,
    body: &[u8],
) -> hyper::Response<Full<Bytes>> {
    let label = bearer(state, authorization);
    if state.oauth && label.is_none() {
        let error = if authorization.is_some() {
            ", error=\"invalid_token\""
        } else {
            ""
        };
        return hyper::Response::builder()
            .status(401)
            .header(
                "www-authenticate",
                format!(
                    "Bearer resource_metadata=\"http://127.0.0.1:{port}/.well-known/oauth-protected-resource/mcp\"{error}"
                ),
            )
            .body(Full::new(Bytes::new()))
            .unwrap_or_default();
    }
    let message: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if let Some(method) = message["method"].as_str() {
        state.calls.push((method.to_owned(), label.clone()));
    }
    match rpc(state, &message, label.as_deref()) {
        Some(reply) => hyper::Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("mcp-session-id", "piarc-t36-session")
            .body(Full::new(Bytes::from(reply.to_string())))
            .unwrap_or_default(),
        // A notification or a response: accepted.
        None => empty(202),
    }
}

async fn answer(
    state: Arc<Mutex<State>>,
    port: u16,
    request: hyper::Request<Incoming>,
) -> Result<hyper::Response<Full<Bytes>>, Infallible> {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = request
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
    let path = uri.path();
    let response = match (method.as_str(), path) {
        ("POST", "/mcp") => mcp(&mut state, port, authorization.as_deref(), &body),
        ("GET", "/mcp") => empty(405),
        ("DELETE", "/mcp") => empty(200),
        ("POST", "/register") => register(&mut state, &body),
        ("GET", "/authorize") => authorize(&mut state, port, &uri),
        ("POST", "/token") => token(&mut state, &body),
        ("GET", _) => metadata(port, path).map_or_else(
            || respond(404, &json!({ "error": "not_found" })),
            |m| respond(200, &m),
        ),
        _ => respond(404, &json!({ "error": "not_found" })),
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::{base64url, form};

    #[test]
    fn pkce_challenges_use_base64url_without_padding() {
        // RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let digest = <sha2::Sha256 as sha2::Digest>::digest(verifier.as_bytes());
        assert_eq!(
            base64url(&digest),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
    }

    #[test]
    fn forms_decode_their_values() {
        assert_eq!(
            form("a=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&s=x+y"),
            [
                ("a".to_owned(), "1".to_owned()),
                (
                    "redirect_uri".to_owned(),
                    "http://127.0.0.1:5/cb".to_owned()
                ),
                ("s".to_owned(), "x y".to_owned())
            ]
        );
    }
}
