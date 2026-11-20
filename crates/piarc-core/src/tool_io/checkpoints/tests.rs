//! T28 on Core's side, through `ToolIo` without an Agent Host: snapshots of `fs/write`,
//! rewinds with conflicts and a failure, undo, the Changes panel's discards and retention.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use piarc_checkpoint::{RetentionPolicy, hash_of};
use piarc_protocol::checkpoint::{
    ChangeKind, ConflictChoice, DiscardRequest, FileOutcome, RewindAction, RewindPreview,
};
use serde_json::{Value, json};

use super::*;
use crate::DataDirs;
use crate::agent_host::Peer;
use crate::checkpoints::CheckpointConfig;
use crate::storage::Storage;
use crate::tool_io::ToolIoConfig;

const S: &str = "main";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

struct Fixture {
    root: PathBuf,
    io: ToolIo,
    cp: Checkpoints,
    clock: Arc<AtomicI64>,
    storage: Storage,
}

impl Fixture {
    fn new(name: &str) -> Self {
        Self::with_retention(name, RetentionPolicy::default())
    }

    fn with_retention(name: &str, retention: RetentionPolicy) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc checkpoints {name} 中文 {}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        std::fs::create_dir_all(root.join("ws 工作区/.git")).expect("workspace");
        let dirs = DataDirs::new(root.join("data"), root.join("cache")).expect("directories");
        dirs.create_layout().expect("layout");
        let storage = Storage::open(dirs).expect("database");
        let clock = Arc::new(AtomicI64::new(1_000 * DAY_MS));
        let now = Arc::clone(&clock);
        let cp = Checkpoints::open(
            storage.clone(),
            CheckpointConfig {
                retention,
                now_ms: Arc::new(move || now.load(Ordering::SeqCst)),
                sweep_interval: Duration::from_secs(3600),
            },
        )
        .expect("checkpoints");
        let io = ToolIo::new(ToolIoConfig::new(root.join("data"))).with_checkpoints(cp.clone());
        let ws = root.join("ws 工作区");
        io.open_session(S, &ws, &ws).expect("session");
        Self {
            root,
            io,
            cp,
            clock,
            storage,
        }
    }

    fn file(&self, rel: &str) -> PathBuf {
        self.root.join("ws 工作区").join(rel)
    }

    fn put(&self, rel: &str, bytes: &[u8]) {
        let path = self.file(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, bytes).expect("written");
    }

    fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        std::fs::read(self.file(rel)).ok()
    }

    fn path(&self, rel: &str) -> String {
        piarc_fs::display(&self.io.scope(S).expect("scope").locate(rel).expect("path"))
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        let (peer, _frames) = Peer::channel(64);
        let Value::Object(params) = params else {
            panic!("params must be an object");
        };
        self.io.dispatch(method, params, peer).await
    }

    async fn read(&self, rel: &str) {
        let origin = json!({"tool":"Read","toolCallId":format!("read-{rel}")});
        let params = json!({"sessionId":S,"path":rel,"read":{},"origin":origin});
        let stat = self.call("fs/stat", params.clone()).await.expect("stat");
        if stat["unchanged"] == false {
            self.call("fs/read", json!({"sessionId":S,"path":rel,"origin":origin}))
                .await
                .expect("content");
            let mut done = params;
            done["completeRead"] = true.into();
            self.call("fs/stat", done).await.expect("complete read");
        }
    }

    async fn write(&self, turn: &str, rel: &str, content: &str) -> Result<Value, ErrorObject> {
        self.call(
            "fs/write",
            json!({ "sessionId": S, "path": rel, "content": content, "turnId": turn }),
        )
        .await
    }

    async fn preview(&self, turn: &str) -> RewindPreview {
        self.io.rewind_preview(S, turn).await.expect("preview")
    }

    async fn discard(
        &self,
        path: &str,
        version: &str,
        hunk: Option<u64>,
    ) -> Result<piarc_protocol::checkpoint::ChangesView, ErrorObject> {
        let request = DiscardRequest {
            path: path.to_owned(),
            version: version.to_owned(),
            hunk,
        };
        self.io.discard(S, request).await
    }

    fn objects(&self) -> usize {
        self.cp.store().count().expect("count")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn actions(preview: &RewindPreview) -> Vec<(&str, RewindAction)> {
    preview
        .files
        .iter()
        .map(|f| (f.label.as_str(), f.action))
        .collect()
}

fn outcomes(report: &RewindReport) -> Vec<(&str, FileOutcome)> {
    report
        .files
        .iter()
        .map(|f| (f.label.as_str(), f.outcome))
        .collect()
}

/// T28-A01: every turn gets a checkpoint, writes store the old content first, equal contents
/// once.
#[tokio::test]
async fn each_turn_has_a_checkpoint_and_equal_old_contents_are_stored_once() {
    let f = Fixture::new("a01");
    f.io.turn_started(S, "turn-quiet");
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.cp.checkpoint_of(S, "turn-quiet").expect("read").is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the turn's checkpoint");
    f.put("a.txt", b"same old\n");
    f.put("b.txt", b"same old\n");
    f.read("a.txt").await;
    f.read("b.txt").await;
    f.write("turn-1", "a.txt", "new a\n").await.expect("a");
    f.write("turn-1", "b.txt", "new b\n").await.expect("b");
    f.write("turn-1", "c.txt", "created\n").await.expect("c");
    assert_eq!(f.objects(), 1, "one object for the two equal old contents");
    let records = f.cp.records(S).expect("records");
    assert_eq!(records.len(), 3);
    let turn =
        f.cp.checkpoint_of(S, "turn-1")
            .expect("read")
            .expect("checkpoint");
    assert!(records.iter().all(|r| r.checkpoint == turn));
    assert_eq!(records[0].before, Some(hash_of(b"same old\n")));
    assert_eq!(records[2].before, None, "a created file has no old content");
    assert_eq!(
        f.cp.store().get(&hash_of(b"same old\n")).expect("stored"),
        b"same old\n"
    );
    let quiet =
        f.cp.checkpoint_of(S, "turn-quiet")
            .expect("read")
            .expect("quiet");
    assert!(quiet < turn, "checkpoints follow turn order");
}

/// T28-A02 (Core side) and A09's fidelity: the files go back byte for byte, created files are
/// removed, and the agent must read again; the rewind can be undone.
#[tokio::test]
async fn rewinding_restores_old_bytes_deletes_created_files_and_can_be_undone() {
    let f = Fixture::new("rewind");
    let original: &[u8] = b"\xEF\xBB\xBFone\r\ntwo\r\n";
    f.put("src/b 中文.txt", original);
    f.read("src/b 中文.txt").await;
    f.write("turn-1", "src/b 中文.txt", "one\nTWO\n")
        .await
        .expect("t1");
    f.write("turn-1", "new.txt", "made\n")
        .await
        .expect("created");
    f.write("turn-2", "src/b 中文.txt", "one\nTWO\nthree\n")
        .await
        .expect("t2");
    let after_t2 = f.bytes("src/b 中文.txt").expect("file");

    let preview = f.preview("turn-1").await;
    assert!(preview.code_available);
    assert_eq!(
        actions(&preview),
        [
            ("src/b 中文.txt", RewindAction::Restore),
            ("new.txt", RewindAction::Delete)
        ]
    );
    assert_eq!(
        f.bytes("src/b 中文.txt"),
        Some(after_t2.clone()),
        "a preview changes nothing"
    );

    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("rewind");
    assert!(report.completed);
    assert_eq!(
        outcomes(&report),
        [
            ("src/b 中文.txt", FileOutcome::Restored),
            ("new.txt", FileOutcome::Deleted)
        ]
    );
    assert_eq!(f.bytes("src/b 中文.txt").as_deref(), Some(original));
    assert_eq!(f.bytes("new.txt"), None);
    let error = f
        .write("turn-3", "src/b 中文.txt", "x")
        .await
        .expect_err("must read");
    assert_eq!(error.data.kind, ErrorKind::FileNotRead);

    // Rewinding to turn 2 now: the files hold what the rewind left, which counts as the
    // session's, and new.txt existed when turn 2 started.
    let again = f.preview("turn-2").await;
    assert_eq!(
        actions(&again),
        [
            ("src/b 中文.txt", RewindAction::Restore),
            ("new.txt", RewindAction::Restore)
        ]
    );

    let restore_id = report.restore_id.expect("undo id");
    let undone = f.io.undo_rewind(S, &restore_id).await.expect("undo");
    assert!(undone.completed);
    assert_eq!(f.bytes("src/b 中文.txt"), Some(after_t2));
    assert_eq!(f.bytes("new.txt").as_deref(), Some(&b"made\n"[..]));
    assert!(
        f.io.rewind_preview(S, "turn-unknown")
            .await
            .expect("preview")
            .files
            .is_empty()
    );
    assert!(!f.preview("turn-unknown").await.code_available);
}

/// T28-A05 (Core side): files changed outside the session are conflicts; the user's choice
/// per file is carried out, and a stale choice fails without overwriting.
#[tokio::test]
async fn conflicts_follow_the_users_choice() {
    let f = Fixture::new("conflicts");
    f.write("turn-1", "keep.txt", "agent keep\n")
        .await
        .expect("keep");
    f.write("turn-1", "take.txt", "agent take\n")
        .await
        .expect("take");
    f.write("turn-1", "plain.txt", "agent plain\n")
        .await
        .expect("plain");
    f.put("keep.txt", b"edited by hand\n");
    f.put("take.txt", b"changed by bash\n");
    let preview = f.preview("turn-1").await;
    assert_eq!(
        actions(&preview),
        [
            ("keep.txt", RewindAction::Conflict),
            ("take.txt", RewindAction::Conflict),
            ("plain.txt", RewindAction::Delete)
        ]
    );
    assert_eq!(
        preview.files[0].deletes,
        Some(true),
        "overwriting removes a created file"
    );
    let choice = |i: usize, overwrite| ConflictChoice {
        path: preview.files[i].path.clone(),
        version: preview.files[i].version.clone(),
        overwrite,
    };

    // A choice made for content that changed again fails, and nothing after it runs.
    f.put("keep.txt", b"edited once more\n");
    let stale =
        f.io.rewind_code(S, "turn-1", vec![choice(0, true), choice(1, true)])
            .await
            .expect("report");
    assert!(!stale.completed);
    assert_eq!(stale.files[0].outcome, FileOutcome::Failed);
    assert_eq!(stale.files[1].outcome, FileOutcome::Skipped);
    assert!(stale.restore_id.is_none());
    assert_eq!(
        f.bytes("take.txt").as_deref(),
        Some(&b"changed by bash\n"[..])
    );

    let preview = f.preview("turn-1").await;
    let choice = |i: usize, overwrite| ConflictChoice {
        path: preview.files[i].path.clone(),
        version: preview.files[i].version.clone(),
        overwrite,
    };
    let report =
        f.io.rewind_code(S, "turn-1", vec![choice(0, false), choice(1, true)])
            .await
            .expect("rewind");
    assert!(report.completed);
    assert_eq!(
        outcomes(&report),
        [
            ("keep.txt", FileOutcome::Kept),
            ("take.txt", FileOutcome::Deleted),
            ("plain.txt", FileOutcome::Deleted)
        ]
    );
    assert_eq!(
        f.bytes("keep.txt").as_deref(),
        Some(&b"edited once more\n"[..])
    );
    assert_eq!(f.bytes("take.txt"), None);
}

/// T28-A06: a file that cannot be written stops the rewind with per-file results; what was
/// restored before it can be undone.
#[tokio::test]
async fn a_failed_file_stops_the_rewind_and_the_restored_part_can_be_undone() {
    let f = Fixture::new("failure");
    for name in ["a.txt", "b.txt", "c.txt"] {
        f.put(name, format!("{name} before\n").as_bytes());
        f.read(name).await;
        f.write("turn-1", name, &format!("{name} after\n"))
            .await
            .expect("write");
    }
    let b = f.file("b.txt");
    let mut permissions = std::fs::metadata(&b).expect("meta").permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&b, permissions.clone()).expect("read-only");

    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("report");
    assert!(!report.completed);
    assert_eq!(
        outcomes(&report),
        [
            ("a.txt", FileOutcome::Restored),
            ("b.txt", FileOutcome::Failed),
            ("c.txt", FileOutcome::Skipped)
        ]
    );
    assert!(
        report.files[1]
            .error
            .as_deref()
            .is_some_and(|e| e.contains("permission denied")),
        "{report:?}"
    );
    assert!(
        report
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("b.txt"))
    );
    assert_eq!(f.bytes("a.txt").as_deref(), Some(&b"a.txt before\n"[..]));
    assert_eq!(f.bytes("c.txt").as_deref(), Some(&b"c.txt after\n"[..]));

    let undone =
        f.io.undo_rewind(S, report.restore_id.as_deref().expect("undo id"))
            .await
            .expect("undo");
    assert!(undone.completed);
    assert_eq!(outcomes(&undone), [("a.txt", FileOutcome::Restored)]);
    assert_eq!(f.bytes("a.txt").as_deref(), Some(&b"a.txt after\n"[..]));
    #[expect(clippy::permissions_set_readonly_false, reason = "the test's own file")]
    permissions.set_readonly(false);
    std::fs::set_permissions(&b, permissions).expect("writable again");
}

