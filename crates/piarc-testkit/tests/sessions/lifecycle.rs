//! Workspace and session lifecycle: warm-up and idle reclaim (T14-A09), snapshot revisions
//! (A10), fork and close (A12, Core side).

use std::sync::Arc;
use std::time::Duration;

use piarc_core::clock::ManualClock;
use piarc_core::composer::UserInput;
use piarc_core::sessions::Op;
use serde_json::Value;

use crate::support::{
    Env, answer, kill_host, mock_model, prompt_text, record_host_pid, reply, shutdown, user_texts,
};
use crate::{open_session, prompt};

fn host_of(snapshot: &Value, ws: &std::path::Path) -> Option<String> {
    // Core reports the canonical path without the verbatim `\\?\` prefix `canonicalize` adds on
    // Windows.
    let ws = std::fs::canonicalize(ws).expect("workspace");
    let ws = ws.to_string_lossy();
    let ws = if cfg!(windows) {
        ws.strip_prefix(r"\\?\").unwrap_or(&ws)
    } else {
        &ws
    };
    snapshot["workspaces"]
        .as_array()?
        .iter()
        .find(|w| w["path"].as_str() == Some(ws))
        .and_then(|w| w["host"].as_str())
        .map(str::to_owned)
}

/// T14-A09: opening the workspace starts its Agent Host; once every session stayed idle for the
/// threshold (on the injected clock) the process is stopped; the next prompt starts it again,
/// reopens the session and the request carries its history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_workspace_stops_its_agent_host_and_the_next_prompt_restarts_it() {
    let env = Env::new("reclaim").await;
    let clock = ManualClock::new();
    let threshold = Duration::from_secs(30 * 60);
    let mut config = env.config(&[]);
    config.sessions.clock = Arc::clone(&clock) as _;
    config.sessions.idle_timeout = threshold;
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;
    let last_host = |e: &crate::support::Events| {
        e.on("core/workspaces")
            .last()
            .and_then(|s| host_of(s, &env.ws))
    };
    // The turn's end armed the idle timer: short of the threshold nothing happens ...
    while clock.sleepers() == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    clock.advance(threshold - Duration::from_secs(60));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(last_host(&events).as_deref(), Some("ready"), "not yet");
    // ... and at the threshold the Agent Host is stopped (stepping in minutes covers a timer
    // armed a moment after the first step).
    let mut reclaimed = false;
    for _ in 0..40 {
        clock.advance(Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(100)).await;
        if last_host(&events).as_deref() == Some("reclaimed") {
            reclaimed = true;
            break;
        }
    }
    assert!(reclaimed, "the Agent Host was reclaimed");

    let turn = prompt(&core, &id, "Question two.").await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let hosts: Vec<String> = events
        .on("core/workspaces")
        .iter()
        .filter_map(|s| host_of(s, &env.ws))
        .collect();
    println!("host states: {hosts:?}");
    let reclaimed = hosts
        .iter()
        .position(|h| h == "reclaimed")
        .expect("reclaimed");
    assert!(hosts[reclaimed..].iter().any(|h| h == "starting"));
    assert_eq!(hosts.last().map(String::as_str), Some("ready"));
    let last = env.requests("chat").last().expect("a request").body.clone();
    assert_eq!(
        user_texts(&last),
        [prompt_text("Question one.", "chat"), "Question two.".into()],
        "the reopened session kept its history"
    );
    assert!(last.contains("First answer."));
    shutdown(core).await;
}

