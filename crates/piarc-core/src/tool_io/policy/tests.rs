//! T20: the real Core preflight, including the trust check, filesystem and audit insert.
use std::time::{Duration, Instant};

use tokio::runtime::Handle;
use tokio::sync::mpsc::Receiver;

use super::*;
use crate::DataDirs;
use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};
use crate::tool_io::ToolIoConfig;

struct Sink;
impl EventSink for Sink {
    fn deliver(&self, _: Vec<EventBatch>, _: DeliveryDone) -> Result<(), SinkClosed> {
        Ok(())
    }
}

const SESSION: &str = "main";

struct Fixture {
    root: PathBuf,
    /// The workspace as the session names it (W1 uses a UNC spelling of the same directory).
    work: PathBuf,
    io: ToolIo,
    storage: Storage,
    peer: Peer,
    frames: Receiver<Vec<u8>>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_env(super::super::CommandEnv::process()).await
    }

    async fn with_env(command_env: super::super::CommandEnv) -> Self {
        Self::build(command_env, Path::to_path_buf, false, system_clock()).await
    }

    /// As Core runs: with the hooks service, whose steps run even when no hook is configured.
    async fn with_hooks(command_env: super::super::CommandEnv) -> Self {
        Self::build(command_env, Path::to_path_buf, true, system_clock()).await
    }

    /// `spell` names the workspace directory the way the session opens it; `hooks` adds the
    /// hooks service (the ladder alone otherwise); `clock` times question forms.
    async fn build(
        command_env: super::super::CommandEnv,
        spell: impl FnOnce(&Path) -> PathBuf,
        hooks: bool,
        clock: Arc<dyn piarc_ports::Clock>,
    ) -> Self {
        Self::build_with(
            command_env,
            spell,
            hooks,
            clock,
            super::super::WebConfig::default(),
        )
        .await
    }

    /// [`Fixture::build`] with WebFetch's configuration (T29).
    async fn build_with(
        command_env: super::super::CommandEnv,
        spell: impl FnOnce(&Path) -> PathBuf,
        hooks: bool,
        clock: Arc<dyn piarc_ports::Clock>,
        web: super::super::WebConfig,
    ) -> Self {
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique id"));
        let local = root.join("workspace");
        let data = root.join("data");
        let dirs = DataDirs::new(data.clone(), root.join("cache")).expect("directories");
        dirs.create_layout().expect("layout");
        std::fs::create_dir_all(local.join(".piarc")).expect("workspace");
        std::fs::write(
            local.join(".piarc/settings.json"),
            r#"{"permissions":{"allow":["Read(known)","Bash(cargo check *)","Bash(npm run lint *)"]}}"#,
        )
        .expect("settings");
        let work = spell(&local);
        let storage = Storage::open(dirs).expect("open database");
        let trust = TrustService::new(storage.clone());
        trust
            .decide(
                &work,
                true,
                &trust
                    .view(&work)
                    .await
                    .expect("displayed trust view")
                    .version,
            )
            .await
            .expect("trust the fixture");
        let (events, coalescer, _) = crate::events::channel(
            Duration::from_millis(1),
            Arc::new(Sink),
            CancellationToken::new(),
        );
        tokio::spawn(coalescer.run());
        let snapshots = Snapshots::spawn(&Handle::current(), events.clone(), storage.clone());
        let hooks = hooks.then(|| {
            crate::hooks::HooksService::new(
                storage.clone(),
                trust.clone(),
                Some(events),
                Arc::new(piarc_exec::ProcessTreeSpawner),
                piarc_hooks::RunnerConfig::default(),
                crate::tool_io::hook_condition,
            )
        });
        let io = ToolIo::new(ToolIoConfig {
            command_env,
            clock,
            web,
            ..ToolIoConfig::new(data)
        })
        .policy_services(Services {
            storage: storage.clone(),
            trust,
            snapshots,
            hooks,
        });
        io.open_session(SESSION, &work, &work).expect("session");
        let (peer, frames) = Peer::channel(4);
        Self {
            root,
            work,
            io,
            storage,
            peer,
            frames,
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
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(request) = lock(&session.policy).ledger.pending().next().cloned() {
                    return request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("approval arrived")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.io.close_session(SESSION);
        self.storage.close();
        std::fs::remove_dir_all(&self.root).expect("remove test data");
    }
}

fn system_clock() -> Arc<dyn piarc_ports::Clock> {
    Arc::new(crate::clock::SystemClock)
}

fn answer(r: &ApprovalRequest, decision: ApprovalDecision) -> ApprovalAnswer {
    ApprovalAnswer {
        request_id: r.request_id.clone(),
        session_id: r.session_id.clone(),
        revision: r.revision,
        connection_epoch: r.connection_epoch,
        decision,
        feedback: None,
        rules: Vec::new(),
        directory: None,
        mode: None,
        comments: Vec::new(),
        answers: Vec::new(),
    }
}

#[tokio::test]
async fn memory_refusal_delivers_card_feedback_at_the_import_site() {
    let f = Fixture::new().await;
    std::fs::write(f.root.join("workspace/CLAUDE.md"), "@../private.md").unwrap();
    std::fs::write(f.root.join("private.md"), "External file marker.").unwrap();
    let params = json!({"sessionId": SESSION, "toolCallId": "memory-test"});
    let read = f.io.dispatch(
        "fs/memory",
        params.as_object().unwrap().clone(),
        f.peer.clone(),
    );
    let feedback = "Use only the project notes.";
    let decline = async {
        let card = f.pending().await;
        let mut reply = answer(&card, ApprovalDecision::Deny);
        reply.feedback = Some(feedback.into());
        assert_eq!(
            f.io.answer_approval(reply).await.unwrap()["status"],
            "applied"
        );
    };
    let (snapshot, ()) = tokio::join!(read, decline);
    let snapshot = snapshot.unwrap();
    let memory: piarc_protocol::memory::MemorySnapshot =
        serde_json::from_str(snapshot["chunk"].as_str().unwrap()).unwrap();
    let source = memory
        .files
        .iter()
        .find(|file| {
            file.path.ends_with("CLAUDE.md") && file.content.contains("Memory import denied")
        })
        .unwrap();
    assert!(
        source.content.contains(feedback),
        "the refusal omitted the user's feedback"
    );
    assert!(!source.content.contains("External file marker."));
}

#[tokio::test]
async fn concurrent_answers_apply_once_and_each_decision_is_audited_by_session() {
    let f = Fixture::new().await;
    assert_eq!(
        f.evaluate("read", "Read", json!({"path":"known"})).await["allowed"],
        true
    );
    let pending = f.evaluate("cmd", "Bash", json!({"command":"npm test"}));
    let responder = async {
        let r = f.pending().await;
        let allow = answer(&r, ApprovalDecision::AllowOnce);
        let mut stale = allow.clone();
        stale.revision += 1;
        assert_eq!(
            f.io.answer_approval(stale).await.expect("answer")["status"],
            "stale"
        );
        let (one, two) = tokio::join!(
            f.io.answer_approval(allow.clone()),
            f.io.answer_approval(allow)
        );
        let mut outcomes = [one.expect("first"), two.expect("second")]
            .map(|v| v["status"].as_str().expect("status").to_owned());
        outcomes.sort();
        assert_eq!(outcomes, ["alreadyHandled", "applied"]);
    };
    let (result, ()) = tokio::join!(pending, responder);
    assert_eq!(result["allowed"], true);
    let states: Vec<Value> = f
        .storage
        .with(|store| store.session_audit_events(SESSION, 100))
        .expect("open")
        .expect("audit")
        .iter()
        .map(|row| serde_json::from_str(&row.detail).expect("decision detail"))
        .collect();
    assert_eq!(states.len(), 2);
    assert_eq!(states[0]["tool"], "Bash");
    assert_eq!(states[0]["mode"], "default");
    assert_eq!(states[0]["source"], "user");
    assert_eq!(states[0]["conclusion"], "allow");
    assert!(states[0]["arguments"].is_object());
    assert_eq!(states[1]["tool"], "Read");
    assert_eq!(states[1]["source"], "automatic");
    assert_eq!(states[1]["rule"], "Read(known)");
    assert_eq!(states[1]["ruleSource"], "project");
    assert_eq!(states[1]["step"], "allowRule");
    assert!(
        f.storage
            .with(|s| s.session_audit_events("other", 100))
            .expect("open")
            .expect("audit")
            .is_empty()
    );
}

#[tokio::test]
async fn disconnect_expires_pending_cards_and_records_refusal_for_recovery() {
    let mut f = Fixture::new().await;
    let io = f.io.clone();
    let peer = f.peer.clone();
    let run = tokio::spawn(async move {
        io.dispatch("policy/evaluate", json!({"sessionId":SESSION,"toolCallId":"gone","tool":"Bash","input":{"command":"npm run build"}}).as_object().expect("object").clone(),peer).await
    });
    let card = f.pending().await;
    f.frames.close();
    let denied = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .expect("no pending wait")
        .expect("joined")
        .expect("decision");
    assert_eq!(denied["allowed"], false);
    assert!(denied["reason"].is_string());
    assert!(
        lock(&f.io.session(SESSION).expect("open").policy)
            .ledger
            .pending()
            .next()
            .is_none()
    );
    assert_eq!(
        f.io.recover(SESSION, "gone").expect("recover")["reason"],
        denied["reason"]
    );
    assert_eq!(
        f.io.answer_approval(answer(&card, ApprovalDecision::AllowOnce))
            .await
            .expect("already processed")["status"],
        "alreadyHandled"
    );
}

/// T20-A13 and T23-A13: automatic decisions, including rule matching and Bash analysis, with
/// the hooks service as Core runs it (no hook configured). Run alone on the benchmark host with
/// --nocapture for the release-gate measurement.
#[tokio::test]
async fn automatic_decision_latency() {
    const COUNT: usize = 1000;
    // A fixed PATH keeps the program lookup independent of the developer's shell.
    let f = Fixture::with_hooks(super::super::CommandEnv::Fixed(vec![(
        "PATH".into(),
        "/usr/bin:/bin".into(),
    )]))
    .await;
    let read_only = if cfg!(windows) {
        "echo \"done $(pwd)\" && cd src && pwd"
    } else {
        "git status && ls -la src | grep -c ts; echo \"done $(pwd)\""
    };
    let calls = [
        ("Read", json!({"path":"known"})),
        ("Read", json!({"path":"file.txt"})),
        ("Bash", json!({"command": read_only})),
        (
            "Bash",
            json!({"command":"cargo check --workspace && npm run lint -- --fix"}),
        ),
    ];
    let mut samples = Vec::with_capacity(COUNT);
    let mut by_call: [Vec<Duration>; 4] = Default::default();
    for i in 0..COUNT + 100 {
        let (tool, input) = &calls[i % calls.len()];
        let started = Instant::now();
        let decision = tokio::time::timeout(
            Duration::from_secs(10),
            f.evaluate("auto", tool, input.clone()),
        )
        .await
        .unwrap_or_else(|_| panic!("{tool} {input} asked the user"));
        let elapsed = started.elapsed();
        assert_eq!(decision["allowed"], true, "{tool} {input}");
        f.io.finish_tool(SESSION, "auto");
        if i >= 100 {
            samples.push(elapsed);
            by_call[i % calls.len()].push(elapsed);
        }
    }
    // Which kind of call a slow percentile comes from (printed with the result).
    let by_call: Vec<String> = by_call
        .iter_mut()
        .zip([
            "allow rule",
            "read-only file",
            "read-only Bash",
            "Bash allow rules",
        ])
        .map(|(kind, name)| {
            kind.sort_unstable();
            let p95 = kind[kind.len() * 95 / 100 - 1];
            format!("{name} p50 {:?} p95 {p95:?}", kind[kind.len() / 2 - 1])
        })
        .collect();
    samples.sort_unstable();
    let p95 = samples[COUNT * 95 / 100 - 1];
    println!(
        "policy/evaluate automatic (allow rule, read-only file, read-only compound Bash, Bash allow rules), including settings, rules, Bash analysis, program lookup, canonical paths and SQLite audit: {COUNT} decisions; p50 {:?}, p95 {p95:?}, p99 {:?}",
        samples[COUNT / 2 - 1],
        samples[COUNT * 99 / 100 - 1]
    );
    println!("by call: {}", by_call.join("; "));
    let rows = f
        .storage
        .with(|s| s.session_audit_events(SESSION, 1200))
        .expect("open")
        .expect("audit");
    assert_eq!(rows.len(), COUNT + 100);
    let steps: HashSet<String> = rows
        .iter()
        .map(|r| serde_json::from_str::<Value>(&r.detail).expect("detail")["step"].to_string())
        .collect();
    assert_eq!(steps.len(), 2, "{steps:?}");
    // Architecture chapter 11, ADR-0040: NTFS metadata calls cost several times more.
    let budget = Duration::from_millis(if cfg!(windows) { 10 } else { 2 });
    assert!(
        p95 <= budget,
        "automatic permission budget {budget:?} exceeded: {p95:?}"
    );
}

#[tokio::test]
async fn permanent_answers_must_include_every_value_shown_for_confirmation() {
    let f = Fixture::new().await;
    let wait = f.evaluate("cmd", "Bash", json!({"command":"npm test"}));
    let responder = async {
        let r = f.pending().await;
        assert!(
            f.io.answer_approval(answer(&r, ApprovalDecision::AllowAlways))
                .await
                .is_err()
        );
        f.io.answer_approval(answer(&r, ApprovalDecision::Deny))
            .await
            .expect("still pending");
    };
    let (result, ()) = tokio::join!(wait, responder);
    assert_eq!(result["allowed"], false);
}

#[tokio::test]
async fn file_grants_bind_the_reviewed_change_and_are_consumed_by_one_write() {
    let f = Fixture::new().await;
    f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
        .await
        .expect("mode");
    let request = |id: &str, content: &str| {
        json!({"path":"note.txt","content":content,
        "sessionId":SESSION,"origin":{"tool":"Write","toolCallId":id}, "lineEndings":"matchFile"})
        .as_object()
        .expect("object")
        .clone()
    };
    assert_eq!(
        f.evaluate(
            "first",
            "Write",
            json!({"path":"note.txt","content":"reviewed"})
        )
        .await["allowed"],
        true
    );
    assert!(
        f.io.dispatch("fs/write", request("first", "different"), f.peer.clone())
            .await
            .is_err()
    );
    assert!(!f.root.join("workspace/note.txt").exists());
    assert_eq!(
        f.evaluate(
            "second",
            "Write",
            json!({"path":"note.txt","content":"reviewed"})
        )
        .await["allowed"],
        true
    );
    f.io.dispatch("fs/write", request("second", "reviewed"), f.peer.clone())
        .await
        .expect("exact content");
    assert!(
        f.io.dispatch("fs/write", request("second", "reviewed"), f.peer.clone())
            .await
            .is_err()
    );
    assert_eq!(
        f.evaluate(
            "edit",
            "Edit",
            json!({"path":"note.txt","edits":[{"oldText":"reviewed","newText":"revised"}]})
        )
        .await["allowed"],
        true
    );
    let edit = json!({"sessionId":SESSION,"origin":{"tool":"Edit","toolCallId":"edit"},"path":"note.txt","content":"other"});
    assert!(
        f.io.dispatch(
            "fs/write",
            edit.as_object().expect("object").clone(),
            f.peer.clone()
        )
        .await
        .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("workspace/note.txt")).expect("unchanged"),
        "reviewed"
    );
}

