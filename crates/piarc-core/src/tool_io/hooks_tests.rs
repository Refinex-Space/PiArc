//! T25 through the real Core: the ladder's hook steps (A04, A05), `hooks/run` and the Core
//! events, trust (A11), audit and long output (A12), parallel runs and one run per handler
//! (A10), and process trees on timeout and interruption (A09). Hooks run with `piarc-exec`'s
//! process-tree spawner: `/bin/sh` on macOS, Git Bash on Windows.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_hooks::RunnerConfig;
use piarc_host::Peer;
use piarc_protocol::policy::{ApprovalRequest, PermissionMode};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::DataDirs;
use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};
use crate::hooks::HooksService;
use crate::sessions::Snapshots;
use crate::storage::Storage;
use crate::tool_io::policy::{Cleanup, Services};
use crate::tool_io::{CommandEnv, ToolIo, ToolIoConfig, hook_condition, lock};
use crate::trust::TrustService;

const SESSION: &str = "hooked";

/// Collects `core/notices`.
struct Notices(Arc<Mutex<Vec<Value>>>);

impl EventSink for Notices {
    fn deliver(&self, batches: Vec<EventBatch>, _: DeliveryDone) -> Result<(), SinkClosed> {
        for batch in batches {
            if batch.route.as_str() == "core/notices"
                && let Ok(Value::Array(list)) = serde_json::from_slice::<Value>(&batch.payload)
            {
                lock(&self.0).extend(list);
            }
        }
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    work: PathBuf,
    io: ToolIo,
    storage: Storage,
    trust: TrustService,
    peer: Peer,
    _frames: tokio::sync::mpsc::Receiver<Vec<u8>>,
    notices: Arc<Mutex<Vec<Value>>>,
}

struct Setup {
    trusted: bool,
    user: Value,
    project: Value,
    permissions: Value,
    runner: RunnerConfig,
    /// Where commands get their environment; a fixed `PATH` when `None`.
    command_env: Option<CommandEnv>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            trusted: true,
            user: json!({}),
            project: json!({}),
            permissions: json!({}),
            runner: RunnerConfig {
                kill_grace: Duration::from_millis(300),
                ..RunnerConfig::default()
            },
            command_env: None,
        }
    }
}

/// A handler group for `event` with `matcher`.
fn group(matcher: &str, handlers: &[Value]) -> Value {
    json!([{ "matcher": matcher, "hooks": handlers }])
}

fn command(text: &str) -> Value {
    json!({ "type": "command", "command": text })
}

/// A hook that prints `json` (single-quoted for the shell).
fn prints(json: &Value) -> Value {
    command(&format!(
        "printf '%s' '{}'",
        json.to_string().replace('\'', "'\\''")
    ))
}

/// A hook that appends its stdin, one line per run, to `log/<name>.jsonl`.
fn records(name: &str) -> String {
    format!("mkdir -p log && tr -d '\\n' >> log/{name}.jsonl && echo >> log/{name}.jsonl")
}

