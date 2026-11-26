//! T29-A06, A07: provider sign-in through Core's public API, the settings Host and the mock
//! authorization server. The authorization code flow opens the page "in the browser" (this test
//! follows the redirect to the Agent Host's loopback server), the device code flow polls; refusal,
//! expiry and cancel end with a clear message on `core/login`; tokens reach the vault only.
use std::path::{Path, PathBuf};

use piarc_core::providers::Operation;
use piarc_testkit::auth_server::{AuthBehavior, MockAuthServer};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::support::{Env, Events, answer, reply, shutdown};

pub(super) const PROVIDER: &str = "piarc-test-oauth";

/// The `--test-oauth-provider` file for `flow`.
pub(super) fn provider_file(env: &Env, auth: &MockAuthServer, flow: &str) -> PathBuf {
    let path = env.root.join(format!("oauth-{flow}.json"));
    let config = json!({
        "id": PROVIDER,
        "baseUrl": env.mock.openai_base_url(),
        "tokenUrl": auth.token_url(),
        "authorizeUrl": auth.authorize_url(),
        "deviceUrl": auth.device_url(),
        "flow": flow,
        "models": [{ "id": "oauth-model", "contextWindow": 32_000, "maxTokens": 1024 }],
    });
    std::fs::write(&path, config.to_string()).expect("provider file");
    path
}

pub(super) fn start(env: &Env, file: &Path) -> (piarc_core::CoreRuntime, std::sync::Arc<Events>) {
    let file = file.to_string_lossy().into_owned();
    env.start(env.config(&["--test-oauth-provider", &file]))
}

pub(super) async fn list(core: &piarc_core::CoreRuntime) -> Value {
    let (done, rx) = reply();
    core.provider_op(Operation::List, done).expect("queued");
    answer(rx).await.expect("settings")
}

fn signed_in(view: &Value) -> Option<bool> {
    view["loginProviders"]
        .as_array()?
        .iter()
        .find(|p| p["id"] == PROVIDER)?["signedIn"]
        .as_bool()
}

/// The sign-in's last `core/login` event with `state`.
async fn login_event(events: &Events, state: &str) -> Value {
    events
        .until(&format!("core/login {state}"), |route, v| {
            route == "core/login" && v["state"] == state
        })
        .await
}

/// GETs `url` with a plain HTTP/1.1 request; returns the status and the `location` header.
async fn get(url: &str) -> (u16, Option<String>) {
    let rest = url.strip_prefix("http://").expect("http URL");
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, "/".to_owned()), |(a, p)| (a, format!("/{p}")));
    let mut stream = tokio::net::TcpStream::connect(authority)
        .await
        .expect("connect");
    let request = format!("GET {path} HTTP/1.1\r\nhost: {authority}\r\nconnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("send");
    let mut text = String::new();
    stream.read_to_string(&mut text).await.expect("read");
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let location = text
        .lines()
        .find_map(|l| {
            l.strip_prefix("location: ")
                .or_else(|| l.strip_prefix("Location: "))
        })
        .map(str::to_owned);
    (status, location)
}

/// What the user's browser does with the authorization page: follows the redirect to the
/// loopback callback.
async fn browse(url: &str) {
    let (status, location) = get(url).await;
    assert_eq!(status, 302, "the authorization page redirects");
    let (status, _) = get(&location.expect("a redirect target")).await;
    assert_eq!(status, 200, "the loopback server took the callback");
}

