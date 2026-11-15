//! Scenario selection (T05-A06), error injection (T05-A05) and the request log
//! (T05-A07, library side).

mod support;

use piarc_testkit::{MockProvider, Outcome, REDACTED, RequestRecord, Rule, WireFormat};
use serde_json::{Value, json};
use support::{library, parse_sse, post, send};

const ANTHROPIC: &str = "/v1/messages";
const OPENAI: &str = "/v1/chat/completions";

const TWO_STEPS: &str = r#"
id: two-steps
steps:
  - text: "first"
  - text: "second"
"#;

const FAULTS: &str = r#"
id: faults
steps:
  - error: { kind: rate_limit, retry_after_secs: 7 }
  - error: { kind: overloaded }
  - error: { kind: server_error, message: "boom" }
  - error: { kind: unavailable }
  - text: "this answer breaks off"
    tool_calls: [{ name: read_file, input: { path: "a" } }]
    disconnect_after_events: 4
  - text: "recovered"
"#;

fn anthropic(first_user_text: &str) -> Value {
    json!({
        "model": "mock-model",
        "max_tokens": 64,
        "stream": true,
        "messages": [{ "role": "user", "content": first_user_text }],
    })
}

fn openai(first_user_text: &str) -> Value {
    json!({
        "model": "mock-model",
        "stream": true,
        "messages": [
            { "role": "system", "content": "sys" },
            { "role": "user", "content": [{ "type": "text", "text": first_user_text }] },
        ],
    })
}

fn streamed_text(body: &str) -> String {
    parse_sse(body)
        .iter()
        .filter(|event| event.data != "[DONE]")
        .map(support::Event::json)
        .filter_map(|data| {
            data["delta"]["text"]
                .as_str()
                .or_else(|| data["choices"][0]["delta"]["content"].as_str())
                .map(str::to_owned)
        })
        .collect()
}

#[tokio::test]
async fn header_selects_the_scenario_and_steps_advance_per_request() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let first = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps"),
        &anthropic("hi"),
    )
    .await;
    let second = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps"),
        &anthropic("hi"),
    )
    .await;
    assert_eq!(streamed_text(&first.body), "first");
    assert_eq!(streamed_text(&second.body), "second");
    let third = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps"),
        &anthropic("hi"),
    )
    .await;
    assert_eq!(third.status, 400);
    assert_eq!(third.json()["error"]["code"], Rule::ScenarioExhausted.id());
}

#[tokio::test]
async fn first_user_message_marker_selects_the_scenario_on_both_formats() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let marker = "[[piarc-scenario:two-steps]] please answer";
    let reply = post(provider.address(), ANTHROPIC, None, &anthropic(marker)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(streamed_text(&reply.body), "first");
    let reply = post(provider.address(), OPENAI, None, &openai(marker)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    assert_eq!(
        streamed_text(&reply.body),
        "second",
        "same selector, same counter"
    );
}

#[tokio::test]
async fn the_header_wins_over_the_marker() {
    const OTHER: &str = "id: other\nsteps:\n  - text: \"from other\"\n";
    let provider = MockProvider::start(library(&[TWO_STEPS, OTHER]))
        .await
        .expect("start");
    let body = anthropic("[[piarc-scenario:two-steps]]");
    let reply = post(provider.address(), ANTHROPIC, Some("other"), &body).await;
    assert_eq!(streamed_text(&reply.body), "from other");
}

#[tokio::test]
async fn missing_or_unknown_scenarios_are_rejected() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let reply = post(
        provider.address(),
        ANTHROPIC,
        None,
        &anthropic("no marker here"),
    )
    .await;
    assert_eq!(reply.status, 400);
    assert_eq!(
        reply.json()["error"]["code"],
        Rule::ScenarioNotSelected.id()
    );

    let reply = post(provider.address(), OPENAI, Some("nope"), &openai("hi")).await;
    assert_eq!(reply.status, 400);
    let error = &reply.json()["error"];
    assert_eq!(error["code"], Rule::ScenarioNotFound.id());
    assert!(
        error["message"]
            .as_str()
            .expect("message")
            .contains("loaded: two-steps")
    );

    let reply = post(
        provider.address(),
        ANTHROPIC,
        None,
        &anthropic("[[piarc-scenario:nope#1]]"),
    )
    .await;
    assert_eq!(reply.json()["error"]["code"], Rule::ScenarioNotFound.id());
}