impl Fixture {
    async fn new(setup: Setup) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc hooks 钩子 {}",
            crate::sessions::new_session_id().expect("unique id")
        ));
        let work = root.join("workspace");
        let home = root.join("home");
        let data = root.join("data");
        let dirs = DataDirs::new(data.clone(), root.join("cache"))
            .expect("directories")
            .with_home(Some(home.clone()));
        dirs.create_layout().expect("layout");
        std::fs::create_dir_all(work.join(".claude")).expect("workspace");
        std::fs::create_dir_all(home.join(".claude")).expect("home");
        std::fs::write(
            data.join("settings.json"),
            json!({ "hooks": setup.user }).to_string(),
        )
        .expect("user settings");
        std::fs::write(
            work.join(".claude/settings.json"),
            json!({ "hooks": setup.project, "permissions": setup.permissions }).to_string(),
        )
        .expect("project settings");
        let storage = Storage::open(dirs).expect("open database");
        let trust = TrustService::new(storage.clone());
        if setup.trusted {
            let version = trust.view(&work).await.expect("trust view").version;
            trust.decide(&work, true, &version).await.expect("trust");
        }
        let notices = Arc::new(Mutex::new(Vec::new()));
        let (events, coalescer, _) = crate::events::channel(
            Duration::from_millis(1),
            Arc::new(Notices(Arc::clone(&notices))),
            CancellationToken::new(),
        );
        tokio::spawn(coalescer.run());
        let snapshots = Snapshots::spawn(&Handle::current(), events.clone(), storage.clone());
        let hooks = HooksService::new(
            storage.clone(),
            trust.clone(),
            Some(events),
            Arc::new(piarc_exec::ProcessTreeSpawner),
            setup.runner,
            hook_condition,
        );
        let io = ToolIo::new(ToolIoConfig {
            // Cargo's `DYLD_*` variables would turn off rule-based allows (T23).
            command_env: match setup.command_env {
                Some(env) => env,
                None if cfg!(windows) => CommandEnv::process(),
                None => CommandEnv::Fixed(vec![("PATH".into(), "/usr/bin:/bin".into())]),
            },
            ..ToolIoConfig::new(data)
        })
        .policy_services(Services {
            storage: storage.clone(),
            trust: trust.clone(),
            snapshots,
            hooks: Some(hooks),
        });
        io.open_session(SESSION, &work, &work).expect("session");
        let (peer, frames) = Peer::channel(64);
        Self {
            root,
            work,
            io,
            storage,
            trust,
            peer,
            _frames: frames,
            notices,
        }
    }

    async fn evaluate(&self, call: &str, tool: &str, input: Value) -> Value {
        let params =
            json!({"sessionId": SESSION, "toolCallId": call, "tool": tool, "input": input});
        self.io
            .dispatch(
                "policy/evaluate",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
            .expect("preflight")
    }

    async fn pending(&self) -> ApprovalRequest {
        let session = self.io.session(SESSION).expect("registered");
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(request) = lock(&session.policy).first_pending() {
                    return request;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("approval arrived")
    }

    fn log(&self, name: &str) -> Vec<Value> {
        std::fs::read_to_string(self.work.join("log").join(format!("{name}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect()
    }

    async fn hook_audit(&self) -> Vec<Value> {
        self.storage
            .run(|db| db.audit_events(100))
            .await
            .expect("storage")
            .expect("audit")
            .into_iter()
            .filter(|e| e.kind == "hook")
            .map(|e| serde_json::from_str(&e.detail).expect("detail"))
            .collect()
    }

    async fn notices(&self) -> Vec<Value> {
        tokio::time::sleep(Duration::from_millis(50)).await;
        lock(&self.notices).clone()
    }

    async fn hooks_run(&self, params: Value) -> Result<Value, piarc_protocol::ErrorObject> {
        self.io
            .hooks_run(
                &self.work,
                params.as_object().expect("params").clone(),
                &self.peer,
            )
            .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.io.close_session(SESSION);
        self.storage.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn pre(json: &Value) -> Value {
    let mut fields = json.clone();
    fields["hookEventName"] = json!("PreToolUse");
    json!({ "hookSpecificOutput": fields })
}

#[tokio::test]
async fn pre_tool_use_denies_asks_allows_and_rewrites_the_call() {
    // A04: deny with a reason, exit 2 with stderr, deny > ask > allow, updatedInput.
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": [
            { "matcher": "Bash", "hooks": [
                prints(&pre(&json!({"permissionDecision": "allow"}))),
                prints(&pre(&json!({"permissionDecision": "ask"}))),
            ]},
            { "matcher": "Read", "hooks": [prints(&pre(&json!({"permissionDecision": "deny", "permissionDecisionReason": "no reading today"})))] },
            { "matcher": "Glob", "hooks": [command("echo 'globs are off' >&2; exit 2")] },
            { "matcher": "Grep", "hooks": [
                prints(&pre(&json!({"permissionDecision": "allow"}))),
                prints(&pre(&json!({"permissionDecision": "deny", "permissionDecisionReason": "deny wins"}))),
                prints(&pre(&json!({"permissionDecision": "ask"}))),
            ]},
            { "matcher": "Edit", "hooks": [prints(&pre(&json!({"permissionDecision": "allow", "updatedInput": {"path": "rewritten.txt", "edits": []}, "additionalContext": "edited by policy"})))] },
        ]}),
        ..Setup::default()
    })
    .await;
    let read = f.evaluate("r", "Read", json!({"path": "a.txt"})).await;
    assert_eq!(
        read,
        json!({"allowed": false, "reason": "no reading today"})
    );
    let glob = f.evaluate("g", "Glob", json!({"pattern": "*"})).await;
    assert_eq!(glob, json!({"allowed": false, "reason": "globs are off"}));
    let grep = f.evaluate("p", "Grep", json!({"pattern": "x"})).await;
    assert_eq!(grep["reason"], "deny wins");
    // allow + ask: the user is asked even for a command the rules would allow.
    let asked = tokio::spawn({
        let io = f.io.clone();
        let peer = f.peer.clone();
        async move {
            let params = json!({"sessionId": SESSION, "toolCallId": "b", "tool": "Bash", "input": {"command": "ls"}});
            io.dispatch(
                "policy/evaluate",
                params.as_object().cloned().unwrap_or_default(),
                peer,
            )
            .await
        }
    });
    let card = f.pending().await;
    assert_eq!(card.command.as_deref(), Some("ls"));
    f.io.clear_approvals(SESSION, Cleanup::Interrupted);
    let _ = asked.await;
    // allow with updatedInput: the call runs with the hook's arguments, context included.
    std::fs::write(f.work.join("rewritten.txt"), "x").expect("file");
    let edit = f
        .evaluate("e", "Edit", json!({"path": "original.txt", "edits": []}))
        .await;
    assert_eq!(
        edit["updatedInput"],
        json!({"path": "rewritten.txt", "edits": []})
    );
    assert_eq!(edit["context"], "edited by policy");
    let audit = f.hook_audit().await;
    let decisions: Vec<&str> = audit
        .iter()
        .filter_map(|a| a["decision"].as_str())
        .collect();
    assert!(
        decisions.contains(&"deny") && decisions.contains(&"ask") && decisions.contains(&"allow")
    );
}

#[tokio::test]
async fn a_hook_allow_leaves_deny_rules_ask_rules_and_plan_mode_in_force() {
    // A05.
    let allow = prints(&pre(&json!({"permissionDecision": "allow"})));
    let launder = prints(&pre(
        &json!({"permissionDecision": "allow", "updatedInput": {"command": "rm -rf build"}}),
    ));
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": [
            { "matcher": "Bash", "hooks": [allow.clone()] },
            { "matcher": "Write", "hooks": [allow] },
        ]}),
        project: json!({ "PreToolUse": group("Bash", &[]) }),
        permissions: json!({ "deny": ["Bash(rm *)"], "ask": ["Bash(sed *)"] }),
        ..Setup::default()
    })
    .await;
    let denied = f
        .evaluate("d", "Bash", json!({"command": "rm -rf build"}))
        .await;
    assert_eq!(denied["allowed"], false);
    assert!(
        denied["reason"]
            .as_str()
            .is_some_and(|r| r.contains("Bash(rm *)"))
    );
    // The hook allow works where no rule objects: a command the default mode asks about.
    let plain = f
        .evaluate("p", "Bash", json!({"command": "touch made.txt"}))
        .await;
    assert_eq!(plain, json!({"allowed": true}));
    let asked = tokio::spawn({
        let io = f.io.clone();
        let peer = f.peer.clone();
        async move {
            let params = json!({"sessionId": SESSION, "toolCallId": "a", "tool": "Bash", "input": {"command": "sed -n 1p notes"}});
            io.dispatch(
                "policy/evaluate",
                params.as_object().cloned().unwrap_or_default(),
                peer,
            )
            .await
        }
    });
    assert_eq!(
        f.pending().await.command.as_deref(),
        Some("sed -n 1p notes")
    );
    f.io.clear_approvals(SESSION, Cleanup::Interrupted);
    let _ = asked.await;
    f.io.changed_mode(SESSION, PermissionMode::Plan)
        .await
        .expect("plan mode");
    let plan = f
        .evaluate("w", "Write", json!({"path": "new.txt", "content": "x"}))
        .await;
    assert_eq!(plan["allowed"], false);
    assert_eq!(plan["reason"], piarc_policy::PLAN_MODE_REFUSAL);
    f.io.changed_mode(SESSION, PermissionMode::Default)
        .await
        .expect("manual");
    drop(f);
    // A rewritten input meets the deny rules too.
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": group("Bash", &[launder]) }),
        permissions: json!({ "deny": ["Bash(rm *)"] }),
        ..Setup::default()
    })
    .await;
    let laundered = f.evaluate("l", "Bash", json!({"command": "ls"})).await;
    assert_eq!(laundered["allowed"], false);
}