fn no_plaintext(env: &Env, auth: &MockAuthServer) {
    let tokens = auth.issued();
    assert!(!tokens.is_empty(), "the server issued tokens");
    let needles: Vec<&[u8]> = tokens.iter().map(String::as_bytes).collect();
    let scan = piarc_testkit::plaintext::scan(&[&env.data, &env.cache, &env.ws], &needles, None);
    println!("plaintext scan: {} files, {} bytes", scan.files, scan.bytes);
    assert!(
        scan.findings.is_empty() && scan.unreadable.is_empty(),
        "findings {:?}, unreadable {:?}",
        scan.findings,
        scan.unreadable
    );
    assert!(env.data.join("secrets.vault").is_file());
    assert!(!env.data.join("pi/auth.json").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorization_code_sign_in_reaches_the_vault_and_signs_out() {
    let env = Env::new("login-code").await;
    let auth = MockAuthServer::start(AuthBehavior::Approve, 0)
        .await
        .expect("auth server");
    let (core, events) = start(&env, &provider_file(&env, &auth, "authorizationCode"));
    let before = list(&core).await;
    let offered: Vec<&str> = before["loginProviders"]
        .as_array()
        .expect("login providers")
        .iter()
        .filter_map(|p| p["id"].as_str())
        .collect();
    println!("sign-in offered for: {offered:?}");
    assert!(offered.contains(&PROVIDER));
    assert!(
        !offered.contains(&"anthropic"),
        "Anthropic subscription sign-in is never offered"
    );
    assert_eq!(signed_in(&before), Some(false));

    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    let step = events
        .until("the authorization URL", |route, v| {
            route == "core/login" && v["interaction"]["type"] == "authUrl"
        })
        .await;
    browse(step["interaction"]["url"].as_str().expect("a URL")).await;
    let done = answer(rx).await.expect("signed in");
    assert_eq!(done["loginId"], step["loginId"]);
    login_event(&events, "succeeded").await;
    assert_eq!(signed_in(&list(&core).await), Some(true));
    no_plaintext(&env, &auth);
    assert!(
        !events
            .on("core/login")
            .iter()
            .any(|e| auth.issued().iter().any(|t| e.to_string().contains(t))),
        "no token in Core's events"
    );

    let (done, rx) = reply();
    core.logout(PROVIDER.into(), done).expect("queued");
    answer(rx).await.expect("signed out");
    assert_eq!(signed_in(&list(&core).await), Some(false));
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusal_and_cancel_end_the_sign_in_with_a_message() {
    let env = Env::new("login-refused").await;
    let auth = MockAuthServer::start(AuthBehavior::Deny, 0)
        .await
        .expect("auth server");
    let (core, events) = start(&env, &provider_file(&env, &auth, "authorizationCode"));

    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    let step = events
        .until("the authorization URL", |route, v| {
            route == "core/login" && v["interaction"]["type"] == "authUrl"
        })
        .await;
    browse(step["interaction"]["url"].as_str().expect("a URL")).await;
    let error = answer(rx).await.expect_err("refused");
    println!("refused: {error}");
    let failed = login_event(&events, "failed").await;
    assert!(
        failed["message"]
            .as_str()
            .unwrap()
            .contains("access_denied"),
        "{failed}"
    );

    // Cancel while the page is open: the sign-in stops and says so.
    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    let first = step["loginId"].clone();
    let step = events
        .until("a second authorization URL", |route, v| {
            route == "core/login" && v["interaction"]["type"] == "authUrl" && v["loginId"] != first
        })
        .await;
    core.answer_login(step["loginId"].as_str().unwrap(), None)
        .expect("cancel");
    let error = answer(rx).await.expect_err("cancelled");
    println!("cancelled: {error}");
    let cancelled = login_event(&events, "cancelled").await;
    assert_eq!(cancelled["loginId"], step["loginId"]);
    assert_eq!(signed_in(&list(&core).await), Some(false));
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_code_sign_in_approves_and_expires() {
    let env = Env::new("login-device").await;
    let auth = MockAuthServer::start(AuthBehavior::Approve, 0)
        .await
        .expect("auth server");
    let (core, events) = start(&env, &provider_file(&env, &auth, "deviceCode"));

    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    let step = events
        .until("the device code", |route, v| {
            route == "core/login" && v["interaction"]["type"] == "deviceCode"
        })
        .await;
    assert_eq!(step["interaction"]["userCode"], "PIAR-C029");
    answer(rx).await.expect("signed in");
    assert_eq!(signed_in(&list(&core).await), Some(true));
    no_plaintext(&env, &auth);

    auth.set_behavior(AuthBehavior::Expire);
    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    answer(rx).await.expect_err("expired");
    let failed = login_event(&events, "failed").await;
    assert!(
        failed["message"].as_str().unwrap().contains("expired"),
        "{failed}"
    );
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pasted_code_answers_the_prompt() {
    let env = Env::new("login-prompt").await;
    let auth = MockAuthServer::start(AuthBehavior::Approve, 0)
        .await
        .expect("auth server");
    let (core, events) = start(&env, &provider_file(&env, &auth, "manualCode"));
    let (done, rx) = reply();
    core.login(PROVIDER.into(), done).expect("queued");
    let step = events
        .until("the prompt", |route, v| {
            route == "core/login" && v["interaction"]["type"] == "prompt"
        })
        .await;
    assert_eq!(step["interaction"]["kind"], "manualCode");
    // The mock's authorization page gives the code when no browser takes the redirect.
    let page = format!(
        "{}?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback&state=s",
        auth.authorize_url()
    );
    let (_, location) = get(&page).await;
    let code = location
        .and_then(|l| {
            l.split_once("code=")
                .map(|(_, c)| c.split('&').next().unwrap_or("").to_owned())
        })
        .expect("a code");
    core.answer_login(step["loginId"].as_str().unwrap(), Some(code))
        .expect("answered");
    answer(rx).await.expect("signed in");
    assert_eq!(signed_in(&list(&core).await), Some(true));
    shutdown(core).await;
}
