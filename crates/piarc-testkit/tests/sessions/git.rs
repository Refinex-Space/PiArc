//! The Git panel through Core's public API with a real Agent Host and the mock provider
//! (ADR-0084 to ADR-0087): read-only status, writes that wait for trust and refuse while a
//! session in the same root runs a turn, a commit message generated in the interface language
//! from the staged changes with secrets left out, and a PR description and a review written from
//! the branch's or the uncommitted diff, the review keeping only findings the diff can carry.

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
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
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
    std::fs::write(
        env.ws.join("login.ts"),
        "export const a = 2;\nexport const b = 3;\n",
    )
    .expect("edit");
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
    let version = core
        .trust()
        .expect("trust")
        .view(ws)
        .await
        .expect("view")
        .version;
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
    assert!(
        paths.contains(&"login.ts") && paths.contains(&"notes 笔记.md"),
        "{paths:?}"
    );

    let refused = git(
        &core,
        &id,
        json!({ "op": "stage", "paths": ["notes 笔记.md"] }),
    )
    .await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");

    trust(&core, &env.ws).await;
    let staged = git(
        &core,
        &id,
        json!({ "op": "stage", "paths": ["notes 笔记.md"] }),
    )
    .await;
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
    let unstaged = git(
        &core,
        &id,
        json!({ "op": "unstage", "paths": ["notes 笔记.md"] }),
    )
    .await;
    assert!(unstaged.get("result").is_some(), "{unstaged}");
    std::fs::write(env.ws.join("go"), "").expect("go");
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commit_messages_follow_the_language_and_leave_secrets_out() {
    let env = Env::new("git-message").await;
    repository(&env);
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;
    let request = json!({
        "op": "commitMessage",
        "language": "zh-CN",
        "instructions": "Use Conventional Commits. [[piarc-scenario:git-commit-message]]",
    });

    // The staged changes leave the machine only for a trusted project (ADR-0086, SPEC B8.1).
    let refused = git(&core, &id, request.clone()).await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");
    assert!(env.requests("git-commit-message").is_empty());
    trust(&core, &env.ws).await;

    let generated = git(&core, &id, request).await;
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
    assert!(
        !body.contains("do-not-send-this-value"),
        "the .env content reached the model"
    );
    assert!(
        !body.contains("notes 笔记.md"),
        "an unstaged file reached the model"
    );
    shutdown(core).await;
}

/// A bare remote that tracks `main`.
fn remote(env: &Env) -> std::path::PathBuf {
    let bare = env.root.join("remote 远端.git");
    let path = bare.to_str().expect("utf-8");
    run_git(
        &env.root,
        &env.root,
        &["init", "-q", "--bare", "-b", "main", path],
    );
    run_git(&env.ws, &env.root, &["remote", "add", "origin", path]);
    run_git(&env.ws, &env.root, &["push", "-q", "-u", "origin", "main"]);
    bare
}

fn head_of(dir: &Path, root: &Path, rev: &str) -> String {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("empty-git-config"))
        .args(["rev-parse", rev])
        .output()
        .expect("git");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Review findings on the write path: "always force push" leaves protected branches to plain
