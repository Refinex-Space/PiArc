//! T32 through Core's runtime and the real Agent Host: a background command survives the Agent
//! Host's crash and its notice still reaches the next request (A09), and quitting PiArc ends
//! every background tree, which a restarted Core shows as interrupted (A10).

use std::time::Duration;

use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision, ApprovalRequest};
use serde_json::Value;

use crate::support::{Env, kill_host, prompt_text, record_host_pid, reply, shutdown};
use crate::{open_session, prompt};

/// Waits until `file` in the workspace holds a line; returns it.
async fn line_of(env: &Env, file: &str) -> String {
    let path = env.ws.join(file);
    let read = async {
        loop {
            if let Ok(text) = std::fs::read_to_string(&path)
                && text.ends_with('\n')
            {
                return text.trim().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(crate::support::WAIT, read)
        .await
        .unwrap_or_else(|_| panic!("{file} never appeared"))
}

/// Whether process `pid` exists (tasklist on Windows).
fn alive(pid: &str) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&out.stdout).contains(pid)
    } else {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .expect("kill runs")
            .success()
    }
}

/// The latest snapshot row of the task started by tool call `call`.
fn task_row(events: &crate::support::Events, call: &str) -> Option<Value> {
    events.on("core/tasks").iter().rev().find_map(|snapshot| {
        snapshot["tasks"]
            .as_array()?
            .iter()
            .find(|t| t["toolCallId"] == call)
            .cloned()
    })
}

/// Allows the session's one pending approval once (the command writes pid files).
async fn approve(core: &piarc_core::CoreRuntime, events: &crate::support::Events, id: &str) {
    let snapshot = events
        .until("the command's approval", |route, v| {
            route == "core/sessions"
                && v["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|s| s["id"] == id && s["pendingApprovals"] == 1)
        })
        .await;
    let session = snapshot["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["id"] == id)
        .expect("the session");
    let card: ApprovalRequest =
        serde_json::from_value(session["approvals"][0].clone()).expect("a card");
    let answer = ApprovalAnswer {
        elicitation: None,
        confirmed_url: None,
        request_id: card.request_id,
        session_id: card.session_id,
        revision: card.revision,
        connection_epoch: card.connection_epoch,
        decision: ApprovalDecision::AllowOnce,
        rules: Vec::new(),
        directory: None,
        domain: None,
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
}

/// T32-A09: the Agent Host is killed while a background command runs. The command goes on (it
/// finishes once the test releases it, after the crash), Core records its end, and the
/// session's next request carries the completion notice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_command_survives_an_agent_host_crash_and_its_notice_arrives() {
    let env = Env::new("bg-crash").await;
    let mut config = env.config(&[]);
    let pid_file = record_host_pid(&env, &mut config);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(
        &core,
        &id,
        &prompt_text("Wait in the background.", "bg-command"),
    )
    .await;
    events.turn_completed(&id, &turn).await;
    events
        .wait("the task runs", |e| {
            task_row(e, "toolu_bg").is_some_and(|t| t["status"] == "running")
        })
        .await;
    let first_host = std::fs::read_to_string(&pid_file).expect("host pid");
    kill_host(&pid_file);
    // The supervisor starts a new process and reopens the session.
    events
        .wait("a new Agent Host", |_| {
            std::fs::read_to_string(&pid_file).is_ok_and(|pid| pid != first_host)
        })
        .await;
    assert_eq!(
        task_row(&events, "toolu_bg").expect("the task")["status"],
        "running",
        "the command outlived the Agent Host"
    );
    std::fs::write(env.ws.join("release"), "").expect("released");
    events
        .wait("the task ended", |e| {
            task_row(e, "toolu_bg").is_some_and(|t| t["status"] == "completed")
        })
        .await;
    let ended = task_row(&events, "toolu_bg").expect("the task");
    assert_eq!(ended["exitCode"], 0);
    assert_eq!(ended["tail"], serde_json::json!(["finished-bg"]));
    let next = prompt(&core, &id, "Did it finish?").await;
    assert_eq!(
        events.turn_completed(&id, &next).await["status"],
        "completed"
    );
    let last = env
        .requests("bg-command")
        .last()
        .expect("a request")
        .body
        .clone();
    assert!(last.contains("has ended.\\nCommand: while"), "{last}");
    assert!(last.contains("Status: completed successfully"), "{last}");
    assert!(last.contains("Last lines:\\nfinished-bg"), "{last}");
    shutdown(core).await;
}

/// T32-A10: Core quits while a background command runs with a child and a grandchild that
/// ignores SIGTERM: the whole tree ends, and a Core started again on the same data directory
/// lists the task as interrupted without running it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quitting_ends_background_trees_and_a_restart_shows_them_interrupted() {
    let env = Env::new("bg-quit").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Start the tree.", "bg-tree")).await;
    approve(&core, &events, &id).await;
    events.turn_completed(&id, &turn).await;
    let child = line_of(&env, "child.pid").await;
    let grand = line_of(&env, "grand.pid").await;
    assert!(alive(&child) && alive(&grand), "the tree runs");
    let task = task_row(&events, "toolu_tree").expect("the task")["taskId"].clone();
    shutdown(core).await;
    for (name, pid) in [("child", &child), ("grandchild", &grand)] {
        assert!(!alive(pid), "the {name} {pid} outlived PiArc");
    }

    let (core, events) = env.start(env.config(&[]));
    events
        .until("the interrupted task", |route, snapshot| {
            route == "core/tasks"
                && snapshot["tasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|t| t["taskId"] == task && t["status"] == "interrupted")
        })
        .await;
    shutdown(core).await;
}
