//! OpenAI-compatible Chat Completions wire format: request parsing and `data:` chunk
//! encoding.
//!
//! The stream follows the official chunk shape (`chat.completion.chunk`): the first chunk
//! carries `delta.role`, text arrives in `delta.content`, each tool call opens with
//! `delta.tool_calls[i]` holding `id`, `type` and `function.name` and then appends
//! `function.arguments` fragments, the last choice chunk carries `finish_reason`, a usage
//! chunk with empty `choices` follows when `stream_options.include_usage` is set, and the
//! stream ends with `data: [DONE]`.

use serde_json::{Value, json};

use crate::request::{
    Message, Request, Role, Tool, ToolKind, WireFormat, as_object, malformed, optional_array,
    required_str,
};
use crate::rules::{Violation, attach_violations};
use crate::scenario::{InjectedErrorKind, Step, StopReason};
use crate::server::StreamContext;

/// The fixed `created` timestamp of every chunk, so recorded streams are reproducible.
const CREATED: u64 = 1_767_225_600;

/// Parses a Chat Completions request body.
///
/// # Errors
///
/// A `malformed_request` violation when the body lacks the Chat Completions structure.
pub(crate) fn parse(body: &Value) -> Result<Request, Violation> {
    let object = as_object(body, "request")?;
    let mut request = Request::new(WireFormat::OpenaiChatCompletions, object);
    request.include_usage = object
        .get("stream_options")
        .and_then(|options| options.get("include_usage"))
        .and_then(Value::as_bool)
        == Some(true);
    for (index, tool) in optional_array(object, "tools", "tools")?.iter().enumerate() {
        request.tools.push(parse_tool(index, tool)?);
    }
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed("messages must be an array", "messages"))?;
    for (index, message) in messages.iter().enumerate() {
        request.messages.push(parse_message(index, message)?);
    }
    Ok(request)
}

fn parse_tool(index: usize, tool: &Value) -> Result<Tool, Violation> {
    let location = format!("tools.{index}");
    let object = as_object(tool, &location)?;
    let tool_type = required_str(object, "type", &location)?;
    let (name, kind) = match tool_type {
        "function" => {
            let function = as_object(
                object.get("function").unwrap_or(&Value::Null),
                &format!("{location}.function"),
            )?;
            let kind = ToolKind::Function {
                schema: function.get("parameters").cloned(),
                schema_required: false,
            };
            (function.get("name"), kind)
        }
        "custom" => {
            let custom = object.get("custom");
            let kind = ToolKind::Typed {
                tool_type: tool_type.to_owned(),
            };
            (custom.and_then(|custom| custom.get("name")), kind)
        }
        other => (
            None,
            ToolKind::Unsupported {
                tool_type: other.to_owned(),
            },
        ),
    };
    Ok(Tool {
        index,
        name: name.and_then(Value::as_str).map(str::to_owned),
        kind,
    })
}

fn parse_message(index: usize, value: &Value) -> Result<Message, Violation> {
    let location = format!("messages.{index}");
    let object = as_object(value, &location)?;
    let role = match required_str(object, "role", &location)? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "system" | "developer" => Role::System,
        "tool" => Role::Tool,
        other => Role::Other(other.to_owned()),
    };
    let mut message = Message::new(index, role);
    match object.get("content") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) => message.texts.push(text.clone()),
        Some(Value::Array(parts)) => {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    message.texts.push(text.to_owned());
                }
            }
        }
        Some(_) => {
            return Err(malformed(
                format!("{location}.content must be a string, an array or null"),
                location,
            ));
        }
    }
    for (call_index, call) in optional_array(object, "tool_calls", &location)?
        .iter()
        .enumerate()
    {
        let call_location = format!("{location}.tool_calls.{call_index}");
        let call = as_object(call, &call_location)?;
        message
            .tool_calls
            .push(required_str(call, "id", &call_location)?.to_owned());
    }
    if message.role == Role::Tool {
        message
            .tool_results
            .push(required_str(object, "tool_call_id", &location)?.to_owned());
    }
    Ok(message)
}

