//! Core's state services on a real data directory (T13): the directory layout, trust keyed
//! by the main checkout (A09), decisions that survive a restart and revocation (A10, Core
//! side), `trust/get` failing closed (A11, Core side), the executable items of a decision
//! (A13) and settings change events (A08).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_config::TrustLookup;
use piarc_core::trust::{TrustService, answer_trust_get};
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SinkClosed,
};
use piarc_protocol::ErrorKind;
use serde_json::{Map, Value, json};

const WAIT: Duration = Duration::from_secs(20);

struct Batches(Mutex<Sender<EventBatch>>);

impl EventSink for Batches {
    fn deliver(&self, batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        let tx = self.0.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            tx.send(batch).map_err(|_| SinkClosed)?;
        }
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc-core {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        Self { root }
    }

    fn dirs(&self) -> DataDirs {
        DataDirs::new(self.root.join("data 数据"), self.root.join("cache")).expect("absolute")
    }

    fn start(&self) -> (CoreRuntime, Receiver<EventBatch>) {
        let (tx, rx) = channel();
        let core = CoreRuntime::start(
            CoreConfig {
                home: Some(self.root.join("home")),
                dirs: Some(self.dirs()),
                ..CoreConfig::default()
            },
            Arc::new(Batches(Mutex::new(tx))),
        )
        .expect("core starts");
        (core, rx)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=PiArc Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repo(dir: &Path) {
    std::fs::create_dir_all(dir).expect("repo");
    git(dir, &["init", "-q"]);
    std::fs::write(dir.join("README.md"), "fixture\n").expect("file");
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "initial"]);
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
}

fn trust_get_params(path: &Path) -> Map<String, Value> {
    let Value::Object(map) = json!({ "path": path.to_string_lossy() }) else {
        unreachable!()
    };
    map
}

async fn decide_current(
    trust: &TrustService,
    path: &Path,
    trusted: bool,
) -> piarc_core::Result<piarc_core::trust::TrustView> {
    let displayed = trust.view(path).await?;
    trust.decide(path, trusted, &displayed.version).await
}

async fn asked(trust: &TrustService, path: &Path) -> bool {
    trust
        .trust_get(trust_get_params(path))
        .await
        .expect("answered")["trusted"]
        == json!(true)
}

#[test]
fn the_data_directory_gets_its_layout_and_database() {
    let f = Fixture::new("layout");
    let (core, _rx) = f.start();
    let data = f.dirs().data().to_owned();
    for dir in [
        "pi/sessions",
        "sessions",
        "logs",
        "agents",
        "skills",
        "commands",
        "checkpoints/objects",
        "agent-host/tmp",
        "agent-host/npm-cache",
    ] {
        assert!(data.join(dir).is_dir(), "{dir}");
    }
    assert!(data.join("core.sqlite").is_file());
    assert!(f.dirs().cache().is_dir());
    let version = core
        .storage()
        .expect("storage")
        .with(|s| s.schema_version())
        .expect("open")
        .expect("version");
    assert_eq!(
        version,
        piarc_store::migrate::latest_version(piarc_store::MIGRATIONS)
    );
    let storage = core.storage().expect("storage");
    core.shutdown_blocking().expect("shutdown");
    // The ordered shutdown closes the database: a JavaScript `CoreRuntime` lives on until it
    // is collected, and Windows cannot delete a data directory with open files (I66).
    assert_eq!(
        storage
            .with(|s| s.schema_version())
            .expect_err("the database is closed")
            .kind(),
        ErrorKind::ShuttingDown
    );

    // Without a data directory the state services are absent, not broken.
    let (tx, _rx) = channel();
    let bare = CoreRuntime::start(CoreConfig::default(), Arc::new(Batches(Mutex::new(tx))))
        .expect("bare core");
    assert_eq!(
        bare.trust().expect_err("no trust").kind(),
        ErrorKind::InternalError
    );
    bare.shutdown_blocking().expect("shutdown");
}

