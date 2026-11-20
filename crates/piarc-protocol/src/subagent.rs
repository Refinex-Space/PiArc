//! Subagents (architecture section 6.4, T31, ADR-0048): child sessions the `Agent` tool runs in
//! the same Agent Host, each with its own context, tools and model. Needs the handshake
//! capability `subagents`.
//!
//! - `agents/list` (Agent Host → Core): the subagent definitions found from a directory
//!   (project `.piarc/agents/` and `.claude/agents/` from the directory upward, the user's
//!   PiArc `agents/`, `~/.claude/agents/`), merged by name, with the limits from the settings.
//!   Core reads the files: it owns the home directory and project trust.
//! - `resources/listAgents` (Core → Agent Host): the definitions above plus the built-in types,
//!   with the model each one resolves to; the settings window lists them.
//! - `subagent/start` (Agent Host → Core): registers a child session before it runs, so its
//!   file and command I/O, permission checks, approvals, hooks and checkpoints know its parent.
//! - `subagent/finish` (Agent Host → Core): the child ended; Core drops what it registered.
//! - `subagent/stop` (Core → Agent Host): the user stopped a running subagent.
//! - `subagent/started`, `subagent/progress`, `subagent/completed` (Agent Host → Core, session
//!   notifications of the parent): the state the client's subagent card shows.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{notification, request};
use crate::models::{EffortLevel, ModelAlias};
use crate::policy::PermissionMode;
use crate::session::{ModelRef, SessionEventHeader};
use crate::turn::{ItemId, TurnUsage};

/// Where a subagent definition came from, highest precedence first (ADR-0005).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AgentSource {
    /// `.piarc/agents/` of the directory or one above it.
    ProjectPiarc,
    /// `.claude/agents/` of the directory or one above it.
    ProjectClaude,
    /// `agents/` in PiArc's data directory.
    User,
    /// `~/.claude/agents/`.
    UserClaude,
    /// A plugin's `agents/` (T40).
    Plugin,
    /// Shipped with PiArc: `general-purpose`, `Explore`, `Plan`.
    BuiltIn,
}

/// Something about a definition the user should know; the client words it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AgentWarningKind {
    /// A frontmatter field PiArc does not support; it is ignored (`field`).
    IgnoredField,
    /// A field PiArc reads but does not apply yet (`field`, `task`).
    InactiveField,
    /// A project definition's `bypassPermissions` or `auto` does not apply (`value`).
    ProjectModeIgnored,
    /// A permission mode PiArc does not have (`value`); the parent's mode applies.
    UnsupportedMode,
    /// The mode is looser than the parent session's; the parent's applies (`value`).
    ModeClamped,
    /// The definition's hooks do not run: the project is not trusted.
    HooksUntrusted,
    /// The model alias is not set or its model is unavailable; the parent's model is used
    /// (`value` is the alias).
    AliasFallback,
    /// The model does not support the effort (`value`); its default effort is used.
    EffortUnsupported,
}

/// One warning about a definition or a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentWarning {
    /// What it is about.
    pub kind: AgentWarningKind,
    /// The frontmatter field concerned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// The value concerned (a mode, an alias, an effort).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The task that makes an inactive field work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

/// A definition file that could not be read as one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentIssue {
    /// The file.
    pub path: String,
    /// Its line (1-based), when the problem has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    /// What is wrong.
    pub message: String,
}

/// A subagent type: a definition file's frontmatter and body, or a built-in type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// The type's name (`subagent_type`).
    pub name: String,
    /// When to use it, as the model reads it.
    pub description: String,
    /// Where it came from.
    pub source: AgentSource,
    /// Its file; absent for built-in types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The body: the subagent's identity in its system prompt.
    pub prompt: String,
    /// Tools it may use (canonical names, `Tool(specifier)` reduced to the tool); absent: all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    /// Tools it may not use.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disallowed_tools: Vec<String>,
    /// `inherit`, an alias or `<provider>/<model id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The permission mode it asks for, after the project restriction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Model responses before it stops with a partial result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u64>,
    /// Skills to preload (T37).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// MCP servers it names or defines (T36): their names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<String>,
    /// Whether it defines hooks for its runs.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hooks: bool,
    /// `worktree` (T35).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    /// Always runs in the background.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// Effort it runs with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
    /// Display color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Built-in context choice: no memory files and no git status (`Explore`, `Plan`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub omit_project_context: bool,
    /// Files of lower precedence with the same name, which this one replaces.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<String>,
    /// Ignored and inactive fields, restricted modes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<AgentWarning>,
    /// An `Agent(<name>)` deny rule removes it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub denied: bool,
    /// The model it resolves to for the workspace's default model (`resources/listAgents`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<ModelRef>,
}

/// Depth and concurrency limits (settings `subagents.maxDepth`, `subagents.maxConcurrent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLimits {
    /// Levels below the main session; a subagent at this level has no `Agent` tool.
    pub max_depth: u64,
    /// Subagents running at once in one main session and all its descendants.
    pub max_concurrent: u64,
}