/// Encodes a scripted step as the complete list of `data:` events, `[DONE]` included.
///
/// # Errors
///
/// A description of the problem when a tool call's `split_at` does not fit its arguments.
pub(crate) fn encode_stream(
    step: &Step,
    context: &StreamContext,
    include_usage: bool,
) -> Result<Vec<String>, String> {
    let id = format!("chatcmpl-mock-{}", context.response_number);
    let chunk = |delta: Value, finish_reason: Option<&str>| {
        data(&json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": CREATED,
            "model": context.model,
            "choices": [{
                "index": 0,
                "delta": delta,
                "logprobs": null,
                "finish_reason": finish_reason,
            }],
        }))
    };
    let mut events = vec![chunk(json!({ "role": "assistant", "content": "" }), None)];
    for piece in step.text_fragments() {
        events.push(chunk(json!({ "content": piece }), None));
    }
    for (call_index, call) in step.tool_calls.iter().enumerate() {
        events.push(chunk(
            json!({ "tool_calls": [{
                "index": call_index,
                "id": call.wire_id("call", context.step_index, call_index),
                "type": "function",
                "function": { "name": call.name, "arguments": "" },
            }] }),
            None,
        ));
        for piece in call.argument_fragments()? {
            events.push(chunk(
                json!({ "tool_calls": [{ "index": call_index, "function": { "arguments": piece } }] }),
                None,
            ));
        }
    }
    events.push(chunk(
        json!({}),
        Some(finish_reason(step.effective_stop_reason())),
    ));
    if include_usage {
        events.push(data(&usage_chunk(&id, step, &context.model)));
    }
    events.push("data: [DONE]\n\n".to_owned());
    Ok(events)
}

fn usage_chunk(id: &str, step: &Step, model: &str) -> Value {
    let usage = step.usage;
    let prompt_tokens = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
    let mut details = json!({ "cached_tokens": usage.cache_read_tokens });
    // `cache_write_tokens` is the OpenRouter extension pi-ai reads; OpenAI never sends it,
    // so it only appears when the script reports cache writes.
    if usage.cache_write_tokens > 0
        && let Some(details) = details.as_object_mut()
    {
        details.insert(
            "cache_write_tokens".to_owned(),
            json!(usage.cache_write_tokens),
        );
    }
    json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": CREATED,
        "model": model,
        "choices": [],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": usage.output_tokens,
            "total_tokens": prompt_tokens + usage.output_tokens,
            "prompt_tokens_details": details,
        },
    })
}

fn data(chunk: &Value) -> String {
    format!("data: {chunk}\n\n")
}

fn finish_reason(reason: StopReason) -> &'static str {
    match reason {
        StopReason::EndTurn => "stop",
        StopReason::ToolUse => "tool_calls",
        StopReason::MaxTokens => "length",
    }
}

/// `error.type` and `error.code` for an injected error. OpenAI documents no 529; the mock
/// sends one anyway so retry paths see the same statuses on both wire formats.
pub(crate) fn injected_error_type(kind: InjectedErrorKind) -> (&'static str, Option<&'static str>) {
    match kind {
        InjectedErrorKind::RateLimit => ("requests", Some("rate_limit_exceeded")),
        InjectedErrorKind::Overloaded => ("server_error", Some("overloaded")),
        InjectedErrorKind::ServerError => ("server_error", None),
        InjectedErrorKind::Unavailable => ("server_error", Some("service_unavailable")),
    }
}

/// An error body in the official shape. For rule violations `code` is the rule id,
/// `param` the location of the first violation, and `violations` (a mock extension) lists
/// them all.
pub(crate) fn error_body(
    error_type: &str,
    code: Option<&str>,
    message: &str,
    violations: &[Violation],
) -> Value {
    let param = violations.first().and_then(|first| first.location.clone());
    let mut error = json!({ "message": message, "type": error_type, "param": param, "code": code });
    attach_violations(&mut error, violations);
    json!({ "error": error })
}