/// A repository with a linked worktree and a submodule, and a plain directory.
fn projects(f: &Fixture) -> [PathBuf; 4] {
    let main = f.root.join("main repo 主");
    repo(&main);
    let linked = f.root.join("linked 树");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            linked.to_str().expect("utf-8"),
            "-b",
            "feature",
        ],
    );
    let library = f.root.join("library 库");
    repo(&library);
    git(
        &main,
        &[
            "submodule",
            "add",
            "-q",
            library.to_str().expect("utf-8"),
            "vendor/lib",
        ],
    );
    let submodule = main.join("vendor").join("lib");
    let plain = f.root.join("plain 普通");
    std::fs::create_dir_all(&plain).expect("plain");

    [main, linked, submodule, plain]
}

#[test]
fn worktrees_share_trust_submodules_and_plain_directories_do_not_and_decisions_survive_a_restart() {
    let f = Fixture::new("trust");
    let [main, linked, submodule, plain] = projects(&f);
    let rt = runtime();
    let (core, _rx) = f.start();
    let trust = core.trust().expect("trust");
    rt.block_on(async {
        for dir in [&main, &linked, &submodule, &plain] {
            assert!(
                !asked(&trust, dir).await,
                "untrusted before any decision: {}",
                dir.display()
            );
        }
        let view = decide_current(&trust, &linked, true)
            .await
            .expect("decide from the worktree");
        assert_eq!(view.kind, "linkedWorktree");
        assert!(
            asked(&trust, &main).await,
            "the main checkout shares the worktree's decision"
        );
        assert!(asked(&trust, &linked).await);
        assert!(
            asked(&trust, &main.join("vendor")).await,
            "subdirectories of the repository too"
        );
        assert!(
            !asked(&trust, &submodule).await,
            "a submodule is its own project"
        );
        assert!(!asked(&trust, &plain).await);

        decide_current(&trust, &plain, true)
            .await
            .expect("trust the plain directory");
        assert!(asked(&trust, &plain).await);
        assert!(
            !asked(&trust, &plain.join("..")).await,
            "the parent is not trusted"
        );
    });
    core.shutdown_blocking().expect("shutdown");

    // A new Core on the same data directory sees the same decisions.
    let (core, _rx) = f.start();
    let trust = core.trust().expect("trust");
    rt.block_on(async {
        assert!(asked(&trust, &linked).await, "kept across a restart");
        assert!(asked(&trust, &plain).await);
        let mut changes = trust.subscribe();
        let view = trust.revoke(&main).await.expect("revoke");
        assert!(!view.trusted && view.decision.is_none());
        let change = changes.recv().await.expect("a change is announced");
        assert!(!change.trusted);
        assert_eq!(change.checkout, piarc_git::canonical(&main).expect("main"));
        assert!(!asked(&trust, &linked).await, "revoked for every worktree");
        assert!(asked(&trust, &plain).await, "other projects keep theirs");
        decide_current(&trust, &plain, false).await.expect("deny");
        assert!(!asked(&trust, &plain).await, "a denial is not trust");
    });
    core.shutdown_blocking().expect("shutdown");
}

struct Failing;

impl TrustLookup for Failing {
    fn lookup(&self, _dir: &Path) -> Result<bool, String> {
        Err("the database is locked".into())
    }
}

struct Panicking;

impl TrustLookup for Panicking {
    fn lookup(&self, _dir: &Path) -> Result<bool, String> {
        panic!("a bug in the lookup")
    }
}

struct Slow;

impl TrustLookup for Slow {
    fn lookup(&self, _dir: &Path) -> Result<bool, String> {
        std::thread::sleep(Duration::from_millis(50));
        Ok(true)
    }
}

