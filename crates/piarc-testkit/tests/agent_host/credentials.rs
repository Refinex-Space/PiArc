//! S5 end to end (T08-A06, A08, A09, A10): the real Agent Host bundle with its vault-backed
//! credential store, Core's `SecretsService` over a real vault file, a local OAuth token
//! endpoint and the strict mock provider.
//!
//! Run with `--nocapture` to print the observations recorded in
//! `docs/spikes/S05-credential-vault.md`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use piarc_core::agent_host::{HostConfig, HostEvent, HostSupervisor, Peer};
use piarc_ports::SecretStoreError;
use piarc_protocol::session::{ModelRef, SessionCreateParams, SessionId};
use piarc_testkit::plaintext;
use serde_json::{Map, Value, json};

use crate::harness::{self, Env, Recorder, WAIT, open, prompt_text};
use crate::token_server::{Issued, TokenServer};

const PROVIDER: &str = "piarc-test-oauth";

fn scenario(id: &str) -> String {
    format!("id: {id}\nsteps:\n  - text: \"Answered by {id}.\"\n")
}

const ENV_DUMP: &str = r#"
id: env-dump
steps:
  - tool_calls:
      - { name: Bash, input: { command: "env" } }
      - { name: mcp__alpha__echo, input: { text: "pid please" } }
  - text: "Environment printed."
"#;

const AFTER_RECOVERY: &str = r#"
id: after-recovery
steps:
  - text: "Credentials are back."
"#;

/// Writes the `--test-oauth-provider` file and returns host settings that pass it.
fn oauth_config(env: &Env, tokens: &TokenServer, login: bool, name: &str) -> HostConfig {
    let mut provider = json!({
        "id": PROVIDER,
        "baseUrl": env.mock.openai_base_url(),
        "tokenUrl": tokens.url,
        "models": [{ "id": "mock-oauth", "contextWindow": 200_000, "maxTokens": 4096 }],
    });
    if login {
        provider["loginCode"] = json!(tokens.code);
    }
    let file = env.root.join(format!("{name}.json"));
    std::fs::write(&file, provider.to_string()).expect("provider file written");
    let mut config = env.config();
    config.extra_args.push("--test-oauth-provider".into());
    config.extra_args.push(file.into_os_string());
    config
}

/// Core's current entry for `key`, read as any other client would.
async fn vault_entry(env: &Env, key: &str) -> Option<Map<String, Value>> {
    let (peer, _frames) = Peer::channel(4);
    let mut params = Map::new();
    params.insert("key".into(), json!(key));
    let result = env
        .secrets
        .dispatch("secrets/get", params, peer)
        .await
        .expect("secrets/get");
    result["entry"]["value"].as_object().cloned()
}

async fn connected_pid(events: &mut Recorder) -> u32 {
    let event = events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    match event {
        HostEvent::Connected { pid, .. } => pid.expect("the Agent Host has a pid"),
        _ => unreachable!("matched Connected"),
    }
}

async fn oauth_session(supervisor: &HostSupervisor, cwd: &str) -> SessionId {
    supervisor
        .create_session(SessionCreateParams::new(cwd).with_model(Some(ModelRef {
            provider: PROVIDER.into(),
            id: "mock-oauth".into(),
        })))
        .await
        .expect("session opens")
        .session_id
}

/// Login in Agent Host A, then two sessions of A and one of Agent Host B use the expiring token
/// at the same time: one refresh in total, every request uses the refreshed token, and the
/// vault holds it. Then the plaintext and environment scans (A10).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn login_and_one_refresh_reach_the_vault_and_every_session() {
    let log_file = harness::capture_logs();
    let started = SystemTime::now();
    let scenarios = [
        scenario("oauth-a1"),
        scenario("oauth-a2"),
        scenario("oauth-b1"),
    ];
    let mut yaml: Vec<&str> = scenarios.iter().map(String::as_str).collect();
    yaml.push(ENV_DUMP);
    let env = Env::new("credentials", &yaml, json!({})).await;
    write_mcp_config(&env.ws[0]);
    let tokens = TokenServer::start(Duration::from_millis(300)).await;
    let mut changes = env.secrets.changes();

    let (host_a, mut events_a, core_a) = env.start_with(
        oauth_config(&env, &tokens, true, "oauth-a"),
        &[env.ws[0].as_path()],
    );
    let pid_a = connected_pid(&mut events_a).await;
    let change = tokio::time::timeout(WAIT, changes.recv())
        .await
        .expect("the login reaches the vault")
        .expect("change");
    assert_eq!(change.key, format!("oauth/{PROVIDER}"));
    let (host_b, mut events_b, _core_b) =
        env.start_with(oauth_config(&env, &tokens, false, "oauth-b"), &[]);
    let pid_b = connected_pid(&mut events_b).await;

    run_three_sessions(&env, [&host_a, &host_b], [&mut events_a, &mut events_b]).await;
    let issued = check_single_refresh(&env, &tokens).await;

    let env_session = open(&host_a, &core_a, &env.cwd(0), "mock-large").await;
    let turn = host_a
        .prompt(
            &env_session,
            "env",
            &prompt_text("Print the environment.", "env-dump"),
        )
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(
        events_a.turn_completed(&turn.0).await["status"],
        "completed"
    );
    let needles: Vec<String> = issued
        .iter()
        .flat_map(|i| [i.access.clone(), i.refresh.clone()])
        .collect();
    let mcp_pid = check_child_environments(&events_a, &env_session.0, &needles);
    check_process_environment("Agent Host A", pid_a, &needles);
    check_process_environment("Agent Host B", pid_b, &needles);
    check_process_environment("MCP server of A", mcp_pid, &needles);

    host_a.shutdown().await;
    host_b.shutdown().await;
    check_no_plaintext(&env, log_file, started, &needles);
}

