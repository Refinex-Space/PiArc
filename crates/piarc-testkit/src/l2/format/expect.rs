//! What a scenario expects: approval answers and the `expect` section (requests, tool
//! results, Core I/O). Moved out of `format.rs` (R4 I150); `format` re-exports every type.

use super::*;

/// An approval answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    /// The decision.
    pub decision: ApprovalDecision,
    /// The tool the request must be for.
    #[serde(default)]
    pub tool: Option<String>,
    /// The tool call the request must be for; L3 runs pick the approval by it (T30).
    #[serde(default)]
    pub call: Option<String>,
    /// The presentation kind the approval card must have.
    #[serde(default)]
    pub kind: Option<piarc_protocol::policy::ApprovalKind>,
    /// User feedback returned with a refusal.
    #[serde(default)]
    pub feedback: Option<String>,
    /// The mode an approved plan continues in (T26).
    #[serde(default)]
    pub mode: Option<piarc_protocol::policy::PermissionMode>,
    /// Inline comments sent with a declined plan (T26).
    #[serde(default)]
    pub comments: Vec<crate::l2::harness_spec::PlanCommentSpec>,
    /// The structured answer to an MCP elicitation.
    #[serde(default)]
    pub elicitation: Option<piarc_protocol::mcp::ElicitationReply>,
    /// One answer per question of a question card (T26).
    #[serde(default)]
    pub answers: Vec<crate::l2::harness_spec::QuestionAnswerSpec>,
    /// The subagent the card must come from (T31).
    #[serde(default)]
    pub subagent: Option<SubagentOriginSpec>,
    /// The answer comes from a system notification's action (T42).
    #[serde(default)]
    pub via: Option<piarc_protocol::policy::AnswerVia>,
    /// Whether the card must offer "Allow" in its notification (T42).
    #[serde(default)]
    pub notification_allow: Option<bool>,
    /// The card came back from the Auto mode reviewer for this reason (T46); `none`: the
    /// card never went to the reviewer.
    #[serde(default)]
    pub review: Option<ReviewSpec>,
}

/// What an approval expects of the Auto mode reviewer (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewSpec {
    /// The card never went to the reviewer.
    None,
    /// It came back with this reason.
    #[serde(untagged)]
    Fallback(piarc_protocol::policy::ReviewFallback),
}

/// Where an approval card must come from (T31).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubagentOriginSpec {
    /// The subagent type.
    #[serde(rename = "type")]
    pub kind: String,
    /// The task description the model gave.
    #[serde(default)]
    pub description: Option<String>,
}

/// Approval decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Allow the same invocation for this session.
    Session,
    /// Persist a confirmed permission.
    Always,
    /// Allow.
    Allow,
    /// Deny.
    Deny,
    /// Leave the card unanswered: a question form whose timeout answers it (T26).
    Wait,
}

/// What must hold after the run.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    /// Configured provider ids and the public settings fields expected for each.
    #[serde(default)]
    pub configured_providers: BTreeMap<String, Value>,
    /// Ordered subsequence of events per session.
    #[serde(default)]
    pub events: Vec<EventExpect>,
    /// Workspace files: content, or `None` for absent.
    #[serde(default)]
    pub files: BTreeMap<String, Option<String>>,
    /// Workspace files whose bytes equal a fixture file (`fixtures/` name).
    #[serde(default)]
    pub fixtures: BTreeMap<String, String>,
    /// Request assertions.
    #[serde(default)]
    pub requests: Vec<RequestExpect>,
    /// Exact request counts per endpoint.
    #[serde(default)]
    pub request_counts: BTreeMap<String, usize>,
    /// Tool call ids in the batches their Core requests arrive in.
    #[serde(default)]
    pub tool_batches: Vec<Vec<String>>,
    /// Core requests per tool call.
    #[serde(default)]
    pub core_io: Vec<CoreIoExpect>,
    /// A subset of Core's configuration diagnostics of the workspace after the run, with
    /// `files` keyed by layer id (T24).
    #[serde(default)]
    pub config_diagnostics: Option<Value>,
    /// Workspace files of JSON lines (hook fixtures' records): each line a field subset (T25).
    #[serde(default)]
    pub json_lines: BTreeMap<String, Vec<Value>>,
    /// Strings no file of the run's temporary root (data directory, workspace, home) may
    /// contain after the run, scanned byte for byte (T38: a key that must only be in the
    /// vault).
    #[serde(default)]
    pub absent_on_disk: Vec<String>,
    /// Audit rows of the workspace (T47): each must match a row of its kind.
    #[serde(default)]
    pub audit: Vec<AuditExpect>,
}

/// One audit expectation (T47).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditExpect {
    /// `memory`, `hook`, `permission`, `sandbox` or `autoReview`.
    pub kind: String,
    /// A field subset of the row's detail.
    pub detail: Value,
    /// How many rows match; at least one when absent.
    #[serde(default)]
    pub count: Option<usize>,
}

/// One request assertion; every field present must hold.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestExpect {
    /// The endpoint; the only one when absent.
    #[serde(default)]
    pub provider: Option<String>,
    /// Request number of the endpoint, from 0.
    pub index: usize,
    /// Message roles in order.
    #[serde(default)]
    pub roles: Option<Vec<String>>,
    /// Exactly these tool names, any order.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Exactly these tool names on Windows, where sessions also get `PowerShell` (W2);
    /// `tools` applies when this is absent.
    #[serde(default)]
    pub tools_windows: Option<Vec<String>>,
    /// These tool names among others.
    #[serde(default)]
    pub tools_include: Option<Vec<String>>,
    /// None of these tool names.
    #[serde(default)]
    pub tools_exclude: Option<Vec<String>>,
    /// The text of every user message, in order.
    #[serde(default)]
    pub user_texts: Option<Vec<String>>,
    /// The text of the last user message.
    #[serde(default)]
    pub last_user_text: Option<String>,
    /// Substrings of the raw body.
    #[serde(default)]
    pub contains: Option<Vec<String>>,
    /// Strings the raw body must not contain.
    #[serde(default)]
    pub not_contains: Option<Vec<String>>,
    /// Number of occurrences of each literal substring in the raw request body.
    #[serde(default)]
    pub occurrences: BTreeMap<String, usize>,
    /// One user message must contain all these literal strings.
    #[serde(default)]
    pub user_message_contains: Option<Vec<String>>,
    /// Compare the complete system content with an earlier request on the same endpoint.
    #[serde(default)]
    pub same_system_as: Option<usize>,
    /// The earlier request's messages form a prefix; cache breakpoints move to the new tail.
    #[serde(default)]
    pub message_prefix_as: Option<usize>,
    /// Compare the tool definitions byte for byte with an earlier request (T26).
    #[serde(default)]
    pub same_tools_as: Option<usize>,
    /// Every tool result, in order.
    #[serde(default)]
    pub tool_results: Option<Vec<ToolResultExpect>>,
    /// Field subset of the body.
    #[serde(default)]
    pub body: Option<Value>,
}

/// One expected tool result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultExpect {
    /// The tool call it answers.
    pub id: String,
    /// Whether it is an error (Anthropic only).
    #[serde(default)]
    pub is_error: Option<bool>,
    /// A substring of its text.
    #[serde(default)]
    pub contains: Option<String>,
}

/// Core answered a request with `method` for tool call `call`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreIoExpect {
    /// The tool call id.
    pub call: String,
    /// The AHP method, such as `fs/read`.
    pub method: String,
}
