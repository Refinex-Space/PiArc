//! T39 through Core's runtime and the real Agent Host (macOS: Seatbelt).
//!
//! - A09: the Agent Host runs under its finalized profile: a project Pi extension that writes to
//!   the home directory is refused, an MCP server started with `npx` writes where the profile
//!   allows and nowhere else, and the session's model requests and JSONL go on.
//! - A05, A14, A07: a sandboxed command reaches allowed hosts through the proxy; a host outside
//!   the allowlist raises a network-domain card (allow once, add to the allowlist, deny, time
//!   out); a changed allowlist applies to the next command with the same Agent Host process;
//!   a direct connection around the proxy fails; refusals and answers are in the audit.
//! - A11: git, a Python script, `cargo build` and `npm install` run through the Bash tool in the
//!   sandbox (the last two reach the real registries, as T11's tests do).

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision, ApprovalRequest};
use serde_json::{Value, json};

use crate::support::{Env, answer, prompt_text, record_host_pid, reply, shutdown};
use crate::{open_session, prompt};

/// The root `Env::with_scenario(name, …)` will use (to put its paths in a generated script).
fn root_of(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("piarc sessions {name} 中文 {}", std::process::id()))
}

fn scenario(id: &str, steps: Value) -> piarc_testkit::Scenario {
    piarc_testkit::Scenario::from_json_str(id, &json!({ "id": id, "steps": steps }).to_string())
        .expect("scenario")
}

fn bash(id: &str, command: &str) -> Value {
    json!({ "tool_calls": [{ "id": id, "name": "Bash", "input": { "command": command } }] })
}

fn text(text: &str) -> Value {
    json!({ "text": text })
}

fn write_settings(env: &Env, change: impl FnOnce(&mut Value)) {
    let file = env.data.join("settings.json");
    let mut settings: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("settings")).expect("json");
    change(&mut settings);
    std::fs::write(&file, settings.to_string()).expect("settings written");
}

/// The completed tool item of call `call`.
fn item_of(events: &crate::support::Events, id: &str, call: &str) -> Value {
    events
        .of(id, "item/completed")
        .into_iter()
        .rfind(|n| n["item"]["itemId"] == call)
        .unwrap_or_else(|| panic!("no item for {call}"))["item"]
        .clone()
}

/// The model-visible text of call `call` in the latest request of `scenario`.
fn tool_result(env: &Env, scenario: &str, call: &str) -> String {
    let requests = env.requests(scenario);
    let body: Value =
        serde_json::from_str(&requests.last().expect("a request").body).expect("JSON request");
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .find(|b| b["type"] == "tool_result" && b["tool_use_id"] == call)
        .map(|b| match &b["content"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        })
        .unwrap_or_else(|| panic!("no tool result for {call}"))
}

/// Waits for an approval of session `id` that `pick` accepts and answers it.
async fn answer_card(
    core: &piarc_core::CoreRuntime,
    events: &crate::support::Events,
    id: &str,
    pick: impl Fn(&ApprovalRequest) -> bool,
    decision: ApprovalDecision,
) -> ApprovalRequest {
    let pick = &pick;
    let snapshot = events
        .until("an approval card", |route, v| {
            route == "core/sessions"
                && v["sessions"].as_array().into_iter().flatten().any(|s| {
                    s["id"] == id
                        && s["approvals"].as_array().into_iter().flatten().any(|c| {
                            serde_json::from_value::<ApprovalRequest>(c.clone())
                                .is_ok_and(|card| pick(&card))
                        })
                })
        })
        .await;
    let card: ApprovalRequest = snapshot["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["id"] == id)
        .flat_map(|s| s["approvals"].as_array().cloned().unwrap_or_default())
        .filter_map(|c| serde_json::from_value::<ApprovalRequest>(c).ok())
        .find(|card| pick(card))
        .expect("the card");
    let answer = ApprovalAnswer {
        elicitation: None,
        confirmed_url: None,
        request_id: card.request_id.clone(),
        session_id: card.session_id.clone(),
        revision: card.revision,
        connection_epoch: card.connection_epoch,
        decision,
        rules: Vec::new(),
        directory: None,
        domain: (decision == ApprovalDecision::AllowAlways)
            .then(|| card.domain.clone())
            .flatten(),
        feedback: None,
        mode: None,
        comments: Vec::new(),
        answers: Vec::new(),
        via: None,
    };
    let (done, rx) = reply();
    core.answer_approval(answer, done).expect("queued");
    assert_eq!(
        crate::support::answer(rx).await.expect("answered")["status"],
        "applied"
    );
    card
}

fn network_card(host: &'static str) -> impl Fn(&ApprovalRequest) -> bool {
    move |card| card.tool == "SandboxNetwork" && card.domain.as_deref() == Some(host)
}

/// A local HTTP server answering every request with `hello`.
async fn hello_server() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binds");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0_u8; 4096];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                    )
                    .await;
            });
        }
    });
    port
}

