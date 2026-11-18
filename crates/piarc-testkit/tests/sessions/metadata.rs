//! T18: Core's metadata commands — rename, pin, archive, delete — on open and closed sessions,
//! persisted in the index and surviving a restart; deleting removes the Pi session file and the
//! session's temporary directory.

use piarc_core::sessions::{Op, SessionPrefsChange};
use serde_json::Value;

use crate::support::{Env, Events, answer, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

fn prefs(title: Option<Option<&str>>, pinned: Option<bool>, archived: Option<bool>) -> Op {
    Op::Prefs(SessionPrefsChange {
        custom_title: title.map(|t| t.map(str::to_owned)),
        pinned,
        archived,
    })
}

async fn apply(core: &piarc_core::CoreRuntime, id: &str, op: Op) -> piarc_core::Result<Value> {
    let (done, rx) = reply();
    core.session_op(id.to_owned(), op, done).expect("queued");
    answer(rx).await
}

/// Waits for a `core/sessions` snapshot in which session `id` satisfies `pred`.
async fn listed(events: &Events, id: &str, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let snapshot = events
        .until(what, |route, v| {
            route == "core/sessions"
                && v["sessions"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["id"] == id && pred(s)))
        })
        .await;
    snapshot["sessions"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == id))
        .cloned()
        .expect("listed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn titles_pins_and_archives_persist_and_delete_removes_the_files() {
    let env = Env::new("metadata").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    // Renamed before the first reply: the index has no row yet, the open session keeps it.
    apply(
        &core,
        &id,
        prefs(Some(Some("计划 · plan")), Some(true), None),
    )
    .await
    .expect("renamed while open");
    listed(&events, &id, "the live title", |s| {
        s["title"] == "计划 · plan" && s["pinned"] == true
    })
    .await;
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;

    // Closed, the list comes from the index: the title and pin were stored with the turn.
    let (done, rx) = reply();
    core.close_session(id.clone(), done).expect("queued");
    answer(rx).await.expect("closed");
    let closed = listed(&events, &id, "the stored title", |s| {
        s["open"] == false && s["title"] == "计划 · plan" && s["pinned"] == true
    })
    .await;
    assert_eq!(closed["archived"], false);

    // Closed sessions change through the index; removing the title shows the first message.
    apply(&core, &id, prefs(Some(None), Some(false), None))
        .await
        .expect("renamed while closed");
    listed(&events, &id, "the derived title", |s| {
        s["title"]
            .as_str()
            .is_some_and(|t| t.starts_with("Question one."))
            && s["pinned"] == false
    })
    .await;
    let bad = apply(&core, &id, prefs(Some(Some(" padded ")), None, None))
        .await
        .expect_err("a padded title is refused");
    assert_eq!(
        bad.to_error_object().data.kind,
        piarc_protocol::ErrorKind::InvalidParams
    );

    // Archiving removes the session's temporary directory.
    let temp = env.data.join("sessions").join(&id);
    assert!(temp.is_dir(), "the session had a temporary directory");
    apply(&core, &id, prefs(None, None, Some(true)))
        .await
        .expect("archived");
    listed(&events, &id, "archived", |s| s["archived"] == true).await;
    assert!(!temp.exists(), "archiving removed {}", temp.display());

    let file = core
        .storage()
        .expect("storage")
        .with(|s| s.session(&id))
        .expect("open")
        .expect("read")
        .expect("indexed")
        .file_path;
    assert!(std::path::Path::new(&file).is_file());
    shutdown(core).await;

    deleted_sessions_stay_deleted(&env, &id, &file).await;
}

