use super::*;

fn file<'a>(
    path: &'a str,
    before: Option<&'a str>,
    after: Option<&'a str>,
) -> NewCheckpointFile<'a> {
    NewCheckpointFile {
        path,
        before_hash: before,
        after_hash: after,
        operation: if before.is_none() { "create" } else { "modify" },
        restore_id: None,
        subagent_session: None,
    }
}

#[test]
fn checkpoints_are_per_turn_and_files_in_write_order() {
    let mut store = Store::open_in_memory(1).expect("store");
    let first = store.ensure_checkpoint("s1", "turn-a", 10).expect("first");
    assert_eq!(
        store.ensure_checkpoint("s1", "turn-a", 11).expect("again"),
        first
    );
    let second = store.ensure_checkpoint("s1", "turn-b", 12).expect("second");
    let other = store
        .ensure_checkpoint("s2", "turn-a", 13)
        .expect("other session");
    assert!(first < second && second < other);
    assert_eq!(
        store.checkpoint_id("s1", "turn-b").expect("id"),
        Some(second)
    );
    assert_eq!(store.checkpoint_id("s1", "turn-z").expect("id"), None);
    assert_eq!(store.latest_checkpoint("s1").expect("latest"), Some(second));
    assert_eq!(store.latest_checkpoint("s9").expect("latest"), None);

    store
        .add_checkpoint_files(
            first,
            &[
                file("a 中文.txt", None, Some("aa")),
                file("b", Some("b0"), Some("b1")),
            ],
        )
        .expect("files");
    store
        .add_checkpoint_files(second, &[file("b", Some("b1"), Some("b2"))])
        .expect("files");
    store
        .add_checkpoint_files(other, &[file("c", Some("c0"), Some("c1"))])
        .expect("files");
    let rows = store.checkpoint_files("s1").expect("rows");
    let summary: Vec<(i64, &str, Option<&str>)> = rows
        .iter()
        .map(|r| (r.checkpoint_id, r.path.as_str(), r.before_hash.as_deref()))
        .collect();
    assert_eq!(
        summary,
        [
            (first, "a 中文.txt", None),
            (first, "b", Some("b0")),
            (second, "b", Some("b1"))
        ]
    );
    assert!(rows.windows(2).all(|w| w[0].id < w[1].id));
    let turns: Vec<String> = store
        .session_checkpoints("s1")
        .expect("checkpoints")
        .into_iter()
        .map(|c| c.turn_id)
        .collect();
    assert_eq!(turns, ["turn-a", "turn-b"]);
}

#[test]
fn an_unknown_operation_is_refused_and_nothing_is_added() {
    let mut store = Store::open_in_memory(1).expect("store");
    let id = store.ensure_checkpoint("s", "t", 1).expect("checkpoint");
    let bad = NewCheckpointFile {
        operation: "delete",
        ..file("x", None, Some("x"))
    };
    assert!(
        store
            .add_checkpoint_files(id, &[file("ok", None, Some("o")), bad])
            .is_err()
    );
    assert!(store.checkpoint_files("s").expect("rows").is_empty());
}

#[test]
fn pruning_keeps_the_newest_checkpoints_with_their_files() {
    let mut store = Store::open_in_memory(1).expect("store");
    for n in 0..5 {
        let id = store
            .ensure_checkpoint("s", &format!("turn-{n}"), n)
            .expect("checkpoint");
        let path = format!("f{n}");
        store
            .add_checkpoint_files(id, &[file(&path, Some("x"), Some("y"))])
            .expect("file");
    }
    assert_eq!(store.prune_checkpoints("s", 3).expect("prune"), 2);
    assert_eq!(store.prune_checkpoints("s", 3).expect("prune"), 0);
    let turns: Vec<String> = store
        .session_checkpoints("s")
        .expect("checkpoints")
        .into_iter()
        .map(|c| c.turn_id)
        .collect();
    assert_eq!(turns, ["turn-2", "turn-3", "turn-4"]);
    let paths: Vec<String> = store
        .checkpoint_files("s")
        .expect("rows")
        .into_iter()
        .map(|r| r.path)
        .collect();
    assert_eq!(
        paths,
        ["f2", "f3", "f4"],
        "file rows go with their checkpoint"
    );
}

#[test]
fn idle_sessions_lose_all_snapshots_and_access_moves_forward_only() {
    let mut store = Store::open_in_memory(1).expect("store");
    let old = store.ensure_checkpoint("old", "t", 100).expect("old");
    store
        .add_checkpoint_files(old, &[file("o", Some("h-old"), Some("x"))])
        .expect("file");
    let recent = store.ensure_checkpoint("recent", "t", 100).expect("recent");
    store
        .add_checkpoint_files(recent, &[file("r", Some("h-recent"), Some("y"))])
        .expect("file");
    store
        .touch_checkpoint_session("recent", 900)
        .expect("touch");
    store
        .touch_checkpoint_session("recent", 50)
        .expect("an older time");
    assert_eq!(store.drop_idle_checkpoints(500).expect("drop"), ["old"]);
    assert!(store.session_checkpoints("old").expect("old").is_empty());
    assert_eq!(
        store.session_checkpoints("recent").expect("recent").len(),
        1
    );
    assert_eq!(store.referenced_snapshots().expect("refs"), ["h-recent"]);
    assert!(store.drop_idle_checkpoints(500).expect("again").is_empty());
    store.delete_session_checkpoints("recent").expect("delete");
    assert!(store.referenced_snapshots().expect("refs").is_empty());
}
