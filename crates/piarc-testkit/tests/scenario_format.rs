//! Loading scenario scripts from JSON and YAML.

mod support;

use piarc_testkit::{
    CachePlacement, ErrorKind, InjectedErrorKind, Rule, RuleSwitches, Scenario, ScenarioLibrary,
    StopReason, Usage,
};
use serde_json::json;

const YAML: &str = r#"
id: read-then-answer
validation:
  rules:
    cache_breakpoint_position: false
  required_system_sections: ["<environment>"]
  cache_breakpoints:
    max_message_level: 2
    last_message_only: true
steps:
  - text: "Reading."
    tool_calls:
      - id: toolu_read_1
        name: read_file
        input: { path: "a b/中文.txt" }
        fragments: 4
    usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 5, cache_write_tokens: 100 }
    stop_reason: tool_use
  - text: "Partial."
    disconnect_after_events: 3
  - error:
      kind: rate_limit
      retry_after_secs: 2
      message: slow down
  - text: "Done."
"#;

#[test]
fn yaml_scenario_loads_every_field() {
    let scenario = Scenario::from_yaml_str("inline", YAML).expect("valid scenario");
    assert_eq!(scenario.id, "read-then-answer");
    let validation = &scenario.script.validation;
    assert!(!validation.rules.cache_breakpoint_position);
    assert!(validation.rules.tool_pairing, "unspecified rules stay on");
    assert!(!validation.rules.is_enabled(Rule::CacheBreakpointPosition));
    assert_eq!(validation.required_system_sections, ["<environment>"]);
    assert_eq!(
        validation.cache_breakpoints,
        CachePlacement {
            max_message_level: 2,
            last_message_only: true
        }
    );

    let steps = &scenario.script.steps;
    assert_eq!(steps.len(), 4);
    let call = &steps[0].tool_calls[0];
    assert_eq!(call.id.as_deref(), Some("toolu_read_1"));
    assert_eq!(call.input, json!({ "path": "a b/中文.txt" }));
    assert_eq!(call.argument_fragments().expect("fragments").len(), 4);
    assert_eq!(
        steps[0].usage,
        Usage {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_tokens: 5,
            cache_write_tokens: 100
        }
    );
    assert_eq!(steps[0].effective_stop_reason(), StopReason::ToolUse);
    assert_eq!(steps[1].disconnect_after_events, Some(3));
    let error = steps[2].error.as_ref().expect("error step");
    assert_eq!(error.kind, InjectedErrorKind::RateLimit);
    assert_eq!(error.retry_after_secs, Some(2));
    assert_eq!(steps[3].effective_stop_reason(), StopReason::EndTurn);
}

#[test]
fn json_scenario_uses_the_same_fields_and_defaults() {
    let text = json!({
        "id": "json-one",
        "steps": [{ "tool_calls": [{ "name": "ls", "input": {} }] }],
    })
    .to_string();
    let scenario = Scenario::from_json_str("inline.json", &text).expect("valid scenario");
    assert_eq!(scenario.script.validation.rules, RuleSwitches::default());
    assert_eq!(
        scenario
            .script
            .validation
            .cache_breakpoints
            .max_message_level,
        1
    );
    let step = &scenario.script.steps[0];
    assert_eq!(step.usage, Usage::default());
    assert_eq!(step.effective_stop_reason(), StopReason::ToolUse);
    assert_eq!(
        step.tool_calls[0]
            .argument_fragments()
            .expect("fragments")
            .len(),
        3
    );
}

#[test]
fn rejects_unknown_fields_and_broken_steps() {
    let cases = [
        (
            "id: x\nsteps:\n  - text: hi\n    colour: red\n",
            "unknown field",
        ),
        ("id: x\nsteps: []\n", "at least one step"),
        (
            "id: x\nsteps:\n  - usage: { input_tokens: 1 }\n",
            "needs text, tool_calls or error",
        ),
        (
            "id: x\nsteps:\n  - text: hi\n    error: { kind: server_error }\n",
            "cannot also carry",
        ),
        (
            "id: x\nsteps:\n  - error: { kind: server_error, retry_after_secs: 1 }\n",
            "rate_limit only",
        ),
        (
            "id: x\nsteps:\n  - tool_calls: [{ name: a, input: [1] }]\n",
            "JSON object",
        ),
        (
            "id: x\nsteps:\n  - tool_calls: [{ name: a, input: {}, split_at: [5] }]\n",
            "split_at offset",
        ),
        (
            "id: x\nsteps:\n  - tool_calls: [{ name: a, input: {}, fragments: 2, split_at: [1] }]\n",
            "not both",
        ),
        (
            "id: x\nsteps:\n  - text: hi\n    disconnect_after_events: 0\n",
            "at least 1",
        ),
        (
            "id: x\nsteps:\n  - text: hi\n    stall_after_events: 0\n",
            "stall_after_events must be at least 1",
        ),
        (
            "id: x\nsteps:\n  - text: hi\n    stall_after_events: 2\n    disconnect_after_events: 2\n",
            "not both",
        ),
        (
            "id: x\nsteps:\n  - error: { kind: overloaded }\n    stall_after_events: 2\n",
            "cannot also carry a response",
        ),
        ("id: 'bad id'\nsteps:\n  - text: hi\n", "id must be"),
        ("id: x\nsteps:\n  - error: { kind: teapot }\n", "teapot"),
    ];
    for (yaml, expected) in cases {
        let error = Scenario::from_yaml_str("case", yaml).expect_err(yaml);
        assert_eq!(error.kind(), ErrorKind::InvalidScenario);
        assert!(!error.retryable());
        assert!(error.to_string().contains(expected), "{yaml}: {error}");
    }
}

#[test]
fn library_loads_a_directory_with_spaces_and_non_ascii_in_its_path() {
    let root = std::env::temp_dir().join(format!("piarc testkit 场景 {}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create the temp dir");
    let write = |name: &str, text: &str| std::fs::write(root.join(name), text).expect("write");
    write("a.yaml", "id: alpha\nsteps:\n  - text: hi\n");
    write("b.json", r#"{"id":"beta","steps":[{"text":"hi"}]}"#);
    write("c.yml", "id: gamma\r\nsteps:\r\n  - text: hi\r\n");
    write("notes.txt", "ignored");

    let library = ScenarioLibrary::load_paths(&[&root]).expect("load the directory");
    assert_eq!(
        library.ids().collect::<Vec<_>>(),
        ["alpha", "beta", "gamma"]
    );

    write("d.yaml", "id: alpha\nsteps:\n  - text: again\n");
    let error = ScenarioLibrary::load_paths(&[&root]).expect_err("duplicate id");
    assert!(
        error
            .to_string()
            .contains("duplicate scenario id \"alpha\"")
    );

    let missing = root.join("missing.yaml");
    let error = ScenarioLibrary::load_paths(&[&missing]).expect_err("missing file");
    assert_eq!(error.kind(), ErrorKind::Io);
    std::fs::remove_dir_all(&root).expect("clean up");
}

#[test]
fn scripts_embed_without_an_id() {
    let script = support::script("steps:\n  - text: hi\n");
    let scenario = Scenario::new("embedded", script).expect("valid");
    let library = ScenarioLibrary::new().with(scenario).expect("insert");
    assert!(library.get("embedded").is_some());
}
