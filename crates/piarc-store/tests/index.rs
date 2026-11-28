//! T13-A03 and T13-A05: incremental sync equals a full rebuild; unfinished lines, unknown
//! format versions and damaged lines never fail the index.

mod support;

use std::path::Path;

use piarc_store::{FileOutcome, IndexStatus, SessionRecord, Store};
use support::{Rng, SessionWriter, TempDir};

fn sessions_without_core_state(store: &Store) -> Vec<SessionRecord> {
    store.sessions().expect("sessions")
}

fn fresh_rebuild(sessions: &Path) -> Vec<SessionRecord> {
    let mut store = Store::open_in_memory(0).expect("store");
    store.rebuild_index(sessions).expect("rebuild");
    sessions_without_core_state(&store)
}

#[test]
fn random_appends_synced_incrementally_match_a_full_rebuild() {
    let dir = TempDir::new("random appends");
    let sessions = dir.path().join("pi").join("sessions");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let mut writers: Vec<SessionWriter> = (0..4)
        .map(|i| {
            SessionWriter::create(
                &sessions,
                &format!("/work/项目 {i}"),
                &format!("s-{i}"),
                Some(3),
            )
        })
        .collect();
    let mut rng = Rng::new(0x5eed_1234);
    let mut appended_rounds = 0;
    let mut pending: Vec<Option<String>> = vec![None; writers.len()];
    let mut unfinished_rounds = 0;
    for round in 0..60 {
        // Append 0..5 entries to a random subset, sometimes leaving the last write unfinished
        // until a later round.
        for (writer, rest) in writers.iter_mut().zip(&mut pending) {
            if rng.below(3) == 0 {
                continue;
            }
            if let Some(tail) = rest.take() {
                writer.append_raw(&tail);
            }
            for _ in 0..rng.below(5) {
                let line = writer.random_entry(&mut rng);
                writer.append_raw(&line);
            }
            if rng.below(4) == 0 {
                let line = writer.random_entry(&mut rng);
                let cut = usize::try_from(rng.below(line.len() as u64 - 1) + 1).unwrap_or(1);
                let cut = (cut..line.len())
                    .find(|&i| line.is_char_boundary(i))
                    .unwrap_or(1);
                writer.append_partial(&line[..cut]);
                *rest = Some(line[cut..].to_owned());
                unfinished_rounds += 1;
            }
        }
        let report = store.sync_dir(&sessions).expect("incremental sync");
        assert!(report.failed.is_empty(), "{report:?}");
        assert!(report.skipped_lines.is_empty(), "{report:?}");
        appended_rounds += usize::from(report.appended > 0);
        if round % 7 == 0 {
            assert_eq!(
                sessions_without_core_state(&store),
                fresh_rebuild(&sessions),
                "round {round}"
            );
        }
    }
    assert!(appended_rounds > 10, "the incremental path was exercised");
    assert!(
        unfinished_rounds > 5,
        "unfinished last lines were exercised"
    );
    assert_eq!(
        sessions_without_core_state(&store),
        fresh_rebuild(&sessions)
    );
    for (writer, rest) in writers.iter_mut().zip(&mut pending) {
        if let Some(tail) = rest.take() {
            writer.append_raw(&tail);
        }
    }
    let report = store.sync_dir(&sessions).expect("sync");
    assert!(report.skipped_lines.is_empty());
    assert_eq!(
        sessions_without_core_state(&store),
        fresh_rebuild(&sessions)
    );

    // Rebuilding the same database gives the same table again and keeps Core's own columns.
    let incremental = sessions_without_core_state(&store);
    store.rebuild_index(&sessions).expect("rebuild in place");
    assert_eq!(sessions_without_core_state(&store), incremental);
}

