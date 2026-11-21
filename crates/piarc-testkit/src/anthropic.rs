//! Anthropic Messages wire format: request parsing and SSE encoding.
//!
//! Event order follows the official streaming documentation: `message_start`, then per
//! content block `content_block_start`, `content_block_delta`*, `content_block_stop`, then
//! `message_delta` (stop reason and cumulative usage) and `message_stop`. One `ping`
//! follows `message_start`, as on the real service, so clients must tolerate it.

use serde_json::{Map, Value, json};

use crate::request::{
    CacheBreakpoint, CacheSection, Message, Request, Role, Tool, ToolKind, ToolResultContent,
    WireFormat, as_object, malformed, optional_array, required_str,
};
use crate::rules::{Violation, attach_violations};
use crate::scenario::{InjectedErrorKind, Step, StopReason};
use crate::server::StreamContext;

/// Parses a Messages API request body.
///
/// # Errors
///
/// A `malformed_request` violation when the body lacks the Messages structure.
pub(crate) fn parse(body: &Value) -> Result<Request, Violation> {
    let object = as_object(body, "request")?;
    let mut request = Request::new(WireFormat::AnthropicMessages, object);
    if object.contains_key("cache_control") {
        request.cache_breakpoints.push(CacheBreakpoint {
            location: "cache_control".to_owned(),
            section: CacheSection::Request,
            message_index: None,
            block_type: String::new(),
            empty_text: false,
        });
    }
    parse_system(object.get("system"), &mut request)?;
    for (index, tool) in optional_array(object, "tools", "tools")?.iter().enumerate() {
        parse_tool(index, tool, &mut request)?;
    }
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("messages must be an array", "messages"))?;
    for (index, message) in messages.iter().enumerate() {
        let parsed = parse_message(index, message, &mut request.cache_breakpoints)?;
        request.messages.push(parsed);
    }
    Ok(request)
}

fn parse_system(system: Option<&Value>, request: &mut Request) -> Result<(), Violation> {
    match system {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(text)) => {
            request.system_texts.push(text.clone());
            Ok(())
        }
        Some(Value::Array(blocks)) => {
            for (index, block) in blocks.iter().enumerate() {
                let location = format!("system.{index}");
                let block = as_object(block, &location)?;
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    request.system_texts.push(text.to_owned());
                }
                note_cache_control(
                    block,
                    location,
                    CacheSection::System,
                    None,
                    &mut request.cache_breakpoints,
                );
            }
            Ok(())
        }
        Some(_) => Err(malformed(
            "system must be a string or an array of blocks",
            "system",
        )),
    }
}

fn parse_tool(index: usize, tool: &Value, request: &mut Request) -> Result<(), Violation> {
    let location = format!("tools.{index}");
    let object = as_object(tool, &location)?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let kind = match object.get("type").and_then(Value::as_str) {
        None | Some("custom") => ToolKind::Function {
            schema: object.get("input_schema").cloned(),
            schema_required: true,
        },
        Some(tool_type) => ToolKind::Typed {
            tool_type: tool_type.to_owned(),
        },
    };
    if object.contains_key("cache_control") {
        request.cache_breakpoints.push(CacheBreakpoint {
            location,
            section: CacheSection::Tools,
            message_index: None,
            block_type: String::new(),
            empty_text: false,
        });
    }
    request.tools.push(Tool { index, name, kind });
    Ok(())
}

