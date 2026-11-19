//! Request validation: each rule rejects with HTTP 400 and its rule id (T05-A02); compliant
//! requests shaped like pi-ai's pass every rule (T05-A03).

mod support;

use piarc_testkit::{
    MockProvider, Outcome, Rule, Scenario, ValidationConfig, WireFormat, parse_request, validate,
};
use serde_json::{Value, json};
use support::{library, post};

const ANTHROPIC: &str = "/v1/messages";
const OPENAI: &str = "/v1/chat/completions";

/// Every rule on, one required system section, and the single message-level breakpoint
/// pinned to the last message.
const STRICT: &str = r#"
id: strict
validation:
  required_system_sections: ["<environment>"]
  ordered_system_sections: ["You are a coding agent.", "<environment>"]
  cache_breakpoints: { last_message_only: true }
steps:
  - text: "ok"
  - text: "ok"
"#;

const RELAXED: &str = r#"
id: relaxed
validation:
  rules: { tool_pairing: false }
steps:
  - text: "ok"
"#;

const ROUND_TRIP_ID: &str = "toolu_01";

fn cache() -> Value {
    json!({ "type": "ephemeral" })
}

/// A follow-up request the way pi-ai's anthropic-messages API builds it: system block,
/// tools with the breakpoint on the last one, and one message-level breakpoint on the last
/// block of the last user message.
fn anthropic_compliant() -> Value {
    json!({
        "model": "mock-model",
        "max_tokens": 4096,
        "stream": true,
        "system": [{ "type": "text", "text": "You are a coding agent.\n<environment>macOS</environment>", "cache_control": cache() }],
        "tools": [
            { "name": "read_file", "description": "Read a file", "eager_input_streaming": true,
              "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
            { "name": "list-dir_2", "description": "List", "eager_input_streaming": true,
              "input_schema": { "type": "object", "properties": {}, "required": [] }, "cache_control": cache() },
        ],
        "messages": [
            { "role": "user", "content": "[[piarc-scenario:strict]] read a b/中文.txt" },
            { "role": "assistant", "content": [
                { "type": "text", "text": "Reading." },
                { "type": "tool_use", "id": ROUND_TRIP_ID, "name": "read_file", "input": { "path": "a b/中文.txt" } },
            ] },
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": ROUND_TRIP_ID, "content": [{ "type": "text", "text": "hello" }], "is_error": false, "cache_control": cache() },
            ] },
        ],
    })
}

