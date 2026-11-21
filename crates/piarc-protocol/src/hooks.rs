//! `hooks/run` (Agent Host → Core): run the hooks of an event the Agent Host observes in Pi
//! (architecture sections 6.3 and 7.4, ADR-0039). `hooks/prompt` (Core → Agent Host, T38,
//! ADR-0055): one model judgement for a `prompt` hook.
//!
//! Core owns hooks: it reads their configuration, runs the commands, writes the audit and
//! merges the decision; the Agent Host only reports the moment and applies the answer. Events
//! Core observes itself (`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
//! `Notification`) are not accepted here. Only sent to a Core that enabled the `hooks`
//! capability.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

crate::method::request!(
    /// Run the hooks of one event and return the merged decision.
    HooksRun, "hooks/run", HooksRunParams, HooksRunResult
);

/// The events the Agent Host reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HostHookEvent {
    /// Pi's `session_start` (created, resumed, forked) or a finished compaction.
    SessionStart,
    /// Pi's `session_shutdown`.
    SessionEnd,
    /// Pi's `tool_result` of a successful call.
    PostToolUse,
    /// Pi's `tool_result` of a failed call.
    PostToolUseFailure,
    /// Pi's `agent_before_settle`.
    Stop,
    /// Pi's `session_before_compact`.
    PreCompact,
    /// Pi's `session_compact`.
    PostCompact,
    /// A subagent session is about to send its first request (T38).
    SubagentStart,
    /// A subagent's `agent_before_settle` (T38).
    SubagentStop,
    /// Pi's `turn_end` after a round of tool calls (T38).
    PostToolBatch,
}

/// Parameters of `hooks/run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HooksRunParams {
    /// The session.
    pub session_id: String,
    /// The event.
    pub event: HostHookEvent,
    /// The session's working directory; must be inside the connection's workspace.
    pub cwd: String,
    /// Pi's session file (the hooks' `transcript_path`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// The event's own input fields with Claude Code's names (`source`, `tool_name`,
    /// `tool_input`, `tool_response`, `error`, `trigger`, `compact_summary`, …). Core adds the
    /// common fields and drops names the event does not have.
    pub input: Map<String, Value>,
    /// `Stop`, `SubagentStop`: how many times in a row hooks already continued this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuations: Option<u64>,
}

/// `continue: false`: the agent stops.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HookStop {
    /// `stopReason`, shown to the user and kept in the conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The merged decision. Every member is optional: an empty result means "go on unchanged".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HooksRunResult {
    /// `Stop`, `SubagentStop`: continue the turn with this reason for the model. `PreCompact`:
    /// do not compact (the reason went to the user). `PostToolBatch`: stop the loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// Text for the model's context (`additionalContext`, plain stdout), already bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// `PostToolUse`, `PostToolUseFailure`: feedback the model reads next to the tool result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    /// `PostToolUse`: the tool output the model reads instead (`updatedToolOutput`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_output: Option<Value>,
    /// `PreCompact`: instructions for the compaction summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// The agent stops after this event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<HookStop>,
}

crate::method::request!(
    /// One model call judging a `prompt` hook's question (Core → Agent Host).
    HooksPrompt, "hooks/prompt", HooksPromptParams, HooksPromptResult
);

/// Parameters of `hooks/prompt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HooksPromptParams {
    /// The main session whose model settings and usage the call belongs to.
    pub session_id: String,
    /// The hook's prompt with the input JSON in place of `$ARGUMENTS`.
    pub prompt: String,
    /// The hook's `model` (an alias, `provider/model` or a model id); absent: the auxiliary
    /// model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The hook's timeout; the model call ends with it.
    pub timeout_ms: u64,
}

/// Result of `hooks/prompt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HooksPromptResult {
    /// The model's answer text.
    pub text: String,
    /// `provider/model` that answered.
    pub model: String,
    /// Input tokens of the call.
    pub input_tokens: u64,
    /// Output tokens of the call.
    pub output_tokens: u64,
}