fn parse_message(
    index: usize,
    value: &Value,
    breakpoints: &mut Vec<CacheBreakpoint>,
) -> Result<Message, Violation> {
    let location = format!("messages.{index}");
    let object = as_object(value, &location)?;
    let role = match required_str(object, "role", &location)? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "system" => Role::System,
        other => Role::Other(other.to_owned()),
    };
    let mut message = Message::new(index, role);
    match object.get("content") {
        Some(Value::String(text)) => message.texts.push(text.clone()),
        Some(Value::Array(blocks)) => {
            let mut other_content_seen = false;
            for (block_index, block) in blocks.iter().enumerate() {
                let block_location = format!("{location}.content.{block_index}");
                let block = as_object(block, &block_location)?;
                let block_type = required_str(block, "type", &block_location)?;
                match block_type {
                    "text" => message
                        .texts
                        .push(required_str(block, "text", &block_location)?.to_owned()),
                    "tool_use" => message
                        .tool_calls
                        .push(required_str(block, "id", &block_location)?.to_owned()),
                    "tool_result" => {
                        let id = required_str(block, "tool_use_id", &block_location)?.to_owned();
                        message.tool_result_contents.push(ToolResultContent {
                            id: id.clone(),
                            text: tool_result_text(block.get("content")),
                            is_error: Some(
                                block.get("is_error").and_then(Value::as_bool) == Some(true),
                            ),
                        });
                        message.tool_results.push(id);
                        message.results_first &= !other_content_seen;
                        for (inner, nested) in optional_array(block, "content", &block_location)
                            .unwrap_or_default()
                            .iter()
                            .enumerate()
                        {
                            if let Some(nested) = nested.as_object() {
                                let nested_location = format!("{block_location}.content.{inner}");
                                note_cache_control(
                                    nested,
                                    nested_location,
                                    CacheSection::Messages,
                                    Some(index),
                                    breakpoints,
                                );
                            }
                        }
                    }
                    _ => {}
                }
                other_content_seen |= block_type != "tool_result";
                note_cache_control(
                    block,
                    block_location,
                    CacheSection::Messages,
                    Some(index),
                    breakpoints,
                );
            }
        }
        _ => {
            return Err(malformed(
                format!("{location}.content must be a string or an array"),
                location,
            ));
        }
    }
    Ok(message)
}

/// The text of a `tool_result` block's `content`: a string, or its parts joined with newlines.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| match part.get("type").and_then(Value::as_str) {
                Some("image") => format!(
                    "[image {}]",
                    part.pointer("/source/media_type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ),
                _ => part
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn note_cache_control(
    block: &Map<String, Value>,
    location: String,
    section: CacheSection,
    message_index: Option<usize>,
    breakpoints: &mut Vec<CacheBreakpoint>,
) {
    if !block.contains_key("cache_control") {
        return;
    }
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let empty_text = block_type == "text" && block.get("text").and_then(Value::as_str) == Some("");
    breakpoints.push(CacheBreakpoint {
        location,
        section,
        message_index,
        block_type,
        empty_text,
    });
}

/// Encodes a scripted step as the complete list of SSE events.
///
/// # Errors
///
/// A description of the problem when a tool call's `split_at` does not fit its arguments.
pub(crate) fn encode_stream(step: &Step, context: &StreamContext) -> Result<Vec<String>, String> {
    let usage = step.usage;
    let mut events = vec![
        message_start(step, context),
        event("ping", &json!({ "type": "ping" })),
    ];
    let mut index = 0;
    let thinking = step.thinking_fragments();
    if !thinking.is_empty() {
        let start = json!({ "type": "thinking", "thinking": "" });
        let deltas = thinking
            .iter()
            .map(|piece| json!({ "type": "thinking_delta", "thinking": piece }))
            .chain(std::iter::once(
                json!({ "type": "signature_delta", "signature": format!("mock-signature-{}", context.response_number) }),
            ));
        push_block(&mut events, index, &start, deltas);
        index += 1;
    }
    let mut citations = Vec::new();
    if let Some(search) = &step.web_search {
        citations = push_web_search(&mut events, &mut index, search, context);
    }
    let text = step.text_fragments();
    if !text.is_empty() {
        let start = json!({ "type": "text", "text": "" });
        let deltas = text
            .iter()
            .map(|piece| json!({ "type": "text_delta", "text": piece }))
            .chain(
                citations
                    .into_iter()
                    .map(|citation| json!({ "type": "citations_delta", "citation": citation })),
            );
        push_block(&mut events, index, &start, deltas);
        index += 1;
    }
    for (call_index, call) in step.tool_calls.iter().enumerate() {
        let start = json!({
            "type": "tool_use",
            "id": call.wire_id("toolu", context.step_index, call_index),
            "name": call.name,
            "input": {},
        });
        let fragments = call.argument_fragments()?;
        let deltas = fragments
            .iter()
            .map(|piece| json!({ "type": "input_json_delta", "partial_json": piece }));
        push_block(&mut events, index, &start, deltas);
        index += 1;
    }
    events.push(event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason(step.effective_stop_reason()), "stop_sequence": null },
            "usage": {
                "input_tokens": usage.input_tokens,
                "cache_creation_input_tokens": usage.cache_write_tokens,
                "cache_read_input_tokens": usage.cache_read_tokens,
                "output_tokens": usage.output_tokens,
                "server_tool_use": { "web_search_requests": u64::from(step.web_search.is_some()) },
            },
        }),
    ));
    events.push(event("message_stop", &json!({ "type": "message_stop" })));
    Ok(events)
}