#[test]
fn trust_get_answers_untrusted_on_every_failure() {
    let f = Fixture::new("trust get faults");
    let rt = runtime();
    let (core, _rx) = f.start();
    let trust = core.trust().expect("trust");
    let workspace = f.root.join("ws");
    std::fs::create_dir_all(&workspace).expect("ws");
    rt.block_on(async {
        decide_current(&trust, &workspace, true)
            .await
            .expect("trusted");
        assert!(asked(&trust, &workspace).await);

        // A directory that cannot be resolved.
        assert!(!asked(&trust, &workspace.join("gone")).await);
        // Lookup failures and panics.
        for lookup in [
            Arc::new(Failing) as Arc<dyn TrustLookup>,
            Arc::new(Panicking),
        ] {
            let answer = answer_trust_get(lookup, trust_get_params(&workspace))
                .await
                .expect("answered");
            assert_eq!(answer, json!({ "trusted": false }));
        }
        // A slow but positive lookup still answers.
        let answer = answer_trust_get(Arc::new(Slow), trust_get_params(&workspace))
            .await
            .expect("answered");
        assert_eq!(answer, json!({ "trusted": true }));
        // Malformed parameters are an error, which the Agent Host also treats as untrusted.
        for params in [json!({}), json!({ "path": 3 })] {
            let Value::Object(map) = params else {
                unreachable!()
            };
            let error = trust.trust_get(map).await.expect_err("invalid");
            assert_eq!(error.data.kind, ErrorKind::InvalidParams);
        }
    });

    // A database that fails (its table dropped behind Core's back) answers untrusted.
    let other = rusqlite::Connection::open(f.dirs().database()).expect("second connection");
    other
        .execute_batch("DROP TABLE project_trust")
        .expect("drop the table");
    rt.block_on(async {
        assert!(
            !asked(&trust, &workspace).await,
            "a broken store is untrusted"
        );
    });
    drop(other);
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn a_trust_view_lists_the_items_and_what_is_new_since_the_decision() {
    let f = Fixture::new("trust view");
    let ws = f.root.join("ws 工作");
    std::fs::create_dir_all(ws.join(".piarc")).expect("ws");
    std::fs::write(
        ws.join(".piarc").join("settings.json"),
        r#"{ "permissions": { "allow": ["Bash(npm test)"] } }"#,
    )
    .expect("settings");
    std::fs::write(
        ws.join(".mcp.json"),
        r#"{ "mcpServers": { "db": { "command": "db" } } }"#,
    )
    .expect("mcp");
    let rt = runtime();
    let (core, _rx) = f.start();
    let trust = core.trust().expect("trust");
    rt.block_on(async {
        let before = trust.view(&ws).await.expect("view");
        assert_eq!(before.kind, "notGit");
        assert!(before.decision.is_none() && !before.trusted);
        assert_eq!(before.items.len(), 2);
        let decided = decide_current(&trust, &ws, true).await.expect("decide");
        assert!(decided.trusted && decided.new_items.is_empty());
        std::fs::write(
            ws.join(".piarc").join("settings.json"),
            r#"{ "permissions": { "allow": ["Bash(npm test)", "Bash(curl *)"] } }"#,
        )
        .expect("settings");
        let after = trust.view(&ws).await.expect("view");
        assert_eq!(after.items.len(), 3);
        let new: Vec<&str> = after.new_items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(new, ["Bash(curl *)"]);
        let json = serde_json::to_value(&after).expect("serializes");
        assert_eq!(json["newItems"][0]["category"], "allowRule");
        assert_eq!(json["newItems"][0]["source"], ".piarc/settings.json");
        // I63: an item the user has not confirmed keeps the whole project untrusted, in the
        // view and in the one trust query, until the user confirms again.
        assert!(!after.trusted);
        assert_eq!(after.decision, Some("trusted"));
        assert!(
            !asked(&trust, &ws).await,
            "unconfirmed items are not trusted"
        );
        let confirmed = decide_current(&trust, &ws, true).await.expect("confirm");
        assert!(confirmed.trusted && confirmed.new_items.is_empty());
        assert!(asked(&trust, &ws).await, "confirmed items are trusted");
        // Removing an item needs no confirmation.
        std::fs::remove_file(ws.join(".mcp.json")).expect("remove");
        assert!(asked(&trust, &ws).await);
        std::fs::write(ws.join(".mcp.json"), "{").expect("interrupted configuration save");
        let incomplete = trust.view(&ws).await.expect("view");
        assert!(!incomplete.unreadable.is_empty());
        assert!(!incomplete.trusted && !asked(&trust, &ws).await);
    });
    core.shutdown_blocking().expect("shutdown");
}

fn settings_events(rx: &Receiver<EventBatch>, deadline: Instant) -> Vec<Value> {
    let mut found = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left.min(Duration::from_millis(100))) {
            Ok(batch) if batch.route.as_str() == "core/settings" => {
                let events: Vec<Value> =
                    serde_json::from_slice(&batch.payload).expect("json array");
                found.extend(events);
                return found;
            }
            Ok(_) => {}
            Err(_) if found.is_empty() => {}
            Err(_) => return found,
        }
    }
    found
}