/// pushes (SPEC A8.2, B4.3); a path inside `.git` is refused (C5); undoing a rollback writes
/// nothing when any of its files changed since (B1.6).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protected_pushes_stay_plain_git_paths_are_refused_and_undo_is_whole() {
    let env = Env::new("git-push").await;
    repository(&env);
    run_git(&env.ws, &env.root, &["commit", "-qm", "feat: two"]);
    let bare = remote(&env);
    std::fs::write(env.ws.join("login.ts"), "export const a = 4;\n").expect("edit");
    run_git(&env.ws, &env.root, &["commit", "-qam", "feat: four"]);
    std::fs::create_dir_all(&env.data).expect("data");
    std::fs::write(
        env.data.join("settings.json"),
        json!({ "git": { "alwaysForcePush": true } }).to_string(),
    )
    .expect("settings");
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;
    trust(&core, &env.ws).await;

    // `main` is protected by default: the push goes out without a lease instead of failing.
    let pushed = git(&core, &id, json!({ "op": "push" })).await;
    assert!(pushed.get("result").is_some(), "{pushed}");
    assert_eq!(
        head_of(&bare, &env.root, "main"),
        head_of(&env.ws, &env.root, "HEAD")
    );
    // An explicit force push of a protected branch is still refused.
    let forced = git(&core, &id, json!({ "op": "push", "force": true })).await;
    assert_eq!(forced["failure"]["kind"], "protected", "{forced}");

    let config = env.ws.join(".git").join("config");
    let refused = git(
        &core,
        &id,
        json!({ "op": "rollback", "paths": [".git/config"] }),
    )
    .await;
    assert_eq!(refused["failure"]["kind"], "invalid", "{refused}");
    assert!(config.exists(), "the rollback deleted .git/config");

    std::fs::write(env.ws.join("login.ts"), "changed before rollback\n").expect("login");
    std::fs::write(env.ws.join(".env"), "API_TOKEN=changed\n").expect("env");
    let rolled = git(
        &core,
        &id,
        json!({ "op": "rollback", "paths": ["login.ts", ".env"] }),
    )
    .await;
    let restore = rolled["result"]["restoreId"]
        .as_str()
        .expect("restore id")
        .to_owned();
    let at_head = std::fs::read_to_string(env.ws.join("login.ts")).expect("read");
    std::fs::write(env.ws.join(".env"), "edited after the rollback\n").expect("edit");
    let undo = git(
        &core,
        &id,
        json!({ "op": "undoRollback", "restoreId": restore }),
    )
    .await;
    assert_eq!(undo["failure"]["kind"], "stale", "{undo}");
    assert_eq!(undo["failure"]["paths"], json!([".env"]), "{undo}");
    assert_eq!(
        std::fs::read_to_string(env.ws.join("login.ts")).expect("read"),
        at_head,
        "undo wrote some files back although another had changed"
    );
    // Put the file back as the rollback left it: the same undo works now.
    run_git(&env.ws, &env.root, &["checkout", "--", ".env"]);
    let undone = git(
        &core,
        &id,
        json!({ "op": "undoRollback", "restoreId": restore }),
    )
    .await;
    assert!(undone.get("result").is_some(), "{undone}");
    assert_eq!(
        std::fs::read_to_string(env.ws.join("login.ts")).expect("read"),
        "changed before rollback\n"
    );
    shutdown(core).await;
}

/// `main` is protected: refused before any confirmation; `topic` is deleted and restored.
async fn remote_branch_round_trip(
    core: &CoreRuntime,
    id: &str,
    env: &Env,
    bare: &Path,
    head: &str,
) {
    let protected = git(
        core,
        id,
        json!({ "op": "describe", "action": { "kind": "deleteRemoteBranch", "remote": "origin", "branch": "main" } }),
    )
    .await;
    assert_eq!(
        protected["result"]["refused"]["kind"], "protected",
        "{protected}"
    );
    let deleted = git(
        core,
        id,
        json!({ "op": "deleteRemoteBranch", "remote": "origin", "branch": "topic" }),
    )
    .await;
    let gone = &deleted["result"]["deletedRemote"];
    assert_eq!(gone["oid"], head, "{deleted}");
    assert!(!has_branch(bare, "topic"));
    let restored = git(
        core,
        id,
        json!({ "op": "restoreRemoteBranch", "remote": "origin", "branch": "topic", "oid": head }),
    )
    .await;
    assert!(restored.get("result").is_some(), "{restored}");
    assert_eq!(head_of(bare, &env.root, "refs/heads/topic"), head);
}

fn rev(dir: &Path, root: &Path, rev: &str) -> String {
    head_of(dir, root, rev)
}