#[tokio::test]
async fn untrusted_project_hooks_wait_for_trust_while_user_hooks_run() {
    // A11.
    let f = Fixture::new(Setup {
        trusted: false,
        user: json!({ "PreToolUse": group("Read", &[command(&records("user"))]) }),
        project: json!({ "PreToolUse": group("Read", &[command(&records("project"))]) }),
        ..Setup::default()
    })
    .await;
    std::fs::write(f.work.join("a.txt"), "a").expect("file");
    f.evaluate("one", "Read", json!({"path": "a.txt"})).await;
    assert_eq!(f.log("user").len(), 1);
    assert!(f.log("project").is_empty());
    let version = f.trust.view(&f.work).await.expect("view").version;
    f.trust
        .decide(&f.work, true, &version)
        .await
        .expect("trust");
    f.evaluate("two", "Read", json!({"path": "a.txt"})).await;
    assert_eq!(f.log("user").len(), 2);
    let project = f.log("project");
    assert_eq!(project.len(), 1);
    // A02 for PreToolUse: the common fields and the event's own.
    let input = &project[0];
    assert_eq!(input["hook_event_name"], "PreToolUse");
    assert_eq!(input["session_id"], SESSION);
    assert_eq!(input["permission_mode"], "default");
    assert_eq!(input["tool_name"], "Read");
    assert_eq!(input["tool_use_id"], "two");
    assert!(input["tool_input"]["path"].as_str().is_some());
    assert!(input.get("transcript_path").is_some() && input["cwd"].as_str().is_some());
}