fn message_start(step: &Step, context: &StreamContext) -> String {
    let usage = step.usage;
    event(
        "message_start",
        &json!({
            "type": "message_start",
            "message": {
                "id": format!("msg_mock_{}", context.response_number),
                "type": "message",
                "role": "assistant",
                "model": context.model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {
                    "input_tokens": usage.input_tokens,
                    "cache_creation_input_tokens": usage.cache_write_tokens,
                    "cache_read_input_tokens": usage.cache_read_tokens,
                    "output_tokens": 0,
                },
            },
        }),
    )
}

/// The `server_tool_use` block (its input streamed as one `input_json_delta`) and the
/// `web_search_tool_result` block whose `content_block_start` carries the whole result, as the
/// official streaming reference shows; returns the citations for the text block.
fn push_web_search(
    events: &mut Vec<String>,
    index: &mut usize,
    search: &crate::scenario::WebSearchStep,
    context: &StreamContext,
) -> Vec<Value> {
    let id = format!("srvtoolu_mock_{}", context.step_index);
    let start = json!({ "type": "server_tool_use", "id": id, "name": "web_search", "input": {} });
    let input = json!({ "query": search.query }).to_string();
    let delta = json!({ "type": "input_json_delta", "partial_json": input });
    push_block(events, *index, &start, std::iter::once(delta));
    *index += 1;
    let content = match &search.error {
        Some(code) => json!({ "type": "web_search_tool_result_error", "error_code": code }),
        None => Value::Array(
            search
                .results
                .iter()
                .enumerate()
                .map(|(n, r)| {
                    json!({
                        "type": "web_search_result",
                        "url": r.url,
                        "title": r.title,
                        "encrypted_content": format!("mock-encrypted-{n}"),
                        "page_age": r.page_age,
                    })
                })
                .collect(),
        ),
    };
    let result = json!({ "type": "web_search_tool_result", "tool_use_id": id, "content": content });
    push_block(events, *index, &result, std::iter::empty());
    *index += 1;
    if search.error.is_some() {
        return Vec::new();
    }
    search
        .results
        .iter()
        .enumerate()
        .filter_map(|(n, r)| {
            let cited = r.cited_text.as_ref()?;
            Some(json!({
                "type": "web_search_result_location",
                "url": r.url,
                "title": r.title,
                "encrypted_index": format!("mock-index-{n}"),
                "cited_text": cited,
            }))
        })
        .collect()
}

fn push_block(
    events: &mut Vec<String>,
    index: usize,
    start: &Value,
    deltas: impl Iterator<Item = Value>,
) {
    events.push(event(
        "content_block_start",
        &json!({ "type": "content_block_start", "index": index, "content_block": start }),
    ));
    for delta in deltas {
        events.push(event(
            "content_block_delta",
            &json!({ "type": "content_block_delta", "index": index, "delta": delta }),
        ));
    }
    events.push(event(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
    ));
}

fn event(name: &str, data: &Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

fn stop_reason(reason: StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::ToolUse => "tool_use",
        StopReason::MaxTokens => "max_tokens",
    }
}

/// The official `error.type` for an injected error.
pub(crate) fn injected_error_type(kind: InjectedErrorKind) -> &'static str {
    match kind {
        InjectedErrorKind::RateLimit => "rate_limit_error",
        InjectedErrorKind::Overloaded => "overloaded_error",
        InjectedErrorKind::ServerError | InjectedErrorKind::Unavailable => "api_error",
        InjectedErrorKind::Unauthorized => "authentication_error",
    }
}

/// An error body in the official shape. `code` and `violations` are mock extensions that
/// carry the rule id and every violation; clients ignore unknown members.
pub(crate) fn error_body(
    error_type: &str,
    message: &str,
    violations: &[Violation],
    request_id: &str,
) -> Value {
    let mut error = json!({ "type": error_type, "message": message });
    attach_violations(&mut error, violations);
    json!({ "type": "error", "error": error, "request_id": request_id })
}
