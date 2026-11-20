//! L3 recording (architecture section 12.5, T30): the whitelisted structure of a request.
//!
//! In L3 mode the mock provider serves both PiArc and a real Claude Code. Neither side's
//! prompt text may be stored (ADR-0006), so the request log keeps only [`structure`] of each
//! body and drops the body itself:
//!
//! - top level: the sorted key names and `stream`;
//! - tools: name, the description as a [`fingerprint`] and the input schema with every
//!   `description` (and any other long string) replaced by its fingerprint;
//! - system: one fingerprint per segment, with its cache breakpoint;
//! - messages: role and content blocks in order. Text and thinking blocks become
//!   fingerprints; `tool_use` keeps its id, name and input (the mock's own script);
//!   `tool_result` keeps the id it answers, the error flag and the length of its content.
//!   Every block notes whether it carries a cache breakpoint.
//!
//! [`classify`] separates main-loop requests from auxiliary ones (title generation, topic
//! detection, extraction by a helper model): a request is `main` when it is a streaming
//! Messages request that declares at least one tool, `auxiliary` otherwise. In L3 mode the
//! mock answers auxiliary requests with a fixed short text without consuming a scenario step,
//! so a client's helper calls never shift the main loop's script. The comparison only uses
//! main-loop requests.

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::scenario::ValidationConfig;

/// Strings in a tool schema longer than this many characters are fingerprinted even when
/// they are not a `description`.
pub const MAX_SCHEMA_STRING_CHARS: usize = 64;

/// The text the mock streams back to an auxiliary request in L3 mode.
pub const AUXILIARY_REPLY: &str = "OK.";

/// Which loop a request belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The agent's main loop: a streaming Messages request with tools.
    Main,
    /// Anything else the client sends.
    Auxiliary,
}

impl Kind {
    /// `main` or `auxiliary`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Auxiliary => "auxiliary",
        }
    }
}

/// Classifies a parsed request body that arrived on `path` (query string allowed).
#[must_use]
pub fn classify(path: &str, body: &Value) -> Kind {
    let endpoint = path.split('?').next().unwrap_or(path);
    let streaming = body.get("stream").and_then(Value::as_bool) == Some(true);
    let has_tools = body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if endpoint == "/v1/messages" && streaming && has_tools {
        Kind::Main
    } else {
        Kind::Auxiliary
    }
}

/// `{"len": <characters>, "hash": "sha256:<first 16 hex digits>"}` of `text`.
#[must_use]
pub fn fingerprint(text: &str) -> Value {
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    json!({ "len": text.chars().count(), "hash": format!("sha256:{hex}") })
}

/// The whitelisted structure of the request body `body` that arrived on `path`.
#[must_use]
pub fn structure(path: &str, body: &str) -> Value {
    let endpoint = path.split('?').next().unwrap_or(path);
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return json!({ "kind": Kind::Auxiliary.as_str(), "endpoint": endpoint, "malformed": true });
    };
    let mut keys: Vec<&str> = json
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .unwrap_or_default();
    keys.sort_unstable();
    let tools: Vec<Value> = array(&json, "tools").iter().map(tool).collect();
    let system: Vec<Value> = match json.get("system") {
        Some(Value::String(text)) => vec![fingerprinted(text, None)],
        Some(Value::Array(blocks)) => blocks.iter().map(block).collect(),
        _ => Vec::new(),
    };
    let messages: Vec<Value> = array(&json, "messages").iter().map(message).collect();
    json!({
        "kind": classify(path, &json).as_str(),
        "endpoint": endpoint,
        "keys": keys,
        "stream": json.get("stream").and_then(Value::as_bool).unwrap_or(false),
        "tools": tools,
        "system": system,
        "messages": messages,
    })
}

/// The validation an L3 run applies: the protocol rules of `config` stay on, the rules that
/// encode PiArc's own prompt and caching layout (`system_sections`,
/// `cache_breakpoint_position`) are off.
#[must_use]
pub fn validation(config: &ValidationConfig) -> ValidationConfig {
    let mut config = config.clone();
    config.rules.system_sections = false;
    config.rules.cache_breakpoint_position = false;
    config.required_system_sections.clear();
    config.ordered_system_sections.clear();
    config
}

fn array<'a>(json: &'a Value, key: &str) -> &'a [Value] {
    json.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn cached(block: &Value) -> bool {
    block.get("cache_control").is_some_and(|c| !c.is_null())
}

fn fingerprinted(text: &str, cache: Option<bool>) -> Value {
    let mut value = fingerprint(text);
    if let (Some(cache), Some(object)) = (cache, value.as_object_mut()) {
        object.insert("cache".into(), Value::Bool(cache));
    }
    value
}

fn tool(tool: &Value) -> Value {
    let mut out = Map::new();
    for key in ["name", "type"] {
        if let Some(value) = tool.get(key).and_then(Value::as_str) {
            out.insert(key.into(), Value::String(value.to_owned()));
        }
    }
    if let Some(text) = tool.get("description").and_then(Value::as_str) {
        out.insert("description".into(), fingerprint(text));
    }
    if let Some(schema) = tool.get("input_schema") {
        out.insert("input_schema".into(), schema_shape(schema));
    }
    let mut keys: Vec<&str> = tool
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .unwrap_or_default();
    keys.sort_unstable();
    out.insert("keys".into(), json!(keys));
    out.insert("cache".into(), Value::Bool(cached(tool)));
    Value::Object(out)
}

