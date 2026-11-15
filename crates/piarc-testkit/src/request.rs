//! The wire-format-neutral view of a model request that the validator checks.
//!
//! Each wire format parses its JSON body into [`Request`] (`anthropic::parse`,
//! `openai::parse`). The validator only sees this structure, so every rule can be tested
//! on its own and a new wire format only needs a parser.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rules::{Rule, Violation};

/// The two wire formats the mock speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFormat {
    /// Anthropic Messages (`POST /v1/messages`).
    AnthropicMessages,
    /// OpenAI-compatible Chat Completions (`POST /v1/chat/completions`).
    OpenaiChatCompletions,
}

/// A parsed model request.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// The wire format the request arrived in.
    pub format: WireFormat,
    /// The requested model id (empty when absent).
    pub model: String,
    /// `stream: true` was set.
    pub stream: bool,
    /// OpenAI `stream_options.include_usage` was set.
    pub include_usage: bool,
    /// Text of the top-level system prompt (Anthropic `system`; OpenAI messages with role
    /// `system` or `developer` are in [`Self::messages`] with [`Role::System`]).
    pub system_texts: Vec<String>,
    /// The conversation, in order.
    pub messages: Vec<Message>,
    /// The declared tools, in order.
    pub tools: Vec<Tool>,
    /// Every Anthropic `cache_control` marker, in document order.
    pub cache_breakpoints: Vec<CacheBreakpoint>,
}

/// One conversation message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Position in the request's `messages` array.
    pub index: usize,
    /// The message role.
    pub role: Role,
    /// Text content, one entry per text block.
    pub texts: Vec<String>,
    /// Ids of the tool calls this message makes (Anthropic `tool_use`, OpenAI
    /// `tool_calls`).
    pub tool_calls: Vec<String>,
    /// Ids this message answers (Anthropic `tool_result.tool_use_id`, OpenAI
    /// `tool_call_id`).
    pub tool_results: Vec<String>,
    /// Anthropic: no other content block comes before a `tool_result` block.
    pub results_first: bool,
}

/// Message roles; anything unknown is kept as [`Role::Other`] for the validator to
/// report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// `user`.
    User,
    /// `assistant`.
    Assistant,
    /// `system`, or OpenAI `developer`.
    System,
    /// OpenAI `tool`.
    Tool,
    /// Any other role string.
    Other(String),
}

impl Role {
    /// The role as it appears on the wire.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
            Self::Tool => "tool",
            Self::Other(role) => role,
        }
    }
}

/// A declared tool.
#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    /// Position in the request's `tools` array.
    pub index: usize,
    /// The tool name, when it has one.
    pub name: Option<String>,
    /// What kind of declaration it is.
    pub kind: ToolKind,
}

/// Tool declaration kinds.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolKind {
    /// A function described by a JSON Schema (Anthropic custom tool, OpenAI `function`).
    Function {
        /// The parameter schema, when present.
        schema: Option<Value>,
        /// The format requires the schema (Anthropic `input_schema`).
        schema_required: bool,
    },
    /// A provider-defined or free-form tool without a parameter schema (Anthropic typed
    /// tools such as server tools and toolsets, OpenAI `custom`).
    Typed {
        /// The declaration's `type`.
        tool_type: String,
    },
    /// A declaration type the wire format does not have.
    Unsupported {
        /// The declaration's `type`.
        tool_type: String,
    },
}

/// Where an Anthropic `cache_control` marker sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheSection {
    /// Top-level `cache_control` (automatic caching).
    Request,
    /// A tool definition.
    Tools,
    /// A `system` block.
    System,
    /// A content block inside `messages`.
    Messages,
}

/// One Anthropic `cache_control` marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheBreakpoint {
    /// Dotted path, for example `messages.3.content.1`.
    pub location: String,
    /// The request section.
    pub section: CacheSection,
    /// For [`CacheSection::Messages`]: position of the message.
    pub message_index: Option<usize>,
    /// The `type` of the block that carries the marker (empty for tools and the request).
    pub block_type: String,
    /// The block is a text block with empty text.
    pub empty_text: bool,
}

impl Request {
    pub(crate) fn new(format: WireFormat, body: &serde_json::Map<String, Value>) -> Self {
        Self {
            format,
            model: body
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            stream: body.get("stream").and_then(Value::as_bool) == Some(true),
            include_usage: false,
            system_texts: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            cache_breakpoints: Vec::new(),
        }
    }

    /// Text of the first user message, used to find the scenario marker.
    #[must_use]
    pub fn first_user_text(&self) -> Option<String> {
        self.messages
            .iter()
            .find(|message| message.role == Role::User)
            .map(|message| message.texts.join("\n"))
    }

    /// The whole system prompt: top-level system text and every system-role message.
    #[must_use]
    pub fn system_text(&self) -> String {
        let in_messages = self
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .flat_map(|message| message.texts.iter());
        self.system_texts
            .iter()
            .chain(in_messages)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl Message {
    pub(crate) fn new(index: usize, role: Role) -> Self {
        Self {
            index,
            role,
            texts: Vec::new(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
            results_first: true,
        }
    }
}

/// A `malformed_request` violation.
pub(crate) fn malformed(message: impl Into<String>, location: impl Into<String>) -> Violation {
    Violation::new(Rule::MalformedRequest, message, Some(location.into()))
}

/// Reads a required string member.
pub(crate) fn required_str<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    location: &str,
) -> Result<&'a str, Violation> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| malformed(format!("{location}.{key} must be a string"), location))
}

/// Reads an object, or reports where it was expected.
pub(crate) fn as_object<'a>(
    value: &'a Value,
    location: &str,
) -> Result<&'a serde_json::Map<String, Value>, Violation> {
    value
        .as_object()
        .ok_or_else(|| malformed(format!("{location} must be a JSON object"), location))
}

/// Reads an optional array member; absent and `null` are both an empty slice.
pub(crate) fn optional_array<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    location: &str,
) -> Result<&'a [Value], Violation> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(malformed(format!("{location} must be an array"), location)),
    }
}
