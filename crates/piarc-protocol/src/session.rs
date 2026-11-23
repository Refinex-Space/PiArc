//! Session event envelope.
//!
//! ADR-0009 describes every session event as `{sessionId, seq, ts, type, payload}`. On the
//! wire this is a JSON-RPC notification:
//!
//! - `type` is the JSON-RPC `method` (for example `turn/started`);
//! - `sessionId`, `seq` and `ts` are members of `params` ([`SessionEventHeader`]);
//! - `payload` is the rest of `params` (the method-specific fields).
//!
//! `seq` increases monotonically per session; Core detects gaps by it and backfills with
//! `session/getEntries(since)`.
//!
//! # Session requests (Core → Agent Host)
//!
//! - `session/create` opens a new session in a working directory; `session/resume` reopens
//!   one by id (Core uses it after an Agent Host restart, passing the last `seq` it received
//!   so numbering continues). Both answer with [`SessionOpened`].
//! - `session/prompt` starts a turn. Mentions and attachments travel beside the text
//!   ([`crate::input`]). The response ([`PromptAccepted`]) only acknowledges it: the turn's outcome arrives later as `turn/completed` with the same `turnId`. Its
//!   `requestId` is an idempotency key: the same key on the same session returns the turn
//!   it already started instead of starting another (ADR-0009 rule 5).
//! - `session/compact` compacts the conversation as a turn of its own (the user's `/compact`):
//!   it answers with the turn's id like `session/prompt`, and the turn reports the
//!   `contextCompaction` item. The session must be idle.
//! - `session/steer` and `session/followUp` add input to a running turn: a steering message
//!   reaches the model after the current step (before its next request), a follow-up starts a
//!   new turn once the current one completes. Both are queued items with ids that
//!   `session/queue/*` edits, deletes and reorders ([`crate::queue`]). On an idle session
//!   either starts a turn at once, like `session/prompt`.
//! - `session/abort` interrupts the running turn and answers once the session is idle; the
//!   queued items come back in the result and the queue is empty afterwards.
//!   `session/close` aborts, shuts the session down and forgets it.
//! - `session/fork` opens a new session whose conversation is a copy of another session's
//!   current branch, up to an entry when one is given.
//! - `session/getEntries` returns the session's notifications after a `seq` from the Agent
//!   Host's replay buffer (Core backfills a gap with it); `session/history` returns the
//!   persisted conversation as items, projected by the same rules as the live notifications
//!   ([`crate::history`]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::input::{InputAttachment, InputMention};
use crate::jsonrpc::Version;
use crate::method::request;
use crate::queue::QueueItem;
use crate::turn::TurnId;

/// Session identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct SessionId(pub String);

/// Members every session notification carries in `params`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventHeader {
    /// The session the event belongs to.
    pub session_id: SessionId,
    /// Sequence number, monotonically increasing within the session.
    pub seq: u64,
    /// Time the event was produced, in milliseconds since the Unix epoch (UTC).
    pub ts: u64,
}

/// Any session notification, read without interpreting its method: header plus payload.
/// Core uses it to track `seq` for every session event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventNotification {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// The event type, for example `item/completed`.
    pub method: String,
    /// Header and payload.
    pub params: SessionEventParams,
}

/// `params` of a session notification: the header plus the method-specific payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEventParams {
    /// `sessionId`, `seq` and `ts`.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// Every other member of `params`.
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

/// Selects a model by provider id and model id, for example `anthropic` / `claude-opus-5-5`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    /// Provider id.
    pub provider: String,
    /// Model id within the provider.
    pub id: String,
}

/// Parameters of `session/create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    /// Absolute working directory of the session: tools resolve relative paths against it.
    pub cwd: String,
    /// The new session's id, chosen by Core so that a timed-out request can still be
    /// reconciled (closed or resumed) under a known id; the Agent Host chooses one when
    /// absent. Letters, digits, `.`, `_` and `-`, at most 128 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    /// Model to start with; the Agent Host's configured default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// The settings' default model when `model` is absent (T31, Claude Code's `model` key):
    /// `<provider>/<model id>`, or a model id the Agent Host looks up among the configured
    /// models; an alias was already resolved by Core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// The settings' default effort (T31, `effortLevel`), applied when the model supports it
    /// and the user set no default for that model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<crate::models::EffortLevel>,
}