#[tokio::test]
async fn handlers_run_in_parallel_and_a_handler_in_two_files_runs_once() {
    // A10.
    let shared = command(&format!("sleep 1; {}", records("shared")));
    let own = command(&format!("sleep 1; {}", records("own")));
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": group("Read", &[shared.clone(), own]) }),
        project: json!({ "PreToolUse": group("Read", &[shared]) }),
        ..Setup::default()
    })
    .await;
    std::fs::write(f.work.join("a.txt"), "a").expect("file");
    let started = Instant::now();
    f.evaluate("c", "Read", json!({"path": "a.txt"})).await;
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_millis(1900), "took {elapsed:?}");
    assert_eq!(f.log("shared").len(), 1);
    assert_eq!(f.log("own").len(), 1);
    assert_eq!(f.hook_audit().await.len(), 2);
}

#[tokio::test]
async fn every_run_is_audited_and_long_context_goes_to_a_file() {
    // A12.
    let long = "context ".repeat(1500);
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": group("Read", &[
            prints(&pre(&json!({"additionalContext": long}))),
            command("echo 'lint failed' >&2; exit 1"),
        ]) }),
        ..Setup::default()
    })
    .await;
    std::fs::write(f.work.join("a.txt"), "a").expect("file");
    let result = f.evaluate("c", "Read", json!({"path": "a.txt"})).await;
    let Some(context) = result["context"].as_str() else {
        // Say why: the hooks' exit codes and the notices (a hook error names its cause).
        let audit = f.hook_audit().await;
        let notices = f.notices().await;
        panic!("no context in {result}; hook audit {audit:?}; notices {notices:?}");
    };
    assert!(context.starts_with(&long[..2000]));
    assert!(context.len() < 3000, "only a preview: {}", context.len());
    let path = context
        .rsplit("the full text is in ")
        .next()
        .and_then(|rest| rest.strip_suffix(']'))
        .expect("the file is named");
    assert_eq!(std::fs::read_to_string(path).expect("spilled"), long);
    let audit = f.hook_audit().await;
    assert_eq!(audit.len(), 2);
    for row in &audit {
        assert_eq!(row["event"], "PreToolUse");
        assert_eq!(row["layer"], "user");
        assert!(
            row["source"]
                .as_str()
                .is_some_and(|s| s.ends_with("settings.json"))
        );
        assert!(row["durationMs"].is_u64());
        assert!(row["commandSha256"].as_str().is_some_and(|d| d.len() == 64));
        assert_eq!(row["timedOut"], false);
    }
    let mut codes: Vec<i64> = audit
        .iter()
        .filter_map(|a| a["exitCode"].as_i64())
        .collect();
    codes.sort_unstable();
    assert_eq!(codes, [0, 1]);
    // A03: the other exit code does not block; the user is told.
    assert_eq!(result["allowed"], true);
    let notices = f.notices().await;
    assert!(notices.iter().any(|n| n["type"] == "hook"
        && n["level"] == "error"
        && n["message"] == "exited with code 1: lint failed"));
}

