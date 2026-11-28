//! The L2 runner itself (T15): format errors name the file and the field (A01), broken
//! expectations fail with readable differences (A04), unused approval answers fail (A05),
//! runs are repeatable and clean up their temporary root (A06).
//!
//! The scenarios run like the `scenarios` target: the real Agent Host bundle (built first with
//! the `node` on `PATH`, or `PIARC_TEST_NODE`) and Core's headless runtime.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use piarc_testkit::l2::format::{Approval, ApprovalDecision, EventExpect};
use piarc_testkit::l2::{self, RunnerConfig, ScenarioSpec};
use serde_json::json;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the repository root")
        .to_path_buf()
}

fn config() -> &'static RunnerConfig {
    static CONFIG: OnceLock<RunnerConfig> = OnceLock::new();
    CONFIG.get_or_init(|| RunnerConfig::build(&repo()).expect("the Agent Host bundle builds"))
}

fn scenario(id: &str) -> ScenarioSpec {
    let file = repo()
        .join("tests")
        .join("scenarios")
        .join(format!("{id}.yaml"));
    l2::load(&file).expect("the scenario loads")
}

/// Writes `text` as `<dir>/<name>.yaml` and loads it.
fn load_text(dir: &Path, name: &str, text: &str) -> Result<ScenarioSpec, l2::FormatError> {
    let file = dir.join(format!("{name}.yaml"));
    std::fs::write(&file, text).expect("written");
    l2::load(&file)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "piarc l2 format {name} 中文 {}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

const VALID: &str = r"id: minimal
description: A minimal valid scenario.
capabilities: [CAP-SESSION-TURN-001]
providers:
  main: { wire: anthropic, steps: [{ text: 'Hi.' }] }
actions:
  - prompt: { text: 'Hello.' }
expect:
  request_counts: { main: 1 }
";

/// T15-A01: a valid file loads; a missing field, a wrong type, an unknown field and a broken
/// reference are each rejected with the file and the field in the message.
#[test]
fn invalid_scenario_files_are_rejected_with_the_file_and_the_field() {
    let dir = scratch("errors");
    assert!(load_text(&dir, "minimal", VALID).is_ok());
    let cases = [
        // (file name, text, field the error must name)
        (
            "missing-expect",
            VALID.replace("expect:\n  request_counts: { main: 1 }\n", ""),
            "/: \"expect\" is a required property",
        ),
        (
            "wrong-type",
            VALID.replace("{ main: 1 }", "{ main: 'one' }"),
            "/expect/request_counts/main",
        ),
        (
            "unknown-field",
            VALID.replace("actions:", "colour: blue\nactions:"),
            "colour",
        ),
        (
            "bad-wire",
            VALID.replace("anthropic", "anthropc"),
            "/providers/main/wire",
        ),
        (
            "bad-session",
            VALID.replace("{ text: 'Hello.' }", "{ text: 'Hello.', session: other }"),
            "/actions/0/prompt/session: no session `other`",
        ),
        (
            "bad-id",
            VALID.to_owned(),
            "/id: `minimal` differs from the file name `bad-id`",
        ),
        (
            "bad-run-path",
            VALID.replace(
                "providers:",
                "workspace: { run_files: { '../outside.txt': 'x' } }\nproviders:",
            ),
            "/workspace/run_files/../outside.txt",
        ),
        (
            "bad-path",
            VALID.replace(
                "expect:\n",
                "expect:\n  files: { '../outside.txt': null }\n",
            ),
            "/expect/files/../outside.txt",
        ),
    ];
    for (name, text, field) in cases {
        let error = load_text(&dir, name, &text).expect_err(name);
        let message = error.to_string();
        println!("{message}");
        assert!(
            message.contains(&format!("{name}.yaml")),
            "{name}: names the file: {message}"
        );
        assert!(message.contains(field), "{name}: names {field}: {message}");
    }
    std::fs::remove_dir_all(&dir).expect("scratch removed");
}

/// T15-A01: every committed scenario passes the schema and the reference checks.
#[test]
fn every_committed_scenario_loads() {
    let entries = l2::load_all(&[repo().join("tests").join("scenarios")]).expect("listed");
    assert!(entries.len() >= 10, "{} scenarios", entries.len());
    for entry in entries {
        if let Err(e) = entry.spec {
            panic!("{e}");
        }
    }
}

fn failures_of(spec: &ScenarioSpec) -> Vec<(String, String)> {
    l2::run(spec, config())
        .failures
        .into_iter()
        .map(|f| (f.kind.to_owned(), f.message))
        .collect()
}

/// T15-A04: an expected event, file and request are broken one at a time; each run fails with
/// a readable difference of that kind, and the restored scenario passes.
#[test]
fn broken_expectations_fail_with_readable_differences() {
    let good = scenario("tools-canonical-via-core");
    assert_eq!(failures_of(&good), [], "the scenario as committed passes");

    let mut broken = good.clone();
    let EventExpect::One(last) = broken.expect.events.last_mut().expect("events") else {
        panic!("the last expected event is a single event");
    };
    last.params = Some(json!({ "status": "failed" }));
    let failures = failures_of(&broken);
    println!("broken event:\n{failures:#?}");
    assert_eq!(failures.len(), 1, "{failures:#?}");
    assert_eq!(failures[0].0, "events");
    assert!(
        failures[0]
            .1
            .contains("params.status: expected \"failed\", got \"completed\"")
    );
    assert!(failures[0].1.contains("turn/completed"));

    let mut broken = good.clone();
    broken.expect.files.insert(
        "src/app 应用.ts".into(),
        Some("export const answer = 43;\n".into()),
    );
    let failures = failures_of(&broken);
    println!("broken file:\n{failures:#?}");
    assert_eq!(failures.len(), 1, "{failures:#?}");
    assert_eq!(failures[0].0, "files");
    assert!(failures[0].1.contains(
        "content differs at line 1: expected \"export const answer = 43;\", got \"export const answer = 42;\""
    ));

    let mut broken = good.clone();
    let results = broken.expect.requests[0]
        .tool_results
        .as_mut()
        .expect("tool results");
    results[3].contains = Some("from zsh".into());
    let failures = failures_of(&broken);
    println!("broken request:\n{failures:#?}");
    assert_eq!(failures.len(), 1, "{failures:#?}");
    assert_eq!(failures[0].0, "requests");
    assert!(failures[0].1.starts_with(
        "requests[main#1].tool_results[3] (toolu_bash).contains: \"from zsh\" is not in"
    ));

    assert_eq!(failures_of(&good), [], "restored, it passes again");
}

/// T15-A05: approval answers that no approval request used make the scenario fail.
#[test]
fn declared_approvals_without_approval_requests_fail() {
    let mut spec = scenario("chat-basic");
    spec.approvals = vec![Approval {
        elicitation: None,
        decision: ApprovalDecision::Allow,
        kind: None,
        feedback: None,
        tool: Some("Bash".into()),
        call: None,
        mode: None,
        comments: Vec::new(),
        answers: Vec::new(),
        subagent: None,
        via: None,
        notification_allow: None,
        review: None,
        rules: None,
    }];
    let failures = failures_of(&spec);
    println!("{failures:#?}");
    assert_eq!(
        failures,
        [(
            "approvals".to_owned(),
            "approvals: 1 answer(s) declared, but Core issued 0 approval requests".to_owned()
        )]
    );
}

/// T15-A06: the same scenario run twice gives the same result; each run's root has spaces and
/// Chinese characters in its path and is gone afterwards.
#[test]
fn a_scenario_gives_the_same_result_twice_and_removes_its_root() {
    let spec = scenario("turn-queue-edit-reorder");
    let first = l2::run(&spec, config());
    let second = l2::run(&spec, config());
    for outcome in [&first, &second] {
        let root = outcome.root.to_string_lossy().into_owned();
        println!(
            "root {root:?}: cleaned {} failures {:?}",
            outcome.cleaned, outcome.failures
        );
        assert!(root.contains(' ') && root.contains("中文"), "{root}");
        assert!(outcome.cleaned && !outcome.root.exists(), "{root} removed");
    }
    assert_eq!(first.failures, []);
    assert_eq!(first.failures, second.failures);
    assert_ne!(first.root, second.root, "each run has its own root");
}
