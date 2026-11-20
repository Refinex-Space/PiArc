//! T27 through the real Agent Host and the mock (the paths L2 cannot drive through Core's
//! public API): a background task's reminder (`session/remind`, T32's entry point) reaches the
//! next model request with the system prompt unchanged, a keyed Monitor reminder wakes an idle
//! session once (T32), and the instructions of invoked skills
//! (a simulated `piarc.skillInvoked` record, T37's) are given back after a compaction within
//! their limits.

use std::io::Write;

use piarc_core::agent_host::{HostEvent, HostSupervisor};
use piarc_protocol::context::{ReminderType, SessionRemind, SessionRemindParams};
use piarc_protocol::session::{SessionCompact, SessionCompactParams, SessionId};
use serde_json::{Value, json};

use crate::harness::{Env, Recorder, SMALL_WINDOW_SCENARIO, open};

const SCRIPT: &str = r#"
id: small-window
steps:
  - text: "First."
  - text: "Second."
  - text: "Summary of the session."
  - text: "Third."
"#;

fn system_of(body: &str) -> Value {
    serde_json::from_str::<Value>(body).expect("request body")["system"].clone()
}

/// Appends a custom entry to the session's file, after its last entry.
fn append_entry(env: &Env, session: &SessionId, custom_type: &str, data: &Value) {
    let entries = env.session_entries(&session.0);
    let last = entries.last().expect("entries");
    let sessions = env.data_dir.join("pi").join("sessions");
    let file = std::fs::read_dir(&sessions)
        .expect("sessions")
        .flatten()
        .flat_map(|dir| std::fs::read_dir(dir.path()).expect("group").flatten())
        .map(|f| f.path())
        .find(|path| std::fs::read_to_string(path).is_ok_and(|text| text.contains(&session.0)))
        .expect("the session file");
    let id = format!("{:08x}", rand_id());
    let entry = json!({
        "type": "custom",
        "customType": custom_type,
        "data": data,
        "id": id,
        "parentId": last["id"],
        "timestamp": last["timestamp"],
    });
    let mut out = std::fs::OpenOptions::new()
        .append(true)
        .open(file)
        .expect("session file opens");
    writeln!(out, "{entry}").expect("entry appended");
}

fn rand_id() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    nanos ^ std::process::id()
}

/// A started Agent Host with one `mock-small` session that has answered one prompt.
async fn started(name: &str) -> (Env, HostSupervisor, Recorder, SessionId) {
    let env = Env::new(
        name,
        &[SCRIPT],
        json!({ "compaction": { "keepRecentTokens": 1 } }),
    )
    .await;
    let (supervisor, mut events, core) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { epoch: 1, .. }))
        .await;
    let session = open(&supervisor, &core, &env.cwd(0), "mock-small").await;
    let turn = supervisor
        .prompt(&session, "r1", "Hello.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    (env, supervisor, events, session)
}

#[tokio::test(flavor = "multi_thread")]
async fn background_task_reminders_reach_the_next_request() {
    let (env, supervisor, mut events, session) = started("context remind").await;
    // Only background task reminders are accepted.
    let wrong = supervisor
        .session_call::<SessionRemind>(
            &session,
            None,
            SessionRemindParams {
                session_id: session.clone(),
                kind: ReminderType::FileModified,
                source: "x".into(),
                text: "y".into(),
                key: None,
                wake: false,
            },
        )
        .await
        .expect_err("refused");
    assert!(wrong.to_string().contains("backgroundTask"), "{wrong}");
    let remind = SessionRemindParams {
        session_id: session.clone(),
        kind: ReminderType::BackgroundTask,
        source: "npm test".into(),
        text: "The command exited with code 0.".into(),
        key: None,
        wake: false,
    };
    supervisor
        .session_call::<SessionRemind>(&session, None, remind)
        .await
        .expect("queued");
    let turn = supervisor
        .prompt(&session, "r2", "Next.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    let requests = env.requests(SMALL_WINDOW_SCENARIO);
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .body
            .contains("Background task npm test:\\nThe command exited with code 0."),
        "{}",
        requests[1].body
    );
    assert!(requests[1].body.contains("[PiArc reminder]"));
    assert!(!requests[0].body.contains("Background task"));
    assert_eq!(system_of(&requests[0].body), system_of(&requests[1].body));
    supervisor.shutdown().await;
}

