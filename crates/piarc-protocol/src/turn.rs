//! Turns and items: the `turn/*` and `item/*` notifications (architecture section 5.3).
//!
//! A session runs turns: one user input, everything the agent does for it, until Pi settles.
//! A turn produces items (the user's input, agent messages, reasoning, tool calls,
//! compactions). Each item goes `item/started` → optional deltas (`item/agentMessage/delta`,
//! `item/reasoning/delta`) or updates (`item/updated`) → `item/completed`, identified by
//! `sessionId / turnId / itemId`. `turn/retrying` reports a model request retried after a
//! recoverable error; `turn/usage` the turn's token use after each model response;
//! `turn/completed` carries the outcome (with the kind of failure) and the turn's usage.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::diff::FileDiff;
use crate::exec::{CommandOutcome, CwdReset};
use crate::input::{InputAttachment, InputMention};
use crate::method::notification;
use crate::session::SessionEventHeader;

/// Turn identifier, unique within a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct TurnId(pub String);

/// Item identifier, unique within a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ItemId(pub String);

/// Lifecycle state of an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    /// Started and not finished yet.
    InProgress,
    /// Finished successfully.
    Completed,
    /// Finished with an error.
    Failed,
    /// Rejected by the user or by policy before it ran.
    Declined,
    /// Stopped because the turn was aborted.
    Interrupted,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    /// The turn ran to completion.
    Completed,
    /// The turn ended with an error.
    Failed,
    /// The turn was aborted.
    Interrupted,
}

/// What kind of failure ended a turn, as the client groups errors (architecture section 8.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnErrorKind {
    /// The provider refused the credentials, or none are configured.
    Auth,
    /// The provider's rate limit, still hit after the automatic retries; or a usage quota.
    RateLimit,
    /// The provider was overloaded or failed on its side, after the automatic retries.
    Provider,
    /// The provider could not be reached: network, DNS, proxy or timeout.
    Network,
    /// The conversation does not fit the model's context window.
    ContextOverflow,
    /// The provider rejected the request itself (an invalid parameter, an unsupported input).
    InvalidRequest,
    /// Anything else, including failures inside PiArc or Pi.
    Internal,
}

/// Why a compaction ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CompactionReason {
    /// The user asked for it.
    Manual,
    /// The context crossed the automatic compaction threshold.
    Threshold,
    /// The model rejected the context as too long; the turn continues after compaction.
    Overflow,
    /// The user summarized the conversation from a message on (rewind's "summarize from here",
    /// capability `checkpoints`, T28).
    Rewind,
}