fn wait_for(rx: &Receiver<EventBatch>, what: &str, accept: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        for event in settings_events(rx, deadline) {
            if accept(&event) {
                return event;
            }
        }
    }
    panic!("no settings event: {what}");
}

#[test]
fn editing_settings_while_running_emits_changed_keys_and_invalid_files_keep_the_last_valid_content()
{
    let f = Fixture::new("settings events");
    let ws = f.root.join("ws 设置");
    std::fs::create_dir_all(&ws).expect("ws");
    let rt = runtime();
    let (core, rx) = f.start();
    let settings = rt
        .block_on(core.open_settings(ws.clone()))
        .expect("settings open");
    assert_eq!(
        settings.merged(),
        json!({ "permissions": { "defaultMode": "default" } })
    );

    // `.piarc/` does not exist yet: creating it and the file is noticed.
    std::fs::create_dir_all(ws.join(".piarc")).expect("dir");
    let project = ws.join(".piarc").join("settings.json");
    std::fs::write(
        &project,
        r#"{ "model": "m1", "permissions": { "deny": ["Bash(rm *)"] } }"#,
    )
    .expect("write");
    let event = wait_for(&rx, "first file", |e| {
        e["changed"].as_array().is_some_and(|c| !c.is_empty())
    });
    assert_eq!(event["changed"], json!(["/model", "/permissions/deny"]));
    assert_eq!(event["workspace"], json!(ws.to_string_lossy()));

    std::fs::write(
        &project,
        r#"{ "model": "m2", "permissions": { "deny": ["Bash(rm *)"] } }"#,
    )
    .expect("write");
    let event = wait_for(&rx, "model change", |e| e["changed"] == json!(["/model"]));
    assert_eq!(event["issues"], json!([]));
    assert_eq!(settings.merged()["model"], "m2");

    std::fs::write(
        &project,
        r#"{ "model": "m3", "permissions": { "deny": "everything" } }"#,
    )
    .expect("write");
    let event = wait_for(&rx, "invalid file", |e| {
        !e["issues"].as_array().is_none_or(Vec::is_empty)
    });
    assert_eq!(event["changed"], json!([]));
    assert_eq!(event["issues"][0]["pointer"], "/permissions/deny");
    assert_eq!(event["issues"][0]["severity"], "error");
    assert_eq!(event["issues"][0]["file"], json!(project.to_string_lossy()));
    assert_eq!(
        settings.merged()["model"],
        "m2",
        "the last valid content stays"
    );

    // Writing through Core goes to `.piarc/settings.local.json` and is reported like any edit.
    let written = rt
        .block_on(settings.write("projectLocal", "/permissions/allow", Some(json!(["Read"]))))
        .expect("write");
    assert_eq!(written, ws.join(".piarc").join("settings.local.json"));
    // Untrusted project: its allow rule is not merged, so no allow key changes; the project
    // file is still invalid.
    assert!(settings.merged().pointer("/permissions/allow").is_none());

    // Trusting the project merges its allow rules and reports the key.
    let trust = core.trust().expect("trust");
    rt.block_on(async { decide_current(&trust, &ws, true).await })
        .expect("trust");
    let event = wait_for(&rx, "trust change", |e| {
        e["changed"] == json!(["/permissions/allow"])
    });
    assert_eq!(event["changed"], json!(["/permissions/allow"]));
    assert_eq!(settings.merged()["permissions"]["allow"], json!(["Read"]));
    drop(settings);
    core.shutdown_blocking().expect("shutdown");
}