/// T28-A09 (Core side): the Changes panel's base, hunk and file discards keep CRLF and the byte
/// order mark, refuse a stale version, and make the agent read again.
#[tokio::test]
async fn discards_keep_crlf_and_bom_and_need_a_new_read() {
    let f = Fixture::new("discard");
    let base: String = (1..=30).map(|n| format!("line {n}\r\n")).collect();
    let original = [b"\xEF\xBB\xBF".as_slice(), base.as_bytes()].concat();
    f.put("crlf.txt", &original);
    f.read("crlf.txt").await;
    let edited = base
        .replace("line 2\r\n", "line two\r\n")
        .replace("line 25\r\n", "line twenty-five\r\n");
    f.write("turn-1", "crlf.txt", &edited).await.expect("edit");
    f.write("turn-1", "made.txt", "new\n")
        .await
        .expect("created");
    f.put("bash-only.txt", b"a command wrote this\n");

    let view = f.io.changes(S, None).await.expect("changes");
    assert_eq!(view.files.len(), 2, "only files written through Core");
    let file = &view.files[0];
    assert_eq!(
        (file.kind, file.added, file.removed),
        (ChangeKind::Modified, 2, 2)
    );
    assert_eq!(view.files[1].kind, ChangeKind::Created);
    assert_eq!((view.added, view.removed), (3, 2));
    let diff = file.diff.as_ref().expect("diff");
    assert_eq!(diff.hunks.len(), 2);
    assert!(diff.hunks[0].lines.iter().all(|l| !l.text.contains('\r')));

    let stale = f
        .discard(&file.path, &"0".repeat(64), Some(1))
        .await
        .expect_err("stale");
    assert_eq!(stale.data.kind, ErrorKind::FileModified);

    let after = f
        .discard(&file.path, &file.version, Some(1))
        .await
        .expect("hunk");
    let expected = [
        b"\xEF\xBB\xBF".as_slice(),
        base.replace("line 2\r\n", "line two\r\n").as_bytes(),
    ]
    .concat();
    assert_eq!(f.bytes("crlf.txt"), Some(expected));
    let left = &after.files[0];
    assert_eq!((left.added, left.removed), (1, 1));
    let error = f
        .write("turn-2", "crlf.txt", "x")
        .await
        .expect_err("must read");
    assert_eq!(error.data.kind, ErrorKind::FileNotRead);

    let cleared = f
        .discard(&left.path, &left.version, None)
        .await
        .expect("file");
    assert!(cleared.files.is_empty());
    assert_eq!(f.bytes("crlf.txt"), Some(original));
    let made = &view.files[1];
    f.discard(&made.path, &made.version, None)
        .await
        .expect("created file");
    assert_eq!(f.bytes("made.txt"), None);
    assert!(
        f.io.changes(S, None)
            .await
            .expect("changes")
            .files
            .is_empty()
    );
}