#[tokio::test]
async fn instances_and_providers_count_steps_independently() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let other = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let a = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps#a"),
        &anthropic("hi"),
    )
    .await;
    let b = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps#b"),
        &anthropic("hi"),
    )
    .await;
    let a2 = post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps#a"),
        &anthropic("hi"),
    )
    .await;
    let fresh = post(
        other.address(),
        ANTHROPIC,
        Some("two-steps#a"),
        &anthropic("hi"),
    )
    .await;
    assert_eq!(streamed_text(&a.body), "first");
    assert_eq!(streamed_text(&b.body), "first");
    assert_eq!(streamed_text(&a2.body), "second");
    assert_eq!(streamed_text(&fresh.body), "first");
}

#[tokio::test]
async fn injected_errors_use_the_anthropic_status_and_error_shape() {
    let provider = MockProvider::start(library(&[FAULTS]))
        .await
        .expect("start");
    let mut seen = Vec::new();
    for _ in 0..4 {
        let reply = post(
            provider.address(),
            ANTHROPIC,
            Some("faults"),
            &anthropic("hi"),
        )
        .await;
        let body = reply.json();
        assert_eq!(body["type"], "error");
        assert!(
            body["request_id"]
                .as_str()
                .is_some_and(|id| id.starts_with("req_"))
        );
        seen.push((
            reply.status,
            body["error"]["type"].as_str().expect("type").to_owned(),
            reply.header("retry-after").map(str::to_owned),
        ));
    }
    assert_eq!(
        seen,
        [
            (429, "rate_limit_error".to_owned(), Some("7".to_owned())),
            (529, "overloaded_error".to_owned(), None),
            (500, "api_error".to_owned(), None),
            (503, "api_error".to_owned(), None),
        ]
    );
}

#[tokio::test]
async fn injected_errors_use_the_openai_status_and_error_shape() {
    let provider = MockProvider::start(library(&[FAULTS]))
        .await
        .expect("start");
    let mut statuses = Vec::new();
    for _ in 0..4 {
        let reply = post(provider.address(), OPENAI, Some("faults"), &openai("hi")).await;
        let error = &reply.json()["error"];
        assert!(
            error["message"].is_string() && error["type"].is_string(),
            "{error}"
        );
        statuses.push(reply.status);
        if reply.status == 429 {
            assert_eq!(reply.header("retry-after"), Some("7"));
            assert_eq!(error["code"], "rate_limit_exceeded");
        }
        if reply.status == 500 {
            assert_eq!(error["message"], "boom");
        }
    }
    assert_eq!(statuses, [429, 529, 500, 503]);
}

#[tokio::test]
async fn disconnect_sends_partial_events_then_breaks_the_stream() {
    let provider = MockProvider::start(library(&[FAULTS]))
        .await
        .expect("start");
    for _ in 0..4 {
        post(
            provider.address(),
            ANTHROPIC,
            Some("faults"),
            &anthropic("hi"),
        )
        .await;
    }
    let reply = post(
        provider.address(),
        ANTHROPIC,
        Some("faults"),
        &anthropic("hi"),
    )
    .await;
    assert_eq!(reply.status, 200);
    assert!(reply.body_error.is_some(), "the client sees a broken body");
    let names: Vec<String> = parse_sse(&reply.body)
        .into_iter()
        .filter_map(|event| event.name)
        .collect();
    assert_eq!(
        names,
        [
            "message_start",
            "ping",
            "content_block_start",
            "content_block_delta"
        ]
    );
    assert!(!reply.body.contains("message_stop"));

    // The client retries; the next step answers.
    let retry = post(
        provider.address(),
        ANTHROPIC,
        Some("faults"),
        &anthropic("hi"),
    )
    .await;
    assert!(retry.body_error.is_none());
    assert_eq!(streamed_text(&retry.body), "recovered");
    let outcomes: Vec<Outcome> = provider.records().iter().map(|r| r.outcome).collect();
    assert_eq!(outcomes[4..], [Outcome::Disconnected, Outcome::Streamed]);
}

