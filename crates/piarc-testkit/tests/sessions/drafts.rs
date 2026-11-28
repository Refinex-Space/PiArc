//! Draft sessions (ADR-0099): the new-session view opens one for its tools before the first
//! message. Session lists leave it out until its first input; the first prompt makes it an
//! ordinary session; a draft left without a message is discarded with the terminal it opened,
//! and a session that took an input is never discarded.

use piarc_core::tool_io::UserTerminal;
use serde_json::Value;

use crate::prompt;
use crate::support::{Env, Events, answer, prompt_text, reply, shutdown};

/// The session `id` in the last `core/sessions` snapshot.
fn listed(events: &Events, id: &str) -> Option<Value> {
    events.on("core/sessions").pop().and_then(|snapshot| {
        snapshot["sessions"]
            .as_array()?
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
    })
}

/// The status of session `session`'s task in the last `core/tasks` snapshot.
fn task_status(events: &Events, session: &str) -> Option<Value> {
    events.on("core/tasks").pop().and_then(|snapshot| {
        snapshot["tasks"]
            .as_array()?
            .iter()
            .find(|t| t["sessionId"] == session)
            .map(|t| t["status"].clone())
    })
}

async fn create_draft(core: &piarc_core::CoreRuntime, env: &Env) -> String {
    let (done, rx) = reply();
    core.create_draft_session(env.ws.clone(), done)
        .expect("queued");
    let created = answer(rx).await.expect("the draft opens");
    created["sessionId"].as_str().expect("an id").to_owned()
}

async fn discard(core: &piarc_core::CoreRuntime, id: &str) -> piarc_core::Result<Value> {
    let (done, rx) = reply();
    core.discard_draft_session(id.to_owned(), done)
        .expect("queued");
    answer(rx).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_is_listed_as_one_until_its_first_prompt_and_then_is_kept() {
    let env = Env::new("draft prompt").await;
    let (core, events) = env.start(env.config(&[]));
    let id = create_draft(&core, &env).await;
    events
        .wait("the draft is listed as a draft", |e| {
            listed(e, &id).is_some_and(|s| s["draft"] == true && s["open"] == true)
        })
        .await;

    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;
    events
        .wait("the session is no longer a draft", |e| {
            listed(e, &id).is_some_and(|s| s.get("draft").is_none())
        })
        .await;
    let refused = discard(&core, &id).await.expect_err("not a draft any more");
    assert!(refused.to_string().contains("not a draft"), "{refused}");
    assert!(listed(&events, &id).is_some(), "the conversation stays");
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discarding_a_draft_removes_it_and_stops_its_terminal() {
    let env = Env::new("draft discard").await;
    let (core, events) = env.start(env.config(&[]));
    let id = create_draft(&core, &env).await;
    let (done, rx) = reply();
    let request = UserTerminal {
        size: (80, 24, 8, 16),
        restore: None,
        directory: None,
    };
    core.open_session_terminal(id.clone(), request, done)
        .expect("queued");
    answer(rx).await.expect("the draft's terminal opens");
    events
        .wait("the terminal runs", |e| {
            task_status(e, &id).is_some_and(|s| s == "running")
        })
        .await;

    discard(&core, &id).await.expect("discarded");
    events
        .wait("the draft leaves the snapshot", |e| {
            e.on("core/sessions").pop().is_some_and(|s| {
                s["sessions"]
                    .as_array()
                    .is_some_and(|l| !l.iter().any(|s| s["id"] == id.as_str()))
            })
        })
        .await;
    events
        .wait("its terminal stopped", |e| task_status(e, &id).is_none())
        .await;
    assert!(
        !env.data.join("sessions").join(&id).exists(),
        "its directory is gone"
    );
    let again = discard(&core, &id)
        .await
        .expect_err("nothing left to discard");
    assert!(again.to_string().contains(&id), "{again}");
    shutdown(core).await;
}