/// Past the panel's limits the diffs are left out; a file alone still has its (degraded) diff.
#[tokio::test]
async fn a_large_change_degrades_the_panel() {
    let f = Fixture::new("degrade");
    let big: String = (0..5_001).map(|n| format!("{n}\n")).collect();
    f.write("turn-1", "big.txt", &big).await.expect("big");
    let view = f.io.changes(S, None).await.expect("changes");
    assert_eq!(view.degraded, Some(true));
    assert!(view.files[0].diff.is_none());
    assert_eq!(view.files[0].added, 5_001);
    let alone =
        f.io.changes(S, Some(view.files[0].path.clone()))
            .await
            .expect("one file");
    assert_eq!(alone.degraded, None);
    let diff = alone.files[0].diff.as_ref().expect("diff");
    assert_eq!(diff.degraded, Some(true));
    assert!(diff.hunks.is_empty());
}

/// T28-A10: a session keeps its newest checkpoints, an idle one loses all, and objects nothing
/// refers to are collected.
#[tokio::test]
async fn retention_keeps_the_newest_checkpoints_and_drops_idle_sessions() {
    let f = Fixture::with_retention(
        "retention",
        RetentionPolicy {
            max_checkpoints: 3,
            idle: Duration::from_secs(30 * 24 * 60 * 60),
        },
    );
    f.write("turn-0", "f.txt", "v0\n").await.expect("v0");
    for n in 1..=5 {
        f.write(&format!("turn-{n}"), "f.txt", &format!("v{n}\n"))
            .await
            .expect("write");
    }
    assert_eq!(f.objects(), 5, "v0 to v4 were replaced");
    assert_eq!(f.cp.prune(S).expect("prune"), 3);
    let turns: Vec<String> =
        f.cp.records(S)
            .expect("records")
            .iter()
            .map(|r| r.path.clone())
            .collect();
    assert_eq!(turns.len(), 3);
    assert_eq!(f.objects(), 3, "the pruned turns' objects are collected");
    assert!(!f.preview("turn-1").await.code_available);
    assert!(f.preview("turn-3").await.code_available);

    // 29 days later the session is still kept; 31 days after its last use it is not.
    f.clock.fetch_add(29 * DAY_MS, Ordering::SeqCst);
    assert!(f.cp.sweep().expect("sweep").idle_sessions.is_empty());
    f.clock.fetch_add(2 * DAY_MS, Ordering::SeqCst);
    let report = f.cp.sweep().expect("sweep");
    assert_eq!(report.idle_sessions, [S]);
    assert_eq!(report.collected.removed, 3);
    assert_eq!(f.objects(), 0);
    assert!(f.cp.records(S).expect("records").is_empty());
}

