//! Permission recovery through Core's public API. Each test has its own mock and workspace.

use std::process::Command;

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::sessions::Op;
use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision, ApprovalRequest, PermissionMode};
use serde_json::Value;

use crate::support::{Env, Events, answer, node, prompt_text, reply, shutdown};
use crate::{open_session, prompt, window};

fn view<'a>(snapshot: &'a Value, id: &str) -> Option<&'a Value> {
    snapshot["sessions"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == id)
}

async fn pending(events: &Events, id: &str) -> (ApprovalRequest, u64) {
    let snapshot = events
        .until("pending approval", |route, v| {
            route == "core/sessions" && view(v, id).is_some_and(|s| s["pendingApprovals"] == 1)
        })
        .await;
    (
        serde_json::from_value(view(&snapshot, id).expect("session")["approvals"][0].clone())
            .expect("approval"),
        snapshot["revision"].as_u64().expect("revision"),
    )
}

fn allow(card: &ApprovalRequest) -> ApprovalAnswer {
    ApprovalAnswer {
        request_id: card.request_id.clone(),
        session_id: card.session_id.clone(),
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
    }
}

fn assert_model_received_expiry(env: &Env) {
    let requests = env.requests("pending-approval");
    let body = requests
        .last()
        .expect("next model request")
        .body_json()
        .expect("JSON");
    let blocks = body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter_map(|m| m["content"].as_array())
        .flatten();
    let refused = blocks
        .filter(|b| b["type"] == "tool_result" && b["tool_use_id"] == "waiting")
        .collect::<Vec<_>>();
    assert_eq!(refused.len(), 1, "{body}");
    assert_eq!(refused[0]["is_error"], true);
    assert!(
        refused[0]["content"]
            .to_string()
            .contains("approval expired"),
        "{}",
        refused[0]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashed_host_expires_the_card_and_the_next_model_request_contains_the_refusal() {
    let env = Env::new("expired approval").await;
    let mut config = env.config(&[]);
    // The wrapper records only this isolated test's Agent Host pid, on either platform.
    let Some(AgentHostLaunch::Custom { bundle, .. }) = &mut config.sessions.launch else {
        panic!("expected development host")
    };
    let wrapper = env.root.join("host.mjs");
    // Inside the Agent Host's own directory, which its Seatbelt profile lets it write (T39).
    let pid_file = env.data.join("agent-host").join("host.pid");
    std::fs::write(&wrapper, format!(
        "import {{writeFileSync}} from 'node:fs';\nimport {{pathToFileURL}} from 'node:url';\nwriteFileSync({},String(process.pid));\nawait import(pathToFileURL({}).href);",
        serde_json::to_string(&pid_file).expect("path"), serde_json::to_string(bundle).expect("bundle"))).expect("wrapper");
    *bundle = wrapper;
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    prompt(&core, &id, &prompt_text("Write.", "pending-approval")).await;
    let (card, revision) = pending(&events, &id).await;
    let pid = std::fs::read_to_string(pid_file)
        .expect("host pid")
        .parse::<u32>()
        .expect("pid");
    let killed = Command::new(node())
        .args([
            "-e",
            "process.kill(Number(process.argv[1]),'SIGKILL')",
            &pid.to_string(),
        ])
        .status()
        .expect("kill this host");
    assert!(killed.success());
    events
        .until("new snapshot removed the old card", |route, v| {
            route == "core/sessions"
                && v["revision"].as_u64().is_some_and(|r| r > revision)
                && view(v, &id).is_some_and(|s| {
                    s["pendingApprovals"] == 0
                        && s["approvals"].as_array().is_some_and(Vec::is_empty)
                })
        })
        .await;
    let (done, rx) = reply();
    core.answer_approval(allow(&card), done).expect("queued");
    assert_eq!(
        answer(rx).await.expect("old answer")["status"],
        "alreadyHandled"
    );
    let turn = prompt(&core, &id, "Explain why the write was skipped.").await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    assert_model_received_expiry(&env);
    let history = window(&core, &id, None).await;
    assert!(
        history["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|row| row["item"]["itemId"] == "waiting" && row["item"]["status"] == "declined")
    );
    assert!(!env.ws.join("pending.txt").exists());
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_one_answer_applies_and_the_mode_entry_survives_core_restart() {
    let env = Env::new("restore permission mode").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Write.", "pending-approval")).await;
    let (card, _) = pending(&events, &id).await;
    let mut stale = allow(&card);
    stale.revision += 1;
    let (done, rx) = reply();
    core.answer_approval(stale, done).expect("queued");
    assert_eq!(answer(rx).await.expect("stale answer")["status"], "stale");
    let (a, ar) = reply();
    let (b, br) = reply();
    core.answer_approval(allow(&card), a)
        .expect("first contender");
    core.answer_approval(allow(&card), b)
        .expect("second contender");
    let (a, b) = tokio::join!(answer(ar), answer(br));
    let mut statuses = [
        a.expect("first answer")["status"].clone(),
        b.expect("second answer")["status"].clone(),
    ];
    statuses.sort_by(|x, y| x.as_str().cmp(&y.as_str()));
    assert_eq!(statuses, ["alreadyHandled", "applied"]);
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let (done, rx) = reply();
    core.session_op(
        id.clone(),
        Op::SetPermissionMode(PermissionMode::AcceptEdits),
        done,
    )
    .expect("queued");
    answer(rx).await.expect("accepted");
    events
        .until("live mode row", |r, v| {
            r == format!("session/{id}")
                && v["method"] == "item/completed"
                && v["params"]["item"]["type"] == "permissionModeChanged"
        })
        .await;
    shutdown(core).await;

    let (core, events) = env.start(env.config(&[]));
    let (done, rx) = reply();
    core.resume_session(id.clone(), done).expect("queued");
    answer(rx).await.expect("resumed");
    events
        .until("restored mode", |r, v| {
            r == "core/sessions"
                && view(v, &id).is_some_and(|s| s["permissionMode"] == "acceptEdits")
        })
        .await;
    let history = window(&core, &id, None).await;
    assert!(
        history["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|row| row["item"]["type"] == "permissionModeChanged"
                && row["item"]["mode"] == "acceptEdits")
    );
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_larger_than_an_ahp_frame_is_approved_before_all_bytes_are_written() {
    // The surrogate pair falls across the first UTF-16 chunk boundary.
    let content = "x".repeat(256 * 1024 - 1) + "🙂" + &"文".repeat(3 * 1024 * 1024);
    let response = serde_json::json!({ "id": "large-input", "steps": [
        { "tool_calls": [{ "id": "large", "name": "Write", "input": {"path":"large.txt","content":content}}] },
        { "text": "Stored." }
    ]});
    let scenario = piarc_testkit::Scenario::from_json_str("large-input", &response.to_string())
        .expect("scenario");
    drop(response);
    let env = Env::with_scenario("large permission input", Some(scenario)).await;
    // A generated model response of this size exceeds the ordinary chat fixture's
    // context. Give this mock a window large enough for the actual next model request.
    let model_file = env.data.join("pi/models.json");
    let mut models: Value =
        serde_json::from_slice(&std::fs::read(&model_file).expect("models")).expect("JSON");
    let model = &mut models["providers"]["piarc-mock"]["models"][0];
    model["contextWindow"] = serde_json::json!(16_000_000);
    model["maxTokens"] = serde_json::json!(4_000_000);
    std::fs::write(model_file, models.to_string()).expect("test model limits");
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Write the file.", "large-input")).await;
    let (card, _) = pending(&events, &id).await;
    assert_eq!(card.tool, "Write");
    assert!(
        card.diff
            .as_ref()
            .is_some_and(|diff| diff.created == Some(true) && diff.degraded == Some(true))
    );
    let file = env.ws.join("large.txt");
    assert!(!file.exists());
    let (done, rx) = reply();
    core.answer_approval(allow(&card), done).expect("queued");
    assert_eq!(answer(rx).await.expect("approved")["status"], "applied");
    let completed = events.turn_completed(&id, &turn).await;
    assert!(
        std::fs::read(file).expect("the approved file") == content.as_bytes(),
        "exact content"
    );
    assert_eq!(completed["status"], "completed", "{completed}");
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupting_a_pending_approval_closes_the_card_and_marks_the_tool_interrupted() {
    let env = Env::new("interrupted approval").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Write.", "pending-approval")).await;
    let (card, revision) = pending(&events, &id).await;
    let (done, rx) = reply();
    core.session_op(id.clone(), Op::Abort, done).expect("abort");
    answer(rx)
        .await
        .expect("abort completes without a user answer");
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "interrupted"
    );
    events
        .until("card closed", |r, v| {
            r == "core/sessions"
                && v["revision"].as_u64().is_some_and(|n| n > revision)
                && view(v, &id).is_some_and(|s| s["pendingApprovals"] == 0)
        })
        .await;
    let items = events.of(&id, "item/completed");
    let item = items
        .iter()
        .map(|p| &p["item"])
        .find(|i| i["itemId"] == "waiting")
        .expect("completed tool");
    assert_eq!(item["status"], "interrupted");
    assert!(!env.ws.join("pending.txt").exists());
    let (done, rx) = reply();
    core.answer_approval(allow(&card), done)
        .expect("stale card");
    assert_eq!(
        answer(rx).await.expect("status")["status"],
        "alreadyHandled"
    );
    shutdown(core).await;
}
