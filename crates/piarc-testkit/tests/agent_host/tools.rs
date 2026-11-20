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

/// The Harness Kit's host tools after them (T26): no file or command I/O of their own.
const HOST_TOOLS: [&str; 6] = [
    "EnterPlanMode",
    "ExitPlanMode",
    "TodoWrite",
    "AskUserQuestion",
    "SuggestNextSteps",
    // T29: registered with the host tools when Core enables `webFetch`.
    "WebFetch",
];

/// The tools a session offers on this platform: Windows adds PowerShell after Bash (T17).
fn offered_canonical() -> Vec<&'static str> {
    let mut names = CANONICAL.to_vec();
    if cfg!(windows) {
        names.insert(4, "PowerShell");
    }
    names.extend(HOST_TOOLS);
    names
}

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
        assert_eq!(names, offered_canonical(), "request {}", request.seq);
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

/// T07-A04: exactly the six canonical tools (then T26's host tools), with the default profile's
/// descriptions.
fn check_offered_tools(body: &str) {
    let offered = offered_tools(body);
    println!("tools offered to the model:");
    for (name, description) in &offered {
        println!("  {name}: {description}");
    }
    let names: Vec<&str> = offered.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, offered_canonical());
    for (name, start) in DEFAULT_DESCRIPTIONS {
        let description = &offered.iter().find(|(n, _)| n == name).expect("offered").1;
        assert!(description.starts_with(start), "{name}: {description}");
    }
    for native in PI_NATIVE_NAMES {
        assert!(!names.contains(&native), "{native} offered");
    }
}

/// The offered tools other than the host tools (T26), which must all be offered, in order.
fn without_host_tools(offered: Vec<(String, String)>) -> Vec<(String, String)> {
    let (host, rest): (Vec<_>, Vec<_>) = offered
        .into_iter()
        .partition(|(name, _)| HOST_TOOLS.contains(&name.as_str()));
    let host: Vec<&str> = host.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(host, HOST_TOOLS);
    rest
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
    // `exec/shells` (T17) is asked once when the session's tools are set up, for no tool call;
    // it must succeed, or the session silently gets the platform's guess of its shells.
    let shells: Vec<_> = calls.iter().filter(|c| c.method == "exec/shells").collect();
    assert_eq!(shells.len(), 1, "{shells:?}");
    assert!(shells[0].error.is_none(), "{:?}", shells[0]);
    let mut memory_scans = 0;
    // `policy/tools` (T23) asks once before every run which tools the deny rules remove; it
    // belongs to no tool call and must succeed, or the model keeps a tool a rule denied.
    let mut tool_lists = 0;
    for call in calls.iter().filter(|c| c.method != "exec/shells") {
        if call.method == "fs/memory" {
            assert!(call.tool.is_none() && call.error.is_none(), "{call:?}");
            memory_scans += 1;
            continue;
        }
        if call.method == "policy/tools" {
            assert!(call.tool.is_none() && call.error.is_none(), "{call:?}");
            tool_lists += 1;
            continue;
        }
        // T27: the compaction settings before each run and the files changed outside before
        // each model request belong to no tool call either.
        if call.method == "context/settings" || call.method == "fs/changes" {
            assert!(call.tool.is_none() && call.error.is_none(), "{call:?}");
            continue;
        }
        let tool = call.tool.as_deref().expect("every request names its tool");
        by_tool
            .entry(tool)
            .or_default()
            .insert(call.method.as_str());
        assert!(call.error.is_none(), "{call:?}");
    }
    // Opening context, then a single refresh when Write enters src for the first time.
    assert_eq!(memory_scans, 2);
    // One prompt, one run.
    assert_eq!(tool_lists, 1);
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
    // The profile renames the six tools; Windows also offers PowerShell under its own name, and
    // the host tools (T26) keep theirs.
    let (powershell, renamed_tools): (Vec<_>, Vec<_>) = without_host_tools(offered)
        .into_iter()
        .partition(|(name, _)| name == "PowerShell");
    assert_eq!(renamed_tools, expected);
    assert_eq!(
        powershell.len(),
        usize::from(cfg!(windows)),
        "{powershell:?}"
    );
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

/// A Core error (including a reported timeout) and a malformed success result all reach
/// the strict provider as refusals; not one of the file tools runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_faults_decline_the_call_and_give_the_model_a_reason() {
    let script = r#"
id: policy-faults
steps:
  - tool_calls:
      - {id: a, name: Write, input: {path: a, content: a}}
      - {id: b, name: Write, input: {path: b, content: b}}
      - {id: c, name: Write, input: {path: c, content: c}}
  - text: "No files were written."
"#;
    let env = Env::new("policy-faults", &[script], json!({})).await;
    let (supervisor, mut events, core) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let session = open(&supervisor, &core, &env.cwd(0), "mock-large").await;
    core.policy_answers.lock().expect("queue").extend([
        Err(piarc_protocol::ErrorObject::new(
            piarc_protocol::ErrorKind::InternalError,
            "injected audit failure",
            false,
        )),
        Err(piarc_protocol::ErrorObject::new(
            piarc_protocol::ErrorKind::Timeout,
            "injected approval transport timeout",
            true,
        )),
        Ok(json!({"allowed": "yes"})),
    ]);
    let turn = supervisor
        .prompt(
            &session,
            "req-faults",
            &prompt_text("Write.", "policy-faults"),
        )
        .await
        .expect("accepted")
        .turn_id;
    events.turn_completed(&turn.0).await;
    let requests = env.requests("policy-faults");
    assert_eq!(requests.len(), 2);
    let results = tool_results_in(&requests[1].body);
    assert_eq!(results.len(), 3);
    for ((tool, text, is_error), reason) in results.iter().zip([
        "injected audit failure",
        "injected approval transport timeout",
        "malformed result",
    ]) {
        assert_eq!(tool, "Write");
        assert!(
            *is_error && text.contains("Permission denied") && text.contains(reason),
            "{text}"
        );
    }
    let completed = events.tool_results(&session.0);
    assert_eq!(completed.len(), 3);
    assert!(completed.iter().all(|item| item["status"] == "declined"));
    for name in ["a", "b", "c"] {
        assert!(!env.ws[0].join(name).exists(), "{name} was written");
    }
    supervisor.shutdown().await;
}