/// Files outside the workspace (written with the user's approval) are marked, and a rewind
/// writes them through a scope bound to exactly that path.
#[tokio::test]
async fn files_outside_the_workspace_are_marked_and_restored() {
    let f = Fixture::new("outside");
    let outside = f.root.join("outside 外部.txt");
    std::fs::write(&outside, b"after\n").expect("outside file");
    let path = piarc_fs::display(&outside.canonicalize().expect("canonical"));
    f.cp.ensure(S, "turn-1").expect("checkpoint");
    let before = f.cp.store().put(b"before\n").expect("stored");
    f.cp.record(
        S,
        Some("turn-1"),
        &[NewRecord {
            path: path.clone(),
            before: Some(before.hash()),
            after: Some(hash_of(b"after\n")),
            operation: Operation::Modify,
            subagent: None,
        }],
        None,
    )
    .expect("record");
    let preview = f.preview("turn-1").await;
    assert_eq!(preview.files[0].approval, Some(true));
    assert_eq!(preview.files[0].label, path, "outside paths are absolute");
    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("rewind");
    assert!(report.completed, "{report:?}");
    assert_eq!(std::fs::read(&outside).expect("read"), b"before\n");
    assert!(f.path("x").ends_with("x"));
}

/// R3: a recorded file replaced by a link to a file outside the workspace (by Bash, or by
/// injected instructions) is not written through the link: the user approved the recorded
/// path, not wherever it points now.
#[cfg(unix)]
#[tokio::test]
async fn a_rewind_does_not_write_through_a_link_that_replaced_the_file() {
    let f = Fixture::new("link");
    f.put("a.txt", b"original\n");
    f.read("a.txt").await;
    f.write("turn-1", "a.txt", "agent\n").await.expect("write");
    let outside = f.root.join("outside.txt");
    std::fs::write(&outside, b"not the workspace's\n").expect("outside");
    std::fs::remove_file(f.file("a.txt")).expect("remove");
    std::os::unix::fs::symlink(&outside, f.file("a.txt")).expect("link");
    let preview = f.preview("turn-1").await;
    let choices = preview
        .files
        .iter()
        .filter(|p| p.action == RewindAction::Conflict)
        .map(|p| ConflictChoice {
            path: p.path.clone(),
            version: p.version.clone(),
            overwrite: true,
        })
        .collect();
    let report =
        f.io.rewind_code(S, "turn-1", choices)
            .await
            .expect("report");
    assert_eq!(
        std::fs::read(&outside).expect("outside"),
        b"not the workspace's\n",
        "{report:?}"
    );
    assert!(!report.completed, "{report:?}");
}