#[test]
fn an_unfinished_last_line_is_not_an_error_and_is_synced_once_complete() {
    let dir = TempDir::new("unfinished line");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/w", "s-half", Some(3));
    let first = writer.user("第一条");
    writer.append_raw(&first);
    let line = writer.assistant("answer", "mock-large", 100, 20);
    let (head, tail) = line.split_at(line.len() / 2);
    writer.append_partial(head);

    let mut skipped = Vec::new();
    let outcome = store.sync_file(&writer.path, &mut skipped).expect("sync");
    assert_eq!(outcome, FileOutcome::Rescanned { entries: 1 });
    assert!(
        skipped.is_empty(),
        "the half line is not reported as damaged"
    );
    let record = store.session("s-half").expect("read").expect("indexed");
    assert_eq!(record.meta.message_count, 1);
    assert_eq!(record.meta.usage.input, 0);

    // Syncing again while it is still unfinished changes nothing.
    assert_eq!(
        store.sync_file(&writer.path, &mut skipped).expect("sync"),
        FileOutcome::Unchanged
    );

    writer.append_partial(tail);
    writer.append_partial("\n");
    let outcome = store.sync_file(&writer.path, &mut skipped).expect("sync");
    assert_eq!(outcome, FileOutcome::Appended { entries: 1 });
    assert!(skipped.is_empty());
    let record = store.session("s-half").expect("read").expect("indexed");
    assert_eq!(record.meta.message_count, 2);
    assert_eq!(record.meta.usage.input, 100);
    assert_eq!(record.meta.model_id.as_deref(), Some("mock-large"));
    assert_eq!(record.title(), Some("第一条"));
    assert_eq!(vec![record], fresh_rebuild(&sessions));
}

#[test]
fn a_shorter_or_replaced_file_is_read_again_from_the_start() {
    let dir = TempDir::new("replaced");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/w", "s-r", Some(3));
    for text in ["one", "two", "three"] {
        let line = writer.user(text);
        writer.append_raw(&line);
    }
    let mut skipped = Vec::new();
    store.sync_file(&writer.path, &mut skipped).expect("sync");

    // Shorter: a new session with the same file name.
    let mut other = SessionWriter::create(&dir.path().join("tmp"), "/w", "s-r", Some(3));
    let line = other.user("only");
    other.append_raw(&line);
    std::fs::copy(&other.path, &writer.path).expect("replace");
    assert_eq!(
        store.sync_file(&writer.path, &mut skipped).expect("sync"),
        FileOutcome::Rescanned { entries: 1 }
    );
    let record = store.session("s-r").expect("read").expect("indexed");
    assert_eq!(record.meta.message_count, 1);
    assert_eq!(record.title(), Some("only"));

    // Same length or longer but with different bytes before the offset: read again.
    let mut rewritten = std::fs::read_to_string(&writer.path).expect("read");
    rewritten = rewritten.replace("only", "ONLY");
    rewritten.push_str(&other.user("more"));
    rewritten.push('\n');
    std::fs::write(&writer.path, rewritten).expect("rewrite");
    assert_eq!(
        store.sync_file(&writer.path, &mut skipped).expect("sync"),
        FileOutcome::Rescanned { entries: 2 }
    );
    assert_eq!(
        store
            .session("s-r")
            .expect("read")
            .expect("indexed")
            .title(),
        Some("ONLY")
    );

    // A rewrite can preserve both the size and the final complete entry.
    let changed = std::fs::read_to_string(&writer.path)
        .expect("file")
        .replace("ONLY", "Only");
    let before = std::fs::metadata(&writer.path)
        .and_then(|m| m.modified())
        .expect("mtime");
    std::fs::write(&writer.path, changed).expect("edit earlier entry");
    // Only the modification time tells this rewrite apart. Two writes inside one timestamp
    // tick (Windows runners) keep it equal, so move it like a later edit would.
    std::fs::File::options()
        .write(true)
        .open(&writer.path)
        .and_then(|f| f.set_modified(before + std::time::Duration::from_secs(1)))
        .expect("set mtime");
    assert_eq!(
        store.sync_file(&writer.path, &mut skipped).expect("sync"),
        FileOutcome::Rescanned { entries: 2 }
    );
    assert_eq!(
        store
            .session("s-r")
            .expect("lookup")
            .expect("indexed")
            .title(),
        Some("Only")
    );

    // A file that now holds another session id replaces the old row.
    let mut third = SessionWriter::create(&dir.path().join("tmp3"), "/w", "s-other", Some(3));
    let line = third.user("x");
    third.append_raw(&line);
    std::fs::copy(&third.path, &writer.path).expect("replace");
    store.sync_file(&writer.path, &mut skipped).expect("sync");
    assert!(store.session("s-r").expect("read").is_none());
    assert!(store.session("s-other").expect("read").is_some());
    assert!(skipped.is_empty());
}

