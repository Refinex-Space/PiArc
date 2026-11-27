//! Removing a workspace from the list (the sidebar's "Remove project"): its running session
//! closes and its background task stops, neither it nor its sessions are listed, its files
//! stay, and opening the folder again lists it with its sessions.

use serde_json::Value;

use crate::support::{Env, Events, answer, mock_model, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

/// The last snapshot delivered on `route`.
fn last(events: &Events, route: &str) -> Value {
    events.on(route).pop().unwrap_or(Value::Null)
}

fn lists_workspace(snapshot: &Value, path: &str) -> bool {
    snapshot["workspaces"]
        .as_array()
        .is_some_and(|w| w.iter().any(|w| w["path"] == path))
}

fn lists_session(snapshot: &Value, id: &str) -> bool {
    snapshot["sessions"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["id"] == id))
}

fn task_status(events: &Events, call: &str) -> Option<Value> {
    events.on("core/tasks").iter().rev().find_map(|snapshot| {
        snapshot["tasks"]
            .as_array()?
            .iter()
            .find(|t| t["toolCallId"] == call)
            .map(|t| t["status"].clone())
    })
}

async fn workspace_work(core: &piarc_core::CoreRuntime, path: &str) -> Value {
    let (done, rx) = reply();
    core.workspace_work(path.into(), done).expect("queued");
    answer(rx).await.expect("the workspace's work")
}

/// Creates a second session and starts a turn that keeps running; returns its id.
async fn start_running_session(
    core: &piarc_core::CoreRuntime,
    env: &Env,
    events: &Events,
) -> String {
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, mock_model(), done)
        .expect("queued");
    let running = answer(rx).await.expect("the session opens")["sessionId"]
        .as_str()
        .expect("an id")
        .to_owned();
    prompt(
        core,
        &running,
        &prompt_text("Run the three tools.", "abort-tools"),
    )
    .await;
    events
        .wait("the session runs", |e| {
            last(e, "core/sessions")["sessions"]
                .as_array()
                .is_some_and(|s| {
                    s.iter()
                        .any(|s| s["id"] == running.as_str() && s["status"] == "running")
                })
        })
        .await;
    running
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_workspace_stops_its_work_leaves_the_list_and_comes_back_when_opened() {
    let env = Env::new("remove workspace").await;
    let (core, events) = env.start(env.config(&[]));
    let waiting = open_session(&core, &env).await;
    let path = last(&events, "core/workspaces")["workspaces"][0]["path"]
        .as_str()
        .expect("the listed workspace")
        .to_owned();

    // A background command that runs until the test releases it (never, here).
    let turn = prompt(
        &core,
        &waiting,
        &prompt_text("Wait in the background.", "bg-command"),
    )
    .await;
    events.turn_completed(&waiting, &turn).await;
    events
        .wait("the task runs", |e| {
            task_status(e, "toolu_bg").is_some_and(|s| s == "running")
        })
        .await;
    let running = start_running_session(&core, &env, &events).await;
    assert_eq!(
        workspace_work(&core, &path).await,
        serde_json::json!({ "sessions": 1, "tasks": 1 })
    );

    let (done, rx) = reply();
    core.remove_workspace(path.clone().into(), done)
        .expect("queued");
    answer(rx).await.expect("removed");
    events
        .wait("the workspace and its sessions leave the list", |e| {
            let sessions = last(e, "core/sessions");
            !lists_workspace(&last(e, "core/workspaces"), &path)
                && !lists_session(&sessions, &waiting)
                && !lists_session(&sessions, &running)
        })
        .await;
    events
        .wait("the task stopped", |e| {
            task_status(e, "toolu_bg").is_some_and(|s| s == "killed")
        })
        .await;
    assert_eq!(
        workspace_work(&core, &path).await,
        serde_json::json!({ "sessions": 0, "tasks": 0 })
    );
    assert!(env.ws.is_dir(), "the folder stays");

    // Opening the folder lists it again with its sessions, closed. The session stopped in its
    // first turn has no file (Pi writes it with the first reply), so closing it left nothing to
    // list, removed or not.
    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    answer(rx).await.expect("the workspace opens again");
    events
        .wait("the workspace and its session are listed again", |e| {
            lists_workspace(&last(e, "core/workspaces"), &path)
                && last(e, "core/sessions")["sessions"]
                    .as_array()
                    .is_some_and(|s| {
                        s.iter()
                            .any(|s| s["id"] == waiting.as_str() && s["open"] == false)
                    })
        })
        .await;
    shutdown(core).await;
}

