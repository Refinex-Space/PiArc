//! T45-A07 (THR-04): a credential stored in the vault stays out of the Agent Host's process
//! environment, out of the environment of the commands it runs, and out of the log files, where
//! a line carrying it arrives redacted. Its own test binary: the log subscriber is process-wide,
//! and Cores of concurrent tests would point it at their own directories.

#[path = "support/process_environment.rs"]
mod process_environment;
#[path = "sessions/support.rs"]
mod support;

use piarc_core::composer::UserInput;
use piarc_core::providers::Operation;
use piarc_core::sessions::Op;
use piarc_protocol::session::ModelRef;
use serde_json::json;

use support::{Env, answer, prompt_text, record_host_pid, reply, shutdown};

const KEY: &str = "thr04-known-provider-key-5c1d9e";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thr04_a_vault_credential_stays_out_of_child_environments_and_log_files() {
    let env = Env::new("thr04 leaks").await;
    std::fs::write(
        env.data.join("settings.json"),
        json!({ "permissions": { "allow": ["Bash(env)"] } }).to_string(),
    )
    .expect("settings");
    let mut config = env.config(&[]);
    let pid_file = record_host_pid(&env, &mut config);
    let (core, events) = env.start(config);

    // A provider whose key only the vault holds; the Agent Host reads it over AHP.
    let relay = json!({"kind": "custom", "id": "leak-relay", "api": "anthropic-messages",
        "baseUrl": env.mock.anthropic_base_url(), "models": ["one"]});
    let secret = json!({ "key": KEY }).to_string();
    let (done, rx) = reply();
    core.provider_op(
        Operation::save(&relay.to_string(), Some(&secret)).expect("valid settings"),
        done,
    )
    .expect("queued");
    let saved = answer(rx).await.expect("saved");
    assert_eq!(saved["providers"][0]["hasCredential"], true, "{saved}");

    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    assert_eq!(answer(rx).await.expect("opened")["host"], "ready");
    let model = ModelRef {
        provider: "leak-relay".into(),
        id: "one".into(),
    };
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, Some(model), done)
        .expect("queued");
    let id = answer(rx).await.expect("session")["sessionId"]
        .as_str()
        .expect("id")
        .to_owned();
    let (done, rx) = reply();
    let text = prompt_text("Print the environment.", "thr04-env");
    core.session_op(id.clone(), Op::Prompt(UserInput::text(&text)), done)
        .expect("queued");
    let turn = answer(rx).await.expect("accepted")["turnId"]
        .as_str()
        .expect("turn")
        .to_owned();
    let completed = events.turn_completed(&id, &turn).await;
    assert_eq!(completed["status"], "completed", "{completed}");

    // The command's environment: what the model received as the `env` output.
    let requests = env.requests("thr04-env");
    assert_eq!(requests.len(), 2, "the relay answered both requests");
    let result = &requests[1].body;
    assert!(result.contains("PATH="), "the env output reached the model");
    assert!(
        !result.contains(KEY),
        "the vault credential is in the command environment"
    );

    // The Agent Host's own environment.
    let pid: u32 = std::fs::read_to_string(&pid_file)
        .expect("host pid")
        .trim()
        .parse()
        .expect("pid");
    process_environment::check_process_environment("Agent Host", pid, &[KEY.to_owned()]);

    // A line carrying the credential, from Core and as the Agent Host's stderr, reaches the
    // files redacted; nothing under the data directory holds it in plain text.
    tracing::warn!(target: "piarc_core", "relay rejected the key {KEY}");
    tracing::warn!(
        // piarc_telemetry::AGENT_HOST_TARGET: piarc-host logs each stderr line under it.
        target: "piarc_host::agent_host",
        "[session {id}] 401: Authorization: Bearer {KEY}"
    );
    let logs = env.data.join("logs");
    let mut text = String::new();
    for entry in std::fs::read_dir(&logs).expect("log directory").flatten() {
        text.push_str(&std::fs::read_to_string(entry.path()).expect("log file"));
    }
    assert!(
        text.contains("relay rejected the key [REDACTED:secret]"),
        "core log redacts"
    );
    assert!(
        text.contains("401: Authorization: Bearer [REDACTED:"),
        "host log redacts"
    );
    shutdown(core).await;
    let report = piarc_testkit::plaintext::scan(&[&env.data, &env.ws], &[KEY.as_bytes()], None);
    assert!(report.files > 0, "the scan read the data directory");
    assert_eq!(
        report.findings,
        [],
        "the credential is in plain text on disk"
    );
    println!(
        "THR-04: {} files ({} bytes) scanned, no plaintext; Agent Host and command environments clean",
        report.files, report.bytes
    );
}