/// A hook that starts a long `sleep` in the background, writes its OS pid to `pid`, then waits.
fn tree(pid: &str) -> String {
    let last = if cfg!(windows) {
        "$(cat /proc/$!/winpid)"
    } else {
        "$!"
    };
    format!("sleep 120 & echo {last} > {pid}; wait")
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
}

async fn pid_in(path: &std::path::Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(path)
                .ok()
                .and_then(|t| t.trim().parse().ok())
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the hook wrote its pid")
}

async fn gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} still runs");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!("process {pid} ended");
}

#[tokio::test]
async fn a_timeout_or_an_interrupted_turn_ends_the_hooks_process_tree() {
    // A09: the timeout is the handler's (seconds, injected short here); interruption cancels
    // the turn's hooks.
    let mut timed = json!({ "type": "command", "command": tree("timed.pid") });
    timed["timeout"] = json!(0.5);
    let f = Fixture::new(Setup {
        user: json!({ "PreToolUse": [
            { "matcher": "Read", "hooks": [timed] },
            { "matcher": "Glob", "hooks": [command(&tree("cancelled.pid"))] },
        ]}),
        ..Setup::default()
    })
    .await;
    std::fs::write(f.work.join("a.txt"), "a").expect("file");
    let started = Instant::now();
    let result = f.evaluate("t", "Read", json!({"path": "a.txt"})).await;
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(result["allowed"], true);
    gone(pid_in(&f.work.join("timed.pid")).await).await;
    let audit = f.hook_audit().await;
    assert_eq!(audit[0]["timedOut"], true);
    assert_eq!(audit[0]["decision"], "timeout");

    let running = tokio::spawn({
        let io = f.io.clone();
        let peer = f.peer.clone();
        async move {
            let params = json!({"sessionId": SESSION, "toolCallId": "c", "tool": "Glob", "input": {"pattern": "*"}});
            io.dispatch(
                "policy/evaluate",
                params.as_object().cloned().unwrap_or_default(),
                peer,
            )
            .await
        }
    });
    let pid = pid_in(&f.work.join("cancelled.pid")).await;
    assert!(alive(pid));
    f.io.clear_approvals(SESSION, Cleanup::Interrupted);
    let _ = tokio::time::timeout(Duration::from_secs(10), running).await;
    gone(pid).await;
}

#[test]
fn the_default_timeouts_are_600_seconds_and_30_for_user_prompt_submit() {
    let t = piarc_hooks::Timeouts::default();
    assert_eq!(t.default, Duration::from_secs(600));
    assert_eq!(t.user_prompt_submit, Duration::from_secs(30));
    assert_eq!(crate::CoreConfig::default().hooks.timeouts, t);
}