async fn trust(core: &piarc_core::CoreRuntime, ws: &Path) {
    let version = core
        .trust()
        .expect("trust")
        .view(ws)
        .await
        .expect("view")
        .version;
    let (tx, rx) = tokio::sync::oneshot::channel();
    core.trust_view(ws.to_path_buf(), Some((true, version)), move |result| {
        let _ = tx.send(result.map(|view| view.trusted));
    })
    .expect("queued");
    assert!(rx.await.expect("answered").expect("decided"));
}

/// T39-A09: under the Agent Host's profile a third-party extension cannot write to the home
/// directory, an `npx` MCP server writes the workspace and the Agent Host's places but not the
/// home directory, the rest of the data directory or a protected path, and the session's model
/// requests and JSONL are unaffected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::too_many_lines,
    reason = "one end-to-end run: fixtures, the turn and what it may and may not write"
)]
async fn the_agent_host_profile_keeps_extensions_and_mcp_servers_in_their_places() {
    const NAME: &str = "sandbox host";
    let root = root_of(NAME);
    let (ws, data, home) = (
        root.join("work space 工作区"),
        root.join("data 数据"),
        root.join("home"),
    );
    let probe = |call: &str, inside: &Path, outside: &Path| {
        json!({ "id": call, "name": "mcp__probe__probe", "input": {
            "workspace": ".", "native": "",
            "inside": inside.to_string_lossy(), "outside": outside.to_string_lossy() } })
    };
    let steps = json!([
        { "tool_calls": [
            probe("ws", &ws.join("mcp-inside.txt"), &home.join("mcp-outside.txt")),
            probe("host", &data.join("agent-host").join("tmp").join("mcp.txt"), &data.join("mcp-escape.json")),
            probe("pi", &data.join("pi").join("mcp.txt"), &ws.join(".pi").join("mcp.txt")),
        ] },
        text("Probed."),
    ]);
    let env = Env::with_scenario(NAME, Some(scenario("sandbox-host", steps))).await;
    std::fs::create_dir_all(&home).expect("home");
    let report = env.ws.join("extension-report.json");
    let extensions = env.ws.join(".pi").join("extensions");
    std::fs::create_dir_all(&extensions).expect("extensions");
    std::fs::write(
        extensions.join("escape.ts"),
        format!(
            r"import {{ writeFileSync }} from 'node:fs';
import {{ homedir }} from 'node:os';
import {{ join }} from 'node:path';
export default function () {{
  let home = 'written';
  try {{
    writeFileSync(join(homedir(), 'escape.txt'), 'escaped\n');
  }} catch (error: any) {{
    home = String(error?.code ?? error);
  }}
  writeFileSync({}, JSON.stringify({{ home, homedir: homedir() }}));
}}
",
            serde_json::to_string(&report).expect("path"),
        ),
    )
    .expect("extension");
    let tarball = super::mcp::pack_probe(&env.root);
    write_settings(&env, |settings| {
        settings["mcpServers"] = json!({ "probe": {
            "command": "npx",
            "args": ["--yes", "--package", tarball, "piarc-mcp-probe-server"],
        }});
        settings["permissions"]["allow"]
            .as_array_mut()
            .expect("allow list")
            .push(json!("mcp__probe__*"));
    });
    let mut config = env.config(&[]);
    if let Some(piarc_core::agent_host::AgentHostLaunch::Custom { extra_env, .. }) =
        &mut config.sessions.launch
    {
        // The extension's home directory: outside every place the profile lets it write.
        extra_env.push(("HOME".into(), home.clone().into_os_string()));
    }
    let (core, events) = env.start(config);
    trust(&core, &env.ws).await;
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Probe.", "sandbox-host")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );

    let extension: Value =
        serde_json::from_slice(&std::fs::read(&report).expect("the extension ran")).expect("json");
    println!("T39-A09 extension: {extension}");
    assert_eq!(extension["home"], "EPERM", "{extension}");
    assert!(!home.join("escape.txt").exists());
    for (call, outside_error) in [("ws", "EPERM"), ("host", "EPERM"), ("pi", "EPERM")] {
        let item = item_of(&events, &id, call);
        assert_eq!(item["status"], "completed", "{item}");
        let probe: Value =
            serde_json::from_str(item["output"].as_str().expect("output")).expect("json");
        println!(
            "T39-A09 MCP probe {call}: inside {}, outside {}",
            probe["writeInside"], probe["writeOutside"]
        );
        assert_eq!(probe["writeInside"]["ok"], true, "{call}: {probe}");
        assert_eq!(
            probe["writeOutside"]["error"], outside_error,
            "{call}: {probe}"
        );
    }
    assert!(env.ws.join("mcp-inside.txt").exists());
    assert!(!data.join("mcp-escape.json").exists());
    assert_eq!(
        env.requests("sandbox-host").len(),
        2,
        "both model requests went out"
    );
    let sessions = std::fs::read_dir(data.join("pi").join("sessions"))
        .expect("Pi's sessions")
        .flatten()
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .count();
    assert_eq!(sessions, 1, "the session's JSONL is written");
    shutdown(core).await;
}

