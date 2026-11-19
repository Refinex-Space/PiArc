//! Request validation rules.
//!
//! [`validate`] runs the six switchable rules over a parsed [`Request`]. Every finding is
//! a [`Violation`] carrying a stable [`Rule`] id, a readable message and, where it
//! applies, the location in the request (dotted path such as `messages.2.content.0`).
//! The rules are stricter than the real services on purpose: anything a real service
//! would reject, and a few things it would silently repair (consecutive same-role
//! messages, a trailing assistant message), fail here.

use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::request::{CacheSection, Message, Request, Role, Tool, ToolKind, WireFormat};
use crate::scenario::ValidationConfig;

/// Most `cache_control` breakpoints Anthropic accepts in one request, top-level automatic
/// caching included.
pub const MAX_CACHE_BREAKPOINTS: usize = 4;

/// Stable ids of every reason the mock answers 400.
///
/// The first six are the switchable validation rules; the rest describe requests the
/// mock cannot serve at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    /// Every tool call is answered in the next message with the same id; no orphan or
    /// duplicate ids; Anthropic `tool_result` blocks come first in their message.
    ToolPairing,
    /// Anthropic: user and assistant alternate, starting and ending with user. OpenAI:
    /// `tool` messages directly follow an assistant message with `tool_calls`. Unknown
    /// roles and empty conversations fail on both.
    RoleOrder,
    /// Tool names match the service's pattern and are unique; parameter schemas are valid
    /// JSON Schema with a top-level `"type": "object"`.
    ToolSchema,
    /// The system prompt contains every section the scenario requires.
    SystemSections,
    /// Anthropic: at most [`MAX_CACHE_BREAKPOINTS`] `cache_control` markers.
    CacheBreakpointCount,
    /// Anthropic: markers sit where the scenario allows and never on thinking blocks or
    /// empty text.
    CacheBreakpointPosition,
    /// The body is not JSON or lacks the structure of the wire format.
    MalformedRequest,
    /// The request did not set `stream: true`; the mock only streams.
    StreamingRequired,
    /// Neither the `x-piarc-scenario` header nor a first-message marker names a scenario.
    ScenarioNotSelected,
    /// The selected scenario is not loaded.
    ScenarioNotFound,
    /// The scenario instance has answered all its steps.
    ScenarioExhausted,
    /// No such endpoint.
    NotFound,
}

impl Rule {
    /// The six validation rules, in the order they run.
    pub const VALIDATION: [Self; 6] = [
        Self::ToolPairing,
        Self::RoleOrder,
        Self::ToolSchema,
        Self::SystemSections,
        Self::CacheBreakpointCount,
        Self::CacheBreakpointPosition,
    ];

    /// The id as it appears in error bodies and records.
    #[must_use]
    pub fn id(self) -> &'static str {
        match self {
            Self::ToolPairing => "tool_pairing",
            Self::RoleOrder => "role_order",
            Self::ToolSchema => "tool_schema",
            Self::SystemSections => "system_sections",
            Self::CacheBreakpointCount => "cache_breakpoint_count",
            Self::CacheBreakpointPosition => "cache_breakpoint_position",
            Self::MalformedRequest => "malformed_request",
            Self::StreamingRequired => "streaming_required",
            Self::ScenarioNotSelected => "scenario_not_selected",
            Self::ScenarioNotFound => "scenario_not_found",
            Self::ScenarioExhausted => "scenario_exhausted",
            Self::NotFound => "not_found",
        }
    }
}

/// One rule violation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Violation {
    /// The violated rule.
    pub rule: Rule,
    /// What is wrong, for people.
    pub message: String,
    /// Where in the request, when it applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

impl Violation {
    /// Creates a violation.
    #[must_use]
    pub fn new(rule: Rule, message: impl Into<String>, location: Option<String>) -> Self {
        Self {
            rule,
            message: message.into(),
            location,
        }
    }
}

/// Adds the mock's extensions to an error object: `code` (the first rule id) and
/// `violations` (all of them). Clients ignore unknown members.
pub(crate) fn attach_violations(error: &mut Value, violations: &[Violation]) {
    if let (Some(first), Some(object)) = (violations.first(), error.as_object_mut()) {
        object.insert("code".to_owned(), Value::from(first.rule.id()));
        object.insert(
            "violations".to_owned(),
            serde_json::to_value(violations)
                .expect("a violation has only string and enum members, which always serialize"),
        );
    }
}