/// T32: a keyed `monitorOutput` reminder with `wake` starts a turn of the idle session whose
/// input is the reminder; the same reminder sent again is recognized as delivered, a newer one
/// waits for the next request and replaces nothing that was delivered.
#[tokio::test(flavor = "multi_thread")]
async fn a_keyed_reminder_wakes_the_idle_session_once() {
    let (env, supervisor, mut events, session) = started("context wake").await;
    let monitor = |source: &str, text: &str, wake: bool| SessionRemindParams {
        session_id: session.clone(),
        kind: ReminderType::MonitorOutput,
        source: source.into(),
        text: text.into(),
        key: Some("monitor:bg-0a1b2c3d4e5f".into()),
        wake,
    };
    let first = "Monitor bg-0a1b2c3d4e5f (日志): 2 new lines.\nerror A\nerror B";
    let woke = supervisor
        .session_call::<SessionRemind>(&session, None, monitor("bg-0a1b2c3d4e5f@2", first, true))
        .await
        .expect("queued");
    let turn = woke.turn_id.expect("the idle session woke");
    assert!(!woke.delivered);
    assert_eq!(events.turn_completed(&turn).await["status"], "completed");
    let again = supervisor
        .session_call::<SessionRemind>(&session, None, monitor("bg-0a1b2c3d4e5f@2", first, true))
        .await
        .expect("answered");
    assert!(again.delivered && again.turn_id.is_none(), "{again:?}");
    let later = supervisor
        .session_call::<SessionRemind>(
            &session,
            None,
            monitor(
                "bg-0a1b2c3d4e5f@3",
                "Monitor bg-0a1b2c3d4e5f (日志): 1 new line.\nerror C",
                false,
            ),
        )
        .await
        .expect("queued");
    assert!(!later.delivered && later.turn_id.is_none());
    let next = supervisor
        .prompt(&session, "r3", "And now?")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&next.0).await["status"], "completed");
    let requests = env.requests(SMALL_WINDOW_SCENARIO);
    assert_eq!(requests.len(), 3);
    assert!(requests[1].body.contains("[PiArc reminder]"));
    assert!(
        requests[1]
            .body
            .contains("2 new lines.\\nerror A\\nerror B"),
        "{}",
        requests[1].body
    );
    assert!(!requests[1].body.contains("And now?"));
    assert_eq!(
        requests[2].body.matches("2 new lines.").count(),
        1,
        "delivered once"
    );
    assert!(requests[2].body.contains("1 new line.\\nerror C"));
    assert_eq!(system_of(&requests[0].body), system_of(&requests[2].body));
    supervisor.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invoked_skills_come_back_after_a_compaction_within_their_limits() {
    let (env, supervisor, mut events, session) = started("context skills").await;
    // Two invoked skills, one over the 5K-token limit.
    supervisor.close_session(&session).await.expect("closed");
    append_entry(
        &env,
        &session,
        "piarc.skillInvoked",
        &json!({ "name": "lint", "content": "Run the linter before every commit." }),
    );
    append_entry(
        &env,
        &session,
        "piarc.skillInvoked",
        &json!({ "name": "huge", "content": "h".repeat(30_000) }),
    );
    supervisor
        .resume_session(&session, &env.cwd(0), None)
        .await
        .expect("resumed");
    let accepted = supervisor
        .session_call::<SessionCompact>(
            &session,
            Some("compact-1"),
            SessionCompactParams {
                session_id: session.clone(),
                request_id: "compact-1".into(),
                instructions: Some("Keep the test results.".into()),
            },
        )
        .await
        .expect("compaction accepted");
    assert_eq!(
        events.turn_completed(&accepted.turn_id.0).await["status"],
        "completed"
    );
    let turn = supervisor
        .prompt(&session, "r2", "Go on.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");
    let requests = env.requests(SMALL_WINDOW_SCENARIO);
    assert_eq!(requests.len(), 3);
    assert!(
        requests[1]
            .body
            .contains("Focus requested by the user: Keep the test results.")
    );
    let after = &requests[2].body;
    assert!(
        after.contains("Instructions of the skill \\\"huge\\\""),
        "{after}"
    );
    assert!(
        after.contains("Instructions of the skill \\\"lint\\\""),
        "{after}"
    );
    assert!(after.contains("Run the linter before every commit."));
    assert!(
        after.contains("more tokens left out]"),
        "the huge skill is cut"
    );
    let huge = after.matches('h').count();
    assert!(
        huge < 20_000 + 2_000,
        "{huge} h characters: at most about 5K tokens"
    );
    assert_eq!(system_of(&requests[0].body), system_of(after));
    supervisor.shutdown().await;
}
