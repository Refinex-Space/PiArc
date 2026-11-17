//! T07: the canonical tools end to end. The real Agent Host offers Read, Write, Edit, Bash, Glob
//! and Grep, every file and command operation reaches Core as `fs/*` or `exec/*`, and the Agent
//! Host process itself touches neither the workspace nor `child_process` (checked by the I/O spy
//! loaded with `NODE_OPTIONS`). A Tool Profile renames what the model sees while events and Core
//! keep canonical names.

use std::collections::{BTreeMap, BTreeSet};

use piarc_core::agent_host::HostEvent;
use serde_json::{Value, json};

use crate::harness::{
    Env, now_ms, offered_tools, open, prompt_text, spy_report, tool_results_in, with_io_spy,
};

const CANONICAL: [&str; 6] = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

/// The first words of each default description (agent-host/src/tools/profile.ts).
const DEFAULT_DESCRIPTIONS: [(&str, &str); 6] = [
    ("Read", "Return the contents of one file."),
    (
        "Write",
        "Store `content` as the complete text of the file at `path`",
    ),
    (
        "Edit",
        "Change an existing file by replacing exact passages.",
    ),
    (
        "Bash",
        "Run a command line with bash in the working directory",
    ),
    ("Glob", "List the files and directories below `path`"),
    ("Grep", "Search file contents for a regular expression"),
];

const PI_NATIVE_NAMES: [&str; 8] = [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
    "powershell",
];

const ALL_TOOLS: &str = r#"
id: all-tools
steps:
  - tool_calls: [{ name: Write, input: { path: "src/app 应用.ts", content: "export const answer = 41;\n// TODO: check the answer\n" } }]
  - tool_calls: [{ name: Edit, input: { path: "src/app 应用.ts", edits: [{ oldText: "41", newText: "42" }] } }]
  - tool_calls: [{ name: Read, input: { path: "src/app 应用.ts" } }]
  - tool_calls: [{ name: Glob, input: { pattern: "**/*.ts" } }]
  - tool_calls: [{ name: Grep, input: { pattern: "TODO", path: "src" } }]
  - tool_calls: [{ name: Bash, input: { command: "printf 'hello from bash\\n'; ls src" } }]
  - text: "All six tools ran."
"#;

/// T07-A01, A02, A04.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_six_canonical_tools_delegate_every_operation_to_core() {
    let env = Env::new("tools", &[ALL_TOOLS], json!({})).await;
    let mut config = env.config();
    let report = with_io_spy(&mut config, &env.root, &env.ws);
    let (supervisor, mut events, core) = env.start_with(config, &[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &core, &env.cwd(0), "mock-large").await;
    let scenario_start = now_ms();
    let turn = supervisor
        .prompt(&a, "req", &prompt_text("Use every tool.", "all-tools"))
        .await
        .expect("accepted")
        .turn_id;
    let done = events.turn_completed(&turn.0).await;
    let scenario_end = now_ms();
    assert_eq!(done["status"], "completed", "{done}");

    let requests = env.requests("all-tools");
    assert_eq!(requests.len(), 7);
    check_offered_tools(&requests[0].body);
    for request in &requests {
        let names: Vec<String> = offered_tools(&request.body)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, CANONICAL, "request {}", request.seq);
    }
    check_results(&tool_results_in(&requests[6].body));
    check_core_calls(&core.calls_of(&a.0));
    let item_tools: Vec<String> = events
        .tool_results(&a.0)
        .iter()
        .map(|item| item["tool"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        item_tools,
        ["Write", "Edit", "Read", "Glob", "Grep", "Bash"]
    );
    assert_eq!(
        std::fs::read_to_string(env.ws[0].join("src").join("app 应用.ts")).expect("written"),
        "export const answer = 42;\n// TODO: check the answer\n"
    );
    supervisor.shutdown().await;
    check_spy(
        &spy_report(&report),
        scenario_start..=scenario_end,
        &env.cwd(0),
    );
}

/// T07-A04: exactly the six canonical tools, with the default profile's descriptions.
fn check_offered_tools(body: &str) {
    let offered = offered_tools(body);
    println!("tools offered to the model:");
    for (name, description) in &offered {
        println!("  {name}: {description}");
    }
    let names: Vec<&str> = offered.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, CANONICAL);
    for (name, start) in DEFAULT_DESCRIPTIONS {
        let description = &offered.iter().find(|(n, _)| n == name).expect("offered").1;
        assert!(description.starts_with(start), "{name}: {description}");
    }
    for native in PI_NATIVE_NAMES {
        assert!(!names.contains(&native), "{native} offered");
    }
}

/// What the model got back from each tool.
fn check_results(results: &[(String, String, bool)]) {
    for (tool, text, is_error) in results {
        println!("{tool} -> {text:?} (error: {is_error})");
    }
    let names: Vec<&str> = results.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(names, ["Write", "Edit", "Read", "Glob", "Grep", "Bash"]);
    assert!(results.iter().all(|r| !r.2), "no tool failed");
    let text = |index: usize| results[index].1.as_str();
    assert_eq!(text(0), "Successfully wrote to src/app 应用.ts");
    assert_eq!(
        text(1),
        "Successfully replaced 1 block(s) in src/app 应用.ts."
    );
    assert!(text(2).contains("export const answer = 42;"), "{}", text(2));
    assert_eq!(text(3), "src/app 应用.ts");
    assert_eq!(text(4), "app 应用.ts:2: // TODO: check the answer");
    assert_eq!(text(5), "hello from bash\napp 应用.ts\n");
}

