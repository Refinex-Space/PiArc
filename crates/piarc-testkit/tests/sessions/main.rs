//! T14: session orchestration end to end through Core's headless runtime: the real Agent Host
//! bundle on Node, the strict mock provider, and Core's actors in between. Provider scripts
//! are in `scenarios/`.

mod input;
mod lifecycle;
mod login;
mod mcp;
mod metadata;
mod models;
mod permissions;
mod provider_settings;
mod queue;
mod rewind;
mod sandbox;
mod support;
mod tasks;
mod turns;

use piarc_core::composer::UserInput;
use piarc_core::sessions::Op;
use serde_json::Value;
use support::{Env, answer, mock_model, prompt_text, reply, shutdown, user_texts};

/// Opens the workspace and a session in it; returns the session id.
pub(crate) async fn open_session(core: &piarc_core::CoreRuntime, env: &Env) -> String {
    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    let workspace = answer(rx).await.expect("the workspace opens");
    assert_eq!(workspace["host"], "ready", "{workspace}");
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, mock_model(), done)
        .expect("queued");
    let created = answer(rx).await.expect("the session opens");
    created["sessionId"].as_str().expect("an id").to_owned()
}

/// Starts a turn and returns its id.
pub(crate) async fn prompt(core: &piarc_core::CoreRuntime, id: &str, text: &str) -> String {
    let (done, rx) = reply();
    core.session_op(id.to_owned(), Op::Prompt(UserInput::text(text)), done)
        .expect("queued");
    let accepted = answer(rx).await.expect("the prompt is accepted");
    accepted["turnId"].as_str().expect("a turn id").to_owned()
}

/// The last transcript items of a session.
pub(crate) async fn window(core: &piarc_core::CoreRuntime, id: &str, start: Option<u64>) -> Value {
    let (done, rx) = reply();
    core.transcript_window(id.to_owned(), start, 50, done)
        .expect("queued");
    answer(rx).await.expect("a window")
}

/// T14-A11: after Core restarts, the session list comes from the index, the resumed session's
/// next request carries the whole conversation, and the transcript window is the same as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restarted_core_lists_resumes_and_shows_the_same_transcript() {
    let env = Env::new("restart").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    for (n, text) in ["Question one.", "Question two."].iter().enumerate() {
        let text = if n == 0 {
            prompt_text(text, "chat")
        } else {
            (*text).to_owned()
        };
        let turn = prompt(&core, &id, &text).await;
        assert_eq!(
            events.turn_completed(&id, &turn).await["status"],
            "completed"
        );
    }
    let before = window(&core, &id, Some(0)).await;
    assert_eq!(before["total"], 4, "{before}");
    shutdown(core).await;

    let (core, events) = env.start(env.config(&[]));
    let listed = events
        .until("the session in the list", |route, v| {
            route == "core/sessions"
                && v["sessions"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["id"] == id.as_str()))
        })
        .await;
    let entry = listed["sessions"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == id.as_str()))
        .expect("listed")
        .clone();
    println!("restored list entry: {entry}");
    assert_eq!(entry["open"], false);
    assert_eq!(
        entry["title"].as_str(),
        Some(prompt_text("Question one.", "chat").as_str())
    );
    // Pi records its system prompt as the first message entry: system + 2 × (user, assistant).
    assert_eq!(entry["messageCount"], 5);

    let after = window(&core, &id, Some(0)).await;
    assert_eq!(after, before, "the transcript window survived the restart");
    let (done, rx) = reply();
    core.resume_session(id.clone(), done).expect("queued");
    let resumed = answer(rx).await.expect("resumed");
    assert_eq!(resumed["restoredMessages"], 5, "{resumed}");
    let turn = prompt(&core, &id, "Question three.").await;
    let completed = events.turn_completed(&id, &turn).await;
    assert_eq!(completed["status"], "completed", "{completed}");
    let requests = env.requests("chat");
    let last = requests.last().expect("a request");
    let users = user_texts(&last.body);
    println!("the resumed request carries: {users:?}");
    assert_eq!(
        users,
        [
            prompt_text("Question one.", "chat"),
            "Question two.".into(),
            "Question three.".into()
        ]
    );
    assert!(last.body.contains("First answer.") && last.body.contains("Second answer."));
    shutdown(core).await;
}
