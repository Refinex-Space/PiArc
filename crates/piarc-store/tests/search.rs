//! T35-A05: full-text search finds Chinese, English and mixed text in user messages and
//! assistant replies; appended entries reach the index incrementally; a rebuild gives the same
//! results. Tool results, tool arguments and subagents' sessions are not searchable.

mod support;

use std::path::Path;

use piarc_store::{SessionHits, Store};
use support::{SessionWriter, TempDir};

fn search(store: &Store, query: &str) -> Vec<SessionHits> {
    store.search_sessions(query, 50, 5).expect("search")
}

fn ids(hits: &[SessionHits]) -> Vec<&str> {
    hits.iter().map(|h| h.session_id.as_str()).collect()
}

fn marked(hit: &piarc_store::SearchHit) -> Vec<String> {
    let utf16: Vec<u16> = hit.snippet.encode_utf16().collect();
    hit.highlights
        .iter()
        .map(|(s, e)| String::from_utf16_lossy(&utf16[*s..*e]))
        .collect()
}

fn write_fixture(sessions: &Path) -> (SessionWriter, SessionWriter) {
    let mut zh = SessionWriter::create(sessions, "/work/项目 一", "s-zh", Some(3));
    let line = zh.user("帮我修复登录页面的验证码问题");
    zh.append_raw(&line);
    let line = zh.assistant("好的，我先检查验证码组件的实现。", "m", 1, 1);
    zh.append_raw(&line);
    // A tool result's text is not a message of the conversation's participants.
    let line = zh.tool_result("toolresult-only-marker 工具结果");
    zh.append_raw(&line);

    let mut en = SessionWriter::create(sessions, "/work/project two", "s-en", Some(3));
    let line = en.user("Refactor the payment retry logic");
    en.append_raw(&line);
    let line = en.assistant(
        "I will look at PaymentRetry first. 支付重试 is in src/pay.",
        "m",
        1,
        1,
    );
    en.append_raw(&line);

    let mut child = SessionWriter::create(sessions, "/work/项目 一", "s-child", Some(3));
    let line = child.custom(
        "piarc.subagent",
        r#"{"parentSessionId":"s-zh","agentType":"Explore"}"#,
    );
    child.append_raw(&line);
    let line = child.user("验证码 in a subagent");
    child.append_raw(&line);
    (zh, en)
}

#[test]
fn chinese_english_and_mixed_text_is_found_and_stays_consistent() {
    let dir = TempDir::new("search");
    let sessions = dir.path().join("pi").join("sessions");
    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let (mut zh, _en) = write_fixture(&sessions);
    store.sync_dir(&sessions).expect("sync");

    // Chinese in a user message and an assistant reply; the subagent's session is not listed.
    let found = search(&store, "验证码");
    assert_eq!(ids(&found), ["s-zh"]);
    assert_eq!(found[0].total, 2);
    assert_eq!(found[0].hits[0].role, "user");
    assert_eq!(found[0].hits[1].role, "assistant");
    assert_eq!(marked(&found[0].hits[0]), ["验证码"]);
    assert!(found[0].hits[0].entry_id.is_some());

    // English is case-insensitive; mixed text matches each term.
    assert_eq!(ids(&search(&store, "paymentretry")), ["s-en"]);
    let mixed = search(&store, "支付重试 src/pay");
    assert_eq!(ids(&mixed), ["s-en"]);
    assert_eq!(marked(&mixed[0].hits[0]), ["支付重试", "src/pay"]);

    // Shorter than a trigram: answered by a scan.
    let short = search(&store, "登录");
    assert_eq!(ids(&short), ["s-zh"]);
    assert_eq!(marked(&short[0].hits[0]), ["登录"]);
    assert_eq!(ids(&search(&store, "支付 retry")), ["s-en"]);

    // Not indexed: tool results and tool arguments; no match: nothing.
    assert!(search(&store, "toolresult-only-marker").is_empty());
    assert!(search(&store, "中文.txt").is_empty());
    assert!(search(&store, "不存在的内容").is_empty());
    assert!(search(&store, "   ").is_empty());
    // FTS syntax in a query is text.
    assert!(search(&store, "\"OR* NEAR(").is_empty());

    // Appended entries reach the index with the next incremental sync.
    let line = zh.assistant("已经修好 captcha 的刷新逻辑", "m", 1, 1);
    zh.append_raw(&line);
    assert!(search(&store, "captcha").is_empty());
    let report = store.sync_dir(&sessions).expect("sync");
    assert_eq!(report.appended, 1);
    let appended = search(&store, "captcha");
    assert_eq!(ids(&appended), ["s-zh"]);
    assert_eq!(appended[0].hits[0].role, "assistant");

    // A rebuild, and a fresh database built from the same files, answer the same.
    let queries = [
        "验证码",
        "paymentretry",
        "支付重试 src/pay",
        "登录",
        "captcha",
        "the",
    ];
    let before: Vec<_> = queries.iter().map(|q| search(&store, q)).collect();
    store.rebuild_index(&sessions).expect("rebuild");
    let after: Vec<_> = queries.iter().map(|q| search(&store, q)).collect();
    assert_eq!(before, after);
    let mut fresh = Store::open_in_memory(0).expect("fresh");
    fresh.sync_dir(&sessions).expect("sync");
    let rebuilt: Vec<_> = queries.iter().map(|q| search(&fresh, q)).collect();
    assert_eq!(before, rebuilt);

    // A rewritten file is read again from the start: its old text goes.
    std::fs::remove_file(&zh.path).expect("remove the old file");
    let mut replaced = SessionWriter::create(&sessions, "/work/项目 一", "s-zh", Some(3));
    let line = replaced.user("completely different");
    replaced.append_raw(&line);
    store.sync_dir(&sessions).expect("sync");
    assert!(search(&store, "验证码").is_empty());
    assert_eq!(ids(&search(&store, "different")), ["s-zh"]);

    // Removing a session removes its text.
    store.remove_session("s-en").expect("remove");
    assert!(search(&store, "paymentretry").is_empty());
}