/// A follow-up request the way pi-ai's openai-completions API builds it.
fn openai_compliant() -> Value {
    json!({
        "model": "mock-model",
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_completion_tokens": 4096,
        "tools": [
            { "type": "function", "function": { "name": "read_file", "description": "Read a file", "strict": false,
              "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } } },
            { "type": "function", "function": { "name": "no_args", "description": "No parameters" } },
        ],
        "messages": [
            { "role": "system", "content": "You are a coding agent." },
            { "role": "developer", "content": "<environment>macOS</environment>" },
            { "role": "user", "content": [{ "type": "text", "text": "[[piarc-scenario:strict]] read it" }] },
            { "role": "assistant", "content": null, "tool_calls": [
                { "id": "call_1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } },
                { "id": "call_2", "type": "function", "function": { "name": "no_args", "arguments": "{}" } },
            ] },
            { "role": "tool", "content": "hello", "tool_call_id": "call_1" },
            { "role": "tool", "content": "(no tool output)", "tool_call_id": "call_2" },
            { "role": "user", "content": "thanks" },
        ],
    })
}

fn strict_config() -> ValidationConfig {
    Scenario::from_yaml_str("strict", STRICT)
        .expect("valid")
        .script
        .validation
}

#[test]
fn compliant_requests_pass_every_rule() {
    for (format, body) in [
        (WireFormat::AnthropicMessages, anthropic_compliant()),
        (WireFormat::OpenaiChatCompletions, openai_compliant()),
    ] {
        let request = parse_request(format, &body).expect("parses");
        assert_eq!(validate(&request, &strict_config()), [], "{format:?}");
    }
}

#[tokio::test]
async fn compliant_requests_are_served_over_http() {
    let provider = MockProvider::start(library(&[STRICT]))
        .await
        .expect("start");
    for (path, body) in [
        (ANTHROPIC, anthropic_compliant()),
        (OPENAI, openai_compliant()),
    ] {
        let reply = post(provider.address(), path, None, &body).await;
        assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    }
    let records = provider.records();
    assert!(
        records
            .iter()
            .all(|record| record.is_valid() && record.outcome == Outcome::Streamed)
    );
}

/// Sends a request expected to fail validation and checks the response and the record.
async fn expect_rejection(path: &str, scenario: &str, body: &Value, rule: Rule) -> Value {
    let provider = MockProvider::start(library(&[STRICT, RELAXED]))
        .await
        .expect("start");
    let reply = post(provider.address(), path, Some(scenario), body).await;
    assert_eq!(reply.status, 400, "{}", reply.body);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    let error = reply.json()["error"].clone();
    assert_eq!(error["type"], "invalid_request_error");
    assert_eq!(error["code"], rule.id(), "{error}");
    let message = error["message"].as_str().expect("message");
    assert!(message.starts_with(rule.id()), "{message}");
    assert!(
        error["violations"]
            .as_array()
            .is_some_and(|all| !all.is_empty())
    );

    let records = provider.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, Outcome::Rejected);
    assert_eq!(
        records[0].step_index, None,
        "a rejected request consumes no step"
    );
    assert!(
        records[0]
            .violations
            .iter()
            .any(|violation| violation.rule == rule)
    );
    assert_rule_lists_location(&records[0].violations, rule);
    print_evidence(rule, &error);
    error
}

fn assert_rule_lists_location(violations: &[piarc_testkit::Violation], rule: Rule) {
    let violation = violations
        .iter()
        .find(|violation| violation.rule == rule)
        .expect("rule");
    assert!(violation.location.is_some(), "{violation:?}");
}

/// Prints the rejection so `cargo test -- --nocapture` shows the evidence for T05-A02.
fn print_evidence(rule: Rule, error: &Value) {
    println!("{}: {}", rule.id(), error["message"]);
}

fn violation_messages(error: &Value) -> Vec<String> {
    error["violations"]
        .as_array()
        .expect("violations")
        .iter()
        .map(|violation| format!("{} @ {}", violation["message"], violation["location"]))
        .collect()
}

#[tokio::test]
async fn tool_pairing_rejects_missing_and_orphan_results() {
    let mut body = anthropic_compliant();
    body["messages"][1]["content"]
        .as_array_mut()
        .expect("blocks")
        .push(json!({ "type": "tool_use", "id": "toolu_02", "name": "read_file", "input": {} }));
    body["messages"][2]["content"][0]["tool_use_id"] = json!("toolu_99");
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::ToolPairing).await;
    let messages = violation_messages(&error).join("\n");
    assert!(
        messages.contains(r#"\"toolu_01\", \"toolu_02\""#) && messages.contains("no result"),
        "{messages}"
    );
    assert!(
        messages.contains(r#"\"toolu_99\""#) && messages.contains("answer no tool call"),
        "{messages}"
    );
    assert!(messages.contains("messages.2"), "{messages}");
}

#[tokio::test]
async fn tool_pairing_rejects_a_missing_openai_tool_message() {
    let mut body = openai_compliant();
    body["messages"].as_array_mut().expect("messages").remove(5);
    let error = expect_rejection(OPENAI, "strict", &body, Rule::ToolPairing).await;
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains(r#""call_2""#),
        "{error}"
    );
}

#[tokio::test]
async fn tool_pairing_requires_results_before_other_content() {
    let mut body = anthropic_compliant();
    body["messages"][2]["content"]
        .as_array_mut()
        .expect("blocks")
        .insert(0, json!({ "type": "text", "text": "here you go" }));
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::ToolPairing).await;
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("must come before"),
        "{error}"
    );
}

#[tokio::test]
async fn role_order_rejects_consecutive_user_messages() {
    let mut body = anthropic_compliant();
    body["messages"]
        .as_array_mut()
        .expect("messages")
        .insert(1, json!({ "role": "user", "content": "and also" }));
    let error = expect_rejection(ANTHROPIC, "relaxed", &body, Rule::RoleOrder).await;
    assert_eq!(error["violations"][0]["location"], "messages.1");
}

#[tokio::test]
async fn role_order_rejects_a_trailing_assistant_message() {
    let mut body = anthropic_compliant();
    body["messages"]
        .as_array_mut()
        .expect("messages")
        .push(json!({ "role": "assistant", "content": "prefill" }));
    let error = expect_rejection(ANTHROPIC, "relaxed", &body, Rule::RoleOrder).await;
    assert_eq!(error["violations"][0]["location"], "messages.3");
}

#[tokio::test]
async fn role_order_rejects_an_openai_tool_message_after_a_user_message() {
    let mut body = openai_compliant();
    body["messages"]
        .as_array_mut()
        .expect("messages")
        .push(json!({ "role": "tool", "content": "late", "tool_call_id": "call_1" }));
    let error = expect_rejection(OPENAI, "relaxed", &body, Rule::RoleOrder).await;
    assert_eq!(error["violations"][0]["location"], "messages.7");
}

#[tokio::test]
async fn tool_schema_rejects_bad_names_duplicates_and_invalid_schemas() {
    let mut body = anthropic_compliant();
    let tools = body["tools"].as_array_mut().expect("tools");
    tools.push(json!({ "name": "read_file", "input_schema": { "type": "object" } }));
    tools.push(json!({ "name": "has space", "input_schema": { "type": "object" } }));
    tools.push(json!({ "name": "array_root", "input_schema": { "type": "array" } }));
    tools.push(json!({ "name": "bad_type", "input_schema": { "type": "object", "properties": { "a": { "type": "strng" } } } }));
    tools.push(json!({ "name": "no_schema" }));
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::ToolSchema).await;
    let messages = violation_messages(&error).join("\n");
    for expected in [
        "declared more than once\" @ \"tools.2\"",
        "\\\"has space\\\": name must match",
        "top-level \\\"type\\\": \\\"object\\\"\" @ \"tools.4\"",
        "not valid JSON Schema",
        "input_schema is required\" @ \"tools.6\"",
    ] {
        assert!(
            messages.contains(expected),
            "missing {expected} in\n{messages}"
        );
    }
}