fn has_branch(repo: &Path, branch: &str) -> bool {
    std::process::Command::new("git")
        .current_dir(repo)
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .status()
        .expect("git")
        .success()
}

/// G3 through Core (design addendum 9.1): history pages, writes that wait for trust, resets and
/// stash operations refused as stale when the state the dialog showed moved, and remote branch
/// deletion that leaves protected branches alone and can be undone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_operations_guard_stale_state_and_protected_branches() {
    let env = Env::new("git-history").await;
    repository(&env);
    run_git(&env.ws, &env.root, &["commit", "-qm", "feat: two"]);
    let bare = remote(&env);
    run_git(&env.ws, &env.root, &["push", "-q", "origin", "main:topic"]);
    run_git(&env.ws, &env.root, &["fetch", "-q", "origin"]);
    let first = rev(&env.ws, &env.root, "HEAD~1");
    let head = rev(&env.ws, &env.root, "HEAD");
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;

    let log = git(
        &core,
        &id,
        json!({ "op": "log", "revs": { "kind": "head" } }),
    )
    .await;
    let commits = log["result"]["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), 2, "{log}");
    assert_eq!(commits[0]["sha"], head.as_str());
    assert_eq!(commits[0]["parents"][0], first.as_str());
    let refused = git(&core, &id, json!({ "op": "cherryPick", "sha": first })).await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");
    trust(&core, &env.ws).await;

    // A hard reset's confirmation names the commits leaving and those already pushed.
    let described = git(
        &core,
        &id,
        json!({ "op": "describe", "action": { "kind": "reset", "sha": first, "mode": "hard" } }),
    )
    .await;
    assert_eq!(described["result"]["leaving"], 1, "{described}");
    assert_eq!(described["result"]["pushed"], 1, "{described}");
    let stale = git(
        &core,
        &id,
        json!({ "op": "reset", "sha": first, "mode": "mixed", "expect": first }),
    )
    .await;
    assert_eq!(stale["failure"]["kind"], "stale", "{stale}");
    assert_eq!(rev(&env.ws, &env.root, "HEAD"), head);

    // Stash the untracked note; a drop naming another commit is refused.
    let pushed = git(
        &core,
        &id,
        json!({ "op": "stashPush", "message": "笔记", "includeUntracked": true }),
    )
    .await;
    assert!(pushed.get("result").is_some(), "{pushed}");
    assert!(!env.ws.join("notes 笔记.md").exists());
    let stashes = git(&core, &id, json!({ "op": "stashes" })).await;
    let entry = &stashes["result"]["entries"][0];
    assert_eq!(entry["message"], "笔记", "{stashes}");
    let oid = entry["oid"].as_str().expect("oid").to_owned();
    let wrong = git(
        &core,
        &id,
        json!({ "op": "stashDrop", "index": 0, "oid": head }),
    )
    .await;
    assert_eq!(wrong["failure"]["kind"], "stale", "{wrong}");
    let popped = git(
        &core,
        &id,
        json!({ "op": "stashApply", "index": 0, "oid": oid, "pop": true }),
    )
    .await;
    assert!(popped.get("result").is_some(), "{popped}");
    assert!(env.ws.join("notes 笔记.md").exists());

    remote_branch_round_trip(&core, &id, &env, &bare, &head).await;

    let fetched = git(&core, &id, json!({ "op": "fetch", "background": true })).await;
    assert!(fetched.get("result").is_some(), "{fetched}");
    shutdown(core).await;
}