/// Runs every enabled validation rule and returns all violations (empty when the request
/// complies).
#[must_use]
pub fn validate(request: &Request, config: &ValidationConfig) -> Vec<Violation> {
    let mut violations = Vec::new();
    for rule in Rule::VALIDATION {
        if !config.rules.is_enabled(rule) {
            continue;
        }
        match rule {
            Rule::ToolPairing => check_tool_pairing(request, &mut violations),
            Rule::RoleOrder => check_role_order(request, &mut violations),
            Rule::ToolSchema => check_tool_schema(request, &mut violations),
            Rule::SystemSections => check_system_sections(request, config, &mut violations),
            Rule::CacheBreakpointCount => check_cache_count(request, &mut violations),
            Rule::CacheBreakpointPosition => {
                check_cache_position(request, config, &mut violations);
            }
            _ => {}
        }
    }
    violations
}

fn at(message: &Message) -> Option<String> {
    Some(format!("messages.{}", message.index))
}

fn id_list<'a>(ids: impl IntoIterator<Item = &'a String>) -> String {
    ids.into_iter()
        .map(|id| format!("{id:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---- tool_pairing ------------------------------------------------------------------------

fn check_tool_pairing(request: &Request, out: &mut Vec<Violation>) {
    let mut seen = HashSet::new();
    for message in &request.messages {
        for id in &message.tool_calls {
            if !seen.insert(id) {
                out.push(Violation::new(
                    Rule::ToolPairing,
                    format!("tool call id {id:?} is used more than once"),
                    at(message),
                ));
            }
        }
    }
    match request.format {
        WireFormat::AnthropicMessages => anthropic_pairing(&request.messages, out),
        WireFormat::OpenaiChatCompletions => openai_pairing(&request.messages, out),
    }
}

fn anthropic_pairing(messages: &[Message], out: &mut Vec<Violation>) {
    for (position, message) in messages.iter().enumerate() {
        let calls_tools = message.role == Role::Assistant && !message.tool_calls.is_empty();
        if calls_tools {
            let answers = messages
                .get(position + 1)
                .filter(|next| next.role == Role::User);
            let results = answers.map_or(&[][..], |next| next.tool_results.as_slice());
            compare_ids(message, results, answers.and_then(at), out);
            if let Some(next) = answers
                && !next.results_first
            {
                out.push(Violation::new(
                    Rule::ToolPairing,
                    "tool_result blocks must come before any other content in the message",
                    at(next),
                ));
            }
        }
        let previous_called = position
            .checked_sub(1)
            .and_then(|previous| messages.get(previous))
            .is_some_and(|previous| {
                previous.role == Role::Assistant && !previous.tool_calls.is_empty()
            });
        if message.role == Role::User && !message.tool_results.is_empty() && !previous_called {
            out.push(Violation::new(
                Rule::ToolPairing,
                format!(
                    "orphan tool_result ids {}: the previous message is not an assistant \
                     message with tool_use",
                    id_list(&message.tool_results)
                ),
                at(message),
            ));
        }
    }
}

fn openai_pairing(messages: &[Message], out: &mut Vec<Violation>) {
    for (position, message) in messages.iter().enumerate() {
        if message.role != Role::Assistant || message.tool_calls.is_empty() {
            continue;
        }
        let run: Vec<&Message> = messages[position + 1..]
            .iter()
            .take_while(|next| next.role == Role::Tool)
            .collect();
        let results: Vec<String> = run
            .iter()
            .flat_map(|next| next.tool_results.iter().cloned())
            .collect();
        let location = run.first().map_or_else(|| at(message), |first| at(first));
        compare_ids(message, &results, location, out);
    }
}

/// Reports calls without a result, results without a call and repeated results.
fn compare_ids(
    call_message: &Message,
    results: &[String],
    result_location: Option<String>,
    out: &mut Vec<Violation>,
) {
    let calls: BTreeSet<&String> = call_message.tool_calls.iter().collect();
    let mut answered = BTreeSet::new();
    let mut repeated = BTreeSet::new();
    for id in results {
        if !answered.insert(id) {
            repeated.insert(id);
        }
    }
    let missing: Vec<&String> = calls.difference(&answered).copied().collect();
    let extra: Vec<&String> = answered.difference(&calls).copied().collect();
    if !missing.is_empty() {
        out.push(Violation::new(
            Rule::ToolPairing,
            format!(
                "tool calls {} of messages.{} have no result in the next message",
                id_list(missing),
                call_message.index
            ),
            result_location.clone().or_else(|| at(call_message)),
        ));
    }
    if !extra.is_empty() {
        out.push(Violation::new(
            Rule::ToolPairing,
            format!(
                "tool results {} answer no tool call of messages.{}",
                id_list(extra),
                call_message.index
            ),
            result_location.clone(),
        ));
    }
    if !repeated.is_empty() {
        out.push(Violation::new(
            Rule::ToolPairing,
            format!(
                "tool results {} are given more than once",
                id_list(repeated)
            ),
            result_location,
        ));
    }
}

// ---- role_order --------------------------------------------------------------------------

fn check_role_order(request: &Request, out: &mut Vec<Violation>) {
    if request.messages.is_empty() {
        out.push(Violation::new(
            Rule::RoleOrder,
            "messages must not be empty",
            Some("messages".to_owned()),
        ));
        return;
    }
    let allowed: &[Role] = match request.format {
        WireFormat::AnthropicMessages => &[Role::User, Role::Assistant, Role::System],
        WireFormat::OpenaiChatCompletions => {
            &[Role::User, Role::Assistant, Role::System, Role::Tool]
        }
    };
    for message in &request.messages {
        if !allowed.contains(&message.role) {
            out.push(Violation::new(
                Rule::RoleOrder,
                format!("role {:?} is not allowed here", message.role.as_str()),
                at(message),
            ));
        }
    }
    match request.format {
        WireFormat::AnthropicMessages => anthropic_alternation(&request.messages, out),
        WireFormat::OpenaiChatCompletions => openai_tool_placement(&request.messages, out),
    }
}

fn anthropic_alternation(messages: &[Message], out: &mut Vec<Violation>) {
    let turns: Vec<&Message> = messages
        .iter()
        .filter(|message| matches!(message.role, Role::User | Role::Assistant))
        .collect();
    let Some(first) = turns.first() else {
        out.push(Violation::new(
            Rule::RoleOrder,
            "messages contain no user message",
            Some("messages".to_owned()),
        ));
        return;
    };
    if first.role != Role::User {
        out.push(Violation::new(
            Rule::RoleOrder,
            "the first message must have role user",
            at(first),
        ));
    }
    for pair in turns.windows(2) {
        if let [previous, current] = pair
            && previous.role == current.role
        {
            out.push(Violation::new(
                Rule::RoleOrder,
                format!(
                    "two consecutive {} messages (messages.{} and messages.{}); user and \
                     assistant must alternate",
                    current.role.as_str(),
                    previous.index,
                    current.index
                ),
                at(current),
            ));
        }
    }
    if let Some(last) = turns.last()
        && last.role != Role::User
    {
        out.push(Violation::new(
            Rule::RoleOrder,
            "the conversation must end with a user message (assistant prefill is not \
             supported by current models)",
            at(last),
        ));
    }
}

fn openai_tool_placement(messages: &[Message], out: &mut Vec<Violation>) {
    for (position, message) in messages.iter().enumerate() {
        if message.role != Role::Tool {
            continue;
        }
        let owner = messages[..position]
            .iter()
            .rev()
            .find(|previous| previous.role != Role::Tool);
        let follows_call = owner
            .is_some_and(|owner| owner.role == Role::Assistant && !owner.tool_calls.is_empty());
        if !follows_call {
            out.push(Violation::new(
                Rule::RoleOrder,
                "a tool message must directly follow an assistant message with tool_calls \
                 (or another tool message answering it)",
                at(message),
            ));
        }
    }
}

// ---- tool_schema -------------------------------------------------------------------------

fn check_tool_schema(request: &Request, out: &mut Vec<Violation>) {
    let max_name = match request.format {
        WireFormat::AnthropicMessages => 128,
        WireFormat::OpenaiChatCompletions => 64,
    };
    let mut names = HashSet::new();
    for tool in &request.tools {
        let label = tool_label(tool);
        let location = Some(format!("tools.{}", tool.index));
        let mut report = |message: String| {
            out.push(Violation::new(Rule::ToolSchema, message, location.clone()));
        };
        if let Some(name) = &tool.name {
            if !is_valid_tool_name(name, max_name) {
                report(format!(
                    "tool {label}: name must match ^[a-zA-Z0-9_-]{{1,{max_name}}}$"
                ));
            }
            if !names.insert(name.as_str()) {
                report(format!("tool {label}: the name is declared more than once"));
            }
        }
        match &tool.kind {
            ToolKind::Function {
                schema,
                schema_required,
            } => {
                if tool.name.is_none() {
                    report(format!("tool {label}: a function tool needs a name"));
                }
                match schema {
                    Some(schema) => {
                        if let Err(problem) = check_parameter_schema(schema) {
                            report(format!("tool {label}: {problem}"));
                        }
                    }
                    None if *schema_required => {
                        report(format!("tool {label}: input_schema is required"));
                    }
                    None => {}
                }
            }
            ToolKind::Typed { .. } => {}
            ToolKind::Unsupported { tool_type } => {
                report(format!(
                    "tool {label}: tool type {tool_type:?} is not supported"
                ));
            }
        }
    }
}

fn tool_label(tool: &Tool) -> String {
    tool.name.as_ref().map_or_else(
        || format!("tools.{}", tool.index),
        |name| format!("{name:?}"),
    )
}

fn is_valid_tool_name(name: &str, max_len: usize) -> bool {
    (1..=max_len).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn check_parameter_schema(schema: &Value) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or("the parameter schema must be a JSON object")?;
    if object.get("type").and_then(Value::as_str) != Some("object") {
        return Err("the parameter schema must have a top-level \"type\": \"object\"".to_owned());
    }
    jsonschema::meta::validate(schema)
        .map_err(|error| format!("the parameter schema is not valid JSON Schema: {error}"))
}

// ---- system_sections ---------------------------------------------------------------------

fn check_system_sections(request: &Request, config: &ValidationConfig, out: &mut Vec<Violation>) {
    let system = request.system_text();
    let missing: Vec<&String> = config
        .required_system_sections
        .iter()
        .filter(|section| !system.contains(section.as_str()))
        .collect();
    if !missing.is_empty() {
        out.push(Violation::new(
            Rule::SystemSections,
            format!(
                "the system prompt lacks required sections: {}",
                id_list(missing)
            ),
            Some("system".to_owned()),
        ));
    }
    let mut remaining = system.as_str();
    for section in &config.ordered_system_sections {
        let Some((_, after)) = remaining.split_once(section) else {
            out.push(Violation::new(
                Rule::SystemSections,
                format!("required section {section:?} is missing or out of order"),
                Some("system".into()),
            ));
            break;
        };
        remaining = after;
    }
}

// ---- cache breakpoints (Anthropic only) --------------------------------------------------

fn locations<'a>(
    breakpoints: impl IntoIterator<Item = &'a crate::request::CacheBreakpoint>,
) -> String {
    breakpoints
        .into_iter()
        .map(|breakpoint| breakpoint.location.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn check_cache_count(request: &Request, out: &mut Vec<Violation>) {
    if request.format != WireFormat::AnthropicMessages {
        return;
    }
    let count = request.cache_breakpoints.len();
    if count > MAX_CACHE_BREAKPOINTS {
        out.push(Violation::new(
            Rule::CacheBreakpointCount,
            format!(
                "{count} cache breakpoints exceed the limit of {MAX_CACHE_BREAKPOINTS}: {}",
                locations(&request.cache_breakpoints)
            ),
            Some(locations(&request.cache_breakpoints)),
        ));
    }
}

fn check_cache_position(request: &Request, config: &ValidationConfig, out: &mut Vec<Violation>) {
    if request.format != WireFormat::AnthropicMessages {
        return;
    }
    for breakpoint in &request.cache_breakpoints {
        let problem = if matches!(
            breakpoint.block_type.as_str(),
            "thinking" | "redacted_thinking"
        ) {
            Some("thinking blocks cannot carry cache_control")
        } else if breakpoint.empty_text {
            Some("empty text blocks cannot carry cache_control")
        } else {
            None
        };
        if let Some(problem) = problem {
            out.push(Violation::new(
                Rule::CacheBreakpointPosition,
                format!("{problem} ({})", breakpoint.location),
                Some(breakpoint.location.clone()),
            ));
        }
    }
    let placement = &config.cache_breakpoints;
    let in_messages: Vec<_> = request
        .cache_breakpoints
        .iter()
        .filter(|breakpoint| breakpoint.section == CacheSection::Messages)
        .collect();
    if in_messages.len() > placement.max_message_level {
        out.push(Violation::new(
            Rule::CacheBreakpointPosition,
            format!(
                "{} message-level cache breakpoints, the scenario allows {}: {}",
                in_messages.len(),
                placement.max_message_level,
                locations(in_messages.iter().copied())
            ),
            Some(locations(in_messages.iter().copied())),
        ));
    }
    let last = request.messages.last().map(|message| message.index);
    if placement.last_message_only {
        for breakpoint in in_messages
            .iter()
            .filter(|breakpoint| breakpoint.message_index != last)
        {
            out.push(Violation::new(
                Rule::CacheBreakpointPosition,
                format!(
                    "message-level cache breakpoint at {} is not in the last message",
                    breakpoint.location
                ),
                Some(breakpoint.location.clone()),
            ));
        }
    }
}