/// T07-A01: every tool call reached Core with the expected methods and its canonical name.
fn check_core_calls(calls: &[crate::harness::Call]) {
    let mut by_tool: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    // `exec/shells` (T17) is asked once when the session's tools are set up, for no tool call.
    for call in calls.iter().filter(|c| c.method != "exec/shells") {
        let tool = call.tool.as_deref().expect("every request names its tool");
        by_tool
            .entry(tool)
            .or_default()
            .insert(call.method.as_str());
        assert!(call.error.is_none(), "{call:?}");
    }
    println!("Core-side calls by tool: {by_tool:?}");
    let expected: BTreeMap<&str, BTreeSet<&str>> = [
        ("Read", vec!["fs/stat", "fs/read"]),
        ("Write", vec!["fs/mkdir", "fs/write"]),
        ("Edit", vec!["fs/stat", "fs/read", "fs/write"]),
        ("Bash", vec!["exec/run"]),
        ("Glob", vec!["fs/stat", "fs/glob"]),
        ("Grep", vec!["fs/grep"]),
    ]
    .into_iter()
    .map(|(tool, methods)| (tool, methods.into_iter().collect()))
    .collect();
    assert_eq!(by_tool, expected);
}

/// T07-A02: while the scenario ran, the Agent Host made no `fs` call on a workspace path and no
/// `child_process` call. Before it, opening the session made exactly one: Pi's runtime checks
/// that the session's working directory exists (`assertSessionCwdExists`).
fn check_spy(records: &[Value], scenario: std::ops::RangeInclusive<u64>, cwd: &str) {
    let (during, setup): (Vec<&Value>, Vec<&Value>) = records
        .iter()
        .partition(|r| r["at"].as_u64().is_some_and(|at| scenario.contains(&at)));
    println!(
        "I/O spy: {} fs calls on workspace paths or child_process calls during the scenario, \
         {} while the session opened",
        during.len(),
        setup.len()
    );
    for record in records {
        println!("{record:#}");
    }
    assert!(during.is_empty(), "the Agent Host bypassed Core");
    let setup: Vec<(&str, &str, &str)> = setup
        .iter()
        .map(|r| {
            (
                r["module"].as_str().unwrap_or_default(),
                r["fn"].as_str().unwrap_or_default(),
                r["path"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(setup, [("fs", "existsSync", cwd)]);
}

const RENAMED: &str = r#"
id: renamed
steps:
  - tool_calls: [{ name: write_file, input: { path: "r.txt", content: "renamed\n" } }]
  - tool_calls: [{ name: read_file, input: { path: "r.txt" } }]
  - tool_calls: [{ name: run_shell, input: { command: "cat r.txt" } }]
  - text: "Done."
"#;

/// T07-A05: a test profile renames every tool; the model sees the new names and descriptions,
/// while the events and Core get canonical names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_profile_renames_tools_for_the_model_only() {
    let env = Env::new("profile", &[RENAMED], json!({})).await;
    let renamed = [
        ("Read", "read_file"),
        ("Write", "write_file"),
        ("Edit", "edit_file"),
        ("Bash", "run_shell"),
        ("Glob", "find_files"),
        ("Grep", "search_text"),
    ];
    let profile: serde_json::Map<String, Value> = renamed
        .iter()
        .map(|(canonical, visible)| {
            (
                (*canonical).to_owned(),
                json!({ "name": visible, "description": format!("Test profile: the {canonical} tool.") }),
            )
        })
        .collect();
    let profile_file = env.root.join("profile 配置.json");
    std::fs::write(&profile_file, Value::Object(profile).to_string()).expect("written");
    let mut config = env.config();
    config.extra_args.push("--tool-profile".into());
    config.extra_args.push(profile_file.into_os_string());
    let (supervisor, mut events, core) = env.start_with(config, &[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &core, &env.cwd(0), "mock-large").await;
    let turn = supervisor
        .prompt(&a, "req", &prompt_text("Use renamed tools.", "renamed"))
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&turn.0).await["status"], "completed");

    let requests = env.requests("renamed");
    let offered = offered_tools(&requests[0].body);
    let expected: Vec<(String, String)> = renamed
        .iter()
        .map(|(canonical, visible)| {
            (
                (*visible).to_owned(),
                format!("Test profile: the {canonical} tool."),
            )
        })
        .collect();
    assert_eq!(offered, expected);
    let model_side: Vec<String> = tool_results_in(&requests[3].body)
        .into_iter()
        .map(|(name, text, is_error)| {
            assert!(!is_error, "{name}: {text}");
            name
        })
        .collect();
    assert_eq!(model_side, ["write_file", "read_file", "run_shell"]);
    let event_side: Vec<String> = events
        .tool_results(&a.0)
        .iter()
        .map(|item| item["tool"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(event_side, ["Write", "Read", "Bash"]);
    let core_side: BTreeSet<String> = core
        .calls_of(&a.0)
        .into_iter()
        .filter_map(|c| c.tool)
        .collect();
    assert_eq!(
        core_side,
        ["Bash", "Read", "Write"].map(str::to_owned).into()
    );
    println!("model sees {model_side:?}; events carry {event_side:?}; Core sees {core_side:?}");
    supervisor.shutdown().await;
}
