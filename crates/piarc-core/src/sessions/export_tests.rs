use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::*;

fn labels() -> ExportLabels {
    ExportLabels::parse(
        r#"{"user":"你","assistant":"PiArc","tool":"工具","summary":"摘要","project":"项目",
            "created":"创建","updated":"更新","archived":"已归档","untitled":"未命名会话",
            "offsetMinutes":480}"#,
    )
    .expect("labels")
}

fn session(id: &str, title: Option<&str>, file: PathBuf) -> ExportSession {
    ExportSession {
        id: id.to_owned(),
        title: title.map(str::to_owned),
        workspace: Some("/work/我的 项目".to_owned()),
        cwd: None,
        // 2026-11-23 16:28 UTC: 2026-11-24 00:28 at UTC+8.
        created_at: Some(1_795_451_280_000),
        updated_at: Some(1_795_451_340_000),
        archived: true,
        pinned: false,
        model: Some("mock/large".to_owned()),
        file,
    }
}

/// A session file: the header, a first exchange, a branch that was rewound away, and the
/// branch the user kept (with a tool call and a summary).
const RECORDS: &str = concat!(
    r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-11-23T16:28:00Z","cwd":"/work"}"#,
    "\n",
    r#"{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"Read the note","timestamp":1795451280000}}"#,
    "\n",
    r#"{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret plan"},{"type":"toolCall","name":"Read","arguments":{"path":"notes/a `b`.md"}}],"timestamp":1795451281000}}"#,
    "\n",
    r#"{"type":"message","id":"c","parentId":"b","message":{"role":"toolResult","content":[{"type":"text","text":"tool output"}]}}"#,
    "\n",
    r#"{"type":"message","id":"old","parentId":"c","message":{"role":"assistant","content":[{"type":"text","text":"An answer that was rewound"}]}}"#,
    "\n",
    "{not json\n",
    r#"{"type":"branch_summary","id":"d","parentId":"c","fromId":"old","summary":"Tried one way.\nThen another."}"#,
    "\n",
    r#"{"type":"message","id":"e","parentId":"d","message":{"role":"assistant","content":[{"type":"text","text":"The note says hello."}],"timestamp":1795451340000}}"#,
    "\n",
);

#[test]
fn the_markdown_follows_the_kept_branch_with_messages_tools_and_summaries() {
    let markdown = render(
        &session("s1", Some("读笔记"), PathBuf::new()),
        RECORDS.as_bytes(),
        &labels(),
    );
    assert!(markdown.starts_with("# 读笔记\n\n- 项目: /work/我的 项目\n"));
    assert!(markdown.contains("- 创建: 2026-11-24 00:28\n"));
    assert!(markdown.contains("- 已归档\n"));
    assert!(markdown.contains("## 你 · 2026-11-24 00:28\n\nRead the note\n"));
    // A tool call is one line with its first argument; backticks cannot break the code span.
    assert!(markdown.contains("> 工具: `Read` `notes/a 'b'.md`"));
    assert!(markdown.contains("> **摘要**\n> Tried one way.\n> Then another.\n"));
    assert!(markdown.contains("## PiArc · 2026-11-24 00:29\n\nThe note says hello."));
    // Not on the kept branch, or not for reading: the rewound answer, reasoning, tool output.
    for absent in ["rewound", "secret plan", "tool output"] {
        assert!(
            !markdown.contains(absent),
            "{absent} leaked into the export"
        );
    }
}

#[test]
fn an_untitled_session_is_named_and_a_cycle_does_not_hang() {
    let looped = concat!(
        r#"{"type":"message","id":"x","parentId":"y","message":{"role":"user","content":[{"type":"text","text":"one"}]}}"#,
        "\n",
        r#"{"type":"message","id":"y","parentId":"x","message":{"role":"user","content":"two"}}"#,
        "\n",
    );
    let markdown = render(
        &session("s2", None, PathBuf::new()),
        looped.as_bytes(),
        &labels(),
    );
    assert!(markdown.starts_with("# 未命名会话\n"));
    assert!(markdown.contains("one") && markdown.contains("two"));
}

#[test]
fn names_are_safe_and_unique() {
    assert_eq!(safe_name("a/b\\c:d*?\"<>|e"), "a_b_c_d______e");
    assert_eq!(safe_name("  ...  "), "_");
    assert_eq!(safe_name("x\ny."), "x_y");
    assert_eq!(safe_name(&"长".repeat(200)).chars().count(), MAX_NAME);
    let mut names = HashSet::new();
    assert_eq!(unique(&mut names, "m/a.md"), "m/a.md");
    assert_eq!(unique(&mut names, "m/a.md"), "m/a (2).md");
    assert_eq!(unique(&mut names, "m/a.md"), "m/a (3).md");
    let path = markdown_path(&session("s", Some("计划: v2?"), PathBuf::new()), &labels());
    assert_eq!(path, "markdown/我的 项目/2026-11-24 计划_ v2_.md");
}

#[test]
fn local_times_cross_midnight_both_ways() {
    assert_eq!(local_time(0, 0), "1970-01-01 00:00");
    assert_eq!(local_time(0, -60), "1969-12-31 23:00");
    assert_eq!(local_time(1_795_451_280_000, 480), "2026-11-24 00:28");
}

#[test]
fn labels_are_checked() {
    assert!(ExportLabels::parse("{}").is_err());
    let long = labels_json(&"x".repeat(65), 0);
    assert!(ExportLabels::parse(&long).is_err());
    assert!(ExportLabels::parse(&labels_json("ok", 900)).is_err());
    assert!(ExportLabels::parse(&labels_json("ok", -840)).is_ok());
}

fn labels_json(word: &str, offset: i32) -> String {
    serde_json::json!({
        "user": word, "assistant": word, "tool": word, "summary": word, "project": word,
        "created": word, "updated": word, "archived": word, "untitled": word,
        "offsetMinutes": offset,
    })
    .to_string()
}

#[test]
fn the_archive_holds_each_session_twice_and_an_index_and_reads_nothing_outside_its_root() {
    let base = std::env::temp_dir().join(format!(
        "piarc-export-{}",
        crate::sessions::new_session_id().expect("id")
    ));
    let root = base.join("pi").join("sessions");
    std::fs::create_dir_all(root.join("--work--")).expect("root");
    let inside = root.join("--work--").join("s1.jsonl");
    std::fs::write(&inside, RECORDS).expect("session file");
    let outside = base.join("elsewhere.jsonl");
    std::fs::write(
        &outside,
        "{\"type\":\"message\",\"id\":\"z\",\"secret\":\"do not read\"}\n",
    )
    .expect("outside file");
    let target = base.join("导出 export.zip");
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_795_451_400);
    let sessions = [
        session("s1", Some("读笔记"), inside),
        session("s2", Some("读笔记"), outside),
    ];
    write_export(&target, &root, &sessions, &labels(), at).expect("exported");
    let bytes = std::fs::read(&target).expect("archive");
    let has = |needle: &str| bytes.windows(needle.len()).any(|w| w == needle.as_bytes());
    assert!(has("raw/s1.jsonl"));
    assert!(has("markdown/我的 项目/2026-11-24 读笔记.md"));
    assert!(has("sessions.json"));
    assert!(has("\"missing\": true"));
    assert!(!has("raw/s2.jsonl"));
    assert!(!has("do not read"));
    // No partial file is left beside it.
    let leftovers: Vec<_> = std::fs::read_dir(&base)
        .expect("listed")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".partial"))
        .collect();
    assert!(leftovers.is_empty());
    let _ = std::fs::remove_dir_all(&base);
}