#[test]
fn unknown_versions_are_unavailable_and_damaged_lines_are_skipped() {
    let dir = TempDir::new("damaged");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");

    let mut future = SessionWriter::create(&sessions, "/w", "s-future", Some(9));
    let line = future.user("from a newer Pi");
    future.append_raw(&line);

    let mut damaged = SessionWriter::create(&sessions, "/w", "s-damaged", Some(3));
    let line = damaged.user("before");
    damaged.append_raw(&line);
    damaged.append_raw(r#"{"type":"message","id":"broken","message":{"role":"#);
    damaged.append_raw("not json at all");
    let line = damaged.assistant("after", "mock-small", 7, 3);
    damaged.append_raw(&line);

    let mut no_header = SessionWriter::create(&sessions, "/w", "s-noheader", Some(3));
    std::fs::write(&no_header.path, "").expect("truncate");
    let line = no_header.user("orphan");
    no_header.append_raw(&line);

    let report = store.sync_dir(&sessions).expect("the index does not fail");
    assert!(report.failed.is_empty(), "{report:?}");
    let mut unavailable: Vec<String> = report
        .unavailable
        .iter()
        .map(|(path, reason)| {
            format!(
                "{}: {reason}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })
        .collect();
    unavailable.sort();
    assert_eq!(
        unavailable,
        [
            "2026-11-16T10-00-00-000Z_s-future.jsonl: unknown session format version 9",
            "2026-11-16T10-00-00-000Z_s-noheader.jsonl: the file does not start with a session header",
        ]
    );
    assert_eq!(report.skipped_lines.len(), 2, "{report:?}");
    assert!(report.skipped_lines.iter().all(|s| s.path == damaged.path));

    let future_row = store.session("s-future").expect("read").expect("listed");
    assert_eq!(future_row.index_status, IndexStatus::Unavailable);
    assert_eq!(
        future_row.index_error.as_deref(),
        Some("unknown session format version 9")
    );
    let orphan_row = store
        .session("s-noheader")
        .expect("read")
        .expect("listed by file name");
    assert_eq!(orphan_row.index_status, IndexStatus::Unavailable);

    let damaged_row = store.session("s-damaged").expect("read").expect("indexed");
    assert_eq!(damaged_row.index_status, IndexStatus::Indexed);
    assert_eq!(damaged_row.meta.message_count, 2);
    assert_eq!(damaged_row.meta.usage.input, 7);

    // Unavailable files growing later stay unavailable and do not fail either.
    let line = future.user("more");
    future.append_raw(&line);
    let again = store.sync_dir(&sessions).expect("sync");
    assert!(again.failed.is_empty());
    assert_eq!(
        again.skipped_lines.len(),
        0,
        "skipped lines are not reported twice"
    );
    assert_eq!(store.sessions().expect("rows"), fresh_rebuild(&sessions));

    // Deleted files leave the index.
    std::fs::remove_file(&future.path).expect("delete");
    let after = store.sync_dir(&sessions).expect("sync");
    assert_eq!(after.removed, 1);
    assert!(store.session("s-future").expect("read").is_none());
}

/// Core's own columns (T14): written for an indexed session, kept by a rebuild, and refused
/// (false) for a session the index does not have yet.
#[test]
fn core_state_is_written_per_session_and_survives_a_rebuild() {
    let dir = TempDir::new("core state");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/w", "s-state", Some(3));
    let line = writer.user("hello");
    writer.append_raw(&line);
    store.sync_dir(&sessions).expect("sync");
    assert!(
        !store
            .set_session_state("s-unknown", "/w", "idle", true)
            .expect("write")
    );
    assert!(
        store
            .set_session_state("s-state", "/w 工作区", "error", true)
            .expect("write")
    );
    store.rebuild_index(&sessions).expect("rebuild");
    let record = store.session("s-state").expect("read").expect("indexed");
    assert_eq!(
        (
            record.workspace_path.as_deref(),
            record.status.as_deref(),
            record.unread
        ),
        (Some("/w 工作区"), Some("error"), true)
    );
}

#[test]
fn user_titles_pins_and_archives_survive_a_rebuild_and_removal_forgets_the_session() {
    let dir = TempDir::new("prefs 元数据");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/w", "s-prefs", Some(3));
    let line = writer.user("first question");
    writer.append_raw(&line);
    store.sync_dir(&sessions).expect("sync");

    let change = piarc_store::SessionPrefsChange {
        custom_title: Some(Some("重命名的会话".into())),
        pinned: Some(true),
        archived: Some(true),
        ..Default::default()
    };
    assert!(
        !store
            .set_session_prefs("s-unknown", &change)
            .expect("write")
    );
    assert!(store.set_session_prefs("s-prefs", &change).expect("write"));
    store.rebuild_index(&sessions).expect("rebuild");
    let record = store.session("s-prefs").expect("read").expect("indexed");
    assert_eq!(record.title(), Some("重命名的会话"));
    assert!(record.pinned && record.archived);

    // Partial changes leave the other fields alone; removing the title shows the derived one.
    let unpin = piarc_store::SessionPrefsChange {
        custom_title: Some(None),
        pinned: Some(false),
        archived: None,
        ..Default::default()
    };
    assert!(store.set_session_prefs("s-prefs", &unpin).expect("write"));
    let record = store.session("s-prefs").expect("read").expect("indexed");
    assert_eq!(record.title(), Some("first question"));
    assert!(!record.pinned && record.archived);

    let file = store.remove_session("s-prefs").expect("remove");
    assert_eq!(file.as_deref(), Some(record.file_path.as_str()));
    assert!(store.session("s-prefs").expect("read").is_none());
    assert_eq!(store.remove_session("s-prefs").expect("remove again"), None);
}

/// ADR-0106: a generated title stands in for the first message, survives a rebuild, and gives
/// way to the user's title.
#[test]
fn generated_titles_come_after_the_users_and_survive_a_rebuild() {
    let dir = TempDir::new("auto titles 标题");
    let sessions = dir.path().join("sessions");
    let mut store = Store::open_in_memory(0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/w", "s-auto", Some(3));
    let line = writer.user("我想系统地学习 Spring Boot，请帮我规划一个四周的入门学习计划");
    writer.append_raw(&line);
    store.sync_dir(&sessions).expect("sync");

    let generated = piarc_store::SessionPrefsChange {
        auto_title: Some("Spring Boot 入门学习计划".into()),
        ..Default::default()
    };
    assert!(
        store
            .set_session_prefs("s-auto", &generated)
            .expect("write")
    );
    store.rebuild_index(&sessions).expect("rebuild");
    let record = store.session("s-auto").expect("read").expect("indexed");
    assert_eq!(record.title(), Some("Spring Boot 入门学习计划"));

    let renamed = piarc_store::SessionPrefsChange {
        custom_title: Some(Some("我的计划".into())),
        ..Default::default()
    };
    assert!(store.set_session_prefs("s-auto", &renamed).expect("write"));
    let record = store.session("s-auto").expect("read").expect("indexed");
    assert_eq!(record.title(), Some("我的计划"));
    assert_eq!(
        record.auto_title.as_deref(),
        Some("Spring Boot 入门学习计划")
    );
}

/// T31-A09: a subagent's file names its parent in its first `piarc.subagent` entry; the index
/// keeps the link (and the file path), and a rebuild from the files restores it.
#[test]
fn subagent_links_come_from_the_file_and_survive_a_rebuild() {
    let dir = TempDir::new("subagent links");
    let sessions = dir.path().join("pi").join("sessions");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let mut parent = SessionWriter::create(&sessions, "/work/父 项目", "parent-1", Some(3));
    let line = parent.user("Investigate");
    parent.append_raw(&line);
    let mut child = SessionWriter::create(&sessions, "/work/父 项目", "child-1", Some(3));
    let lines = [
        child.custom(
            "piarc.systemPrompt",
            r#"{"system":"long text","versions":{}}"#,
        ),
        child.custom("piarc.memoryDirectories", r#"["/a","/b"]"#),
        child.custom(
            "piarc.subagent",
            r#"{"parentSessionId":"parent-1","agentType":"Explore","toolCallId":"call-1"}"#,
        ),
        child.custom(
            "piarc.subagent",
            r#"{"parentSessionId":"someone-else","agentType":"Plan"}"#,
        ),
        child.user("Find the parser"),
        child.assistant("It is in src/parse.rs", "mock-model", 10, 5),
    ];
    for line in &lines {
        child.append_raw(line);
    }
    store.sync_dir(&sessions).expect("sync");
    let link = |records: &[SessionRecord], id: &str| {
        let record = records.iter().find(|r| r.id == id).expect("row");
        (
            record.meta.subagent_parent.clone(),
            record.meta.subagent_type.clone(),
            record.file_path.ends_with("_child-1.jsonl") || id != "child-1",
        )
    };
    let synced = sessions_without_core_state(&store);
    assert_eq!(
        link(&synced, "child-1"),
        (Some("parent-1".into()), Some("Explore".into()), true)
    );
    assert_eq!(link(&synced, "parent-1"), (None, None, true));
    store.rebuild_index(&sessions).expect("rebuild");
    let rebuilt = sessions_without_core_state(&store);
    assert_eq!(link(&rebuilt, "child-1"), link(&synced, "child-1"));
    assert_eq!(rebuilt, fresh_rebuild(&sessions));
}

/// T35: a session's worktree columns are Core's own state: they survive a rebuild, and an
/// archived session's worktree is due for cleanup once its time has come, unless it waits for
/// the user or was removed.
#[test]
fn worktree_columns_survive_a_rebuild_and_list_due_cleanups() {
    let dir = TempDir::new("worktrees");
    let sessions = dir.path().join("pi").join("sessions");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let mut writer = SessionWriter::create(&sessions, "/work/项目", "s-wt", Some(3));
    let line = writer.user("hello");
    writer.append_raw(&line);
    assert!(
        !store
            .set_session_worktree("s-wt", "/w/x", Some("piarc/x"))
            .expect("before")
    );
    store.sync_dir(&sessions).expect("sync");
    let path = "/work/项目/.piarc/worktrees/one";
    assert!(
        store
            .set_session_worktree("s-wt", path, Some("piarc/one"))
            .expect("write")
    );
    store
        .set_session_state("s-wt", "/work/项目", "idle", false)
        .expect("state");
    store.rebuild_index(&sessions).expect("rebuild");
    let record = store.session("s-wt").expect("read").expect("row");
    let worktree = record.worktree.expect("worktree kept");
    assert_eq!(worktree.path, path);
    assert_eq!(worktree.branch.as_deref(), Some("piarc/one"));
    assert_eq!(worktree.cleanup_at, None);

    // Not archived: never due.
    store
        .set_worktree_cleanup("s-wt", Some(100), false)
        .expect("cleanup");
    assert!(store.due_worktrees(1_000).expect("due").is_empty());
    let archive = piarc_store::SessionPrefsChange {
        archived: Some(true),
        ..Default::default()
    };
    store.set_session_prefs("s-wt", &archive).expect("archive");
    assert!(store.due_worktrees(99).expect("due").is_empty());
    let due = store.due_worktrees(100).expect("due");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].path, path);
    assert_eq!(due[0].workspace.as_deref(), Some("/work/项目"));
    // Waiting for the user: not listed again.
    store
        .set_worktree_cleanup("s-wt", Some(100), true)
        .expect("confirm");
    assert!(store.due_worktrees(1_000).expect("due").is_empty());
    assert!(
        store
            .session("s-wt")
            .expect("read")
            .expect("row")
            .worktree
            .expect("wt")
            .confirm
    );
    // Removed: never due, and the confirmation is gone.
    store
        .set_worktree_removed("s-wt", Some(500))
        .expect("removed");
    let removed = store
        .session("s-wt")
        .expect("read")
        .expect("row")
        .worktree
        .expect("wt");
    assert_eq!(removed.removed_at, Some(500));
    assert!(!removed.confirm);
    assert!(store.due_worktrees(1_000).expect("due").is_empty());
}