/// Parameters of `agents/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentsListParams {
    /// The directory project definitions are looked up from; inside the connection's
    /// workspace.
    pub cwd: String,
}

/// Result of `agents/list` and `resources/listAgents`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentsList {
    /// The definitions in effect, by name.
    pub agents: Vec<AgentDefinition>,
    /// Files that are not valid definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<AgentIssue>,
    /// The limits that apply.
    pub limits: SubagentLimits,
    /// The model alias table (alias → `<provider>/<model id>`), as `resources/listAgents`
    /// resolved it.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub aliases: BTreeMap<ModelAlias, String>,
}

request!(
    /// Method marker for `agents/list` (Agent Host → Core).
    AgentsListMethod, "agents/list", AgentsListParams, AgentsList
);

/// Parameters of `resources/listAgents`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesListAgentsParams {
    /// The directory to look up from; the workspace root when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

request!(
    /// Method marker for `resources/listAgents` (Core → Agent Host).
    ResourcesListAgents, "resources/listAgents", ResourcesListAgentsParams, AgentsList
);

/// Parameters of `subagent/start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStartParams {
    /// The child session's id.
    pub session_id: String,
    /// The session whose `Agent` call starts it (a main session or another subagent).
    pub parent_session_id: String,
    /// The `Agent` call in the parent.
    pub tool_call_id: String,
    /// The subagent type.
    pub agent_type: String,
    /// The task description the model gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The child's working directory (the parent's).
    pub cwd: String,
    /// The child's session file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    /// The model it runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// Whether it runs in the background.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
}

/// Result of `subagent/start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStartResult {
    /// The child's permission mode now: the definition's, never looser than the parent's.
    pub permission_mode: PermissionMode,
    /// What the user should know about the run (a restricted mode, untrusted hooks).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<AgentWarning>,
}

request!(
    /// Method marker for `subagent/start` (Agent Host → Core).
    SubagentStart, "subagent/start", SubagentStartParams, SubagentStartResult
);

/// Where a subagent run stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    /// Running.
    Running,
    /// Finished with a final report.
    Completed,
    /// Stopped at `maxTurns`: the report is what it had.
    Partial,
    /// Ended with an error.
    Failed,
    /// Stopped by an interrupt, the stop button, the parent closing or the Agent Host ending.
    Interrupted,
}

/// Parameters of `subagent/finish`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFinishParams {
    /// The child session.
    pub session_id: String,
    /// How it ended.
    pub status: SubagentStatus,
    /// Its token use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
}

/// Result of `subagent/finish`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFinishResult {}

request!(
    /// Method marker for `subagent/finish` (Agent Host → Core).
    SubagentFinish, "subagent/finish", SubagentFinishParams, SubagentFinishResult
);

/// Parameters of `subagent/stop`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStopParams {
    /// The child session.
    pub session_id: String,
}

/// Result of `subagent/stop`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStopResult {
    /// Whether it was still running.
    pub stopped: bool,
}

request!(
    /// Method marker for `subagent/stop` (Core → Agent Host).
    SubagentStop, "subagent/stop", SubagentStopParams, SubagentStopResult
);

/// Tokens a subagent used, summed over its model responses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTokens {
    /// Input tokens, excluding cache reads and writes.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Tokens read from the prompt cache.
    pub cache_read: u64,
    /// Tokens written to the prompt cache.
    pub cache_write: u64,
}

/// What the subagent card shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentState {
    /// The child session.
    pub session_id: String,
    /// The subagent type.
    pub agent_type: String,
    /// The task description the model gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The type's display color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The model it runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// The effort it runs with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
    /// Where it stands.
    pub status: SubagentStatus,
    /// Runs in the background.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// Unix ms it started.
    pub started_at: u64,
    /// How long it ran, once it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Tool calls it made.
    pub tool_calls: u64,
    /// Its token use so far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<SubagentTokens>,
    /// What it is doing now (its latest tool call or text), while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// Its session file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// Why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Ignored fields, fallbacks and restricted modes of this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<AgentWarning>,
}

/// Parameters of `subagent/started`, `subagent/progress` and `subagent/completed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentEventParams {
    /// Session event header (the parent session).
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The parent's `Agent` call (its `subagent` item).
    pub item_id: ItemId,
    /// The run's state.
    pub subagent: SubagentState,
}

notification!(
    /// Method marker for `subagent/started` (Agent Host → Core).
    SubagentStarted, "subagent/started", SubagentEventParams
);

notification!(
    /// Method marker for `subagent/progress` (Agent Host → Core).
    SubagentProgress, "subagent/progress", SubagentEventParams
);

notification!(
    /// Method marker for `subagent/completed` (Agent Host → Core).
    SubagentCompleted, "subagent/completed", SubagentEventParams
);

/// Where an approval of a subagent's call comes from: shown on the card in the main session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOrigin {
    /// The subagent's session, which made the call.
    pub session_id: String,
    /// The session that started it.
    pub parent_session_id: String,
    /// Its type.
    pub agent_type: String,
    /// The task description the model gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