/// A conflict on `login.ts` between main and `topic`, with the workspace trusted.
async fn conflicted(name: &str) -> (Env, CoreRuntime, String) {
    let env = Env::new(name).await;
    repository(&env);
    run_git(&env.ws, &env.root, &["commit", "-qm", "feat: two"]);
    run_git(&env.ws, &env.root, &["switch", "-q", "-c", "topic"]);
    std::fs::write(env.ws.join("login.ts"), "export const a = 'topic';\n").expect("topic");
    run_git(&env.ws, &env.root, &["commit", "-qam", "topic: a"]);
    run_git(&env.ws, &env.root, &["switch", "-q", "main"]);
    std::fs::write(env.ws.join("login.ts"), "export const a = 'main';\n").expect("main");
    run_git(&env.ws, &env.root, &["commit", "-qam", "main: a"]);
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;
    trust(&core, &env.ws).await;
    (env, core, id)
}

/// G4 through Core (design addendum 9.2): a merge stops with a conflict whose sides are
/// labelled; the merge view's result is written only over the file it read, then resolved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_merge_conflict_is_saved_only_over_what_the_merge_view_read() {
    let (env, core, id) = conflicted("git-merge").await;
    let merged = git(
        &core,
        &id,
        json!({ "op": "merge", "branch": "topic", "mode": "ff" }),
    )
    .await;
    assert_eq!(merged["result"]["conflicts"][0], "login.ts", "{merged}");
    let sides = git(
        &core,
        &id,
        json!({ "op": "conflictSides", "path": "login.ts" }),
    )
    .await;
    let sides = &sides["result"];
    assert_eq!(sides["yours"], "export const a = 'main';\n", "{sides}");
    assert_eq!(sides["theirs"], "export const a = 'topic';\n", "{sides}");
    assert_eq!(sides["yoursLabel"], "main");
    assert_eq!(sides["theirsLabel"], "topic");
    let expect = sides["resultHash"].as_str().expect("hash").to_owned();

    // Someone edits the file after the merge view read it: the save is refused.
    let edited = std::fs::read_to_string(env.ws.join("login.ts")).expect("read") + "// edit\n";
    std::fs::write(env.ws.join("login.ts"), &edited).expect("edit");
    let content = "export const a = 'both';\n";
    let save =
        json!({ "op": "saveResolution", "path": "login.ts", "content": content, "expect": expect });
    let stale = git(&core, &id, save.clone()).await;
    assert_eq!(stale["failure"]["kind"], "stale", "{stale}");
    assert_eq!(
        std::fs::read_to_string(env.ws.join("login.ts")).expect("read"),
        edited
    );

    let sides = git(
        &core,
        &id,
        json!({ "op": "conflictSides", "path": "login.ts" }),
    )
    .await;
    let expect = sides["result"]["resultHash"].clone();
    let saved = git(
        &core,
        &id,
        json!({ "op": "saveResolution", "path": "login.ts", "content": content, "expect": expect }),
    )
    .await;
    assert!(saved.get("result").is_some(), "{saved}");
    assert_eq!(
        std::fs::read_to_string(env.ws.join("login.ts")).expect("read"),
        content
    );
    let continued = git(&core, &id, json!({ "op": "continue" })).await;
    assert!(continued.get("result").is_some(), "{continued}");
    assert_eq!(
        head_of(&env.ws, &env.root, "HEAD^2"),
        head_of(&env.ws, &env.root, "topic")
    );
    shutdown(core).await;
}

