//! ADR-0082: the Agent Hosts' proxy. A new proxy restarts the idle Agent Host with it, the
//! loopback stays direct, and the same proxy again changes nothing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::permissions::{allow, pending};
use crate::support::{Env, answer, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

/// Starts the Agent Host through a wrapper that appends its pid and proxy variables to the
/// returned file at every start (in the Agent Host's own directory, which its Seatbelt profile
/// lets it write).
fn record_host_env(env: &Env, config: &mut piarc_core::CoreConfig) -> PathBuf {
    let Some(piarc_core::agent_host::AgentHostLaunch::Custom { bundle, .. }) =
        &mut config.sessions.launch
    else {
        panic!("expected development host")
    };
    let wrapper = env.root.join("proxy-host.mjs");
    let starts = env.data.join("agent-host").join("starts.jsonl");
    std::fs::write(
        &wrapper,
        format!(
            "import {{appendFileSync}} from 'node:fs';\nimport {{pathToFileURL}} from 'node:url';\n\
             appendFileSync({}, JSON.stringify({{pid: process.pid, https: process.env.HTTPS_PROXY ?? null, http: process.env.HTTP_PROXY ?? null, noProxy: process.env.NO_PROXY ?? null, useEnv: process.env.NODE_USE_ENV_PROXY ?? null}}) + '\\n');\n\
             await import(pathToFileURL({}).href);",
            serde_json::to_string(&starts).expect("path"),
            serde_json::to_string(bundle).expect("bundle"),
        ),
    )
    .expect("wrapper");
    *bundle = wrapper;
    starts
}

fn read_starts(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).expect("a start record"))
        .collect()
}

/// Waits (30 s at most) until `file` lists `count` starts.
async fn starts(file: &Path, count: usize) -> Vec<Value> {
    for _ in 0..300 {
        let seen = read_starts(file);
        if seen.len() >= count {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "no Agent Host start {count} within 30 s: {:?}",
        read_starts(file)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_proxy_restarts_the_idle_host_with_it_and_the_loopback_stays_direct() {
    let env = Env::new("proxy 代理").await;
    let mut config = env.config(&[]);
    let file = record_host_env(&env, &mut config);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let first = starts(&file, 1).await;
    assert!(first[0]["https"].is_null(), "{first:?}");

    // The system's proxy as the main process resolves it (the choice is `auto` by default).
    core.set_system_proxy(Some("HTTP://127.0.0.1:9/".into()))
        .expect("set the system proxy");
    let second = starts(&file, 2).await;
    assert_ne!(second[1]["pid"], second[0]["pid"]);
    assert_eq!(second[1]["https"], "http://127.0.0.1:9");
    assert_eq!(second[1]["http"], "http://127.0.0.1:9");
    assert_eq!(second[1]["noProxy"], "localhost,127.0.0.1,::1");
    assert_eq!(second[1]["useEnv"], "1");

    // The session reopened on the new process and reaches the loopback model directly: the
    // proxy at port 9 would refuse.
    let turn = prompt(&core, &id, &prompt_text("Through no proxy", "chat")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );

    // The same proxy again: nothing restarts.
    core.set_system_proxy(Some("http://127.0.0.1:9".into()))
        .expect("set it again");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(read_starts(&file).len(), 2);
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_turn_finishes_on_the_old_host_and_the_proxy_applies_after_it() {
    let env = Env::new("proxy busy 代理").await;
    let mut config = env.config(&[]);
    let file = record_host_env(&env, &mut config);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    starts(&file, 1).await;
    // The turn waits for an approval: the session is busy.
    let turn = prompt(&core, &id, &prompt_text("Write.", "pending-approval")).await;
    let (card, _) = pending(&events, &id).await;
    core.set_system_proxy(Some("http://127.0.0.1:9".into()))
        .expect("set the system proxy");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(read_starts(&file).len(), 1, "no restart while a turn runs");
    let (done, rx) = reply();
    core.answer_approval(allow(&card), done).expect("queued");
    answer(rx).await.expect("answered");
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    // Once idle, the Agent Host restarts with the proxy.
    let after = starts(&file, 2).await;
    assert_eq!(after[1]["https"], "http://127.0.0.1:9");
    shutdown(core).await;
}