/// T39-A05, A14, A07: the network allowlist, the network-domain card and the audit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::too_many_lines,
    reason = "one session through the card's answers in order, then the audit of them"
)]
async fn hosts_outside_the_allowlist_ask_and_a_changed_allowlist_applies_to_the_next_command() {
    const NAME: &str = "sandbox network";
    let port = hello_server().await;
    let curl = |host: &str| format!("curl -sSf -m 20 http://{host}:{port}/");
    let steps = json!([
        bash("denied", &curl("allowed.test")),
        text("Refused."),
        bash("listed", &curl("allowed.test")),
        text("Reached."),
        { "tool_calls": [
            { "id": "once", "name": "Bash", "input": { "command": curl("other.test") } },
        ] },
        bash("again", &curl("other.test")),
        text("Asked twice."),
        bash("saved", &curl("third.test")),
        bash("remembered", &curl("third.test")),
        bash("direct", &format!("curl -sS -m 5 --noproxy '*' http://127.0.0.1:{port}/")),
        text("Done."),
    ]);
    let env = Env::with_scenario(NAME, Some(scenario("sandbox-network", steps))).await;
    write_settings(&env, |settings| {
        settings["sandbox"] = json!({ "enabled": true, "autoAllowBashIfSandboxed": true });
    });
    let mut config = env.config(&[]);
    let pid_file = record_host_pid(&env, &mut config);
    config.sandbox.network = Arc::new(piarc_core::tool_io::SandboxTestNetwork::new(vec![
        ("allowed.test".into(), port),
        ("other.test".into(), port),
        ("third.test".into(), port),
    ]));
    config.sandbox.approval_timeout = Duration::from_secs(3);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let host_pid = || std::fs::read_to_string(&pid_file).expect("host pid");

    // Not listed: the card comes, the user denies, the command fails naming the host.
    let turn = prompt(&core, &id, &prompt_text("Fetch.", "sandbox-network")).await;
    answer_card(
        &core,
        &events,
        &id,
        network_card("allowed.test"),
        ApprovalDecision::Deny,
    )
    .await;
    events.turn_completed(&id, &turn).await;
    let pid = host_pid();
    let refused = tool_result(&env, "sandbox-network", "denied");
    println!("T39-A14 denied: {refused}");
    assert!(refused.contains("403"), "{refused}");
    assert!(
        refused.contains(&format!("connecting to allowed.test:{port}")),
        "{refused}"
    );

    // The allowlist changes: the next command reaches the host, no card, same Agent Host.
    let (done, rx) = reply();
    core.set_sandbox_settings(
        Some(env.ws.clone()),
        json!({ "allowedDomains": ["allowed.test"] }).to_string(),
        done,
    )
    .expect("queued");
    answer(rx).await.expect("saved");
    let turn = prompt(&core, &id, "Fetch again.").await;
    events.turn_completed(&id, &turn).await;
    assert!(tool_result(&env, "sandbox-network", "listed").contains("hello"));
    assert_eq!(host_pid(), pid, "the Agent Host was not restarted");

    // Allow once: this connection, then the next one asks again (and times out).
    let turn = prompt(&core, &id, "Fetch the other one.").await;
    answer_card(
        &core,
        &events,
        &id,
        network_card("other.test"),
        ApprovalDecision::AllowOnce,
    )
    .await;
    events.turn_completed(&id, &turn).await;
    assert!(tool_result(&env, "sandbox-network", "once").contains("hello"));
    let timed_out = tool_result(&env, "sandbox-network", "again");
    println!("T39-A14 timed out: {timed_out}");
    assert!(timed_out.contains("403"), "{timed_out}");

    // Add to the allowlist: allowed now and later, written to the user's settings.
    let turn = prompt(&core, &id, "Fetch the third one.").await;
    answer_card(
        &core,
        &events,
        &id,
        network_card("third.test"),
        ApprovalDecision::AllowAlways,
    )
    .await;
    events.turn_completed(&id, &turn).await;
    assert!(tool_result(&env, "sandbox-network", "saved").contains("hello"));
    assert!(tool_result(&env, "sandbox-network", "remembered").contains("hello"));
    let settings = std::fs::read_to_string(env.data.join("settings.json")).expect("settings");
    assert!(settings.contains("third.test"), "{settings}");
    let direct = tool_result(&env, "sandbox-network", "direct");
    println!("T39-A05 direct: {direct}");
    assert!(direct.contains("Command exited with code"), "{direct}");
    assert!(!direct.contains("hello"), "{direct}");
    assert_eq!(host_pid(), pid);

    // The audit holds the refusals and the answers.
    let (done, rx) = reply();
    core.audit_events(json!({ "kind": "sandbox", "limit": 50 }).to_string(), done)
        .expect("queued");
    let audit = answer(rx).await.expect("audit");
    let details: Vec<Value> = audit["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|e| e["detail"].clone())
        .collect();
    println!("T39-A07 audit: {details:?}");
    let has = |pred: &dyn Fn(&Value) -> bool| details.iter().any(pred);
    assert!(has(
        &|d| d["denial"] == "network" && d["host"] == "allowed.test"
    ));
    assert!(has(
        &|d| d["approval"] == "network" && d["decision"] == "deny"
    ));
    assert!(has(
        &|d| d["approval"] == "network" && d["decision"] == "timeout"
    ));
    assert!(has(
        &|d| d["approval"] == "network" && d["decision"] == "allowAlways"
    ));
    shutdown(core).await;
}

/// T39-A11: everyday commands through the Bash tool, in the sandbox. `npm install` and the
/// `cargo build` with a crates.io dependency reach the real registries (allowed domains), as
/// T11's tests do; without network access they fail and say so.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn everyday_commands_run_in_the_sandbox_through_the_bash_tool() {
    let steps = json!([
        bash(
            "git",
            "git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m one && git log --oneline | wc -l"
        ),
        bash("python", "python3 tool.py"),
        // Subshells: `cd` carries over to the next command (T17).
        bash(
            "cargo",
            "(cd crate && cargo build -q && ./target/debug/hello)"
        ),
        bash(
            "npm",
            "(cd js && npm install --no-audit --no-fund is-number@7.0.0 && node -e \"console.log(require('is-number')(5))\")"
        ),
        text("Done."),
    ]);
    let env = Env::with_scenario(
        "sandbox commands",
        Some(scenario("sandbox-commands", steps)),
    )
    .await;
    write_build_fixtures(&env);
    write_settings(&env, |settings| {
        settings["sandbox"] = json!({ "enabled": true, "autoAllowBashIfSandboxed": true,
            "network": { "allowedDomains": ["registry.npmjs.org", "index.crates.io", "static.crates.io"] } });
    });
    let mut config = env.config(&[]);
    config.sandbox.approval_timeout = Duration::from_secs(1);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Build.", "sandbox-commands")).await;
    events.turn_completed(&id, &turn).await;
    for (call, expected) in [
        ("git", "1"),
        ("python", "python ok"),
        ("cargo", "cargo ok 42"),
        ("npm", "true"),
    ] {
        let result = tool_result(&env, "sandbox-commands", call);
        println!("T39-A11 {call}:\n{result}\n---");
        assert!(result.contains(expected), "{call}: {result}");
        assert!(
            !result.contains("Command exited with code"),
            "{call}: {result}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(env.ws.join("py.txt")).expect("python wrote"),
        "py"
    );
    shutdown(core).await;
}

/// A git repository (made outside the sandbox: `git init` writes `.git/config` and hooks), a
/// Python script, a crate with a crates.io dependency and an npm package.
fn write_build_fixtures(env: &Env) {
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&env.ws)
            .status()
            .expect("git runs");
        assert!(status.success());
    };
    // The repository is made outside the sandbox: `git init` writes .git/config and hooks.
    git(&["init", "-q"]);
    std::fs::write(env.ws.join("a.txt"), "a\n").expect("file");
    std::fs::write(
        env.ws.join("tool.py"),
        "import tempfile, pathlib\npathlib.Path('py.txt').write_text('py')\nprint('python ok', tempfile.gettempdir())\n",
    )
    .expect("script");
    let krate = env.ws.join("crate");
    std::fs::create_dir_all(krate.join("src")).expect("crate");
    std::fs::write(
        krate.join("Cargo.toml"),
        "[package]\nname = \"hello\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nitoa = \"=1.0.15\"\n\n[workspace]\n",
    )
    .expect("manifest");
    std::fs::write(
        krate.join("src").join("main.rs"),
        "fn main() { println!(\"cargo ok {}\", itoa::Buffer::new().format(42)); }\n",
    )
    .expect("main");
    std::fs::create_dir_all(env.ws.join("js")).expect("js");
    std::fs::write(
        env.ws.join("js").join("package.json"),
        "{\"name\":\"t\",\"version\":\"1.0.0\"}\n",
    )
    .expect("package");
}
