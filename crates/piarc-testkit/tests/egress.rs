//! T45-A09: in a whole mock session (a model turn with a command and a stdio MCP server), the
//! Agent Host connects to nothing but the mock provider. The Agent Host runs as in the app,
//! without `PI_OFFLINE`, through a wrapper that records every connection Node makes
//! (`diagnostics_channel`: `net.client.socket`, undici's `client:connected`, `http.client`) to a
//! file in its own directory. Its own test binary: the log subscriber is process-wide.

#[path = "sessions/support.rs"]
mod support;

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::composer::UserInput;
use piarc_core::sessions::Op;
use serde_json::{Value, json};

use support::{Env, answer, mock_model, prompt_text, reply, repo_root, shutdown};

/// The wrapper module: records connections, then runs the bundle.
fn wrapper(log: &std::path::Path, bundle: &std::path::Path) -> String {
    let log = serde_json::to_string(log).expect("path");
    let bundle = serde_json::to_string(bundle).expect("path");
    format!(
        r"import dc from 'node:diagnostics_channel';
import {{ appendFileSync }} from 'node:fs';
import {{ pathToFileURL }} from 'node:url';
const log = {log};
const note = (kind, host, port) => appendFileSync(log, JSON.stringify({{ kind, host: String(host), port: Number(port) }}) + '\n');
dc.subscribe('net.client.socket', ({{ socket }}) => {{
  socket.once('connect', () => note('net', socket.remoteAddress, socket.remotePort));
}});
dc.subscribe('undici:client:connected', ({{ connectParams }}) => note('undici', connectParams.hostname, connectParams.port));
dc.subscribe('http.client.request.start', ({{ request }}) => note('http', request.host, request.socket?.remotePort ?? 0));
await import(pathToFileURL({bundle}).href);
"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thr04_a_whole_mock_session_connects_only_to_the_model_provider() {
    let env = Env::new("thr04 egress").await;
    let mcp_echo = repo_root()
        .join("packages")
        .join("testkit")
        .join("src")
        .join("mcp-echo-server.ts");
    std::fs::write(
        env.data.join("settings.json"),
        json!({
            "permissions": { "allow": ["Bash(env)", "mcp__echo__echo"] },
            "mcpServers": { "echo": { "command": "node", "args": [mcp_echo, "echo"] } }
        })
        .to_string(),
    )
    .expect("settings");
    let mut config = env.config(&[]);
    let log = env.data.join("agent-host").join("egress.jsonl");
    let Some(AgentHostLaunch::Custom {
        bundle, extra_env, ..
    }) = &mut config.sessions.launch
    else {
        panic!("expected the development launch")
    };
    // As in the app: no PI_OFFLINE, so Pi's own network paths behave as they would there.
    extra_env.retain(|(name, _)| name != "PI_OFFLINE");
    let script = env.root.join("egress-wrapper.mjs");
    std::fs::write(&script, wrapper(&log, bundle)).expect("wrapper");
    *bundle = script;
    let (core, events) = env.start(config);

    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    assert_eq!(answer(rx).await.expect("opened")["host"], "ready");
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, mock_model(), done)
        .expect("queued");
    let id = answer(rx).await.expect("session")["sessionId"]
        .as_str()
        .expect("id")
        .to_owned();
    let (done, rx) = reply();
    let text = prompt_text("Use the tools.", "thr04-egress");
    core.session_op(id.clone(), Op::Prompt(UserInput::text(&text)), done)
        .expect("queued");
    let turn = answer(rx).await.expect("accepted")["turnId"]
        .as_str()
        .expect("turn")
        .to_owned();
    let completed = events.turn_completed(&id, &turn).await;
    assert_eq!(completed["status"], "completed", "{completed}");
    let requests = env.requests("thr04-egress");
    assert_eq!(requests.len(), 3, "the model answered three requests");
    assert!(
        requests[2].body.contains("echo echoes"),
        "the MCP server ran and answered"
    );
    shutdown(core).await;

    // `http://127.0.0.1:<port>[/…]`
    let base = env.mock.anthropic_base_url();
    let port: u16 = base
        .trim_start_matches("http://127.0.0.1:")
        .split('/')
        .next()
        .and_then(|p| p.parse().ok())
        .expect("the mock listens on 127.0.0.1");
    let text = std::fs::read_to_string(&log).expect("the wrapper recorded connections");
    let connections: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON line"))
        .collect();
    assert!(!connections.is_empty(), "the model requests were recorded");
    let elsewhere: Vec<&Value> = connections
        .iter()
        .filter(|c| {
            let host = c["host"].as_str().unwrap_or_default();
            let local = matches!(host, "127.0.0.1" | "::1" | "::ffff:127.0.0.1" | "localhost");
            !(local && c["port"].as_u64() == Some(u64::from(port)))
        })
        .collect();
    assert_eq!(
        elsewhere,
        Vec::<&Value>::new(),
        "connections besides the mock provider"
    );
    println!(
        "THR-04: {} connections, all to the mock provider at 127.0.0.1:{port}",
        connections.len()
    );
}
