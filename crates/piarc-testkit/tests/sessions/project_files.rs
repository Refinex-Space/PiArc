//! The file tool opens an indexed project independently of its Agent Host. Every operation
//! derives its root from the selected session and preserves edits if a second writer races.
use super::support::{Env, answer, mock_model, prompt_text, reply, shutdown};
use piarc_core::CoreRuntime;
use serde_json::{Value, json};

async fn request(core: &CoreRuntime, id: &str, operation: Value) -> piarc_core::Result<Value> {
    let (done, rx) = reply();
    core.project_files(id.to_owned(), operation.to_string(), done)?;
    answer(rx).await
}

fn setup_repository(env: &Env) {
    let git = |args: &[&str]| {
        let result = std::process::Command::new("git")
            .current_dir(&env.ws)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=.fixture-empty-hooks",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "git fixture: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(env.ws.join("sample.md"), "main checkout").unwrap();
    git(&["add", "sample.md"]);
    git(&["commit", "-qm", "fixture"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_follow_the_session_before_and_after_an_app_restart() {
    let env = Env::new("project-file-panel").await;
    setup_repository(&env);
    let (core, events) = env.start(env.config(&[]));
    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).unwrap();
    answer(rx).await.unwrap();
    let (done, rx) = reply();
    core.create_worktree_session(
        env.ws.clone(),
        mock_model(),
        None,
        piarc_core::sessions::WorktreeRequest {
            name: Some("files".to_owned()),
            base: None,
        },
        done,
    )
    .unwrap();
    let opened = answer(rx).await.unwrap();
    let id = opened["sessionId"].as_str().unwrap().to_owned();
    let checkout = env.ws.join(".piarc").join("worktrees").join("files");
    std::fs::write(checkout.join("sample.md"), "original").unwrap();
    let turn = super::prompt(&core, &id, &prompt_text("Hello.", "chat")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let shown = request(&core, &id, json!({"op":"read","path":"sample.md"}))
        .await
        .unwrap();
    assert_eq!(shown["text"], "original");
    shutdown(core).await;

    let (core, _events) = env.start(env.config(&[]));
    let listing = request(&core, &id, json!({"op":"list","path":""}))
        .await
        .unwrap();
    assert!(
        listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["path"] == "sample.md")
    );
    request(
        &core,
        &id,
        json!({"op":"save","path":"sample.md","revision":shown["revision"],"text":"new"}),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(checkout.join("sample.md")).unwrap(),
        "new"
    );
    assert_eq!(
        std::fs::read_to_string(env.ws.join("sample.md")).unwrap(),
        "main checkout"
    );
    assert!(
        request(
            &core,
            &id,
            json!({"op":"save","path":"sample.md","revision":shown["revision"],"text":"stale"})
        )
        .await
        .is_err()
    );
    assert!(
        request(
            &core,
            &id,
            json!({"op":"read","path":"../data 数据/pi/settings.json"})
        )
        .await
        .is_err()
    );
    assert!(
        request(&core, &id, json!({"op":"list","path":"","root":env.root}))
            .await
            .is_err()
    );
    assert!(
        request(
            &core,
            &id,
            json!({"op":"save","path":"new.txt","text":"no revision"})
        )
        .await
        .is_err()
    );
    shutdown(core).await;
}