#[tokio::test]
async fn permission_request_answers_before_the_user_and_saves_session_rules() {
    let allow = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": {
        "behavior": "allow",
        "updatedPermissions": [{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "sed -n *" }], "behavior": "allow", "destination": "session" },
                               { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "x" }], "behavior": "allow", "destination": "userSettings" }]
    }}});
    let deny = json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": {
        "behavior": "deny", "message": "not on Fridays", "interrupt": true
    }}});
    let f = Fixture::new(Setup {
        user: json!({ "PermissionRequest": [
            { "matcher": "Bash", "hooks": [prints(&allow), command(&records("request"))] },
            { "matcher": "Write", "hooks": [prints(&deny)] },
        ]}),
        ..Setup::default()
    })
    .await;
    std::fs::write(f.work.join("notes"), "one\ntwo\n").expect("notes");
    let first = f
        .evaluate("one", "Bash", json!({"command": "sed -n 1p notes"}))
        .await;
    assert_eq!(first, json!({"allowed": true}));
    let input = &f.log("request")[0];
    assert_eq!(input["permission_suggestions"][0]["type"], "addRules");
    assert_eq!(
        input["permission_suggestions"][0]["rules"][0]["toolName"],
        "Bash"
    );
    assert!(input.get("tool_use_id").is_none());
    // The session rule now allows it without asking anyone (no second request).
    let second = f
        .evaluate("two", "Bash", json!({"command": "sed -n 2p notes"}))
        .await;
    assert_eq!(second, json!({"allowed": true}));
    assert_eq!(f.log("request").len(), 1);
    let refused = f
        .evaluate("w", "Write", json!({"path": "new.txt", "content": "x"}))
        .await;
    assert_eq!(refused["allowed"], false);
    assert_eq!(refused["reason"], "not on Fridays");
    assert_eq!(refused["stop"], json!({"reason": "not on Fridays"}));
    let notices = f.notices().await;
    assert!(notices.iter().any(|n| {
        n["message"]
            .as_str()
            .is_some_and(|m| m.contains("userSettings"))
    }));
}

#[tokio::test]
async fn hooks_run_answers_the_agent_hosts_events() {
    let stop = json!({ "decision": "block", "reason": "run the tests" });
    let post = json!({ "decision": "block", "reason": "lint warnings", "hookSpecificOutput": {
        "hookEventName": "PostToolUse", "additionalContext": "formatted", "updatedToolOutput": "[redacted]" } });
    let f = Fixture::new(Setup {
        user: json!({
            "Stop": group("", &[prints(&stop), command(&records("stop"))]),
            "PostToolUse": group("Write", &[prints(&post)]),
            "SessionEnd": group("other", &[command(&records("end"))]),
            "PreCompact": group("manual", &[command("echo 'Keep the API decisions.'")]),
        }),
        ..Setup::default()
    })
    .await;
    let cwd = crate::tool_io::policy::lexical(&f.work);
    let base = |event: &str, input: Value| json!({"sessionId": SESSION, "event": event, "cwd": cwd.to_string_lossy(), "transcriptPath": "/pi/s.jsonl", "input": input});
    let blocked = f
        .hooks_run(base(
            "stop",
            json!({"stop_hook_active": false, "last_assistant_message": "Done."}),
        ))
        .await
        .expect("stop");
    assert_eq!(blocked, json!({"block": "run the tests"}));
    let input = &f.log("stop")[0];
    assert_eq!(input["transcript_path"], "/pi/s.jsonl");
    assert_eq!(input["background_tasks"], json!([]));
    assert_eq!(input["last_assistant_message"], "Done.");
    // A07: at the limit the block is overridden and the user is told.
    let mut at_limit = base("stop", json!({"stop_hook_active": true}));
    at_limit["continuations"] = json!(piarc_hooks::STOP_CONTINUATION_LIMIT);
    assert_eq!(f.hooks_run(at_limit).await.expect("stop"), json!({}));
    assert!(f.notices().await.iter().any(|n| {
        n["message"]
            .as_str()
            .is_some_and(|m| m.contains("8 times in a row"))
    }));
    let posted = f
        .hooks_run(base("postToolUse", json!({"tool_name": "Write", "tool_input": {"path": "x"}, "tool_use_id": "w", "tool_response": {}})))
        .await
        .expect("post");
    assert_eq!(
        posted,
        json!({"context": "formatted", "feedback": "lint warnings", "updatedOutput": "[redacted]"})
    );
    let compact = f
        .hooks_run(base(
            "preCompact",
            json!({"trigger": "manual", "custom_instructions": null}),
        ))
        .await
        .expect("pre-compact");
    assert_eq!(compact, json!({"instructions": "Keep the API decisions."}));
    // SessionEnd after Core closed the session; a cwd outside the workspace is refused.
    f.io.close_session(SESSION);
    f.hooks_run(base("sessionEnd", json!({"reason": "other"})))
        .await
        .expect("end");
    assert_eq!(f.log("end")[0]["reason"], "other");
    let mut outside = base("sessionEnd", json!({"reason": "other"}));
    outside["cwd"] = json!(f.root.join("elsewhere").to_string_lossy());
    assert!(f.hooks_run(outside).await.is_err());
}

