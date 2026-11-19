//! Context engineering (architecture section 6.6, T27, ADR-0043): the system reminder channel,
//! files changed outside the session, the automatic compaction settings and context usage.
//! Everything here needs the handshake capability `context`.
//!
//! - `context/settings` (Agent Host → Core): the session's automatic compaction settings
//!   (`autoCompactEnabled`, `autoCompactWindow`), asked once per run.
//! - `fs/changes` (Agent Host → Core): files the session read or wrote whose content changed
//!   outside it since; each new version is reported once.
//! - `fs/forgetReads` (Agent Host → Core): after a compaction, the read ranges of the session's
//!   file state table are forgotten (hashes stay, so read-before-edit still holds).
//! - `session/usage` (Agent Host → Core): the context usage after each model response and each
//!   compaction; `session/getContextUsage` (Core → Agent Host) returns the latest.
//! - `session/remind` (Core → Agent Host): a `backgroundTask` reminder for the model's next
//!   request (the entry point T32's background tasks use).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{notification, request};
use crate::session::{SessionEventHeader, SessionId, SessionTarget};

/// What a system reminder tells the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReminderType {
    /// The task list has open tasks and has not been updated for a while.
    TodoStale,
    /// A file the session read changed outside it.
    FileModified,
    /// Plan mode turned on or off.
    PlanMode,
    /// A background task finished.
    BackgroundTask,
    /// Memory loaded after the system prompt: a subdirectory's memory file, a changed memory
    /// file, the date.
    MemoryLazyLoad,
    /// A conditional rule (`paths:`) matched a file the session touched.
    RulesMatched,
    /// Context a hook added (`additionalContext`, plain stdout, a Stop hook's reason).
    HookContext,
    /// State given back after a compaction: memory, the plan, the task list, invoked skills,
    /// recently used files.
    ContextRestore,
}

/// One reminder of a reminder message: its type and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRef {
    /// What it tells the model.
    #[serde(rename = "type")]
    pub kind: ReminderType,
    /// Where it came from: a file path, a hook event, a task.
    pub source: String,
}

/// Why automatic compaction stopped for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutoCompactStop {
    /// Three automatic compactions in a row failed (or were ineffective, the last failed).
    Failed,
    /// The context stayed at or above the threshold after compacting, three times in a row.
    Ineffective,
}

/// Whether the session compacts automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutoCompactState {
    /// It does.
    On,
    /// The settings turned it off (`autoCompactEnabled: false`).
    Off,
    /// It stopped after three failed or ineffective compactions; `/compact` still works.
    Stopped,
}

/// Where the context's total comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum UsageSource {
    /// PiArc's estimate (no provider report for the current context yet).
    Estimate,
    /// The input tokens the provider reported for the latest request.
    Provider,
}

/// The context by category, in tokens. The categories add up to the total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategories {
    /// The system prompt without its project context and skills index sections.
    pub system_prompt: u64,
    /// Definitions of the built-in and host tools.
    pub tools: u64,
    /// Definitions of MCP tools.
    pub mcp_tools: u64,
    /// Memory: the system prompt's project context and memory or rule reminders.
    pub memory: u64,
    /// The skills index and skill reminders.
    pub skills: u64,
    /// Messages: the user's, the model's, the compaction summary, other reminders.
    pub conversation: u64,
    /// Tool results.
    pub tool_results: u64,
    /// The provider's count minus the estimated categories.
    pub unclassified: u64,
}

/// How full the session's context is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// Tokens in the context: the sum of the categories.
    pub tokens: u64,
    /// The window the usage is measured against: the model's window or the user's
    /// automatic compaction window, whichever is smaller.
    pub context_window: u64,
    /// Automatic compaction runs when the context reaches this many tokens.
    pub auto_compact_threshold: u64,
    /// The context by category.
    pub categories: ContextCategories,
    /// Where the total comes from.
    pub source: UsageSource,
    /// Whether the session compacts automatically.
    pub auto_compact: AutoCompactState,
    /// Why automatic compaction stopped, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_stopped: Option<AutoCompactStop>,
}

/// Parameters of `session/usage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The context usage.
    pub usage: ContextUsage,
}

/// Parameters of `session/remind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemindParams {
    /// The session whose model hears it.
    pub session_id: SessionId,
    /// What it tells the model; only `backgroundTask` is accepted.
    #[serde(rename = "type")]
    pub kind: ReminderType,
    /// Where it came from (the task).
    pub source: String,
    /// The text for the model.
    pub text: String,
}

/// Result of `session/remind`: the reminder is queued for the next model request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemindResult {}

/// Parameters of `context/settings`, `fs/changes` and `fs/forgetReads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextSessionParams {
    /// The session asking.
    pub session_id: SessionId,
}

/// Result of `context/settings`: the merged settings of the session's workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextSettings {
    /// Whether the session compacts automatically (`autoCompactEnabled`, default true).
    pub auto_compact_enabled: bool,
    /// The automatic compaction window in tokens (`autoCompactWindow`, clamped to
    /// 100,000–1,000,000); absent: the model's window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_window: Option<u64>,
}

/// How a file changed outside the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExternalChange {
    /// Its content differs from what the session last saw.
    Modified,
    /// It no longer exists.
    Deleted,
}

/// A file that changed outside the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// The file's absolute path.
    pub path: String,
    /// How it changed.
    pub change: ExternalChange,
}

/// Result of `fs/changes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsChangesResult {
    /// Files changed since the session saw them (or since the last report), sorted by path.
    pub files: Vec<ChangedFile>,
}

/// Result of `fs/forgetReads`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsForgetReadsResult {
    /// Number of files whose read range was forgotten.
    pub files: u64,
}

notification!(
    /// Method marker for `session/usage` (Agent Host → Core).
    SessionUsage, "session/usage", SessionUsageParams
);
request!(
    /// Method marker for `session/getContextUsage` (Core → Agent Host).
    SessionGetContextUsage, "session/getContextUsage", SessionTarget, ContextUsage
);
request!(
    /// Method marker for `session/remind` (Core → Agent Host).
    SessionRemind, "session/remind", SessionRemindParams, SessionRemindResult
);
request!(
    /// Method marker for `context/settings` (Agent Host → Core).
    ContextSettingsGet, "context/settings", ContextSessionParams, ContextSettings
);
request!(
    /// Method marker for `fs/changes` (Agent Host → Core).
    FsChanges, "fs/changes", ContextSessionParams, FsChangesResult
);
request!(
    /// Method marker for `fs/forgetReads` (Agent Host → Core).
    FsForgetReads, "fs/forgetReads", ContextSessionParams, FsForgetReadsResult
);
