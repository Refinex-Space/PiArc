//! T36-A07: an OAuth-protected Streamable HTTP MCP server through Core's public API and the
//! Agent Host's pool: the server needs a sign-in, the browser authorization (this test follows
//! the authorization page's redirect to the Agent Host's loopback port) stores the tokens in the
//! vault, an expired access token is refreshed, revoked tokens make the server need a sign-in
//! again, and no token or `mcp-auth.json` is left on disk.
use std::path::Path;

use piarc_testkit::mcp_server::MockMcpServer;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::support::{Env, Events, answer, prompt_text, reply, shutdown};
use super::{open_session, prompt};

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

/// The user's browser: opens the authorization page and follows its redirect to the loopback
/// callback.
async fn browse(url: &str) {
    let (status, location) = get(url).await;
    assert_eq!(status, 302, "the authorization page redirects");
    let (status, _) = get(&location.expect("a redirect target")).await;
    assert_eq!(status, 200, "the loopback server took the callback");
}

/// Waits for `core/mcp` to report server `name` in `state`.
async fn mcp_state(events: &Events, name: &str, state: &str) -> Value {
    events
        .until(&format!("core/mcp {name} {state}"), |route, v| {
            route == "core/mcp"
                && v["servers"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["name"] == name && s["state"] == state))
        })
        .await
}

/// Signs in to `docs` the way the settings window does: the authorization page "opens in the
/// browser" when `core/login` shows it.
async fn sign_in(core: &piarc_core::CoreRuntime, events: &Events, ws: &Path) -> Value {
    let earlier: Vec<Value> = events
        .on("core/login")
        .into_iter()
        .map(|v| v["loginId"].clone())
        .collect();
    let (done, rx) = reply();
    core.mcp_login(ws.to_path_buf(), "docs".into(), done)
        .expect("queued");
    let shown = events
        .until("the authorization page", |route, v| {
            route == "core/login"
                && v["provider"] == "mcp:docs"
                && v["interaction"]["type"] == "authUrl"
                && !earlier.contains(&v["loginId"])
        })
        .await;
    browse(
        shown["interaction"]["url"]
            .as_str()
            .expect("an authorization URL"),
    )
    .await;
    answer(rx).await.expect("the sign-in ends")
}

/// The output of the last `mcp__docs__echo` call of session `id`.
fn last_echo(events: &Events, id: &str) -> (String, String) {
    let item = events
        .of(id, "item/completed")
        .into_iter()
        .rfind(|n| n["item"]["tool"] == "mcp__docs__echo")
        .expect("an echo call completed");
    (
        item["item"]["status"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        item["item"]["output"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

fn files_named(dir: &Path, name: &str, found: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_named(&path, name, found);
        } else if entry.file_name() == name {
            found.push(path);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_sign_in_refresh_and_sign_in_again_keep_tokens_in_the_vault() {
    let env = Env::new("mcp-oauth").await;
    let docs = MockMcpServer::start("docs", true)
        .await
        .expect("docs starts");
    configure(&env, &docs);
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;

    // The pool connects for the session: the server asks for a sign-in.
    let state = mcp_state(&events, "docs", "needsAuth").await;
    println!("T36-A07: before sign-in {state}");
    let signed = sign_in(&core, &events, &env.ws).await;
    println!("T36-A07: after sign-in {signed}");
    assert_eq!(
        (signed["state"].as_str(), signed["oauth"].as_bool()),
        (Some("connected"), Some(true))
    );
    assert_eq!(signed["tools"], 2);
    let ended = events
        .until("core/login succeeded", |route, v| {
            route == "core/login" && v["provider"] == "mcp:docs" && v["state"] == "succeeded"
        })
        .await;
    assert_eq!(ended["loginId"], signed["loginId"]);

    let turn = prompt(&core, &id, &prompt_text("Call docs.", "mcp-docs")).await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(
        last_echo(&events, &id),
        (
            "completed".to_owned(),
            "docs echoes \"one\" (token gen-1)".to_owned()
        )
    );

    // The access token stops working; the stored refresh token gets a new one.
    docs.expire_access();
    let turn = prompt(&core, &id, &prompt_text("Again.", "mcp-docs")).await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(
        last_echo(&events, &id),
        (
            "completed".to_owned(),
            "docs echoes \"two\" (token gen-2)".to_owned()
        )
    );

    // Every token revoked: the call fails asking for a sign-in, then signing in again works.
    docs.revoke_all();
    let turn = prompt(&core, &id, &prompt_text("Once more.", "mcp-docs")).await;
    events.turn_completed(&id, &turn).await;
    let (status, output) = last_echo(&events, &id);
    assert_eq!(status, "failed");
    assert!(output.contains("needs a sign-in"), "{output}");
    mcp_state(&events, "docs", "needsAuth").await;
    let again = sign_in(&core, &events, &env.ws).await;
    assert_eq!(again["state"], "connected");
    let (done, rx) = reply();
    core.mcp_status(env.ws.clone(), done).expect("queued");
    let status = answer(rx).await.expect("status");
    println!("T36-A07: status after signing in again {status}");
    assert_eq!(status["servers"][0]["state"], "connected");
    let calls = docs.calls();
    println!("T36-A07: server calls {calls:?}");
    assert!(
        calls
            .iter()
            .any(|(m, label)| m == "tools/call" && label.as_deref() == Some("gen-1"))
    );
    assert!(
        calls
            .iter()
            .any(|(m, label)| m == "tools/call" && label.as_deref() == Some("gen-2"))
    );
    assert!(
        calls
            .iter()
            .any(|(_, label)| label.as_deref() == Some("gen-3"))
    );
    shutdown(core).await;

    tokens_only_in_the_vault(&env, &docs);
}

/// The user's settings: server `docs` (Streamable HTTP, OAuth) and an allow rule for its tools.
fn configure(env: &Env, docs: &MockMcpServer) {
    let settings_file = env.data.join("settings.json");
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&settings_file).expect("settings")).expect("json");
    settings["mcpServers"] = json!({ "docs": { "type": "http", "url": docs.url() } });
    settings["permissions"]["allow"]
        .as_array_mut()
        .expect("allow list")
        .push(json!("mcp__docs__*"));
    std::fs::write(&settings_file, settings.to_string()).expect("settings written");
}

/// Tokens only in the vault: none on disk in plain text, no Pi `mcp-auth.json`.
fn tokens_only_in_the_vault(env: &Env, docs: &MockMcpServer) {
    let tokens = docs.issued();
    assert_eq!(tokens.len(), 6, "three access and three refresh tokens");
    let needles: Vec<&[u8]> = tokens.iter().map(String::as_bytes).collect();
    let scan = piarc_testkit::plaintext::scan(&[&env.data, &env.cache, &env.ws], &needles, None);
    println!(
        "T36-A07: plaintext scan of {} files ({} bytes): {} findings",
        scan.files,
        scan.bytes,
        scan.findings.len()
    );
    assert!(
        scan.findings.is_empty() && scan.unreadable.is_empty(),
        "{:?}",
        scan.findings
    );
    let mut auth_files = Vec::new();
    files_named(&env.root, "mcp-auth.json", &mut auth_files);
    assert!(auth_files.is_empty(), "{auth_files:?}");
    assert!(env.data.join("secrets.vault").is_file());
}