#[tokio::test]
async fn user_prompt_submit_blocks_or_adds_context_and_notifications_run() {
    let f = Fixture::new(Setup {
        user: json!({
            "UserPromptSubmit": group("", &[command(&format!("{}; grep -q secret log/prompt.jsonl && {{ echo 'no secrets' >&2; exit 2; }}; echo 'Branch: main'", records("prompt")))]),
            "Notification": group("permission_prompt", &[command(&records("notice"))]),
        }),
        ..Setup::default()
    })
    .await;
    let cancel = CancellationToken::new();
    assert_eq!(
        f.io.user_prompt_submit(SESSION, "fix the build", &cancel)
            .await,
        Ok(Some("Branch: main".to_owned()))
    );
    assert_eq!(
        f.io.user_prompt_submit(SESSION, "my secret is 42", &cancel)
            .await,
        Err("no secrets".to_owned())
    );
    assert_eq!(f.log("prompt")[0]["prompt"], "fix the build");
    assert_eq!(f.log("prompt")[0]["permission_mode"], "default");
    f.io.notification_hooks(
        SESSION,
        "permission_prompt",
        "PiArc needs your permission to use Bash",
    )
    .await;
    f.io.notification_hooks(SESSION, "idle_prompt", "PiArc is waiting for your input")
        .await;
    let notices = f.log("notice");
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["notification_type"], "permission_prompt");
    assert_eq!(
        notices[0]["message"],
        "PiArc needs your permission to use Bash"
    );
    assert!(notices[0].get("permission_mode").is_none());
}

/// Without a matching handler an input goes on at once: the hooks' environment comes from the
/// user's login shell, which can take seconds, and is resolved only when a handler runs.
#[cfg(unix)]
#[tokio::test]
async fn an_input_without_hooks_does_not_wait_for_the_login_shell() {
    let home = std::env::temp_dir().join(format!(
        "piarc slow login 登录 {}",
        crate::sessions::new_session_id().expect("unique id")
    ));
    std::fs::create_dir_all(&home).expect("home");
    std::fs::write(home.join(".bash_profile"), "sleep 3\n").expect("profile");
    let base = vec![
        ("SHELL".into(), "/bin/bash".into()),
        ("HOME".into(), home.clone().into_os_string()),
        ("PATH".into(), "/usr/bin:/bin".into()),
    ];
    let f = Fixture::new(Setup {
        command_env: Some(CommandEnv::LoginShell { base }),
        ..Setup::default()
    })
    .await;
    let started = Instant::now();
    let context =
        f.io.user_prompt_submit(SESSION, "hello", &CancellationToken::new())
            .await
            .expect("nothing blocks it");
    let waited = started.elapsed();
    std::fs::remove_dir_all(&home).expect("clean");
    assert_eq!(context, None);
    assert!(
        waited < Duration::from_secs(1),
        "the input waited {waited:?}"
    );
}