#[tokio::test]
async fn editing_user_settings_does_not_silently_switch_an_open_session() {
    let f = Fixture::new().await;
    f.io.set_initial_mode(SESSION, None)
        .await
        .expect("initial mode");
    std::fs::write(
        f.root.join("data/settings.json"),
        r#"{"permissions":{"defaultMode":"acceptEdits"}}"#,
    )
    .expect("settings");
    // A later read triggers a new preflight without changing the chosen mode.
    f.evaluate("read", "Read", json!({"path":"known"})).await;
    let s = f.io.session(SESSION).expect("session");
    assert_eq!(lock(&s.policy).mode, PermissionMode::Default);
}

#[cfg(unix)]
#[tokio::test]
async fn simple_commands_with_custom_shell_resolution_require_review() {
    let f = Fixture::with_env(super::super::CommandEnv::Fixed(vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("BASH_ENV".into(), "custom-init".into()),
    ]))
    .await;
    f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
        .await
        .expect("auto edits");
    let run = f.evaluate("custom", "Bash", json!({"command":"touch note.txt"}));
    let answer_user = async {
        let card = f.pending().await;
        f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
            .await
            .expect("decline");
    };
    let (result, ()) = tokio::join!(run, answer_user);
    assert_eq!(result["allowed"], false);
}