#[tokio::test]
async fn openai_disconnect_breaks_the_stream_before_done() {
    let provider = MockProvider::start(library(&[FAULTS]))
        .await
        .expect("start");
    for _ in 0..4 {
        post(provider.address(), OPENAI, Some("faults"), &openai("hi")).await;
    }
    let reply = post(provider.address(), OPENAI, Some("faults"), &openai("hi")).await;
    assert!(reply.body_error.is_some());
    assert_eq!(parse_sse(&reply.body).len(), 4);
    assert!(!reply.body.contains("[DONE]"));
}

#[tokio::test]
async fn records_keep_every_request_in_order() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let headers = [
        ("x-piarc-scenario", "two-steps"),
        ("x-api-key", "test-key-not-secret"),
    ];
    let first = anthropic("one").to_string();
    send(provider.address(), "POST", ANTHROPIC, &headers, &first).await;
    send(
        provider.address(),
        "POST",
        "/v1/messages?beta=true",
        &headers,
        &anthropic("two").to_string(),
    )
    .await;
    post(provider.address(), ANTHROPIC, None, &anthropic("three")).await;
    send(provider.address(), "POST", "/v1/unknown", &[], "{}").await;

    let records = provider.log().snapshot();
    assert_eq!(records.len(), 4);
    assert_eq!(
        records.iter().map(|r| r.seq).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    let first_record = &records[0];
    assert_eq!(first_record.body, first, "the raw body is kept");
    assert_eq!(first_record.format, Some(WireFormat::AnthropicMessages));
    assert_eq!(first_record.scenario.as_deref(), Some("two-steps"));
    assert_eq!(first_record.step_index, Some(0));
    assert!(first_record.is_valid());
    assert_eq!(
        first_record.headers.get("x-api-key").map(String::as_str),
        Some(REDACTED)
    );
    assert_eq!(
        first_record.body_json().expect("json")["messages"][0]["content"],
        "one"
    );

    assert_eq!(
        records[1].path, "/v1/messages?beta=true",
        "query strings are accepted and kept"
    );
    assert_eq!(records[1].step_index, Some(1));
    assert_eq!(records[2].violations[0].rule, Rule::ScenarioNotSelected);
    assert_eq!(records[2].step_index, None);
    assert_eq!(records[3].format, None);
    assert_eq!(records[3].violations[0].rule, Rule::NotFound);
}

#[tokio::test]
async fn the_http_endpoint_returns_the_same_records() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    post(
        provider.address(),
        ANTHROPIC,
        Some("two-steps"),
        &anthropic("one"),
    )
    .await;
    post(
        provider.address(),
        OPENAI,
        Some("two-steps"),
        &openai("two"),
    )
    .await;
    let reply = send(provider.address(), "GET", "/_piarc/requests", &[], "").await;
    assert_eq!(reply.status, 200);
    let served: Vec<RequestRecord> = serde_json::from_str(&reply.body).expect("records");
    assert_eq!(served, provider.records());
    assert_eq!(served[1].format, Some(WireFormat::OpenaiChatCompletions));
    let raw = reply.json();
    assert_eq!(raw[1]["format"], "openai_chat_completions");
    assert_eq!(raw[1]["step_index"], 1);
    assert_eq!(raw[0]["outcome"], "streamed");
    assert_eq!(raw[0]["violations"], json!([]));
}

#[tokio::test]
async fn shutdown_stops_accepting_connections() {
    let provider = MockProvider::start(library(&[TWO_STEPS]))
        .await
        .expect("start");
    let address = provider.address();
    assert!(address.ip().is_loopback());
    assert_eq!(
        provider.anthropic_base_url(),
        format!("http://127.0.0.1:{}", address.port())
    );
    assert_eq!(
        provider.openai_base_url(),
        format!("http://127.0.0.1:{}/v1", address.port())
    );
    provider.shutdown().await;
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}