/// Sessions A1 and A2 on Agent Host A and B1 on Agent Host B prompt at the same time, all on
/// the OAuth provider whose token is about to expire.
async fn run_three_sessions(
    env: &Env,
    [host_a, host_b]: [&HostSupervisor; 2],
    [events_a, events_b]: [&mut Recorder; 2],
) {
    let a1 = oauth_session(host_a, &env.cwd(0)).await;
    let a2 = oauth_session(host_a, &env.cwd(0)).await;
    let b1 = oauth_session(host_b, &env.cwd(1)).await;
    let texts = ["oauth-a1", "oauth-a2", "oauth-b1"].map(|s| prompt_text("Hello.", s));
    let (t1, t2, t3) = tokio::join!(
        host_a.prompt(&a1, "a1", &texts[0]),
        host_a.prompt(&a2, "a2", &texts[1]),
        host_b.prompt(&b1, "b1", &texts[2]),
    );
    for turn in [t1, t2] {
        let done = events_a
            .turn_completed(&turn.expect("accepted").turn_id.0)
            .await;
        assert_eq!(done["status"], "completed", "{done}");
    }
    let done = events_b
        .turn_completed(&t3.expect("accepted").turn_id.0)
        .await;
    assert_eq!(done["status"], "completed", "{done}");
}

fn write_mcp_config(ws: &Path) {
    let config = json!({ "mcpServers": { "alpha": {
        "command": harness::node(), "args": [harness::mcp_fixture(), "alpha"], "exposure": "direct"
    }}});
    std::fs::create_dir_all(ws.join(".pi")).expect(".pi created");
    std::fs::write(ws.join(".pi").join("mcp.json"), config.to_string()).expect("mcp.json");
}

/// One login and one refresh reached the token endpoint; all three requests carried the
/// refreshed token; the vault holds it.
async fn check_single_refresh(env: &Env, tokens: &TokenServer) -> Vec<Issued> {
    let calls = tokens.calls();
    println!("T08-A08/A09: token endpoint calls {calls:?}");
    assert_eq!(
        calls,
        vec![
            ("authorization_code".to_owned(), true),
            ("refresh_token".to_owned(), true)
        ],
        "one login, one refresh, no rejected (double) refresh"
    );
    let issued = tokens.issued();
    let mut labels = Vec::new();
    for selector in ["oauth-a1", "oauth-a2", "oauth-b1"] {
        let requests = env.requests(selector);
        assert_eq!(requests.len(), 1, "{selector}");
        let label = requests[0]
            .headers
            .get("x-piarc-test-token")
            .cloned()
            .unwrap_or_default();
        labels.push(label);
    }
    println!("T08-A08: token labels used by sessions A1, A2, B1: {labels:?}");
    assert_eq!(labels, vec!["gen-2"; 3]);
    let stored = vault_entry(env, &format!("oauth/{PROVIDER}"))
        .await
        .expect("the vault has the OAuth credential");
    assert_eq!(stored["access"], issued[1].access.as_str());
    assert_eq!(stored["refresh"], issued[1].refresh.as_str());
    assert_eq!(stored["label"], "gen-2");
    println!(
        "T08-A08: vault holds gen-2 (first token valid for {:?}, below the 5-minute refresh window)",
        tokens.first_validity
    );
    issued
}

/// The Bash tool's environment and the MCP server's pid, from the env-dump session's results.
fn check_child_environments(events: &Recorder, session: &str, needles: &[String]) -> u32 {
    let results = events.tool_results(session);
    let output = |tool: &str| {
        results
            .iter()
            .find(|item| item["tool"] == tool)
            .and_then(|item| item["output"].as_str())
            .unwrap_or_else(|| panic!("no {tool} result in {results:?}"))
            .to_owned()
    };
    let bash = output("Bash");
    assert!(
        bash.contains("PATH="),
        "the Bash tool printed its environment"
    );
    for needle in needles {
        assert!(
            !bash.contains(needle.as_str()),
            "a credential is in the Bash environment"
        );
    }
    let mcp = output("mcp__alpha__echo");
    let pid = mcp
        .rsplit("(pid ")
        .next()
        .and_then(|rest| rest.trim_end_matches(')').parse().ok())
        .unwrap_or_else(|| panic!("no pid in {mcp:?}"));
    println!(
        "T08-A10: Bash tool environment has {} variables, none holds a credential",
        bash.lines().filter(|l| l.contains('=')).count()
    );
    pid
}

