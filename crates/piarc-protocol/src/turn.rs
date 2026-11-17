//! Turns and items: the `turn/*` and `item/*` notifications (architecture section 5.3).
//!
//! A session runs turns: one user input, everything the agent does for it, until Pi settles.
//! A turn produces items (the user's input, agent messages, reasoning, tool calls,
//! compactions). Each item goes `item/started` → optional deltas (`item/agentMessage/delta`,
//! `item/reasoning/delta`) or updates (`item/updated`) → `item/completed`, identified by
//! `sessionId / turnId / itemId`. `turn/retrying` reports a model request retried after a
//! recoverable error; `turn/completed` carries the outcome and the turn's usage.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
        /// The text.
        text: String,
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
    },
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
            | Self::ContextCompaction { item_id, .. } => item_id,
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
            | Self::ContextCompaction { status, .. } => *status,
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