#[tokio::test]
async fn a_preflight_configuration_error_is_audited_as_a_refusal() {
    let f = Fixture::new().await;
    std::fs::write(f.root.join("workspace/.piarc/settings.json"), "{")
        .expect("invalid configuration");
    let params =
        json!({"sessionId":SESSION,"toolCallId":"read","tool":"Read","input":{"path":"file"}});
    let error =
        f.io.dispatch(
            "policy/evaluate",
            params.as_object().expect("map").clone(),
            f.peer.clone(),
        )
        .await
        .expect_err("fail closed");
    assert_eq!(error.data.kind, ErrorKind::PermissionDenied);
    let rows = f
        .storage
        .with(|s| s.session_audit_events(SESSION, 10))
        .expect("database")
        .expect("audit");
    assert_eq!(rows.len(), 1);
    let detail: Value = serde_json::from_str(&rows[0].detail).expect("audit details");
    assert_eq!(detail["conclusion"], "deny");
    assert_eq!(detail["step"], "preflightError");
}

#[tokio::test]
async fn permission_lookup_requires_a_working_trust_store() {
    let f = Fixture::new().await;
    f.storage.close();
    assert!(
        f.io.services()
            .expect("policy")
            .trust
            .permission_settings(&f.root.join("workspace"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn completion_only_retires_memory_for_its_own_turn() {
    let f = Fixture::new().await;
    std::fs::write(f.root.join("workspace/CLAUDE.md"), "@../guide.md").unwrap();
    std::fs::write(f.root.join("guide.md"), "Outside guide").unwrap();
    let params = json!({"sessionId": SESSION,"toolCallId":"memory-followup","turnId":"follow-up"});
    let scan = f.io.dispatch(
        "fs/memory",
        params.as_object().unwrap().clone(),
        f.peer.clone(),
    );
    let retire = async {
        let card = f.pending().await;
        f.io.clear_approvals(SESSION, Cleanup::Completed("previous"));
        assert_eq!(f.pending().await.request_id, card.request_id);
        f.io.clear_approvals(SESSION, Cleanup::Completed("follow-up"));
        assert_ne!(
            f.io.answer_approval(answer(&card, ApprovalDecision::AllowOnce))
                .await
                .unwrap()["status"],
            "applied"
        );
    };
    let (snapshot, ()) = tokio::join!(scan, retire);
    assert!(
        snapshot.is_err(),
        "a finished turn must not receive an approved file"
    );
}

mod t23;
mod t26;
mod t27;
mod t28;
mod t29;
mod t31;
mod t36;
mod t37;
mod t38;

/// W1 (architecture 15.2): Windows paths through the whole production path, preflight, grant
/// and directory-bound I/O. Long paths and reserved names are made here, never committed.
#[cfg(windows)]
mod windows_paths {
    use super::*;

    impl Fixture {
        async fn io_call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
            let params = params.as_object().expect("object").clone();
            self.io.dispatch(method, params, self.peer.clone()).await
        }

        /// What the Agent Host's Write does after its preflight.
        async fn write_new(
            &self,
            call: &str,
            path: &str,
            content: &str,
        ) -> Result<Value, ErrorObject> {
            let input = json!({"path": path, "content": content});
            let preflight =
                json!({"sessionId": SESSION, "toolCallId": call, "tool": "Write", "input": input});
            let decision = self.io_call("policy/evaluate", preflight).await?;
            assert_eq!(decision["allowed"], true, "{decision}");
            let origin = json!({"tool": "Write", "toolCallId": call});
            self.io_call(
                "fs/write",
                json!({"sessionId": SESSION, "path": path, "content": content, "origin": origin, "lineEndings": "matchFile"}),
            )
            .await
        }

        /// What the Agent Host's Read does after its preflight; the text read.
        async fn read_text(&self, call: &str, path: &str) -> String {
            assert_eq!(
                self.evaluate(call, "Read", json!({"path": path})).await["allowed"],
                true
            );
            let origin = json!({"tool": "Read", "toolCallId": call});
            let read = json!({"sessionId": SESSION, "path": path, "read": {}, "origin": origin});
            self.io_call("fs/stat", read.clone()).await.expect("stat");
            let content = self
                .io_call(
                    "fs/read",
                    json!({"sessionId": SESSION, "path": path, "origin": origin}),
                )
                .await
                .expect("read");
            let mut done = read;
            done["completeRead"] = true.into();
            self.io_call("fs/stat", done).await.expect("complete read");
            content["text"].as_str().expect("text").to_owned()
        }
    }

    #[tokio::test]
    async fn paths_longer_than_260_characters_are_written_and_read() {
        let f = Fixture::new().await;
        f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
            .await
            .expect("mode");
        let deep: String = (0..6)
            .map(|i| format!("{i} 长路径 {}/", "segment".repeat(6)))
            .collect();
        std::fs::create_dir_all(f.root.join("workspace").join(&deep)).expect("long directories");
        let file = format!("{deep}file 文件.txt");
        let full = f.root.join("workspace").join(&file);
        assert!(full.display().to_string().len() > 260, "{}", full.display());
        f.write_new("long-write", &file, "deep\r\n")
            .await
            .expect("written");
        assert_eq!(std::fs::read(&full).expect("on disk"), b"deep\r\n");
        assert_eq!(f.read_text("long-read", &file).await, "deep\r\n");
    }

    #[tokio::test]
    async fn reserved_and_trimmed_names_are_refused_before_anything_is_written() {
        let f = Fixture::new().await;
        f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
            .await
            .expect("mode");
        for name in [
            "CON",
            "nul",
            "aux.txt",
            "COM1.log",
            "LPT9",
            "note.",
            "note.txt ",
        ] {
            let error = f.write_new(name, name, "x").await.expect_err(name);
            assert_eq!(error.data.kind, ErrorKind::IoError, "{name}: {error:?}");
            assert!(
                error.message.contains("Windows"),
                "{name}: {}",
                error.message
            );
        }
        let left: Vec<_> = std::fs::read_dir(f.root.join("workspace"))
            .expect("list")
            .map(|e| e.expect("entry").file_name())
            .filter(|n| n != ".piarc")
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    fn junction(link: &Path, target: &Path) {
        let out = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("cmd runs");
        assert!(out.status.success(), "mklink /J: {out:?}");
    }

    fn outside(f: &Fixture) -> PathBuf {
        let dir = f.root.join("outside 外部");
        std::fs::create_dir_all(&dir).expect("outside");
        std::fs::write(dir.join("secret.txt"), "outside").expect("secret");
        dir
    }

    /// A junction is a directory reparse point: a path through it leaves the workspace and asks.
    #[tokio::test]
    async fn a_junction_to_another_directory_asks_like_any_outside_path() {
        let f = Fixture::new().await;
        f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
            .await
            .expect("mode");
        junction(&f.root.join("workspace").join("link"), &outside(&f));
        for (call, tool, input) in [
            ("read", "Read", json!({"path": "link/secret.txt"})),
            (
                "write",
                "Write",
                json!({"path": "link/new.txt", "content": "x"}),
            ),
        ] {
            let run = f.evaluate(call, tool, input);
            let refuse = async {
                let card = f.pending().await;
                assert_eq!(card.kind, ApprovalKind::PermissionExpansion, "{call}");
                f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
                    .await
                    .expect("decline");
            };
            let (result, ()) = tokio::join!(run, refuse);
            assert_eq!(result["allowed"], false, "{call}");
        }
        assert!(!f.root.join("outside 外部/new.txt").exists());
    }

    /// ADR-0036 on Windows: an approved directory is held without delete sharing, so it cannot
    /// be swapped for a junction; if the volume allowed the move, the bound read must fail.
    #[tokio::test]
    async fn an_approved_directory_cannot_be_swapped_for_a_junction() {
        let f = Fixture::new().await;
        let target = outside(&f);
        let sub = f.root.join("workspace").join("sub");
        std::fs::create_dir_all(&sub).expect("sub");
        std::fs::write(sub.join("secret.txt"), "inside").expect("inside");
        let call = "swap";
        assert_eq!(
            f.evaluate(call, "Read", json!({"path": "sub/secret.txt"}))
                .await["allowed"],
            true
        );
        let moved = std::fs::rename(&sub, f.root.join("workspace").join("sub-old"));
        println!("moving the approved directory: {moved:?}");
        if moved.is_ok() {
            junction(&sub, &target);
        }
        let origin = json!({"tool": "Read", "toolCallId": call});
        let read = f
            .io_call(
                "fs/read",
                json!({"sessionId": SESSION, "path": "sub/secret.txt", "origin": origin}),
            )
            .await;
        match moved {
            Err(e) => {
                assert!(matches!(e.raw_os_error(), Some(5 | 32)), "{e:?}");
                assert_eq!(read.expect("unchanged directory")["text"], "inside");
            }
            Ok(()) => assert!(read.is_err(), "read through the swapped junction: {read:?}"),
        }
    }

    /// A real share: `PIARC_TEST_UNC_SHARE` (`\\host\share`) must expose the test's temporary
    /// directory, where the fixture makes the workspace; point `TMP` at the shared folder.
    /// Without it this prints NOT RUN: W1 ran it on a folder the user shared for the check;
    /// nothing here creates or changes shares.
    #[tokio::test]
    async fn a_workspace_on_a_unc_share_is_written_read_and_searched() {
        let Some(share) = std::env::var_os("PIARC_TEST_UNC_SHARE") else {
            println!("NOT RUN: set PIARC_TEST_UNC_SHARE to a share of the temporary directory");
            return;
        };
        let share = PathBuf::from(share);
        let f = Fixture::build(
            super::super::super::CommandEnv::process(),
            |dir| {
                let below = dir.strip_prefix(std::env::temp_dir()).expect("below temp");
                share.join(below)
            },
            false,
            system_clock(),
        )
        .await;
        f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
            .await
            .expect("mode");
        println!("UNC workspace {}", f.work.display());
        f.write_new("unc-write", "共享 note.txt", "over unc\r\n")
            .await
            .expect("written");
        assert_eq!(
            std::fs::read(f.root.join("workspace/共享 note.txt")).expect("local view"),
            b"over unc\r\n"
        );
        assert_eq!(
            f.read_text("unc-read", "共享 note.txt").await,
            "over unc\r\n"
        );
        let glob = f
            .evaluate("unc-glob", "Glob", json!({"pattern": "*.txt"}))
            .await;
        assert_eq!(glob["allowed"], true);
        let origin = json!({"tool": "Glob", "toolCallId": "unc-glob"});
        let found = f
            .io_call(
                "fs/glob",
                json!({"sessionId": SESSION, "path": ".", "pattern": "*.txt", "origin": origin}),
            )
            .await
            .expect("glob");
        assert!(found.to_string().contains("共享 note.txt"), "{found}");
    }
}