/// A folder deleted after it was opened can still be removed from the list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_folder_is_removed_from_the_list() {
    let env = Env::new("remove deleted workspace").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let path = last(&events, "core/workspaces")["workspaces"][0]["path"]
        .as_str()
        .expect("the listed workspace")
        .to_owned();
    let (done, rx) = reply();
    core.close_workspace(env.ws.clone(), done).expect("queued");
    answer(rx).await.expect("closed");
    std::fs::remove_dir_all(&env.ws).expect("the folder is deleted");

    let (done, rx) = reply();
    core.remove_workspace(path.clone().into(), done)
        .expect("queued");
    answer(rx).await.expect("removed");
    events
        .wait("the workspace and its session leave the list", |e| {
            !lists_workspace(&last(e, "core/workspaces"), &path)
                && !lists_session(&last(e, "core/sessions"), &id)
        })
        .await;
    shutdown(core).await;
}

/// A client that resumes the session the removal just closed (the window still shows it) does
/// not open the workspace behind the list: once removed, opening the folder lists it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resuming_a_session_while_its_workspace_is_removed_does_not_keep_it_open() {
    let env = Env::new("remove while resuming").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Question one.", "chat")).await;
    events.turn_completed(&id, &turn).await;
    let path = last(&events, "core/workspaces")["workspaces"][0]["path"]
        .as_str()
        .expect("the listed workspace")
        .to_owned();

    let core = std::sync::Arc::new(core);
    let removing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let resumer = {
        let (core, removing, id) = (core.clone(), removing.clone(), id.clone());
        tokio::spawn(async move {
            while removing.load(std::sync::atomic::Ordering::SeqCst) {
                let (done, rx) = reply();
                core.resume_session(id.clone(), done).expect("queued");
                // Refused while the workspace is being removed; fine before and after.
                let _ = answer(rx).await;
            }
        })
    };
    let (done, rx) = reply();
    core.remove_workspace(path.clone().into(), done)
        .expect("queued");
    answer(rx).await.expect("removed");
    removing.store(false, std::sync::atomic::Ordering::SeqCst);
    resumer.await.expect("the resumer ends");
    events
        .wait("the workspace leaves the list", |e| {
            !lists_workspace(&last(e, "core/workspaces"), &path)
        })
        .await;
    // Once removed, resuming its session (a window that still shows it) is refused and lists
    // nothing again; only opening the folder or starting a session in it does.
    let (done, rx) = reply();
    core.resume_session(id.clone(), done).expect("queued");
    let refused = answer(rx)
        .await
        .expect_err("a removed workspace does not reopen");
    assert!(
        refused.to_string().contains("removed from the list"),
        "{refused}"
    );
    let (done, rx) = reply();
    core.workspace_work(path.clone().into(), done)
        .expect("queued");
    answer(rx).await.expect("its work");
    assert!(!lists_workspace(&last(&events, "core/workspaces"), &path));

    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    answer(rx).await.expect("the workspace opens again");
    events
        .wait("the workspace and its session are listed again", |e| {
            lists_workspace(&last(e, "core/workspaces"), &path)
                && lists_session(&last(e, "core/sessions"), &id)
        })
        .await;
    let core = std::sync::Arc::into_inner(core).expect("the only reference");
    shutdown(core).await;
}