#[tokio::test]
async fn tool_schema_applies_the_openai_name_limit() {
    let mut body = openai_compliant();
    body["tools"][1]["function"]["name"] = json!("n".repeat(65));
    let error = expect_rejection(OPENAI, "strict", &body, Rule::ToolSchema).await;
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("{1,64}"),
        "{error}"
    );
    assert_eq!(
        error["param"], "tools.1",
        "OpenAI's param names the location"
    );
}

#[tokio::test]
async fn system_sections_lists_every_missing_section() {
    let mut body = anthropic_compliant();
    body["system"][0]["text"] = json!("You are a coding agent.");
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::SystemSections).await;
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("\"<environment>\""),
        "{error}"
    );
}

#[tokio::test]
async fn system_sections_rejects_reversed_markers_on_both_wires() {
    let reversed = json!("<environment>macOS</environment>\nYou are a coding agent.");
    let mut anthropic = anthropic_compliant();
    anthropic["system"][0]["text"] = reversed.clone();
    let mut openai = openai_compliant();
    openai["messages"][0]["content"] = reversed;
    openai["messages"][1]["content"] = json!("second system message");
    for (path, body) in [(ANTHROPIC, anthropic), (OPENAI, openai)] {
        let error = expect_rejection(path, "strict", &body, Rule::SystemSections).await;
        assert!(
            error["message"]
                .as_str()
                .expect("message")
                .contains("out of order"),
            "{error}"
        );
    }
}

#[tokio::test]
async fn cache_breakpoint_count_rejects_more_than_four() {
    let mut body = anthropic_compliant();
    body["cache_control"] = cache();
    body["tools"][0]["cache_control"] = cache();
    body["messages"][0] = json!({ "role": "user", "content": [{ "type": "text", "text": "hi", "cache_control": cache() }] });
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::CacheBreakpointCount).await;
    let message = error["message"].as_str().expect("message");
    assert!(
        message.contains("6 cache breakpoints exceed the limit of 4"),
        "{message}"
    );
    assert!(
        message.contains(
            "cache_control, system.0, tools.0, tools.1, messages.0.content.0, messages.2.content.0"
        ),
        "{message}"
    );
}

#[tokio::test]
async fn cache_breakpoint_position_reports_the_actual_locations() {
    let mut body = anthropic_compliant();
    body["messages"][1]["content"][0]["cache_control"] = cache();
    let error = expect_rejection(ANTHROPIC, "strict", &body, Rule::CacheBreakpointPosition).await;
    let messages = violation_messages(&error).join("\n");
    assert!(messages.contains("2 message-level cache breakpoints, the scenario allows 1: messages.1.content.0, messages.2.content.0"), "{messages}");
    assert!(
        messages.contains("messages.1.content.0 is not in the last message"),
        "{messages}"
    );
}

#[tokio::test]
async fn cache_breakpoint_position_rejects_thinking_and_empty_text_blocks() {
    let mut body = anthropic_compliant();
    body["messages"][1]["content"]
        .as_array_mut()
        .expect("blocks")
        .insert(0, json!({ "type": "thinking", "thinking": "hm", "signature": "sig", "cache_control": cache() }));
    let error = expect_rejection(ANTHROPIC, "relaxed", &body, Rule::CacheBreakpointPosition).await;
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("thinking blocks cannot carry cache_control"),
        "{error}"
    );
}

#[test]
fn switched_off_rules_do_not_report() {
    let mut body = anthropic_compliant();
    body["messages"]
        .as_array_mut()
        .expect("messages")
        .insert(1, json!({ "role": "user", "content": "and also" }));
    let request = parse_request(WireFormat::AnthropicMessages, &body).expect("parses");
    let mut relaxed = strict_config();
    relaxed.rules.role_order = false;
    assert!(
        validate(&request, &strict_config())
            .iter()
            .any(|violation| violation.rule == Rule::RoleOrder)
    );
    assert!(
        validate(&request, &relaxed)
            .iter()
            .all(|violation| violation.rule != Rule::RoleOrder)
    );
}

#[tokio::test]
async fn non_streaming_and_malformed_requests_are_rejected() {
    let provider = MockProvider::start(library(&[STRICT]))
        .await
        .expect("start");
    let mut body = anthropic_compliant();
    body["stream"] = json!(false);
    let reply = post(provider.address(), ANTHROPIC, None, &body).await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["error"]["code"], "streaming_required");

    let reply = support::send(provider.address(), "POST", OPENAI, &[], "{not json").await;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json()["error"]["code"], "malformed_request");

    let reply = post(
        provider.address(),
        ANTHROPIC,
        Some("strict"),
        &json!({ "stream": true }),
    )
    .await;
    assert_eq!(reply.json()["error"]["code"], "malformed_request");
    assert!(
        reply.json()["error"]["message"]
            .as_str()
            .expect("message")
            .contains("messages must be an array")
    );
}