fn diagnostics(core: &CoreRuntime, ws: &Path) -> Value {
    let (tx, rx) = std::sync::mpsc::channel();
    core.config_diagnostics(Some(ws.to_owned()), move |result| {
        let _ = tx.send(result);
    })
    .expect("queued");
    rx.recv_timeout(WAIT).expect("answer").expect("diagnostics")
}

fn file_report<'a>(report: &'a Value, layer: &str) -> &'a Value {
    report["files"]
        .as_array()
        .expect("files")
        .iter()
        .find(|f| f["layer"] == layer)
        .unwrap_or_else(|| panic!("no {layer} in {report}"))
}

/// The end of the A09 test: a broken Claude Code file, and Core's refusal to write one.
fn broken_file_keeps_content_and_writes_are_refused(
    rt: &tokio::runtime::Runtime,
    core: &CoreRuntime,
    rx: &Receiver<EventBatch>,
    settings: &piarc_core::workspace_settings::WorkspaceSettings,
    ws: &Path,
) {
    let project = ws.join(".claude").join("settings.json");
    // A broken file is reported with its position and keeps its last valid content.
    std::fs::write(&project, "{\n  \"permissions\": {\n").expect("write");
    let event = wait_for(rx, "broken claude file", |e| {
        !e["issues"].as_array().is_none_or(Vec::is_empty)
    });
    assert_eq!(event["issues"][0]["layer"], "claudeProject");
    assert_eq!(event["issues"][0]["line"], 3);
    let report = diagnostics(core, ws);
    assert_eq!(file_report(&report, "claudeProject")["status"], "invalid");

    // Core never writes Claude Code's files.
    let error = rt
        .block_on(settings.write("claudeProject", "/permissions/allow", Some(json!(["Read"]))))
        .expect_err("read only");
    assert_eq!(
        error.to_error_object().data.kind,
        piarc_protocol::ErrorKind::PermissionDenied
    );
    assert_eq!(
        std::fs::read_to_string(&project).expect("read"),
        "{\n  \"permissions\": {\n"
    );
}