/// An item in its current state, discriminated by the `type` member. Every variant carries
/// `itemId` and `status`.
///
/// Tool calls are items too: the Agent Host maps each canonical tool name to one of the tool
/// item types (architecture section 5.3) and every tool item carries the canonical `tool`
/// name, the `arguments` the model gave and, once known, the `output` text the model sees
/// (bounded; longer text keeps its end and starts with a truncation note). Whether a tool
/// call succeeded comes from the tool layer's own result, never from an exit code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    /// Input the user gave: the prompt that started the turn, or a steering or follow-up
    /// message when the model receives it.
    UserMessage {
        /// The item's identifier.
        item_id: ItemId,
        /// Lifecycle state (always `completed`).
        status: ItemStatus,
        /// The text the user wrote (mentions spelled `@<path>`); the text of attached PDFs
        /// that the model also received is not part of it.
        text: String,
        /// The files the text mentions.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mentions: Vec<InputMention>,
        /// The images and PDFs the user attached.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<InputAttachment>,
        /// The slash command the text invoked (T37): `text` is what the user typed, the model
        /// received the command's expansion.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<crate::skills::PromptCommand>,
    },
    /// Text produced by the agent.
    AgentMessage {
        /// The item's identifier: `<messageId>#<contentIndex>`.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// The message text accumulated so far (complete in `item/completed`).
        text: String,
    },
    /// The model's visible reasoning (thinking).
    Reasoning {
        /// The item's identifier: `<messageId>#<contentIndex>`.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// The reasoning text accumulated so far (complete in `item/completed`).
        text: String,
    },
    /// A shell command (`Bash`, `PowerShell`).
    CommandExecution {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The command line.
        command: String,
        /// The output the model sees: so far in `item/updated`, final in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// How the command ran, in `item/completed` of a command Core ran (the bash card).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution: Option<CommandExecutionInfo>,
    },
    /// A file write or edit (`Write`, `Edit`, `NotebookEdit`). The structured diff arrives
    /// with the file tools of T16.
    FileChange {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The file, as the model named it.
        path: String,
        /// The text the tool returned, in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// The change Core made, in `item/completed` of a call that changed the file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<FileDiff>,
    },
    /// A tool of an MCP server (`mcp__<server>__<tool>`).
    McpToolCall {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The MCP server's name.
        server: String,
        /// The tool's name on the server.
        server_tool: String,
        /// The text the tool returned, in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    /// A subagent run (`Agent`).
    Subagent {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The task description the model gave, when it gave one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        /// The subagent's final answer, in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// The run's state (T31): in `item/updated` while it runs, at the end, and in the
        /// history (a background run's last state).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<crate::subagent::SubagentState>,
    },
    /// A web page fetch (`WebFetch`).
    WebFetch {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The address.
        url: String,
        /// The text the tool returned, in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    /// A tool call without a specialised item type.
    DynamicToolCall {
        /// The item's identifier: the tool call id.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// Canonical tool name.
        tool: String,
        /// The arguments the tool was called with.
        arguments: Map<String, Value>,
        /// The text the tool returned, in `item/completed`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    /// A permission mode selected by the user on this branch.
    PermissionModeChanged {
        /// The custom entry id in the session file.
        item_id: ItemId,
        /// Completed once the change was recorded.
        status: ItemStatus,
        /// The selected mode.
        mode: crate::policy::PermissionMode,
    },
    /// The conversation was compacted: older messages were replaced by a summary.
    ContextCompaction {
        /// The item's identifier.
        item_id: ItemId,
        /// Lifecycle state: `completed`, or `failed` / `interrupted` when no summary replaced
        /// the context.
        status: ItemStatus,
        /// Why it ran; absent in the history, where Pi does not record it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<CompactionReason>,
        /// Estimated context tokens before, once known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens_before: Option<u64>,
        /// Estimated context tokens after, once known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens_after: Option<u64>,
        /// What went wrong, when it failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        /// Set on the automatic compaction after which the session stopped compacting
        /// automatically, and why (ADR-0043).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auto_compact_stopped: Option<crate::context::AutoCompactStop>,
    },
    /// A system reminder the model received (ADR-0043): runtime notices appended to the
    /// conversation. Clients do not show it by default.
    Reminder {
        /// The custom entry id in the session file (the history) or a generated id (live).
        item_id: ItemId,
        /// Always `completed`.
        status: ItemStatus,
        /// The reminders of the message, in order.
        reminders: Vec<crate::context::ReminderRef>,
        /// The text the model received.
        text: String,
    },
}

/// How a shell command ran: what the client shows on its card, as Core reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionInfo {
    /// The directory the command ran in.
    pub cwd: String,
    /// The exit code, when the command exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The terminating signal number on Unix, when a signal ended the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    /// Whether it succeeded, judged by what its exit code means.
    pub outcome: CommandOutcome,
    /// What a non-zero exit code of a successful command means (`no matches`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meaning: Option<String>,
    /// How long it ran, in milliseconds.
    pub duration_ms: u64,
    /// Whether it was stopped because its timeout passed.
    pub timed_out: bool,
    /// The timeout it ran with, in milliseconds.
    pub timeout_ms: u64,
    /// Whether the model got only part of the output.
    pub truncated: bool,
    /// The file holding the full output, when it was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    /// The next command starts somewhere else, and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_reset: Option<CwdReset>,
    /// The background task the command became (T32); the exit fields are then absent and
    /// `durationMs` is how long it ran in the foreground.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<crate::tasks::TaskStarted>,
}

impl Item {
    /// The item's identifier.
    #[must_use]
    pub fn item_id(&self) -> &ItemId {
        match self {
            Self::UserMessage { item_id, .. }
            | Self::AgentMessage { item_id, .. }
            | Self::Reasoning { item_id, .. }
            | Self::CommandExecution { item_id, .. }
            | Self::FileChange { item_id, .. }
            | Self::McpToolCall { item_id, .. }
            | Self::Subagent { item_id, .. }
            | Self::WebFetch { item_id, .. }
            | Self::DynamicToolCall { item_id, .. }
            | Self::PermissionModeChanged { item_id, .. }
            | Self::ContextCompaction { item_id, .. }
            | Self::Reminder { item_id, .. } => item_id,
        }
    }

    /// The item's lifecycle state.
    #[must_use]
    pub fn status(&self) -> ItemStatus {
        match self {
            Self::UserMessage { status, .. }
            | Self::AgentMessage { status, .. }
            | Self::Reasoning { status, .. }
            | Self::CommandExecution { status, .. }
            | Self::FileChange { status, .. }
            | Self::McpToolCall { status, .. }
            | Self::Subagent { status, .. }
            | Self::WebFetch { status, .. }
            | Self::DynamicToolCall { status, .. }
            | Self::PermissionModeChanged { status, .. }
            | Self::ContextCompaction { status, .. }
            | Self::Reminder { status, .. } => *status,
        }
    }
}

/// Token use and cost of a turn: the sum over the model responses it received.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    /// Input tokens, excluding cache reads and writes.
    pub input_tokens: u64,
    /// Output tokens.
    pub output_tokens: u64,
    /// Tokens read from the prompt cache.
    pub cache_read_tokens: u64,
    /// Tokens written to the prompt cache.
    pub cache_write_tokens: u64,
    /// Cost in US dollars, from the model catalog's prices.
    pub cost: f64,
}

