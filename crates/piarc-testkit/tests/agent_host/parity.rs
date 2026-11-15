//! T07-A06: the delegated tools behave like Pi's own. One script of tool calls runs twice, in
//! two Agent Hosts: one with Pi's native tools and local I/O (`--pi-native-tools`), one with
//! PiArc's canonical tools and Core's I/O. Both start from identical workspaces; the test
//! compares what the model got back from every call (the mock's request log) and the workspaces
//! afterwards. Run with `--nocapture` for the table in `docs/spikes/S04-operations-delegation.md`.
//!
//! Pi's native grep and find run ripgrep and fd: they come from `.tools/bin`
//! (`node scripts/dev/install-tools.mjs`) or PATH.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use piarc_core::agent_host::{HostConfig, HostEvent};
use serde_json::json;

use crate::harness::{Env, open, prompt_text, repo_root, tool_results_in};

/// Canonical tool → Pi's native tool.
const NATIVE_NAMES: [(&str, &str); 6] = [
    ("Read", "read"),
    ("Write", "write"),
    ("Edit", "edit"),
    ("Bash", "bash"),
    ("Glob", "find"),
    ("Grep", "grep"),
];

/// One call per step: (what it shows, canonical tool, input as YAML flow mapping).
const STEPS: [(&str, &str, &str); 17] = [
    ("Read a whole file", "Read", r#"{ path: "README.md" }"#),
    (
        "Read with offset and limit",
        "Read",
        r#"{ path: "notes/日志 1.txt", offset: 10, limit: 5 }"#,
    ),
    ("Read a missing file", "Read", r#"{ path: "missing.txt" }"#),
    ("Read an image", "Read", r#"{ path: "pixel 图.png" }"#),
    (
        "Write a new file in a new directory",
        "Write",
        r#"{ path: "docs/新 目录/note.md", content: "新的笔记\n" }"#,
    ),
    (
        "Write over an existing file",
        "Write",
        r##"{ path: "README.md", content: "# Parity, rewritten\n" }"##,
    ),
    (
        "Edit with a unique match",
        "Edit",
        r#"{ path: "src/main.rs", edits: [{ oldText: "// TODO: real work", newText: "// done" }] }"#,
    ),
    (
        "Edit a CRLF file",
        "Edit",
        r#"{ path: "crlf.txt", edits: [{ oldText: "second", newText: "2nd" }] }"#,
    ),
    (
        "Edit with text not in the file",
        "Edit",
        r#"{ path: "docs/guide.md", edits: [{ oldText: "not in the file", newText: "x" }] }"#,
    ),
    (
        "Bash that succeeds",
        "Bash",
        r#"{ command: "printf 'a\\nb\\n'" }"#,
    ),
    (
        "Bash that fails with output",
        "Bash",
        r#"{ command: "echo oops; exit 3" }"#,
    ),
    (
        "Bash that fails on stderr",
        "Bash",
        r#"{ command: "echo err 1>&2; exit 1" }"#,
    ),
    (
        "Grep with matches and context",
        "Grep",
        r#"{ pattern: "TODO", path: "docs", context: 1 }"#,
    ),
    (
        "Grep with a glob",
        "Grep",
        r#"{ pattern: "println", glob: "*.rs" }"#,
    ),
    (
        "Grep without matches",
        "Grep",
        r#"{ pattern: "nothing-matches-this" }"#,
    ),
    ("Glob with matches", "Glob", r#"{ pattern: "**/*.md" }"#),
    (
        "Glob of gitignored files only",
        "Glob",
        r#"{ pattern: "*.log" }"#,
    ),
];

/// Differences that are intended, by step index: (what differs, why).
const EXPECTED_DIFFERENCES: [(usize, &str); 1] = [(
    15,
    "node_modules/dep/readme.md is listed only by Pi's native find: given FindOperations.glob, \
     Pi itself passes exclude patterns for **/node_modules/** and **/.git/** (find.ts), which fd \
     does not apply",
)];

/// A 1x1 PNG.
const PIXEL_PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0xf8, 0x5f,
    0x0f, 0x00, 0x02, 0x87, 0x01, 0x80, 0xeb, 0x47, 0xba, 0x92, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

/// The workspace both runs start from.
fn populate(ws: &Path) {
    std::fs::create_dir_all(ws).expect("ws exists");
    std::fs::write(ws.join("pixel 图.png"), PIXEL_PNG).expect("image written");
    let lines: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    let files: [(&str, &str); 9] = [
        ("README.md", "# Parity\n"),
        (
            "docs/guide.md",
            "line one\nTODO: write the guide\nline three\n",
        ),
        ("notes/日志 1.txt", &lines),
        ("crlf.txt", "first\r\nsecond\r\n"),
        (".gitignore", "*.log\nbuild/\n"),
        ("debug.log", "TODO in a log\n"),
        ("build/out.md", "# built\n"),
        (
            "src/main.rs",
            "fn main() {\n    // TODO: real work\n    println!(\"hi\");\n}\n",
        ),
        ("node_modules/dep/readme.md", "dep\n"),
    ];
    for (rel, content) in files {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().expect("has a parent")).expect("dir created");
        std::fs::write(path, content).expect("file written");
    }
}

/// The scenario with `tool_name` choosing each step's tool name.
fn scenario(id: &str, tool_name: impl Fn(&str) -> String) -> String {
    let mut yaml = format!("id: {id}\nsteps:\n");
    for (_, tool, input) in STEPS {
        yaml.push_str(&format!(
            "  - tool_calls: [{{ name: {}, input: {input} }}]\n",
            tool_name(tool)
        ));
    }
    yaml.push_str("  - text: \"Compared.\"\n");
    yaml
}

/// Directory holding `rg` and `fd` for Pi's native tools, when `.tools/bin` has them.
fn pinned_search_tools() -> Option<PathBuf> {
    let bin = repo_root().join(".tools").join("bin");
    let exe = |name: &str| bin.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    (exe("rg").is_file() && exe("fd").is_file()).then_some(bin)
}

/// Runs the scenario `id` in workspace `index` and returns the tool results the model saw.
async fn run(env: &Env, config: HostConfig, index: usize, id: &str) -> Vec<(String, String, bool)> {
    let (supervisor, mut events, core) = env.start_with(config, &[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let session = open(&supervisor, &core, &env.cwd(index), "mock-vision").await;
    let turn = supervisor
        .prompt(&session, "req", &prompt_text("Compare.", id))
        .await
        .expect("accepted")
        .turn_id;
    let done = events.turn_completed(&turn.0).await;
    assert_eq!(done["status"], "completed", "{done}");
    supervisor.shutdown().await;
    let requests = env.requests(id);
    tool_results_in(&requests.last().expect("requests").body)
}

/// `text` with the workspace's absolute path (as given and canonical) replaced by `<WS>`.
fn normalized(text: &str, ws: &Path) -> String {
    let mut text = text.to_owned();
    let canonical = std::fs::canonicalize(ws).expect("workspace exists");
    for spelling in [canonical, ws.to_path_buf()] {
        text = text.replace(&spelling.to_string_lossy().into_owned(), "<WS>");
    }
    text
}

/// Every file below `ws`: relative path → content.
fn snapshot(ws: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![ws.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable").flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let rel = path.strip_prefix(ws).expect("below ws");
                let rel: Vec<String> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                files.insert(rel.join("/"), std::fs::read(&path).expect("readable"));
            }
        }
    }
    files
}

/// Glob results are compared as sets: fd's output order is not defined.
fn comparable(tool: &str, text: &str) -> String {
    if tool == "Glob" {
        let mut lines: Vec<&str> = text.lines().collect();
        lines.sort_unstable();
        lines.join("\n")
    } else {
        text.to_owned()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delegated_tools_behave_like_pi_native_tools() {
    let native_scenario = scenario("parity-native", |tool| {
        NATIVE_NAMES
            .iter()
            .find(|(canonical, _)| *canonical == tool)
            .expect("mapped")
            .1
            .to_owned()
    });
    let core_scenario = scenario("parity-core", str::to_owned);
    let env = Env::new("parity", &[&native_scenario, &core_scenario], json!({})).await;
    populate(&env.ws[0]);
    populate(&env.ws[1]);

    let mut native = env.config();
    native.extra_args.push("--pi-native-tools".into());
    let search_tools = pinned_search_tools();
    if let Some(bin) = &search_tools {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined =
            std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::split_paths(&path)))
                .expect("joinable PATH");
        native.extra_env.push((OsString::from("PATH"), joined));
    }
    println!(
        "ripgrep and fd for Pi's native tools: {}",
        search_tools.map_or_else(|| "PATH".to_owned(), |b| b.display().to_string())
    );
    let native_results = run(&env, native, 0, "parity-native").await;
    let core_results = run(&env, env.config(), 1, "parity-core").await;
    assert_eq!(native_results.len(), STEPS.len());
    assert_eq!(core_results.len(), STEPS.len());

    let mut unexpected = Vec::new();
    println!("| # | Scenario | Tool | Result |");
    println!("|---|---|---|---|");
    for (index, ((label, tool, _), (native, core))) in STEPS
        .iter()
        .zip(native_results.iter().zip(&core_results))
        .enumerate()
    {
        let native_text = comparable(tool, &normalized(&native.1, &env.ws[0]));
        let core_text = comparable(tool, &normalized(&core.1, &env.ws[1]));
        let same = native_text == core_text && native.2 == core.2;
        let expected = EXPECTED_DIFFERENCES.iter().find(|(i, _)| *i == index);
        let verdict = match (same, expected) {
            (true, None) => "same".to_owned(),
            (false, Some((_, why))) => format!("differs as intended: {why}"),
            (true, Some(_)) => {
                unexpected.push(format!("step {index} no longer differs"));
                "same (expected a difference)".to_owned()
            }
            (false, None) => {
                unexpected.push(format!(
                    "step {index} {label}:\n  native ({}): {native_text:?}\n  core   ({}): {core_text:?}",
                    native.2, core.2
                ));
                "DIFFERS".to_owned()
            }
        };
        println!("| {index} | {label} | {tool} | {verdict} |");
        println!("  native: {native_text:?} (error: {})", native.2);
        println!("  core:   {core_text:?} (error: {})", core.2);
    }
    let (native_files, core_files) = (snapshot(&env.ws[0]), snapshot(&env.ws[1]));
    println!(
        "workspaces after the run: {} files each, {}",
        core_files.len(),
        if native_files == core_files {
            "identical"
        } else {
            "DIFFERENT"
        }
    );
    assert!(unexpected.is_empty(), "{}", unexpected.join("\n"));
    assert_eq!(native_files, core_files);
}
