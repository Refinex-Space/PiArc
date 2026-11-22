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
    /// For a subagent's call (T31): the session that started it. Core checks it against the
    /// subagent it registered (`subagent/start`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// For a subagent's call: its type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The tool asks the user on every call whatever the mode (an MCP tool's
    /// `_meta["anthropic/requiresUserInteraction"]`, T36).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub requires_user_interaction: bool,
    /// The session's effort level when its model has one (T38): hooks' `effort`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
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
    /// Allowing the call switched the session to this mode (`EnterPlanMode`, an approved
    /// plan, T26): the Agent Host records the change on the branch and tells the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    /// The reviewer model decided the call in Auto mode (T46): the Agent Host records it on
    /// the branch (`piarc.autoReview`) and the call's item shows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ToolReview>,
}

/// What the reviewer model decided about a call (T46).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolReview {
    /// `allow` ran the call; `deny` refused it with the reason.
    pub verdict: ReviewVerdict,
    /// The reviewer's reason, without control characters and at most
    /// [`REVIEW_REASON_CHARS`] characters.
    pub reason: String,
    /// `provider/model` of the reviewer.
    pub model: String,
    /// The blocked category the reviewer named (a default category id or `custom`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// The longest reviewer reason kept, in Unicode characters (T46).
pub const REVIEW_REASON_CHARS: usize = 500;

/// A reviewer verdict that decided a call (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    /// The call ran.
    Allow,
    /// The call was refused.
    Deny,
}

/// Permission modes (architecture section 6.2.1). `dontAsk` (headless) is not available.
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
    /// Auto review (T46): Accept edits' defaults, and the reviewer model answers the calls that
    /// would otherwise ask the user in general; the rest still ask. Available after the user
    /// enables it in their own settings (`permissions.enableAutoMode`).
    Auto,
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
    /// `AskUserQuestion`'s form (`ui/ask`, T26): answered with `answers`.
    Question,
    /// A plan submitted with `ExitPlanMode` (T26): approved with the mode to continue in, or
    /// declined with feedback and comments to keep planning.
    Plan,
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
    /// The plan of a `plan` card (Markdown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// The questions of a `question` card.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<crate::harness::Question>,
    /// Set when a subagent made the call (T31): the card shows in its main session, which
    /// lists it with its own approvals; the answer goes to `session_id` (the subagent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<crate::subagent::ApprovalOrigin>,
    /// Where an approved command runs (T39): in the sandbox, or outside it at the model's
    /// request (`dangerouslyDisableSandbox`), which the card shows with the full command and
    /// answers only with `allowOnce` or `deny`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<CommandPlace>,
    /// The host a sandboxed command asks to reach outside the network allowlist (a
    /// `permissionExpansion` card for tool [`NETWORK_TOOL`], T39). `allowOnce` lets this
    /// connection through, `allowSession` the host for the session, `allowAlways` adds it to
    /// the user's allowlist; `deny` and no answer within the timeout refuse the connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// The user may allow this call from a system notification (T42): an ordinary command or
    /// file change short enough to read there. False for critical deletions, commands outside
    /// the sandbox, protected paths and anything longer; their notification only opens the card.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub notification_allow: bool,
    /// Auto mode (T46): the reviewer model is deciding the call (no answers are taken), or the
    /// card came back to the user and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ApprovalReview>,
}

/// The reviewer's part in a card (T46).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalReview {
    /// Reviewing, or back with the user.
    pub state: ReviewState,
    /// Why the card is the user's to answer (`fallback` only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<ReviewFallback>,
    /// The reviewer's reason when it was unsure, or what went wrong (truncated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `provider/model` of the reviewer, when one is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Where the review of a card stands (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    /// The reviewer model is deciding: the card takes no answer.
    Reviewing,
    /// The user answers the card.
    Fallback,
}

/// Why an Auto mode call came back to the user (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewFallback {
    /// The reviewer could not decide.
    Unsure,
    /// No answer within the review timeout.
    Timeout,
    /// The provider failed (errors, rate limits, authentication) after retries.
    ProviderError,
    /// The answer was not exactly one well-formed `record_review` call.
    Unparsable,
    /// The verdict was not one of the three values.
    InvalidVerdict,
    /// No usable reviewer model (not set, not in the catalog, no credentials, below the bar)
    /// or no running Agent Host.
    Unavailable,
    /// The mode changed while the reviewer worked.
    Discarded,
    /// Review is paused after consecutive refusals.
    PausedConsecutive,
    /// Review is paused after the session's total of refusals.
    PausedTotal,
}

/// The Auto mode state the session list shows (T46): absent unless the session is in Auto
/// mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutoReviewStatus {
    /// Ready, unavailable or paused.
    pub state: AutoReviewState,
    /// Why the reviewer is unavailable, or how review was paused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<AutoReviewReason>,
    /// `provider/model` of the reviewer, when one is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Whether review works in an Auto mode session (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutoReviewState {
    /// Calls that would ask go to the reviewer.
    Ready,
    /// They go to the user: the reviewer cannot be used.
    Unavailable,
    /// They go to the user until the user allows one or selects Auto mode again.
    Paused,
}

