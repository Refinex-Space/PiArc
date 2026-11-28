//! The mock provider's L3 mode (T30): structures instead of bodies, PiArc-specific rules
//! off, auxiliary requests answered without consuming a step.

mod support;

use piarc_testkit::{MockProvider, Mode, Outcome, ScenarioLibrary};
use serde_json::{Value, json};
use support::{library, parse_sse, post};

const PROSE: &str = "Prompt text that the L3 log must never contain, however long it is.";

const SCRIPT: &str = r#"
id: l3-mode
validation:
  required_system_sections: ["<piarc-only-section>"]
  cache_breakpoints: { max_message_level: 0 }
steps:
  - text: "first"
  - text: "second"
"#;

fn main_request() -> Value {
    json!({
        "model": "m", "max_tokens": 64, "stream": true,
        "system": [{ "type": "text", "text": PROSE }],
        "tools": [{ "name": "Bash", "description": PROSE,
                    "input_schema": { "type": "object", "properties": {} } }],
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": PROSE, "cache_control": { "type": "ephemeral" } }] }],
    })
}

fn texts(body: &str) -> String {
    parse_sse(body)
        .iter()
        .filter_map(|event| event.json()["delta"]["text"].as_str().map(str::to_owned))
        .collect()
}

async fn start(library: ScenarioLibrary) -> MockProvider {
    MockProvider::start_with(library, 0, Mode::L3)
        .await
        .expect("start")
}

#[tokio::test]
async fn l3_mode_records_structures_and_skips_piarc_rules() {
    let provider = start(library(&[SCRIPT])).await;
    let first = post(
        provider.address(),
        "/v1/messages",
        Some("l3-mode"),
        &main_request(),
    )
    .await;
    // Strict mode would refuse this request (missing system section, a message-level
    // breakpoint where none is allowed).
    assert_eq!(first.status, 200, "{}", first.body);
    assert_eq!(texts(&first.body), "first");
    let records = provider.records();
    let record = &records[0];
    assert!(record.body.is_empty());
    let structure = record.structure.as_ref().expect("a structure");
    assert_eq!(structure["kind"], "main");
    assert_eq!(structure["messages"][0]["content"][0]["cache"], true);
    let log = serde_json::to_string(&records).expect("serializes");
    assert!(!log.contains("never contain"), "{log}");
}

#[tokio::test]
async fn auxiliary_requests_do_not_consume_steps() {
    let provider = start(library(&[SCRIPT])).await;
    let mut helper = main_request();
    helper["tools"] = json!([]);
    let aux = post(provider.address(), "/v1/messages", Some("l3-mode"), &helper).await;
    assert_eq!(aux.status, 200, "{}", aux.body);
    assert_eq!(texts(&aux.body), piarc_testkit::l3::AUXILIARY_REPLY);
    let main = post(
        provider.address(),
        "/v1/messages",
        Some("l3-mode"),
        &main_request(),
    )
    .await;
    assert_eq!(texts(&main.body), "first");
    let records = provider.records();
    assert_eq!(
        records[0].structure.as_ref().map(|s| &s["kind"]),
        Some(&json!("auxiliary"))
    );
    assert_eq!(records[0].step_index, None);
    assert_eq!(records[0].outcome, Outcome::Streamed);
    assert_eq!(records[1].step_index, Some(0));
}

#[tokio::test]
async fn l3_mode_keeps_the_protocol_rules() {
    let provider = start(library(&[SCRIPT])).await;
    let mut unpaired = main_request();
    unpaired["messages"] = json!([
        { "role": "user", "content": "go" },
        { "role": "assistant", "content": [
            { "type": "tool_use", "id": "t1", "name": "Bash", "input": {} }] },
        { "role": "user", "content": "no result" },
    ]);
    let reply = post(
        provider.address(),
        "/v1/messages",
        Some("l3-mode"),
        &unpaired,
    )
    .await;
    assert_eq!(reply.status, 400);
    assert_eq!(provider.records()[0].outcome, Outcome::Rejected);
    assert!(
        provider.records()[0]
            .violations
            .iter()
            .any(|v| v.rule.id() == "tool_pairing")
    );
}
