//! Streaming encoding of both wire formats, observed through a real HTTP connection
//! (T05-A01, T05-A04).

mod support;

use piarc_testkit::MockProvider;
use serde_json::{Value, json};
use support::{library, parse_sse, post};

const SCENARIOS: &str = r#"
id: wire
steps:
  - text: "Let me read the file."
    tool_calls:
      - id: call_read_1
        name: read_file
        input: { path: "dir with space/中文.txt", pattern: "say \"hi\"\n" }
      - name: list_dir
        input: { path: "." }
        fragments: 5
    usage: { input_tokens: 120, output_tokens: 33, cache_read_tokens: 40, cache_write_tokens: 200 }
  - text: "All done."
    usage: { input_tokens: 10, output_tokens: 4 }
"#;

fn anthropic_request() -> Value {
    json!({
        "model": "mock-model",
        "max_tokens": 1024,
        "stream": true,
        "messages": [{ "role": "user", "content": "read it" }],
    })
}

fn openai_request() -> Value {
    json!({
        "model": "mock-model",
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": [{ "role": "user", "content": "read it" }],
    })
}

#[tokio::test]
async fn anthropic_stream_follows_the_official_event_order() {
    let provider = MockProvider::start(library(&[SCENARIOS]))
        .await
        .expect("start");
    let reply = post(
        provider.address(),
        "/v1/messages",
        Some("wire"),
        &anthropic_request(),
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("text/event-stream"));
    assert!(reply.body_error.is_none());

    let events = parse_sse(&reply.body);
    let names: Vec<&str> = events
        .iter()
        .map(|e| e.name.as_deref().expect("named"))
        .collect();
    let mut expected = vec!["message_start", "ping"];
    for deltas in [3, 3, 5] {
        expected.push("content_block_start");
        expected.extend(std::iter::repeat_n("content_block_delta", deltas));
        expected.push("content_block_stop");
    }
    expected.extend(["message_delta", "message_stop"]);
    assert_eq!(names, expected);
    for event in &events {
        assert_eq!(
            event.json()["type"],
            event.name.as_deref().expect("named"),
            "the data type matches the event name"
        );
    }

    let start = events[0].json();
    assert_eq!(start["message"]["role"], "assistant");
    assert_eq!(start["message"]["model"], "mock-model");
    assert_eq!(start["message"]["content"], json!([]));
    assert_eq!(start["message"]["usage"]["input_tokens"], 120);
    assert_eq!(start["message"]["usage"]["cache_read_input_tokens"], 40);
    assert_eq!(
        start["message"]["usage"]["cache_creation_input_tokens"],
        200
    );

    // Text block at index 0.
    assert_eq!(
        events[2].json()["content_block"],
        json!({ "type": "text", "text": "" })
    );
    let text: String = events[3..6]
        .iter()
        .map(|e| {
            let data = e.json();
            assert_eq!(data["index"], 0);
            assert_eq!(data["delta"]["type"], "text_delta");
            data["delta"]["text"].as_str().expect("text").to_owned()
        })
        .collect();
    assert_eq!(text, "Let me read the file.");

    // First tool call at index 1, with the scripted id.
    let tool_start = events[7].json();
    assert_eq!(tool_start["index"], 1);
    assert_eq!(tool_start["content_block"]["type"], "tool_use");
    assert_eq!(tool_start["content_block"]["id"], "call_read_1");
    assert_eq!(tool_start["content_block"]["name"], "read_file");
    assert_eq!(tool_start["content_block"]["input"], json!({}));
    for delta in &events[8..11] {
        assert_eq!(delta.json()["delta"]["type"], "input_json_delta");
    }
    // Second tool call gets a generated id.
    assert_eq!(events[12].json()["content_block"]["id"], "toolu_mock_0_1");

    let message_delta = events[events.len() - 2].json();
    assert_eq!(message_delta["delta"]["stop_reason"], "tool_use");
    assert_eq!(message_delta["usage"]["output_tokens"], 33);
}

#[tokio::test]
async fn anthropic_text_only_step_ends_the_turn() {
    let provider = MockProvider::start(library(&[SCENARIOS]))
        .await
        .expect("start");
    post(
        provider.address(),
        "/v1/messages",
        Some("wire"),
        &anthropic_request(),
    )
    .await;
    // The second step answers a follow-up; validation is not the point here.
    let mut follow_up = anthropic_request();
    follow_up["messages"] = json!([
        { "role": "user", "content": "read it" },
        { "role": "assistant", "content": [
            { "type": "tool_use", "id": "call_read_1", "name": "read_file", "input": {} },
            { "type": "tool_use", "id": "toolu_mock_0_1", "name": "list_dir", "input": {} },
        ] },
        { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "call_read_1", "content": "x" },
            { "type": "tool_result", "tool_use_id": "toolu_mock_0_1", "content": "y" },
        ] },
    ]);
    let reply = post(provider.address(), "/v1/messages", Some("wire"), &follow_up).await;
    let events = parse_sse(&reply.body);
    let names: Vec<&str> = events
        .iter()
        .map(|e| e.name.as_deref().expect("named"))
        .collect();
    assert_eq!(
        names,
        [
            "message_start",
            "ping",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
    );
    assert_eq!(events[7].json()["delta"]["stop_reason"], "end_turn");
}

