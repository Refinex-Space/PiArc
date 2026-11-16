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