#[path = "../support/process_environment.rs"]
mod process_environment;
use process_environment::check_process_environment;

/// Byte search of the data directory (vault, Pi's directory, session directories), the
/// workspaces, Core's log and the system temp directory for every issued token.
fn check_no_plaintext(env: &Env, log_file: &Path, started: SystemTime, needles: &[String]) {
    let needles: Vec<&[u8]> = needles.iter().map(|n| n.as_bytes()).collect();
    let pi = env.data_dir.join("pi");
    for name in ["auth.json", "mcp-auth.json"] {
        assert!(!pi.join(name).exists(), "{name} must not exist under pi/");
    }
    assert!(env.data_dir.join("secrets.vault").exists());
    // Control: a planted token is found on the same paths, so a clean result means something.
    let control = env.data_dir.join("sessions").join("control.txt");
    std::fs::create_dir_all(control.parent().expect("parent")).expect("dir");
    std::fs::write(&control, needles[0]).expect("control written");
    let planted = plaintext::scan(&[&env.root], &needles, None);
    assert_eq!(planted.findings.len(), 1, "the control token is found");
    std::fs::remove_file(&control).expect("control removed");
    let ours = plaintext::scan(&[&env.root, log_file], &needles, None);
    assert!(
        ours.findings.is_empty(),
        "plaintext found: {:?}",
        ours.findings
    );
    assert!(
        ours.unreadable.is_empty(),
        "unreadable: {:?}",
        ours.unreadable
    );
    let log_bytes = std::fs::metadata(log_file).map_or(0, |m| m.len());
    let temp = std::env::temp_dir();
    let shared = plaintext::scan(&[&temp], &needles, Some(started));
    assert!(
        shared.findings.is_empty(),
        "plaintext in the temp dir: {:?}",
        shared.findings
    );
    println!(
        "T08-A10: scanned {} files ({} bytes) under the test root (data dir, pi/, sessions/, workspaces) and Core's log ({log_bytes} bytes), and {} files written to {} since the test started ({} unreadable entries skipped): no token found; pi/auth.json and pi/mcp-auth.json absent",
        ours.files,
        ours.bytes,
        shared.files,
        temp.display(),
        shared.unreadable.len()
    );
}

/// T08-A06: with the master key's store refusing access, the session's turn fails with a
/// structured error, nothing is written in plaintext, and the next turn after access is
/// granted succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refusing_credential_store_fails_the_turn_and_recovers() {
    let env = Env::new(
        "credentials-denied",
        &[AFTER_RECOVERY, &scenario("denied")],
        json!({}),
    )
    .await;
    env.key_store.fail_with(SecretStoreError::AccessDenied(
        "the user denied Keychain access".into(),
    ));
    let (host, mut events, core) = env.start(&[]);
    connected_pid(&mut events).await;
    let session = open(&host, &core, &env.cwd(0), "mock-large").await;
    let turn = host
        .prompt(&session, "denied", &prompt_text("Hello.", "denied"))
        .await
        .expect("accepted")
        .turn_id;
    let done = events.turn_completed(&turn.0).await;
    println!("T08-A06: turn while access is denied: {done}");
    assert_eq!(done["status"], "failed");
    let message = done["errorMessage"].as_str().unwrap_or_default();
    assert!(
        message.contains("Credential store read failed"),
        "{message}"
    );
    assert!(
        env.requests("denied").is_empty(),
        "no request went out without credentials"
    );
    let files: Vec<PathBuf> = std::fs::read_dir(&env.data_dir)
        .expect("data dir")
        .flatten()
        .map(|e| e.path())
        .collect();
    assert!(
        !env.data_dir.join("secrets.vault").exists(),
        "no vault written while the store refuses: {files:?}"
    );
    assert!(!env.data_dir.join("pi").join("auth.json").exists());

    env.key_store.recover();
    let turn = host
        .prompt(
            &session,
            "recovered",
            &prompt_text("Again.", "after-recovery"),
        )
        .await
        .expect("accepted")
        .turn_id;
    let done = events.turn_completed(&turn.0).await;
    assert_eq!(done["status"], "completed", "{done}");
    assert!(env.data_dir.join("secrets.vault").exists());
    println!("T08-A06: after access was granted the next turn completed and the vault was created");
    host.shutdown().await;
}