impl SessionCreateParams {
    /// A session in `cwd` with the Agent Host's choice of id and model.
    #[must_use]
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            session_id: None,
            model: None,
            default_model: None,
            default_effort: None,
        }
    }

    /// The same, starting with `model`.
    #[must_use]
    pub fn with_model(mut self, model: Option<ModelRef>) -> Self {
        self.model = model;
        self
    }
}

/// Parameters of `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeParams {
    /// The session to reopen.
    pub session_id: SessionId,
    /// Its working directory, as given to `session/create`.
    pub cwd: String,
    /// The last `seq` Core received for this session; the session's notifications continue
    /// from the next number, so `seq` keeps increasing across Agent Host restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<u64>,
}

/// Result of `session/create` and `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    /// The session's id: new for `session/create`, the requested one for `session/resume`.
    pub session_id: SessionId,
    /// Number of conversation messages restored from the session file (0 for a new session).
    pub restored_messages: u64,
    /// Last mode explicitly selected on this session branch, when one was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<crate::policy::PermissionMode>,
}

/// Parameters of `session/close` and `session/abort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    /// The session to act on.
    pub session_id: SessionId,
}

/// Result of `session/close` and `session/abort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStopped {
    /// The session acted on.
    pub session_id: SessionId,
    /// The turn that was running and got interrupted, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_turn_id: Option<TurnId>,
    /// The inputs that were still queued, in queue order: they did not run and the client can
    /// offer them for editing again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub returned_queue: Vec<QueueItem>,
}

/// Parameters of `session/fork`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkParams {
    /// The session to copy.
    pub session_id: SessionId,
    /// Its working directory, which the new session shares.
    pub cwd: String,
    /// The last entry to keep; the source's current position when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// Instead of `entryId`: keep the conversation up to where this turn of the current
    /// branch started (capability `checkpoints`, T28).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_turn: Option<crate::turn::TurnId>,
}

/// Parameters of `session/steer` and `session/followUp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInputParams {
    /// The session.
    pub session_id: SessionId,
    /// Idempotency key chosen by Core; repeating it returns the first answer.
    pub request_id: String,
    /// The user's input.
    pub text: String,
    /// The files the text mentions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<InputMention>,
    /// Images and PDFs, by reference.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<InputAttachment>,
    /// Context `UserPromptSubmit` hooks added for the model (`additionalContext`, plain
    /// stdout), already bounded; delivered with this input and not shown in the transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_context: Option<String>,
    /// The slash command Core expanded into `text` (T37, capability `skills`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<crate::skills::PromptCommand>,
}

/// Result of `session/steer` and `session/followUp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "disposition",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InputAccepted {
    /// A turn was running: the input waits in the queue under `itemId`.
    Queued {
        /// The queued item.
        item_id: String,
    },
    /// The session was idle: the input started turn `turnId`, as a prompt would.
    Started {
        /// The new turn.
        turn_id: TurnId,
    },
}

/// Parameters of `session/prompt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    /// The session to prompt.
    pub session_id: SessionId,
    /// Idempotency key chosen by Core; repeating it returns the turn already started.
    pub request_id: String,
    /// The user's input.
    pub text: String,
    /// The files the text mentions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<InputMention>,
    /// Images and PDFs, by reference.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<InputAttachment>,
    /// Context `UserPromptSubmit` hooks added for the model (`additionalContext`, plain
    /// stdout), already bounded; delivered with this input and not shown in the transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_context: Option<String>,
    /// The slash command Core expanded into `text` (T37, capability `skills`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<crate::skills::PromptCommand>,
}

/// One question in a panel's ephemeral conversation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideChatAskParams {
    /// Parent conversation.
    pub session_id: SessionId,
    /// Distinct panel lifetime, including across windows.
    pub panel_id: String,
    /// User's question.
    pub text: String,
}

/// Discard the panel or just stop its current answer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideChatControlParams {
    /// Parent conversation.
    pub session_id: SessionId,
    /// The panel to control.
    pub panel_id: String,
    /// True to dispose of the conversation.
    pub close: bool,
}