/// An interactive rebase runs only on the HEAD and commits its plan listed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interactive_rebases_follow_the_plan_they_were_given() {
    let (env, core, id) = conflicted("git-rebase-i").await;
    let first = head_of(&env.ws, &env.root, "HEAD~1");
    let plan = git(&core, &id, json!({ "op": "rebasePlan", "from": first })).await;
    let plan = &plan["result"];
    let commits = plan["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), 2, "{plan}");
    let head = plan["head"].as_str().expect("head").to_owned();
    let base = plan["base"].clone();
    let steps = |reworded: &str| {
        json!([
            { "sha": commits[0]["sha"], "action": "reword", "message": reworded },
            { "sha": commits[1]["sha"], "action": "fixup" },
        ])
    };
    let stale = git(
        &core,
        &id,
        json!({ "op": "rebaseInteractive", "base": base, "head": first, "steps": steps("x") }),
    )
    .await;
    assert_eq!(stale["failure"]["kind"], "stale", "{stale}");
    let missing = git(
        &core,
        &id,
        json!({ "op": "rebaseInteractive", "base": base, "head": head, "steps": [steps("x")[0]] }),
    )
    .await;
    assert_eq!(missing["failure"]["kind"], "stale", "{missing}");
    let done = git(
        &core,
        &id,
        json!({ "op": "rebaseInteractive", "base": base, "head": head, "steps": steps("feat: 合并后的提交") }),
    )
    .await;
    assert!(done.get("result").is_some(), "{done}");
    assert_eq!(
        head_of(&env.ws, &env.root, "HEAD~1"),
        base.as_str().expect("base")
    );
    let subject = std::process::Command::new("git")
        .current_dir(&env.ws)
        .args(["log", "-1", "--format=%s"])
        .output()
        .expect("git");
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "feat: 合并后的提交"
    );
    shutdown(core).await;
}

/// A PR description covers the branch's commits against its inferred base, leaves sensitive
/// content out, and runs only in a trusted project (ADR-0087).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_request_descriptions_cover_the_branch_against_its_base() {
    let env = Env::new("git-pr-description").await;
    repository(&env);
    run_git(&env.ws, &env.root, &["checkout", "-qb", "feature/login"]);
    run_git(
        &env.ws,
        &env.root,
        &["commit", "-qm", "feat: validate login"],
    );
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;
    let request = json!({
        "op": "prDescription",
        "language": "en",
        "instructions": "Keep it short. [[piarc-scenario:git-pr-description]]",
    });

    let refused = git(&core, &id, request.clone()).await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");
    assert!(env.requests("git-pr-description").is_empty());
    trust(&core, &env.ws).await;

    let drafted = git(&core, &id, request).await;
    let result = &drafted["result"];
    assert_eq!(result["title"], "Validate the login form", "{drafted}");
    assert_eq!(
        result["body"], "## Summary\n- Checks both fields before sending.",
        "{drafted}"
    );
    assert_eq!(result["withheld"], json!([".env"]), "{drafted}");

    let requests = env.requests("git-pr-description");
    assert_eq!(requests.len(), 1);
    let body = &requests[0].body;
    for expected in [
        "Keep it short.",
        "Language: write in English.",
        "Branch: feature/login",
        "Compared with: main",
        "- feat: validate login",
        "export const b = 3;",
        "[content withheld: sensitive]",
    ] {
        assert!(body.contains(expected), "{expected} missing from {body}");
    }
    assert!(
        !body.contains("feat: start"),
        "a commit of the base reached the model"
    );
    assert!(
        !body.contains("do-not-send-this-value"),
        "the .env content reached the model"
    );
    shutdown(core).await;
}

