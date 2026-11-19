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
        let root = std::env::temp_dir().join(crate::sessions::new_session_id().expect("unique id"));
        let work = root.join("workspace");
        let data = root.join("data");
        let dirs = DataDirs::new(data.clone(), root.join("cache")).expect("directories");
        dirs.create_layout().expect("layout");
        std::fs::create_dir_all(work.join(".piarc")).expect("workspace");
        std::fs::write(
            work.join(".piarc/settings.json"),
            r#"{"permissions":{"allow":["Read(known)"]}}"#,
        )
        .expect("settings");
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
        let snapshots = Snapshots::spawn(&Handle::current(), events, storage.clone());
        let io = ToolIo::new(ToolIoConfig {
            command_env,
            ..ToolIoConfig::new(data)
        })
        .policy_services(Services {
            storage: storage.clone(),
            trust,
            snapshots,
        });
        io.open_session(SESSION, &work, &work).expect("session");
        let (peer, frames) = Peer::channel(4);
        Self {
            root,
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

fn answer(r: &ApprovalRequest, decision: ApprovalDecision) -> ApprovalAnswer {
    ApprovalAnswer {
        request_id: r.request_id.clone(),
        session_id: r.session_id.clone(),
        revision: r.revision,
        connection_epoch: r.connection_epoch,
        decision,
        feedback: None,
        rule: None,
        directory: None,
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
    assert_eq!(states[1]["step"], "exactRule");
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
        io.dispatch("policy/evaluate", json!({"sessionId":SESSION,"toolCallId":"gone","tool":"Bash","input":{"command":"echo hi"}}).as_object().expect("object").clone(),peer).await
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

/// T20-A13. Run alone on the benchmark host with --nocapture for the release-gate measurement.
#[tokio::test]
async fn automatic_decision_latency() {
    const COUNT: usize = 1000;
    let f = Fixture::new().await;
    let mut samples = Vec::with_capacity(COUNT);
    for i in 0..COUNT + 100 {
        let input = json!({"path":if i%2 == 0 {"known"} else {"file.txt"}});
        let started = Instant::now();
        let decision = f.evaluate("auto", "Read", input).await;
        let elapsed = started.elapsed();
        assert_eq!(decision["allowed"], true);
        f.io.finish_tool(SESSION, "auto");
        if i >= 100 {
            samples.push(elapsed);
        }
    }
    samples.sort_unstable();
    let p95 = samples[COUNT * 95 / 100 - 1];
    println!(
        "policy/evaluate automatic, matched rule and mode default, including settings, canonical paths and SQLite audit: {COUNT} decisions; p50 {:?}, p95 {p95:?}, p99 {:?}",
        samples[COUNT / 2 - 1],
        samples[COUNT * 99 / 100 - 1]
    );
    assert_eq!(
        f.storage
            .with(|s| s.session_audit_events(SESSION, 1200))
            .expect("open")
            .expect("audit")
            .len(),
        COUNT + 100
    );
    // Architecture chapter 11, ADR-0037: NTFS metadata calls cost several times more.
    let budget = Duration::from_millis(if cfg!(windows) { 10 } else { 2 });
    assert!(
        p95 <= budget,
        "automatic permission budget {budget:?} exceeded: {p95:?}"
    );
}

#[tokio::test]
async fn permanent_answers_must_include_every_value_shown_for_confirmation() {
    let f = Fixture::new().await;
    let wait = f.evaluate("cmd", "Bash", json!({"command":"echo hello"}));
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
