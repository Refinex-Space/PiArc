//! T41: usage records derived from session files: each assistant reply with usage, each
//! auxiliary call (`piarc.auxiliaryUsage`) and each Pi `usage` entry is one row, written
//! incrementally with the rest of the index, the same after a rebuild, gone with the session;
//! catalog prices round-trip.

mod support;

use piarc_store::{Store, UsageGroup};
use support::{SessionWriter, TempDir};

fn groups(store: &Store) -> Vec<UsageGroup> {
    store.usage_groups().expect("usage groups")
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "one story: written, appended, rebuilt, removed"
)]
fn usage_rows_follow_the_session_files() {
    let dir = TempDir::new("usage");
    let sessions = dir.path().join("pi").join("sessions");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let mut main = SessionWriter::create(&sessions, "/work/用量 一", "s-main", Some(3));
    let line = main.user("hello");
    main.append_raw(&line);
    let line = main.assistant("one", "m-a", 100, 10);
    main.append_raw(&line);
    let line = main.custom(
        "piarc.auxiliaryUsage",
        r#"{"purpose":"webFetch","model":{"provider":"aux","id":"m-x"},"usage":{"input":40,"output":4,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"reasoning":2,"totalTokens":44}}"#,
    );
    main.append_raw(&line);
    let mut child = SessionWriter::create(&sessions, "/work/用量 一", "s-child", Some(3));
    let line = child.custom(
        "piarc.subagent",
        r#"{"parentSessionId":"s-main","agentType":"Explore"}"#,
    );
    child.append_raw(&line);
    let line = child.assistant("child", "m-b", 7, 3);
    child.append_raw(&line);
    store.sync_dir(&sessions).expect("sync");

    let found = groups(&store);
    assert_eq!(found.len(), 3, "{found:?}");
    let reply = found
        .iter()
        .find(|g| g.session_id == "s-main" && g.kind == "model")
        .expect("main reply");
    assert_eq!(
        (
            reply.provider.as_str(),
            reply.model.as_str(),
            reply.requests
        ),
        ("piarc-mock", "m-a", 1)
    );
    assert_eq!(
        (
            reply.input,
            reply.output,
            reply.cache_read,
            reply.cache_write
        ),
        (100, 10, 3, 1)
    );
    let aux = found
        .iter()
        .find(|g| g.kind == "auxiliary")
        .expect("auxiliary call");
    assert_eq!(aux.purpose.as_deref(), Some("webFetch"));
    assert_eq!((aux.provider.as_str(), aux.model.as_str()), ("aux", "m-x"));
    assert_eq!((aux.input, aux.output, aux.reasoning), (40, 4, 2));
    assert!(
        found
            .iter()
            .any(|g| g.session_id == "s-child" && g.model == "m-b")
    );

    // Appended replies and a Pi `usage` entry come in incrementally.
    let line = main.assistant("two", "m-a", 50, 5);
    main.append_raw(&line);
    main.append_raw(
        r#"{"type":"usage","id":"u1","parentId":null,"timestamp":"2026-11-16T10:10:00.000Z","kind":"cache_warm","provider":"piarc-mock","model":"m-a","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":900,"cacheWrite1h":900,"totalTokens":900}}"#,
    );
    store.sync_dir(&sessions).expect("sync again");
    let after = groups(&store);
    let reply = after
        .iter()
        .find(|g| g.session_id == "s-main" && g.kind == "model")
        .expect("main replies");
    assert_eq!((reply.requests, reply.input, reply.output), (2, 150, 15));
    let warm = after
        .iter()
        .find(|g| g.purpose.as_deref() == Some("cache_warm"))
        .expect("cache warming");
    assert_eq!((warm.cache_write, warm.cache_write_1h), (900, 900));
    let requests = store.usage_requests("piarc-mock", "m-a").expect("requests");
    assert_eq!(requests.len(), 3);

    // A rebuild reads the same rows from the files.
    store.rebuild_index(&sessions).expect("rebuild");
    assert_eq!(groups(&store), after);
    let listed = store.usage_sessions().expect("sessions");
    let child = listed.iter().find(|s| s.id == "s-child").expect("child");
    assert_eq!(child.subagent_parent.as_deref(), Some("s-main"));
    assert_eq!(child.subagent_type.as_deref(), Some("Explore"));

    // Removing the session removes its rows.
    store.remove_session("s-main").expect("remove");
    assert!(groups(&store).iter().all(|g| g.session_id == "s-child"));
}

#[test]
fn catalog_prices_are_kept_and_replaced() {
    let dir = TempDir::new("prices");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let price = |input: f64| {
        format!(r#"{{"input":{input},"output":15,"cacheRead":0.3,"cacheWrite":3.75}}"#)
    };
    store
        .put_model_prices(
            &[
                ("anthropic".into(), "a".into(), price(3.0)),
                ("openai".into(), "b".into(), price(1.25)),
            ],
            10,
        )
        .expect("put");
    store
        .put_model_prices(&[("anthropic".into(), "a".into(), price(2.0))], 20)
        .expect("replace");
    store
        .remove_model_prices(&[("openai".into(), "b".into())])
        .expect("remove");
    assert_eq!(
        store.model_prices().expect("prices"),
        [("anthropic".to_owned(), "a".to_owned(), price(2.0))]
    );
}

#[test]
fn side_chat_usage_precedes_parent_history_and_survives_reindexing() {
    let dir = TempDir::new("side-usage");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir(&sessions).expect("session directory");
    let db = dir.path().join("core.sqlite");
    let mut store = Store::open(&db, 0).expect("store");
    let record = piarc_store::RequestUsage {
        entry_id: None,
        at: Some(20),
        kind: "auxiliary",
        purpose: Some("sideChat".into()),
        provider: "piarc-mock".into(),
        model: "model".into(),
        input: 101,
        output: 11,
        cache_read: 7,
        cache_write: 3,
        cache_write_1h: 1,
        reasoning: 2,
    };
    store
        .record_side_chat("main", "/repo", &[record])
        .expect("bill side chat");
    assert_eq!(
        store.usage_sessions().unwrap()[0].workspace.as_deref(),
        Some("/repo")
    );
    drop(store);
    let mut store = Store::open(&db, 1).expect("reopen");
    store
        .rebuild_index(&sessions)
        .expect("rebuild without parent file");
    assert_eq!(groups(&store)[0].input, 101);
    let mut main = SessionWriter::create(&sessions, "/repo", "main", Some(3));
    let line = main.assistant("hello", "model", 7, 9);
    main.append_raw(&line);
    store.sync_dir(&sessions).unwrap();
    store.rebuild_index(&sessions).unwrap();
    let report = groups(&store);
    assert_eq!(report.len(), 2);
    let side = report
        .iter()
        .find(|g| g.purpose.as_deref() == Some("sideChat"))
        .unwrap();
    assert_eq!(
        (side.requests, side.input, side.output, side.cache_write_1h),
        (1, 101, 11, 1)
    );
    assert_eq!(store.usage_sessions().unwrap().len(), 1);
    store.remove_session("main").unwrap();
    assert!(groups(&store).is_empty());
}