/// A review keeps only findings on a file Core sent and a line that file has; it covers a
/// branch or the uncommitted changes, never one commit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reviews_keep_only_findings_on_lines_the_diff_has() {
    let env = Env::new("git-review").await;
    repository(&env);
    std::fs::write(
        env.ws.join("login.ts"),
        "export const a = 2;\nexport const b = 3; // [[piarc-scenario:git-review]]\n",
    )
    .expect("edit");
    let (core, _events) = env.start(env.config(&[]));
    let id = open(&core, &env).await;
    let request =
        json!({ "op": "review", "scope": { "kind": "uncommitted" }, "language": "zh-CN" });

    let refused = git(&core, &id, request.clone()).await;
    assert_eq!(refused["failure"]["kind"], "untrusted", "{refused}");
    trust(&core, &env.ws).await;
    let one = git(
        &core,
        &id,
        json!({ "op": "review", "scope": { "kind": "commit", "sha": "HEAD" }, "language": "en" }),
    )
    .await;
    assert_eq!(one["failure"]["kind"], "invalid", "{one}");
    assert!(env.requests("git-review").is_empty());

    let reviewed = git(&core, &id, request).await;
    let result = &reviewed["result"];
    assert_eq!(
        result["scope"],
        json!({ "kind": "uncommitted" }),
        "{reviewed}"
    );
    assert_eq!(result["summary"], "Adds a second export.", "{reviewed}");
    assert_eq!(
        result["findings"],
        json!([{
            "path": "login.ts",
            "line": 2,
            "severity": "high",
            "title": "b is never checked",
            "body": "Check it.",
        }]),
        "{reviewed}"
    );
    assert_eq!(result["dropped"], 3, "{reviewed}");
    assert_eq!(result["withheld"], json!([".env"]), "{reviewed}");

    let requests = env.requests("git-review");
    assert_eq!(requests.len(), 1);
    let body = &requests[0].body;
    assert!(body.contains("Simplified Chinese"), "{body}");
    assert!(body.contains("export const b = 3;"), "{body}");
    assert!(
        !body.contains("do-not-send-this-value"),
        "the .env content reached the model"
    );
    assert!(
        !body.contains("notes 笔记.md"),
        "an untracked file reached the model"
    );
    shutdown(core).await;
}

/// A fake `gh` in a directory with a space and Chinese characters: it logs its arguments, keeps
/// the body it reads from stdin, and answers "no pull request" until one was created.
#[cfg(unix)]
fn fake_gh(env: &Env) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = env.root.join("fake gh 工具");
    std::fs::create_dir_all(&dir).expect("dir");
    let log = dir.join("calls.log");
    let at = |name: &str| dir.join(name).to_str().expect("utf-8").to_owned();
    let pr = r#"{"number":8,"title":"Validate the login form","state":"OPEN","isDraft":true,"url":"https://github.com/octo/app/pull/8","baseRefName":"main","headRefName":"feature/login","reviewDecision":null,"mergeable":"MERGEABLE","statusCheckRollup":[]}"#;
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" --- >> '{log}'\ncase \"$1 $2\" in\n  \"pr view\") if [ -f '{created}' ]; then echo '{pr}'; else echo 'no pull requests found for branch \"feature/login\"' >&2; exit 1; fi ;;\n  \"pr create\") cat > '{body}'; touch '{created}'; echo https://github.com/octo/app/pull/8 ;;\n  \"pr merge\") exit 0 ;;\nesac\n",
        log = at("calls.log"),
        created = at("created"),
        body = at("body.md"),
    );
    let program = dir.join("gh");
    std::fs::write(&program, script).expect("script");
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("mode");
    (dir, log)
}

/// A feature branch whose remote names GitHub but pushes to a local bare repository, and Core's
/// settings with the fake `gh` first on the command `PATH`.
#[cfg(unix)]
fn github_fixture(
    env: &Env,
) -> (
    piarc_core::CoreConfig,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    repository(env);
    run_git(
        &env.ws,
        &env.root,
        &["commit", "-qm", "feat: validate login"],
    );
    let bare = remote(env);
    run_git(&env.ws, &env.root, &["checkout", "-qb", "feature/login"]);
    run_git(
        &env.ws,
        &env.root,
        &["remote", "set-url", "origin", "git@github.com:octo/app.git"],
    );
    run_git(
        &env.ws,
        &env.root,
        &[
            "config",
            "remote.origin.pushurl",
            bare.to_str().expect("utf-8"),
        ],
    );
    let (dir, log) = fake_gh(env);
    let mut config = env.config(&[]);
    let Some(piarc_core::tool_io::CommandEnv::Fixed(vars)) = &mut config.command_env else {
        panic!("a fixed command environment")
    };
    for (key, value) in vars.iter_mut() {
        if key.to_string_lossy().eq_ignore_ascii_case("PATH") {
            let mut path = dir.clone().into_os_string();
            path.push(":");
            path.push(&*value);
            *value = path;
        }
    }
    (config, dir, log, bare)
}