/// T31: a running background subagent keeps its workspace's Agent Host. The main session's
/// turn is over, but the idle timer must not stop the process (that would end the run); once
/// the run is stopped the timer applies again. The child never shows in the session list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_background_subagent_keeps_the_agent_host() {
    let env = Env::new("reclaim-subagent").await;
    let clock = ManualClock::new();
    let threshold = Duration::from_secs(30 * 60);
    let mut config = env.config(&[]);
    config.sessions.clock = Arc::clone(&clock) as _;
    config.sessions.idle_timeout = threshold;
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(
        &core,
        &id,
        &prompt_text("Survey in the background.", "bg-subagent"),
    )
    .await;
    events.turn_completed(&id, &turn).await;
    child_request(&env).await;
    events
        .wait("the run's start", |e| {
            !e.of(&id, "subagent/started").is_empty()
        })
        .await;
    let child = events.of(&id, "subagent/started")[0]["subagent"]["sessionId"]
        .as_str()
        .expect("the child's id")
        .to_owned();
    let last_host = |e: &crate::support::Events| {
        e.on("core/workspaces")
            .last()
            .and_then(|s| host_of(s, &env.ws))
    };
    for _ in 0..40 {
        clock.advance(Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        last_host(&events).as_deref(),
        Some("ready"),
        "the Agent Host stays while the subagent runs"
    );

    let (done, rx) = reply();
    core.stop_subagent(id.clone(), child.clone(), done)
        .expect("queued");
    assert_eq!(answer(rx).await.expect("stopped")["stopped"], true);
    events
        .wait("the run's end", |e| {
            !e.of(&id, "subagent/completed").is_empty()
        })
        .await;
    let mut reclaimed = false;
    for _ in 0..40 {
        clock.advance(Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(100)).await;
        if last_host(&events).as_deref() == Some("reclaimed") {
            reclaimed = true;
            break;
        }
    }
    assert!(reclaimed, "idle again once the run ended");
    let listed: Vec<String> = events
        .on("core/sessions")
        .iter()
        .flat_map(|s| s["sessions"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect();
    assert!(listed.contains(&id));
    assert!(
        !listed.contains(&child),
        "children stay out of the session list"
    );
    shutdown(core).await;
}

/// Waits until the mock received the subagent's request (`bg-subagent-child`). It sends no
/// event, so this polls the mock's records instead of waiting on the event list.
async fn child_request(env: &Env) {
    let polled = async {
        while env.requests("bg-subagent-child").is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(crate::support::WAIT, polled)
        .await
        .expect("the subagent's request reached the mock");
}

/// T31: the Agent Host stops while the main session waits for a foreground subagent. The
/// main session's turn becomes uncertain (ADR-0009), Core lets go of the child's registration
/// and keeps it out of the session list, and the next prompt carries an interrupted result for
/// the `Agent` call (ADR-0026).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_during_a_foreground_subagent_leaves_the_call_interrupted() {
    let env = Env::new("crash-subagent").await;
    let mut config = env.config(&[]);
    let pid_file = record_host_pid(&env, &mut config);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Survey and wait.", "fg-subagent")).await;
    child_request(&env).await;
    events
        .wait("the run's start", |e| {
            !e.of(&id, "subagent/started").is_empty()
        })
        .await;
    let child = events.of(&id, "subagent/started")[0]["subagent"]["sessionId"]
        .as_str()
        .expect("the child's id")
        .to_owned();
    kill_host(&pid_file);
    events
        .wait("the turn became uncertain", |e| {
            e.of(&id, "session/uncertain")
                .iter()
                .any(|p| p["turnId"] == turn.as_str())
        })
        .await;

    let next = prompt(&core, &id, "Did the survey finish?").await;
    assert_eq!(
        events.turn_completed(&id, &next).await["status"],
        "completed"
    );
    let last = env
        .requests("fg-subagent")
        .last()
        .expect("a request")
        .body
        .clone();
    let request: Value = serde_json::from_str(&last).expect("JSON request");
    let results: Vec<&Value> = request["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .filter(|b| b["type"] == "tool_result" && b["tool_use_id"] == "toolu_fg")
        .collect();
    assert_eq!(results.len(), 1, "{last}");
    assert!(
        results[0]["content"].to_string().contains("Interrupted"),
        "{}",
        results[0]
    );
    // The new process does not know the child: Core no longer routes it, and stopping it finds
    // nothing.
    let (done, rx) = reply();
    core.stop_subagent(id.clone(), child.clone(), done)
        .expect("queued");
    assert_eq!(answer(rx).await.expect("answered")["stopped"], false);
    let listed: Vec<String> = events
        .on("core/sessions")
        .iter()
        .flat_map(|s| s["sessions"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect();
    assert!(
        !listed.contains(&child),
        "children stay out of the session list"
    );
    shutdown(core).await;
}

/// T14-A10: the workspace and session list snapshots carry strictly increasing revisions in the
/// order they arrive, so a client that keeps the highest one never puts an older list over a
/// newer one; the last snapshot reflects the last state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_revisions_only_increase_and_the_last_snapshot_is_the_last_state() {
    let env = Env::new("snapshots").await;
    let (core, events) = env.start(env.config(&[]));
    let first = open_session(&core, &env).await;
    // Several sessions at once: their reports race inside Core.
    let mut created = Vec::new();
    for _ in 0..4 {
        let (done, rx) = reply();
        core.create_session(env.ws.clone(), None, mock_model(), done)
            .expect("queued");
        created.push(rx);
    }
    let mut ids = vec![first.clone()];
    for rx in created {
        let opened = answer(rx).await.expect("opened");
        ids.push(opened["sessionId"].as_str().expect("id").to_owned());
    }
    let turn = prompt(&core, &first, &prompt_text("Hello.", "chat")).await;
    events.turn_completed(&first, &turn).await;
    let (done, rx) = reply();
    core.session_op(first.clone(), Op::MarkRead, done)
        .expect("queued");
    answer(rx).await.expect("marked");
    let (done, rx) = reply();
    core.close_session(ids[4].clone(), done).expect("queued");
    answer(rx).await.expect("closed");
    core.resend_snapshots().expect("resend");

    let expected_open: Vec<&String> = ids[..4].iter().collect();
    events
        .wait("the final session list", |e| {
            e.on("core/sessions").last().is_some_and(|s| {
                let open: Vec<&str> = s["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|s| s["open"] == true)
                    .filter_map(|s| s["id"].as_str())
                    .collect();
                open.len() == 4
                    && expected_open.iter().all(|id| open.contains(&id.as_str()))
                    && s["sessions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|s| s["id"] == first.as_str() && s["unread"] == false)
            })
        })
        .await;
    for route in ["core/workspaces", "core/sessions"] {
        let revisions: Vec<u64> = events
            .on(route)
            .iter()
            .filter_map(|s| s["revision"].as_u64())
            .collect();
        println!("{route}: revisions {revisions:?}");
        assert!(revisions.len() >= 2, "{route}");
        assert!(
            revisions.windows(2).all(|pair| pair[0] < pair[1]),
            "{route}: {revisions:?}"
        );
    }
    shutdown(core).await;
}

/// T14-A12 (Core side): fork copies a session's conversation into a new open session; close
/// removes a session from the Agent Host and from the open ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_copies_the_conversation_and_close_ends_the_session() {
    let env = Env::new("fork").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;

    let (done, rx) = reply();
    core.fork_session(
        id.clone(),
        piarc_core::sessions::ForkPoint::Entry(None),
        done,
    )
    .expect("queued");
    let forked = answer(rx).await.expect("forked");
    let copy = forked["sessionId"].as_str().expect("id").to_owned();
    assert_ne!(copy, id);
    let window = crate::window(&core, &copy, Some(0)).await;
    let texts: Vec<&str> = window["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i["item"]["text"].as_str())
        .collect();
    assert_eq!(
        texts,
        [
            prompt_text("Question one.", "chat").as_str(),
            "First answer."
        ]
    );
    let turn = prompt(&core, &copy, "Question two in the copy.").await;
    assert_eq!(
        events.turn_completed(&copy, &turn).await["status"],
        "completed"
    );
    let last = env.requests("chat").last().expect("request").body.clone();
    assert_eq!(
        user_texts(&last),
        [
            prompt_text("Question one.", "chat"),
            "Question two in the copy.".into()
        ]
    );

    for session in [&copy, &id] {
        let (done, rx) = reply();
        core.close_session(session.clone(), done).expect("queued");
        answer(rx).await.expect("closed");
    }
    let (done, rx) = reply();
    core.session_op(
        id.clone(),
        Op::Prompt(UserInput::text("After close.")),
        done,
    )
    .expect("queued");
    let error = answer(rx)
        .await
        .expect_err("closed sessions take no prompts");
    assert_eq!(error.kind(), piarc_protocol::ErrorKind::SessionNotFound);
    shutdown(core).await;
}