/// Tokens billed to a side conversation, separately from the parent's JSONL.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideChatUsage {
    /// Session model.
    pub model: ModelRef,
    /// Fresh input tokens.
    #[schemars(with = "u64")]
    pub input: u32,
    /// Output tokens.
    #[schemars(with = "u64")]
    pub output: u32,
    /// Cached input tokens read.
    #[schemars(with = "u64")]
    pub cache_read: u32,
    /// Cache-write tokens.
    #[schemars(with = "u64")]
    pub cache_write: u32,
    /// One-hour writes, contained in cache_write.
    #[schemars(with = "u64")]
    pub cache_write_1h: u32,
    /// Reasoning tokens, contained in output.
    #[schemars(with = "u64")]
    pub reasoning: u32,
}

/// Answer and accounting of the question, including partial answers on stop.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideChatAnswer {
    /// Text suitable for the panel.
    pub text: String,
    /// User stopped the answer.
    pub stopped: bool,
    /// One entry per request with provider usage.
    pub usage: Vec<SideChatUsage>,
    /// Provider failure after zero or more billable steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

request!(
    /// Ask in a temporary side session (Core → Agent Host).
    SideChatAsk, "session/sideChatAsk", SideChatAskParams, SideChatAnswer
);
/// The requested panel has been stopped or closed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SideChatControlled {}

request!(
    /// Stop or dispose of a side session (Core → Agent Host).
    SideChatControl, "session/sideChatControl", SideChatControlParams, SideChatControlled
);

/// Parameters of `session/compact`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompactParams {
    /// The session to compact.
    pub session_id: SessionId,
    /// Idempotency key chosen by Core; repeating it returns the turn already started.
    pub request_id: String,
    /// What the summary should focus on (`/compact <focus>`), passed to the summary request
    /// as written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

/// Result of `session/prompt`: the turn was accepted and will report `turn/started` and
/// `turn/completed` with this id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptAccepted {
    /// The turn running the prompt.
    pub turn_id: TurnId,
}

request!(
    /// Method marker for `session/create` (Core → Agent Host).
    SessionCreate, "session/create", SessionCreateParams, SessionOpened
);
request!(
    /// Method marker for `session/resume` (Core → Agent Host).
    SessionResume, "session/resume", SessionResumeParams, SessionOpened
);
request!(
    /// Method marker for `session/close` (Core → Agent Host).
    SessionClose, "session/close", SessionTarget, SessionStopped
);
request!(
    /// Method marker for `session/abort` (Core → Agent Host).
    SessionAbort, "session/abort", SessionTarget, SessionStopped
);
request!(
    /// Method marker for `session/prompt` (Core → Agent Host).
    SessionPrompt, "session/prompt", SessionPromptParams, PromptAccepted
);
request!(
    /// Method marker for `session/compact` (Core → Agent Host).
    SessionCompact, "session/compact", SessionCompactParams, PromptAccepted
);
request!(
    /// Method marker for `session/fork` (Core → Agent Host).
    SessionFork, "session/fork", SessionForkParams, SessionOpened
);
request!(
    /// Method marker for `session/steer` (Core → Agent Host).
    SessionSteer, "session/steer", SessionInputParams, InputAccepted
);
request!(
    /// Method marker for `session/followUp` (Core → Agent Host).
    SessionFollowUp, "session/followUp", SessionInputParams, InputAccepted
);

/// The user's selected permission mode for this session.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetPermissionModeParams {
    /// Session whose branch records the change.
    pub session_id: SessionId,
    /// The new mode.
    pub mode: crate::policy::PermissionMode,
}

/// Acknowledgement that the mode entry is in the session.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetPermissionModeResult {}

request!(
    /// Record a mode change, publish its item and acknowledge it.
    SessionSetPermissionMode, "session/setPermissionMode", SetPermissionModeParams, SetPermissionModeResult
);

/// Lookup during recovery for each incomplete tool call in the last model response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRecoverParams {
    /// Session being resumed.
    pub session_id: SessionId,
    /// The call whose result is missing.
    pub tool_call_id: String,
}

/// An invalidated approval's reason, absent for ordinary interruptions.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PolicyRecoverResult {
    /// The error result the restored conversation must give the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

request!(
    /// Look up a pending approval invalidated by a lost connection.
    PolicyRecover, "policy/recover", PolicyRecoverParams, PolicyRecoverResult
);
