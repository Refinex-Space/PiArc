//! The Git panel through Core's public API with a real Agent Host and the mock provider
//! (ADR-0084 to ADR-0086): read-only status, writes that wait for trust and refuse while a
//! session in the same root runs a turn, and a commit message generated in the interface
//! language from the staged changes with secrets left out.

use std::path::Path;

use super::support::{Env, answer, mock_model, prompt_text, reply, shutdown};
use piarc_core::CoreRuntime;
use serde_json::{Value, json};

async fn git(core: &CoreRuntime, id: &str, request: Value) -> Value {
    let (done, rx) = reply();
    core.git_request(
        id.to_owned(),
        json!({ "opId": "op-1", "request": request }).to_string(),
        done,
    )
    .expect("queued");
    answer(rx).await.expect("answered")
}

fn run_git(dir: &Path, root: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("empty-git-config"))
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .output()
        .expect("git");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

/// A repository in the workspace: one commit, then a staged change, a staged `.env` and an
/// untracked file. The home's global config gives git an identity.
fn repository(env: &Env) {
    let home = env.root.join("home");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n",
    )
    .expect("gitconfig");
    run_git(&env.ws, &env.root, &["init", "-q", "-b", "main"]);
    std::fs::write(env.ws.join("login.ts"), "export const a = 1;\n").expect("file");
    run_git(&env.ws, &env.root, &["add", "login.ts"]);
    run_git(&env.ws, &env.root, &["commit", "-qm", "feat: start"]);
    std::fs::write(env.ws.join("login.ts"), "export const a = 2;\nexport const b = 3;\n").expect("edit");
    std::fs::write(env.ws.join(".env"), "API_TOKEN=do-not-send-this-value\n").expect("env");
    run_git(&env.ws, &env.root, &["add", "login.ts", ".env"]);
    std::fs::write(env.ws.join("notes 笔记.md"), "draft\n").expect("untracked");
}

async fn open(core: &CoreRuntime, env: &Env) -> String {
    let (done, rx) = reply();
    core.open_workspace(env.ws.clone(), done).expect("queued");
    answer(rx).await.expect("workspace");
    let (done, rx) = reply();
    core.create_session(env.ws.clone(), None, mock_model(), done)
        .expect("queued");
    answer(rx).await.expect("session")["sessionId"]
        .as_str()
        .expect("id")
        .to_owned()
}

async fn trust(core: &CoreRuntime, ws: &Path) {
    let version = core.trust().expect("trust").view(ws).await.expect("view").version;
    let (tx, rx) = tokio::sync::oneshot::channel();
    core.trust_view(ws.to_path_buf(), Some((true, version)), move |result| {
        let _ = tx.send(result.map(|view| view.trusted));
    })
    .expect("queued");
    assert!(rx.await.expect("answered").expect("decided"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_reads_and_writes_wait_for_trust_and_idle_sessions() {
    let env = Env::new("git-trust").await;
    repository(&env);
    let (core, events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;

    let status = git(&core, &id, json!({ "op": "status" })).await;
    let repo = &status["result"]["repository"];
    assert_eq!(repo["branch"], "main", "{status}");
    assert_eq!(repo["writable"], false, "{status}");
    let paths: Vec<&str> = status["result"]["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|f| f["path"].as_str())
        .collect();
    assert!(paths.contains(&"login.ts") && paths.contains(&"notes 笔记.md"), "{paths:?}");

    let refused = git(&core, &id, json!({ "op": "stage", "paths": ["notes 笔记.md"] })).await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");

    trust(&core, &env.ws).await;
    let staged = git(&core, &id, json!({ "op": "stage", "paths": ["notes 笔记.md"] })).await;
    assert!(staged.get("result").is_some(), "{staged}");

    // A running turn in the same root blocks operations that rewrite files, not staging.
    let turn = super::prompt(&core, &id, &prompt_text("Wait.", "git-wait")).await;
    events
        .until("the command runs", |route, value| {
            route == format!("session/{id}") && value.to_string().contains("toolu_git_wait")
        })
        .await;
    let busy = git(&core, &id, json!({ "op": "checkout", "target": "main" })).await;
    assert_eq!(busy["failure"]["kind"], "sessionBusy", "{busy}");
    let unstaged = git(&core, &id, json!({ "op": "unstage", "paths": ["notes 笔记.md"] })).await;
    assert!(unstaged.get("result").is_some(), "{unstaged}");
    std::fs::write(env.ws.join("go"), "").expect("go");
    assert_eq!(events.turn_completed(&id, &turn).await["status"], "completed");
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commit_messages_follow_the_language_and_leave_secrets_out() {
    let env = Env::new("git-message").await;
    repository(&env);
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;

    let generated = git(
        &core,
        &id,
        json!({
            "op": "commitMessage",
            "language": "zh-CN",
            "instructions": "Use Conventional Commits. [[piarc-scenario:git-commit-message]]",
        }),
    )
    .await;
    let result = &generated["result"];
    assert_eq!(result["text"], "feat(login): 校验登录表单", "{generated}");
    assert_eq!(result["withheld"], json!([".env"]), "{generated}");

    let requests = env.requests("git-commit-message");
    assert_eq!(requests.len(), 1);
    let body = &requests[0].body;
    assert!(body.contains("Simplified Chinese"), "{body}");
    assert!(body.contains("Use Conventional Commits."), "{body}");
    assert!(body.contains("export const b = 3;"), "{body}");
    assert!(body.contains("[content withheld: sensitive]"), "{body}");
    assert!(!body.contains("do-not-send-this-value"), "the .env content reached the model");
    assert!(!body.contains("notes 笔记.md"), "an unstaged file reached the model");
    shutdown(core).await;
}