/// T24-A09: Claude Code's files are watched like PiArc's; a change reloads the settings,
/// is reported on `core/settings` and shows in the next diagnostics. A10's Core half: the
/// report lists every file with its state, applied, overridden and ignored keys.
#[test]
fn editing_claude_code_settings_while_running_reloads_and_refreshes_the_diagnostics() {
    let f = Fixture::new("claude settings");
    let ws = f.root.join("ws 设置");
    let home = f.root.join("home");
    std::fs::create_dir_all(&ws).expect("ws");
    std::fs::create_dir_all(home.join(".claude")).expect("home");
    std::fs::write(
        home.join(".claude").join("settings.json"),
        r#"{"permissions":{"deny":["Bash(home *)"],"defaultMode":"plan"}}"#,
    )
    .expect("write");
    std::fs::write(home.join(".claude.json"), r#"{"numStartups":1}"#).expect("state");
    let rt = runtime();
    let (core, rx) = f.start();
    let settings = rt
        .block_on(core.open_settings(ws.clone()))
        .expect("settings open");
    assert_eq!(
        settings.merged()["permissions"],
        json!({ "deny": ["Bash(home *)"], "defaultMode": "plan" })
    );
    let report = diagnostics(&core, &ws);
    assert_eq!(report["trusted"], false);
    assert_eq!(file_report(&report, "claudeProject")["status"], "missing");
    assert_eq!(file_report(&report, "claudeUser")["status"], "loaded");
    assert_eq!(file_report(&report, "claudeState")["status"], "loaded");

    // `.claude/` does not exist yet: creating it and its file is noticed.
    std::fs::create_dir_all(ws.join(".claude")).expect("dir");
    let project = ws.join(".claude").join("settings.json");
    std::fs::write(
        &project,
        r#"{"permissions":{"deny":["Bash(curl *)"],"defaultMode":"default"},"theme":"dark"}"#,
    )
    .expect("write");
    let event = wait_for(&rx, "claude project file", |e| {
        e["changed"].as_array().is_some_and(|c| !c.is_empty())
    });
    assert_eq!(
        event["changed"],
        json!(["/permissions/defaultMode", "/permissions/deny"])
    );
    let report = diagnostics(&core, &ws);
    let claude = file_report(&report, "claudeProject");
    assert_eq!(claude["status"], "loaded");
    assert_eq!(claude["writable"], false);
    assert_eq!(
        claude["ignored"],
        json!([{ "pointer": "/theme", "reason": "ignored", "note": "PiArc has its own theme preference" }])
    );
    let user = file_report(&report, "claudeUser");
    assert_eq!(user["overridden"][0]["pointer"], "/permissions/defaultMode");
    assert_eq!(user["overridden"][0]["source"], "claudeProject");
    assert_eq!(user["overridden"][0]["finalValue"], "default");

    // The user-level file is watched as well.
    std::fs::write(
        home.join(".claude").join("settings.json"),
        r#"{"permissions":{"deny":["Bash(home *)","Bash(rm *)"]}}"#,
    )
    .expect("write");
    wait_for(&rx, "claude user file", |e| {
        e["changed"]
            .as_array()
            .is_some_and(|c| c.contains(&json!("/permissions/deny")))
    });
    assert_eq!(
        settings.merged()["permissions"]["deny"],
        json!(["Bash(home *)", "Bash(rm *)", "Bash(curl *)"])
    );

    broken_file_keeps_content_and_writes_are_refused(&rt, &core, &rx, &settings, &ws);
    drop(settings);
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn approval_extends_only_the_selected_entries_of_an_existing_trust_snapshot() {
    use piarc_config::{Category, LayerTable, TrustState, append_local_permissions};

    let fixture = Fixture::new("permission snapshot");
    let repository = fixture.root.join("repository");
    let nested = repository.join("sub");
    std::fs::create_dir_all(repository.join(".git")).expect("repo");
    std::fs::create_dir_all(nested.join(".piarc")).expect("nested workspace");
    let rt = runtime();
    let (core, _events) = fixture.start();
    let trust = core.trust().expect("trust");
    rt.block_on(async {
        decide_current(&trust, &nested, true)
            .await
            .expect("trust empty project");
        let table = LayerTable::piarc(fixture.dirs().data(), &nested);
        let permission = [(Category::AllowRule, "Bash(npm test)")];
        let confirmed = append_local_permissions(&table, &permission).expect("write");
        assert_eq!(
            trust
                .permission_settings(&nested)
                .await
                .expect("settings")
                .trust(),
            TrustState::Untrusted
        );
        trust
            .confirm_items(&nested, confirmed)
            .await
            .expect("user approved the entry");
        let settings = trust.permission_settings(&nested).await.expect("settings");
        assert_eq!(settings.trust(), TrustState::Trusted);
        assert_eq!(
            settings.get("/permissions/allow"),
            Some(&json!(["Bash(npm test)"]))
        );
        std::fs::write(
            nested.join(".piarc/settings.json"),
            r#"{"permissions":{"defaultMode":"acceptEdits"}}"#,
        )
        .expect("external edit");
        let items = append_local_permissions(&table, &[(Category::AllowRule, "Edit(src/a.ts)")])
            .expect("write another rule");
        trust
            .confirm_items(&nested, items)
            .await
            .expect("confirm another rule");
        let view = trust.view(&nested).await.expect("view");
        assert_eq!(view.new_items.len(), 1);
        assert_eq!(view.new_items[0].source, "sub/.piarc/settings.json");
        assert_eq!(view.new_items[0].name, "acceptEdits");
        let settings = trust.permission_settings(&nested).await.expect("settings");
        assert_eq!(settings.trust(), TrustState::Untrusted);
        assert_eq!(
            settings.get("/permissions/defaultMode"),
            Some(&json!("default"))
        );
        trust.revoke(&nested).await.expect("revoke");
        let items = append_local_permissions(&table, &permission).expect("write again");
        trust
            .confirm_items(&nested, items)
            .await
            .expect("native confirmation");
        assert_eq!(
            trust
                .permission_settings(&nested)
                .await
                .expect("settings")
                .trust(),
            TrustState::Untrusted
        );
    });
    core.shutdown_blocking().expect("shutdown");
}

#[path = "state/sources.rs"]
mod sources;