/// Parameters of `turn/started`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn that started.
    pub turn_id: TurnId,
}

/// Parameters of `turn/completed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn that ended.
    pub turn_id: TurnId,
    /// How it ended.
    pub status: TurnStatus,
    /// What went wrong, when `status` is `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// The kind of failure, when `status` is `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<TurnErrorKind>,
    /// Whether sending the same input again may succeed without the user changing anything,
    /// when `status` is `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    /// Token use and cost of the turn's model responses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
}

/// Parameters of `turn/retrying`: a model request failed with a recoverable error (rate
/// limit, overload, server error) and is retried after `delayMs`. The failed attempt never
/// reaches the model's context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnRetryingParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn being retried.
    pub turn_id: TurnId,
    /// The retry about to happen, from 1.
    pub attempt: u64,
    /// The most retries the turn makes.
    pub max_attempts: u64,
    /// Wait before the retry, in milliseconds.
    pub delay_ms: u64,
    /// The error of the failed attempt.
    pub error_message: String,
}

/// Parameters of `turn/usage`: the turn's token use so far, after each model response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsageParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The running turn.
    pub turn_id: TurnId,
    /// The sum over the responses received so far.
    pub usage: TurnUsage,
}

/// Parameters of `item/started`, `item/updated` and `item/completed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemEventParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn the item belongs to.
    pub turn_id: TurnId,
    /// The item's state: `inProgress` when started and updated, final when completed.
    pub item: Item,
}

/// Parameters of `item/agentMessage/delta` and `item/reasoning/delta`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeltaParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn the item belongs to.
    pub turn_id: TurnId,
    /// The `agentMessage` or `reasoning` item being extended.
    pub item_id: ItemId,
    /// Text to append.
    pub delta: String,
}

notification!(
    /// Method marker for `turn/started` (Agent Host → Core).
    TurnStarted, "turn/started", TurnStartedParams
);
notification!(
    /// Method marker for `turn/completed` (Agent Host → Core).
    TurnCompleted, "turn/completed", TurnCompletedParams
);
notification!(
    /// Method marker for `item/started` (Agent Host → Core).
    ItemStarted, "item/started", ItemEventParams
);
notification!(
    /// Method marker for `item/completed` (Agent Host → Core).
    ItemCompleted, "item/completed", ItemEventParams
);
notification!(
    /// Method marker for `item/updated` (Agent Host → Core): a tool item's progress.
    ItemUpdated, "item/updated", ItemEventParams
);
notification!(
    /// Method marker for `item/agentMessage/delta` (Agent Host → Core).
    ItemAgentMessageDelta, "item/agentMessage/delta", ItemDeltaParams
);
notification!(
    /// Method marker for `item/reasoning/delta` (Agent Host → Core).
    ItemReasoningDelta, "item/reasoning/delta", ItemDeltaParams
);
notification!(
    /// Method marker for `turn/retrying` (Agent Host → Core).
    TurnRetrying, "turn/retrying", TurnRetryingParams
);
notification!(
    /// Method marker for `turn/usage` (Agent Host → Core).
    TurnUsageReport, "turn/usage", TurnUsageParams
);
