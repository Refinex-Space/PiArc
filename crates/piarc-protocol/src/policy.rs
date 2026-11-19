//! Permission preflight over AHP and the Core approval API (architecture section 6.2.3).
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::diff::FileDiff;

crate::method::request!(
    /// Wait for the Core decision before executing a tool.
    PolicyEvaluate, "policy/evaluate", PolicyEvaluateParams, PolicyEvaluateResult
);

/// Parameters of the preflight for one tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEvaluateParams {
    /// Owning session.
    pub session_id: String,
    /// Pi tool call identifier.
    pub tool_call_id: String,
    /// Canonical tool name.
    pub tool: String,
    /// Tool arguments before execution.
    pub input: Map<String, Value>,
    /// Bytes previously supplied through policy/inputChunk for this session, connection,
    /// tool and call. For Write the chunks carry the raw content; for other tools they
    /// carry the JSON input object and the inline input must be empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_input_bytes: Option<u64>,
}

/// Final decision. The Agent Host refuses on any bridge or decoding error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEvaluateResult {
    /// Whether this call may execute.
    pub allowed: bool,
    /// Reason visible to the model, including feedback on refusal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The arguments to run the call with instead (a `PreToolUse` or `PermissionRequest`
    /// hook's `updatedInput`, decided on before the rules); the whole object, not a patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<Map<String, Value>>,
    /// Hook context for the model (`PreToolUse` `additionalContext`), delivered with the
    /// call's result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// A hook stops the agent after this call (`continue: false`, or a `PermissionRequest`
    /// deny with `interrupt`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<crate::hooks::HookStop>,
}

/// Permission modes (architecture section 6.2.1). `auto` (M5) and `dontAsk` (headless) are
/// not available.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Ask about changes and commands.
    #[default]
    Default,
    /// Accept ordinary edits inside the workspace.
    AcceptEdits,
    /// Read-only exploration: writes and non-read-only commands are refused.
    Plan,
    /// Run everything except what deny and ask rules, critical deletions and questions stop.
    /// Available after the user enables it in settings and confirms the switch.
    BypassPermissions,
}

/// Presentation of a pending approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalKind {
    /// Shell command.
    Command,
    /// File write or edit.
    FileChange,
    /// Access outside the allowed directories.
    PermissionExpansion,
    /// A structured question. M1 clients decline this kind.
    Question,
}

/// User choice for a pending request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    /// Allow only this invocation.
    AllowOnce,
    /// Allow this invocation and remember its exact rule for the session.
    AllowSession,
    /// Allow this invocation and save the natively confirmed permission.
    AllowAlways,
    /// Refuse and return the feedback to the model.
    Deny,
}

/// Result of answering the approval ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AnswerStatus {
    /// The first valid answer was applied.
    Applied,
    /// The request is no longer pending.
    AlreadyHandled,
    /// The supplied request state is no longer applicable.
    Stale,
}

/// Immutable approval card from the Core ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// Opaque identifier allocated by Core.
    pub request_id: String,
    /// Owning session.
    pub session_id: String,
    /// Revision of this request.
    pub revision: u64,
    /// Agent Host connection that made the call.
    pub connection_epoch: u64,
    /// Canonical tool name.
    pub tool: String,
    /// Which card to show.
    pub kind: ApprovalKind,
    /// Full command text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Working directory of the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Path of the file being accessed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Preview of the file change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<FileDiff>,
    /// Rules "always allow" would save, one per subcommand that needed approval; editable
    /// before saving. Empty when the call cannot be allowed permanently (a critical deletion,
    /// a command that cannot be analyzed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
    /// Suggested directory to add.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    /// Whether the target must always be reviewed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_path: Option<bool>,
}

/// Answer bound to the request as displayed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAnswer {
    /// Opaque identifier allocated by Core.
    pub request_id: String,
    /// Owning session.
    pub session_id: String,
    /// Revision of this request.
    pub revision: u64,
    /// Agent Host connection that made the call.
    pub connection_epoch: u64,
    /// Choice made on the card.
    pub decision: ApprovalDecision,
    /// Feedback to return on refusal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    /// Rules shown in the native confirmation dialog.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<String>,
    /// Directory shown in the native confirmation dialog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
}

/// Correlates an approval wait on the current Agent Host connection.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPendingParams {
    /// Owning session.
    pub session_id: String,
    /// The tool call waiting for approval.
    pub tool_call_id: String,
}

crate::method::notification!(
    /// Core has created the approval. Suspend only this preflight's transport deadline.
    PolicyPending, "policy/pending", PolicyPendingParams
);

/// Core finished cancelling the expired preflight, or it was already gone.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PolicyCancelled {}

crate::method::request!(
    /// Cancel a waiting approval whose Agent Host preflight already timed out.
    PolicyCancel, "policy/cancel", PolicyPendingParams, PolicyCancelled
);

/// Part of a preflight too large for a single AHP frame.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyInputChunkParams {
    /// Owning session.
    pub session_id: String,
    /// Pi call identifier.
    pub tool_call_id: String,
    /// Canonical tool for this transfer.
    pub tool: String,
    /// Starting UTF-8 byte offset, zero for the first chunk.
    pub offset: u64,
    /// Unicode text, complete code points only.
    pub text: String,
}

/// The chunk was accepted at the requested offset.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PolicyInputChunkResult {}

crate::method::request!(
    /// Stage part of a large tool preflight in bounded session memory.
    PolicyInputChunk, "policy/inputChunk", PolicyInputChunkParams, PolicyInputChunkResult
);

/// The canonical names of the tools a session offers the model.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyToolsParams {
    /// Owning session.
    pub session_id: String,
    /// Canonical tool names.
    pub tools: Vec<String>,
}

/// The tools a deny rule without a specifier removes from the model's tool list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyToolsResult {
    /// Canonical names to leave out of the next model request.
    pub denied: Vec<String>,
}

crate::method::request!(
    /// Ask Core which tools are denied as a whole before each agent run.
    PolicyTools, "policy/tools", PolicyToolsParams, PolicyToolsResult
);