/// The detail of [`AutoReviewStatus`] (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutoReviewReason {
    /// `autoMode.model` is not set.
    NoModel,
    /// The model is not in the catalog, or the provider has no credentials.
    UnknownModel,
    /// The model does not meet the reviewer bar.
    BelowBar,
    /// The workspace's Agent Host is not running.
    HostDown,
    /// The settings turned Auto mode off while the session was in it (it continues in Manual
    /// mode).
    Disabled,
    /// Paused after consecutive refusals.
    Consecutive,
    /// Paused after the session's total of refusals.
    Total,
}

/// Where an answer was given (T42); absent: on the approval card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AnswerVia {
    /// A system notification's action: `allowOnce` (only on a card with
    /// `notificationAllow`) or `deny` without feedback.
    Notification,
}

/// The tool name of a network-domain card (T39): no tool call asks, the sandbox's proxy does.
pub const NETWORK_TOOL: &str = "SandboxNetwork";

/// Where an approved command runs (T39).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommandPlace {
    /// In the sandbox.
    Sandbox,
    /// Outside the sandbox, as the model asked.
    Unsandboxed,
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
    /// The host the native confirmation dialog showed for a network-domain card's
    /// `allowAlways` (T39): it must be the card's `domain`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// The mode an approved plan continues in: `acceptEdits` or `default`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PermissionMode>,
    /// Inline comments on a plan, returned to the model with a refusal (keep planning).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<crate::harness::PlanComment>,
    /// One answer per question of a `question` card, with `allowOnce`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<crate::harness::QuestionAnswer>,
    /// Where the user answered (T42); absent on the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<AnswerVia>,
}

crate::method::request!(
    /// Auto mode (T46, Core → Agent Host): ask the reviewer model about a call that would ask
    /// the user. The Agent Host adds the session's user messages and recent calls, makes one
    /// auxiliary call that must answer with the `record_review` tool, and returns the answer as
    /// given; Core checks it and decides.
    PolicyReview, "policy/review", PolicyReviewParams, PolicyReviewResult
);

/// Parameters of `policy/review`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyReviewParams {
    /// The session whose call it is (a subagent's own session).
    pub session_id: String,
    /// The call.
    pub tool_call_id: String,
    /// Canonical tool name.
    pub tool: String,
    /// The arguments the call would run with (after hooks).
    pub input: Map<String, Value>,
    /// Why the call would ask the user.
    pub why: String,
    /// The session's surroundings.
    pub environment: ReviewEnvironment,
    /// The user's review policy.
    pub policy: ReviewPolicy,
    /// The reviewer model.
    pub model: crate::session::ModelRef,
    /// The review's time limit; the model call ends with it.
    pub timeout_ms: u64,
}

/// Where the reviewed call runs (T46).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEnvironment {
    /// `macos`, `windows` or `linux`.
    pub platform: String,
    /// The workspace root, the home directory written `~`.
    pub workspace: String,
    /// The session's working directory, the home directory written `~`.
    pub cwd: String,
    /// The git remotes configured when the session was registered, without credentials.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remotes: Vec<GitRemote>,
    /// A command runs in the sandbox.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sandboxed: bool,
    /// For a subagent's call: its type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

/// A git remote as the review shows it (T46).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    /// The remote's name.
    pub name: String,
    /// Its fetch URL without user information.
    pub url: String,
}

/// The user's additions to the review (T46): `autoMode` of the user's settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPolicy {
    /// Trusted infrastructure.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<String>,
    /// Exceptions to the soft blocks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// Added soft blocks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub soft_deny: Vec<String>,
    /// Added hard blocks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hard_deny: Vec<String>,
}

/// Result of `policy/review`: the reviewer's answer as given, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyReviewResult {
    /// The arguments of the one `record_review` call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<ReviewAnswer>,
    /// Why there is no answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<ReviewFailure>,
    /// What went wrong, for the audit and the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `provider/model` that answered (or was asked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Tokens of the call.
    #[serde(default)]
    pub usage: ReviewUsage,
    /// SHA-256 (hex) of the system and user text sent to the model; empty when none was sent.
    #[serde(default)]
    pub input_hash: String,
    /// Characters of that text.
    #[serde(default)]
    pub input_chars: u64,
    /// The first 12 hex digits of the SHA-256 of the review prompt (its version).
    #[serde(default)]
    pub prompt_id: String,
}

/// The reviewer's `record_review` arguments as given (T46): Core checks them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnswer {
    /// Should be `allow`, `deny` or `unsure`.
    pub verdict: String,
    /// The reviewer's reason.
    pub reason: String,
    /// The category the reviewer named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// Why a review has no answer (T46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewFailure {
    /// The time limit passed.
    Timeout,
    /// The provider failed after retries.
    ProviderError,
    /// Not exactly one `record_review` call with JSON arguments, a verdict and a reason.
    Unparsable,
    /// The model is not in the catalog, has no credentials or is below the reviewer bar.
    UnknownModel,
    /// The model does not meet the reviewer bar.
    BelowBar,
    /// The call's turn was interrupted or its session closed.
    Cancelled,
}

/// Tokens of one review (T46).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUsage {
    /// Input tokens.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Cached input read.
    pub cache_read: u64,
    /// Cached input written.
    pub cache_write: u64,
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