#[tokio::test]
async fn openai_stream_follows_the_official_chunk_shape() {
    let provider = MockProvider::start(library(&[SCENARIOS]))
        .await
        .expect("start");
    let reply = post(
        provider.address(),
        "/v1/chat/completions",
        Some("wire"),
        &openai_request(),
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("text/event-stream"));

    let events = parse_sse(&reply.body);
    assert!(
        events.iter().all(|event| event.name.is_none()),
        "OpenAI uses bare data: lines"
    );
    assert_eq!(events.last().map(|e| e.data.as_str()), Some("[DONE]"));
    let chunks: Vec<Value> = events[..events.len() - 1]
        .iter()
        .map(support::Event::json)
        .collect();
    for chunk in &chunks {
        assert_eq!(chunk["object"], "chat.completion.chunk");
        assert_eq!(chunk["model"], "mock-model");
        assert_eq!(
            chunk["id"], chunks[0]["id"],
            "every chunk shares the completion id"
        );
    }

    assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
    let text: String = chunks
        .iter()
        .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
        .collect();
    assert_eq!(text, "Let me read the file.");

    let calls: Vec<&Value> = chunks
        .iter()
        .filter_map(|c| c["choices"][0]["delta"]["tool_calls"].get(0))
        .collect();
    assert_eq!(calls[0]["index"], 0);
    assert_eq!(calls[0]["id"], "call_read_1");
    assert_eq!(calls[0]["type"], "function");
    assert_eq!(calls[0]["function"]["name"], "read_file");
    assert_eq!(calls[0]["function"]["arguments"], "");
    let second_open = calls
        .iter()
        .position(|call| call["index"] == 1)
        .expect("second call");
    assert_eq!(calls[second_open]["id"], "call_mock_0_1");
    assert!(
        calls[1..second_open]
            .iter()
            .all(|call| call.get("id").is_none()),
        "later pieces only append arguments"
    );

    let finish = &chunks[chunks.len() - 2];
    assert_eq!(finish["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(finish["choices"][0]["delta"], json!({}));
    let usage = &chunks[chunks.len() - 1];
    assert_eq!(usage["choices"], json!([]));
    assert_eq!(usage["usage"]["prompt_tokens"], 360);
    assert_eq!(usage["usage"]["completion_tokens"], 33);
    assert_eq!(usage["usage"]["total_tokens"], 393);
    assert_eq!(usage["usage"]["prompt_tokens_details"]["cached_tokens"], 40);
    assert_eq!(
        usage["usage"]["prompt_tokens_details"]["cache_write_tokens"],
        200
    );
}

#[tokio::test]
async fn openai_stream_omits_usage_unless_requested() {
    let provider = MockProvider::start(library(&[SCENARIOS]))
        .await
        .expect("start");
    let mut request = openai_request();
    request
        .as_object_mut()
        .expect("object")
        .remove("stream_options");
    let reply = post(
        provider.address(),
        "/v1/chat/completions",
        Some("wire"),
        &request,
    )
    .await;
    let events = parse_sse(&reply.body);
    let chunks: Vec<Value> = events[..events.len() - 1]
        .iter()
        .map(support::Event::json)
        .collect();
    assert!(chunks.iter().all(|chunk| chunk.get("usage").is_none()));
    assert_eq!(
        chunks.last().expect("chunks")["choices"][0]["finish_reason"],
        "tool_calls"
    );
}

/// Collects the argument fragments of tool call `index` from either format.
fn anthropic_fragments(body: &str, block_index: u64) -> Vec<String> {
    parse_sse(body)
        .iter()
        .map(support::Event::json)
        .filter(|e| e["type"] == "content_block_delta" && e["index"] == block_index)
        .map(|e| {
            e["delta"]["partial_json"]
                .as_str()
                .expect("partial_json")
                .to_owned()
        })
        .collect()
}

fn openai_fragments(body: &str, call_index: u64) -> Vec<String> {
    parse_sse(body)
        .iter()
        .filter(|e| e.data != "[DONE]")
        .map(support::Event::json)
        .filter_map(|c| c["choices"][0]["delta"]["tool_calls"].get(0).cloned())
        .filter(|call| call["index"] == call_index && call.get("id").is_none())
        .map(|call| {
            call["function"]["arguments"]
                .as_str()
                .expect("arguments")
                .to_owned()
        })
        .collect()
}

#[tokio::test]
async fn tool_arguments_arrive_in_at_least_three_fragments_that_rebuild_the_json() {
    let provider = MockProvider::start(library(&[SCENARIOS]))
        .await
        .expect("start");
    let expected = json!({ "path": "dir with space/中文.txt", "pattern": "say \"hi\"\n" });

    let reply = post(
        provider.address(),
        "/v1/messages",
        Some("wire#a"),
        &anthropic_request(),
    )
    .await;
    let fragments = anthropic_fragments(&reply.body, 1);
    assert!(fragments.len() >= 3, "got {fragments:?}");
    assert_eq!(fragments.concat(), expected.to_string());
    assert_eq!(
        anthropic_fragments(&reply.body, 2).len(),
        5,
        "fragments: 5 is honored"
    );

    let reply = post(
        provider.address(),
        "/v1/chat/completions",
        Some("wire#b"),
        &openai_request(),
    )
    .await;
    let fragments = openai_fragments(&reply.body, 0);
    assert!(fragments.len() >= 3, "got {fragments:?}");
    let rebuilt: Value = serde_json::from_str(&fragments.concat()).expect("valid JSON");
    assert_eq!(rebuilt, expected);
    assert_eq!(fragments.concat(), expected.to_string());
}

#[tokio::test]
async fn split_at_cuts_inside_a_string_value_and_an_escape_sequence() {
    let input = json!({ "q": "say \"hi\"" });
    let serialized = input.to_string();
    let escape = serialized
        .find('\\')
        .expect("the arguments contain an escape");
    let scenario = format!(
        "id: split\nsteps:\n  - tool_calls:\n      - name: grep\n        input: {input}\n        split_at: [8, {}]\n",
        escape + 1
    );
    let provider = MockProvider::start(library(&[&scenario]))
        .await
        .expect("start");
    let reply = post(
        provider.address(),
        "/v1/messages",
        Some("split"),
        &anthropic_request(),
    )
    .await;
    let fragments = anthropic_fragments(&reply.body, 0);
    assert_eq!(fragments.len(), 3);
    assert_eq!(fragments[0], r#"{"q":"sa"#, "cut inside the string value");
    assert!(
        fragments[1].ends_with('\\'),
        "cut between the backslash and the quote: {fragments:?}"
    );
    assert!(fragments[2].starts_with('"'));
    assert_eq!(fragments.concat(), serialized);
}

const SEARCH: &str = r#"
id: search
steps:
  - text: "Tokio is an async runtime."
    web_search:
      query: "tokio runtime"
      results:
        - title: "Tokio"
          url: "https://tokio.rs/"
          page_age: "2 days ago"
          cited_text: "Tokio is an asynchronous runtime"
        - title: "Docs"
          url: "https://docs.rs/tokio"
  - text: "Nothing found."
    web_search:
      query: "x"
      error: max_uses_exceeded
"#;

#[tokio::test]
async fn anthropic_web_search_steps_stream_server_tool_blocks_and_citations() {
    let provider = MockProvider::start(library(&[SEARCH]))
        .await
        .expect("start");
    let mut request = anthropic_request();
    request["tools"] =
        json!([{ "type": "web_search_20250305", "name": "web_search", "max_uses": 1 }]);
    let reply = post(provider.address(), "/v1/messages", Some("search"), &request).await;
    assert_eq!(reply.status, 200);
    let events: Vec<Value> = parse_sse(&reply.body).iter().map(|e| e.json()).collect();
    let starts: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "content_block_start")
        .map(|e| &e["content_block"])
        .collect();
    assert_eq!(starts[0]["type"], "server_tool_use");
    assert_eq!(starts[0]["name"], "web_search");
    assert_eq!(starts[1]["type"], "web_search_tool_result");
    assert_eq!(starts[1]["tool_use_id"], starts[0]["id"]);
    assert_eq!(starts[1]["content"][0]["type"], "web_search_result");
    assert_eq!(starts[1]["content"][0]["url"], "https://tokio.rs/");
    assert_eq!(starts[1]["content"][1]["title"], "Docs");
    assert_eq!(starts[2]["type"], "text");
    let input: String = events
        .iter()
        .filter(|e| e["index"] == 0 && e["delta"]["type"] == "input_json_delta")
        .filter_map(|e| e["delta"]["partial_json"].as_str())
        .collect();
    assert_eq!(input, r#"{"query":"tokio runtime"}"#);
    let citations: Vec<&Value> = events
        .iter()
        .filter(|e| e["delta"]["type"] == "citations_delta")
        .map(|e| &e["delta"]["citation"])
        .collect();
    assert_eq!(citations.len(), 1);
    assert_eq!(citations[0]["type"], "web_search_result_location");
    assert_eq!(
        citations[0]["cited_text"],
        "Tokio is an asynchronous runtime"
    );
    let delta = events
        .iter()
        .find(|e| e["type"] == "message_delta")
        .expect("message_delta");
    assert_eq!(delta["usage"]["server_tool_use"]["web_search_requests"], 1);

    let failed = post(provider.address(), "/v1/messages", Some("search"), &request).await;
    let events: Vec<Value> = parse_sse(&failed.body).iter().map(|e| e.json()).collect();
    let result = events
        .iter()
        .find(|e| e["content_block"]["type"] == "web_search_tool_result")
        .expect("a result block");
    assert_eq!(
        result["content_block"]["content"],
        json!({ "type": "web_search_tool_result_error", "error_code": "max_uses_exceeded" })
    );
}