/// R3 (review D8): a hunk discard decodes the file to text and encodes it back, so bytes that
/// do not decode (an invalid UTF-8 byte a command added far from the agent's change) must not
/// come back as U+FFFD. The hunk discard is refused (today as `fileModified`: the version of
/// the decoded text differs) and the whole-file discard restores the original bytes.
#[tokio::test]
async fn a_hunk_discard_refuses_a_file_that_does_not_decode_cleanly() {
    let f = Fixture::new("lossy");
    // Mostly UTF-8 Chinese, so the detector keeps UTF-8 for the stray byte.
    let base: String = (1..=20).map(|n| format!("第 {n} 行：中文内容\n")).collect();
    f.put("mixed.txt", base.as_bytes());
    f.read("mixed.txt").await;
    let edited = base.replace("第 2 行", "第二行");
    f.write("turn-1", "mixed.txt", &edited).await.expect("edit");
    let current = [edited.as_bytes(), b"tail \xff\n".as_slice()].concat();
    f.put("mixed.txt", &current);
    let view = f.io.changes(S, None).await.expect("changes");
    let file = &view.files[0];
    let refused = f
        .discard(&file.path, &file.version, Some(0))
        .await
        .expect_err("a lossy hunk discard");
    assert_eq!(f.bytes("mixed.txt"), Some(current), "{refused:?}");
    f.discard(&file.path, &file.version, None)
        .await
        .expect("the whole file");
    assert_eq!(f.bytes("mixed.txt"), Some(base.into_bytes()));
}