/// After a restart the archive flag is still there; delete removes the file and the row, and
/// the session stays deleted after another restart.
async fn deleted_sessions_stay_deleted(env: &Env, id: &str, file: &str) {
    let (core, events) = env.start(env.config(&[]));
    listed(&events, id, "archived after a restart", |s| {
        s["archived"] == true
    })
    .await;
    let (done, rx) = reply();
    core.delete_session(id.to_owned(), done).expect("queued");
    answer(rx).await.expect("deleted");
    assert!(
        !std::path::Path::new(file).exists(),
        "the Pi session file is gone"
    );
    events
        .until("the list without the session", |route, v| {
            route == "core/sessions"
                && v["sessions"]
                    .as_array()
                    .is_some_and(|s| s.iter().all(|s| s["id"] != id))
        })
        .await;
    let (done, rx) = reply();
    core.delete_session(id.to_owned(), done).expect("queued");
    let missing = answer(rx).await.expect_err("already deleted");
    assert_eq!(
        missing.to_error_object().data.kind,
        piarc_protocol::ErrorKind::SessionNotFound
    );
    shutdown(core).await;

    let (core, events) = env.start(env.config(&[]));
    let snapshot = events
        .until("the first list", |route, _| route == "core/sessions")
        .await;
    assert!(
        snapshot["sessions"]
            .as_array()
            .is_some_and(|s| s.iter().all(|s| s["id"] != id)),
        "deleted sessions stay deleted: {snapshot}"
    );
    shutdown(core).await;
}

/// The same while the workspace's Agent Host is still starting: the decision must not let a
/// request reach the first process, which is about to restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trust_decision_while_the_agent_host_starts_still_lets_a_session_start() {
    let env = Env::new("trust while starting").await;
    let (core, events) = env.start(env.config(&[]));
    let (done, opened) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    // Decide as soon as Core lists the workspace as starting, before it is ready.
    events
        .until("the workspace starting", |route, v| {
            route == "core/workspaces"
                && v["workspaces"]
                    .as_array()
                    .is_some_and(|w| w.iter().any(|w| w["host"] == "starting"))
        })
        .await;
    let (decided_tx, decided_rx) = tokio::sync::oneshot::channel();
    core.trust_view(env.ws.clone(), Some(true), move |result| {
        let _ = decided_tx.send(result.map(|view| view.trusted));
    })
    .expect("queued");
    assert!(decided_rx.await.expect("answered").expect("decided"));
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, crate::support::mock_model(), done)
        .expect("queued");
    let created = answer(rx)
        .await
        .expect("the session starts on the restarted host");
    answer(opened).await.expect("the workspace opened");
    let id = created["sessionId"].as_str().expect("an id").to_owned();
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    shutdown(core).await;
}

/// Deleting an open session that is running closes it first (its Agent Host stops writing).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_an_open_session_closes_it_first() {
    let env = Env::new("delete open").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;
    let (done, rx) = reply();
    core.delete_session(id.clone(), done).expect("queued");
    answer(rx).await.expect("deleted while open");
    let (done, rx) = reply();
    core.session_op(id.clone(), Op::Prompt("again".into()), done)
        .expect("queued");
    let gone = answer(rx).await.expect_err("no longer open");
    assert_eq!(
        gone.to_error_object().data.kind,
        piarc_protocol::ErrorKind::SessionNotFound
    );
    shutdown(core).await;
}

/// A session created right after a trust decision lands on the restarted Agent Host instead of
/// failing on the one that is shutting down (T18: the trust dialog is answered, then the session
/// is created at once).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_created_right_after_a_trust_decision_starts() {
    let env = Env::new("trust then create").await;
    let (core, events) = env.start(env.config(&[]));
    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    answer(rx).await.expect("the workspace opens");
    for trusted in [true, false, true] {
        let (decided_tx, decided_rx) = tokio::sync::oneshot::channel();
        core.trust_view(env.ws.clone(), Some(trusted), move |result| {
            let _ = decided_tx.send(result.map(|view| view.trusted));
        })
        .expect("queued");
        assert_eq!(
            decided_rx.await.expect("answered").expect("decided"),
            trusted
        );
        let (done, rx) = reply();
        core.create_session(env.ws.clone(), None, crate::support::mock_model(), done)
            .expect("queued");
        let created = answer(rx)
            .await
            .expect("the session starts on the restarted host");
        let id = created["sessionId"].as_str().expect("an id").to_owned();
        let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
        assert_eq!(
            events.turn_completed(&id, &turn).await["status"],
            "completed"
        );
    }
    shutdown(core).await;
}