/// The open pull request is described for the confirmation, a stale number is refused, and the
/// merge runs with the chosen method.
#[cfg(unix)]
async fn merge_round_trip(core: &CoreRuntime, id: &str, log: &Path) {
    let open_pr = git(core, id, json!({ "op": "pullRequest" })).await;
    assert_eq!(open_pr["result"]["pr"]["number"], 8, "{open_pr}");
    let described = git(
        core,
        id,
        json!({ "op": "describe", "action": { "kind": "mergePullRequest", "number": 8 } }),
    )
    .await;
    assert_eq!(
        described["result"]["message"], "Validate the login form",
        "{described}"
    );
    assert_eq!(described["result"]["remote"], "octo/app", "{described}");
    let stale = git(
        core,
        id,
        json!({ "op": "describe", "action": { "kind": "mergePullRequest", "number": 9 } }),
    )
    .await;
    assert_eq!(stale["result"]["refused"]["kind"], "stale", "{stale}");
    let merged = git(
        core,
        id,
        json!({ "op": "mergePullRequest", "number": 8, "method": "squash" }),
    )
    .await;
    assert!(merged.get("result").is_some(), "{merged}");
    let calls = std::fs::read_to_string(log).expect("log");
    assert!(
        calls.contains("pr\nmerge\n--repo=github.com/octo/app\n--squash\n--\n8\n---"),
        "{calls}"
    );
}

/// GitHub through the user's `gh` (ADR-0085 rule 9): nothing runs in an untrusted project, the
/// branch is pushed before the pull request is opened, the repository comes from the remote's
/// URL, and a remote that is not on GitHub is reported as such.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pull_requests_open_and_merge_through_the_users_gh() {
    let env = Env::new("git-github").await;
    let (config, dir, log, bare) = github_fixture(&env);
    let (core, _events) = env.start(config);
    let id = open(&core, &env).await;

    let untrusted = git(&core, &id, json!({ "op": "pullRequest" })).await;
    assert_eq!(untrusted["result"]["gh"], "untrusted", "{untrusted}");
    assert!(!log.exists(), "gh ran in an untrusted project");
    trust(&core, &env.ws).await;

    let none = git(&core, &id, json!({ "op": "pullRequest" })).await;
    assert_eq!(none["result"]["gh"], "ready", "{none}");
    assert_eq!(none["result"]["repo"], "octo/app", "{none}");
    assert!(none["result"].get("pr").is_none(), "{none}");

    let body = "## Summary\n- 校验登录表单\n";
    let created = git(
        &core,
        &id,
        json!({ "op": "createPullRequest", "title": "--web", "body": body, "base": "main", "draft": true }),
    )
    .await;
    assert_eq!(
        created["result"]["url"], "https://github.com/octo/app/pull/8",
        "{created}"
    );
    assert_eq!(
        head_of(&bare, &env.root, "refs/heads/feature/login"),
        head_of(&env.ws, &env.root, "HEAD"),
        "the branch was pushed first"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("body.md")).expect("body"),
        body
    );
    let calls = std::fs::read_to_string(&log).expect("log");
    // A title that looks like a flag stays the title's value.
    assert!(
        calls.contains(
            "pr\ncreate\n--repo=github.com/octo/app\n--base=main\n--head=feature/login\n--title=--web\n--body-file=-\n--draft\n---"
        ),
        "{calls}"
    );

    merge_round_trip(&core, &id, &log).await;

    run_git(
        &env.ws,
        &env.root,
        &[
            "remote",
            "set-url",
            "origin",
            "https://gitlab.example.invalid/octo/app.git",
        ],
    );
    let elsewhere = git(&core, &id, json!({ "op": "pullRequest" })).await;
    assert_eq!(elsewhere["result"]["gh"], "notGithub", "{elsewhere}");
    shutdown(core).await;
}