/// A schema with descriptions and long strings replaced by fingerprints.
fn schema_shape(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let shaped = match value {
                        Value::String(text) if key == "description" || key == "title" => {
                            fingerprint(text)
                        }
                        other => schema_shape(other),
                    };
                    (key.clone(), shaped)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(schema_shape).collect()),
        Value::String(text) if text.chars().count() > MAX_SCHEMA_STRING_CHARS => fingerprint(text),
        other => other.clone(),
    }
}

fn message(message: &Value) -> Value {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let content: Vec<Value> = match message.get("content") {
        Some(Value::String(text)) => vec![text_block(text, false)],
        Some(Value::Array(blocks)) => blocks.iter().map(block).collect(),
        _ => Vec::new(),
    };
    json!({ "role": role, "content": content })
}

fn text_block(text: &str, cache: bool) -> Value {
    let mut value = fingerprinted(text, Some(cache));
    if let Some(object) = value.as_object_mut() {
        object.insert("type".into(), json!("text"));
    }
    value
}

fn block(block: &Value) -> Value {
    let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
    let cache = cached(block);
    let text = |key: &str| block.get(key).and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" => text_block(text("text"), cache),
        "thinking" | "redacted_thinking" => {
            let field = if kind == "thinking" {
                "thinking"
            } else {
                "data"
            };
            json!({ "type": kind, "len": text(field).chars().count(), "cache": cache })
        }
        "tool_use" => json!({
            "type": kind,
            "id": text("id"),
            "name": text("name"),
            "input": block.get("input").cloned().unwrap_or(Value::Null),
            "cache": cache,
        }),
        "tool_result" => json!({
            "type": kind,
            "tool_use_id": text("tool_use_id"),
            "is_error": block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            "len": result_length(block.get("content")),
            "cache": cache,
        }),
        other => json!({ "type": other, "cache": cache }),
    }
}

/// Characters of text in a tool result's content (a string or text blocks); other blocks
/// (images) count as 0.
fn result_length(content: Option<&Value>) -> usize {
    match content {
        Some(Value::String(text)) => text.chars().count(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .map(|text| text.chars().count())
            .sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::{Kind, classify, fingerprint, structure};
    use serde_json::{Value, json};

    const PROSE: &str =
        "This sentence stands in for prompt text that must never reach a recording.";

    fn body() -> Value {
        json!({
            "model": "m", "stream": true, "max_tokens": 10,
            "system": [{"type": "text", "text": PROSE, "cache_control": {"type": "ephemeral"}}],
            "tools": [{"name": "Bash", "description": PROSE, "input_schema": {
                "type": "object",
                "properties": {"command": {"type": "string", "description": PROSE},
                               "mode": {"type": "string", "enum": ["a", PROSE]}},
                "required": ["command"]}}],
            "messages": [
                {"role": "user", "content": PROSE},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": PROSE, "signature": "s"},
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1",
                    "is_error": true, "content": [{"type": "text", "text": "no"}],
                    "cache_control": {"type": "ephemeral"}}]}
            ]
        })
    }

    #[test]
    fn keeps_structure_and_no_prose() {
        let recorded = structure("/v1/messages?beta=true", &body().to_string());
        let text = recorded.to_string();
        assert!(!text.contains("stands in"), "{text}");
        assert_eq!(recorded["kind"], "main");
        assert_eq!(recorded["endpoint"], "/v1/messages");
        assert_eq!(
            recorded["keys"],
            json!([
                "max_tokens",
                "messages",
                "model",
                "stream",
                "system",
                "tools"
            ])
        );
        assert_eq!(recorded["system"][0]["cache"], true);
        assert_eq!(recorded["system"][0]["len"], PROSE.chars().count());
        let schema = &recorded["tools"][0]["input_schema"];
        assert_eq!(schema["required"], json!(["command"]));
        assert_eq!(schema["properties"]["command"]["type"], "string");
        assert_eq!(
            schema["properties"]["command"]["description"],
            fingerprint(PROSE)
        );
        assert_eq!(schema["properties"]["mode"]["enum"][0], "a");
        let messages = &recorded["messages"];
        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[1]["content"][0]["type"], "thinking");
        assert_eq!(messages[1]["content"][1]["input"], json!({"command": "ls"}));
        assert_eq!(messages[2]["content"][0]["is_error"], true);
        assert_eq!(messages[2]["content"][0]["len"], 2);
        assert_eq!(messages[2]["content"][0]["cache"], true);
    }

    #[test]
    fn classifies_main_and_auxiliary_requests() {
        let main = body();
        assert_eq!(classify("/v1/messages", &main), Kind::Main);
        let mut no_tools = main.clone();
        no_tools["tools"] = json!([]);
        assert_eq!(classify("/v1/messages", &no_tools), Kind::Auxiliary);
        let mut blocking = main.clone();
        blocking["stream"] = json!(false);
        assert_eq!(classify("/v1/messages", &blocking), Kind::Auxiliary);
        assert_eq!(
            classify("/v1/messages/count_tokens", &main),
            Kind::Auxiliary
        );
        assert_eq!(structure("/v1/messages", "{")["malformed"], true);
    }

    #[test]
    fn fingerprints_count_characters() {
        assert_eq!(fingerprint("中文")["len"], 2);
        assert_eq!(
            fingerprint("")["hash"],
            "sha256:e3b0c44298fc1c14",
            "the first 8 bytes of SHA-256 of the empty string"
        );
    }
}