/// T31-A10 (Core side): a subagent's writes go to its main session's running turn, recorded
/// with the subagent's session id, and rewinding the main session restores them.
#[tokio::test]
async fn a_subagents_writes_belong_to_its_main_sessions_turn() {
    let f = Fixture::new("subagent");
    f.put("shared.txt", b"before\n");
    f.io.turn_started(S, "turn-1");
    let root = f.io.session(S).expect("main");
    let ws = f.root.join("ws 工作区");
    let link = crate::tool_io::subagents::Link {
        root_id: S.into(),
        root,
        parent_id: S.into(),
        agent_type: "general-purpose".into(),
        description: None,
        mode: None,
        detached: false,
    };
    f.io.open_linked("child", &ws, &ws, link).expect("child");
    let origin = json!({"tool":"Read","toolCallId":"child-read"});
    let read = json!({"sessionId":"child","path":"shared.txt","read":{},"origin":origin});
    f.call("fs/stat", read.clone()).await.expect("stat");
    f.call(
        "fs/read",
        json!({"sessionId":"child","path":"shared.txt","origin":origin}),
    )
    .await
    .expect("read");
    let mut done = read;
    done["completeRead"] = true.into();
    f.call("fs/stat", done).await.expect("complete");
    // The child names no turn: its main session's running turn applies.
    f.call(
        "fs/write",
        json!({"sessionId":"child","path":"shared.txt","content":"by the subagent\n"}),
    )
    .await
    .expect("child write");
    f.call(
        "fs/write",
        json!({"sessionId":"child","path":"made.txt","content":"new\n"}),
    )
    .await
    .expect("child create");
    // The main session never read the file: its own table is separate (I73).
    let error = f
        .write("turn-1", "shared.txt", "x")
        .await
        .expect_err("not read by main");
    assert_eq!(error.data.kind, ErrorKind::FileNotRead);
    let rows = f
        .storage
        .with(|s| s.checkpoint_files(S))
        .expect("open")
        .expect("rows");
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|r| r.subagent_session.as_deref() == Some("child"))
    );
    assert!(
        f.cp.checkpoint_of("child", "turn-1")
            .expect("read")
            .is_none()
    );
    let report =
        f.io.rewind_code(S, "turn-1", Vec::new())
            .await
            .expect("rewind");
    assert!(report.completed);
    assert_eq!(f.bytes("shared.txt").as_deref(), Some(&b"before\n"[..]));
    assert_eq!(f.bytes("made.txt"), None);
}
