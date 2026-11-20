//! Background tasks (architecture section 6.11, T32, ADR-0049): background commands, background
//! subagents and Monitor commands, held by Core's task manager. Needs the handshake capability
//! `backgroundTasks`.
//!
//! - `exec/run` with `background: true` starts a command as a task and answers at once; a
//!   foreground command that reaches its timeout becomes a task without being restarted. Either
//!   way the result's `task` names it ([`TaskStarted`]).
//! - `exec/monitor` (Agent Host → Core): runs a command as a task whose new output lines reach
//!   the session's model as `monitorOutput` reminders.
//! - `exec/background/list` (Agent Host → Core): the session's tasks and its subagents'.
//! - `exec/background/read` (Agent Host → Core): a byte range of a task's output file.
//! - `exec/background/kill` (Agent Host → Core): stops a task of the session (or of one of its
//!   subagents) with its whole process tree; the `KillShell` tool.
//! - Core API: the `core/tasks` snapshot (`{ revision, tasks }`), `readTaskOutput`, `stopTask`.
//!
//! A task's output file lives under `<data dir>/sessions/<main session id>/tasks/`; the
//! session's tools read it without asking.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::exec::CommandOutcome;
use crate::method::request;
use crate::session::SessionId;
use crate::tool_call::ToolOrigin;

/// What a task runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// A shell command started in the background or moved there by its timeout.
    Command,
    /// A background subagent (the `Agent` tool's `run_in_background`).
    Subagent,
    /// A `Monitor` command: its new output lines reach the model.
    Monitor,
}

/// Where a task stands. Every status but `running` is final.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    /// Still running.
    Running,
    /// Ended and did what it was asked (judged by what its exit code means).
    Completed,
    /// Ended unsuccessfully, or a Monitor reached its timeout.
    Failed,
    /// Stopped by `KillShell`, the stop button, or its session being archived or deleted.
    Killed,
    /// Stopped because PiArc quit (or the Agent Host running a subagent ended).
    Interrupted,
}

/// One background task as the task manager knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    /// Its id (`bg-` and 12 hexadecimal digits).
    pub task_id: String,
    /// The session that started it.
    pub session_id: String,
    /// The main session it belongs to: `sessionId`, or the main session of the subagent that
    /// started it.
    pub owner_session_id: String,
    /// The workspace of the session.
    pub workspace: String,
    /// What it runs.
    pub kind: TaskKind,
    /// What the panel calls it: the command, the Monitor's description, the subagent's task.
    pub title: String,
    /// The command line (`command` and `monitor`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The subagent type (`subagent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The subagent's own session (`subagent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_session_id: Option<String>,
    /// The tool call that started it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// The working directory.
    pub cwd: String,
    /// Where it stands.
    pub status: TaskStatus,
    /// When it started, Unix milliseconds.
    pub started_at: u64,
    /// When it ended, Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// The exit code, when the command exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The terminating signal on Unix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    /// Whether the command did what it was asked, judged by what its exit code means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CommandOutcome>,
    /// What a non-zero exit code of a successful command means (`no matches`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meaning: Option<String>,
    /// A Monitor's timeout, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// The output file, as the model is told it (`~` for the home directory).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    /// Bytes written to the output file so far.
    pub output_bytes: u64,
    /// The last lines of the output (a few, each shortened), newest last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tail: Vec<String>,
}

/// Why a command became a background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStartReason {
    /// The call asked for it (`background: true`).
    Requested,
    /// It reached its timeout and kept running in the background.
    Timeout,
}

/// The task a command became (`exec/run`'s `task`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskStarted {
    /// The task's id; `KillShell` takes it.
    pub task_id: String,
    /// Where its output goes, as the model is told it.
    pub output_path: String,
    /// Why it runs in the background.
    pub reason: TaskStartReason,
}

/// Parameters of `exec/monitor`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecMonitorParams {
    /// The session whose model hears the output.
    pub session_id: SessionId,
    /// Chosen by the Agent Host, unique among its requests.
    pub request_id: String,
    /// The shell command line (bash).
    pub command: String,
    /// What the Monitor watches, as the panel shows it.
    pub description: String,
    /// How long it may run, in milliseconds; Core's default (5 minutes) when absent, at most
    /// Core's maximum (30 minutes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// The `Monitor` tool call it serves; its approval is consumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
}

/// Result of `exec/monitor`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecMonitorResult {
    /// The task's id.
    pub task_id: String,
    /// Where its output goes, as the model is told it.
    pub output_path: String,
    /// The timeout it runs with, in milliseconds.
    pub timeout_ms: u64,
    /// The timeout asked for, when it was above the maximum and cut to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_timeout_ms: Option<u64>,
}

/// Parameters of `exec/background/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskListParams {
    /// The session asking.
    pub session_id: SessionId,
}

/// Result of `exec/background/list`: the session's tasks and its subagents', newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    /// The tasks.
    pub tasks: Vec<BackgroundTask>,
}

/// Parameters of `exec/background/read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskReadParams {
    /// The session asking.
    pub session_id: SessionId,
    /// The task.
    pub task_id: String,
    /// Byte offset to read from; 0 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Bytes to read at most; Core's chunk size (64 KiB) when absent or larger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
}

/// A range of a task's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputChunk {
    /// The task.
    pub task_id: String,
    /// Where the text starts, in bytes.
    pub offset: u64,
    /// The bytes read, as UTF-8 (invalid sequences replaced); ends on a character boundary.
    pub text: String,
    /// Where the next read starts.
    pub next_offset: u64,
    /// Bytes in the file now.
    pub total_bytes: u64,
    /// Where the task stands: once it is not `running` and `nextOffset` reached
    /// `totalBytes`, there is no more.
    pub status: TaskStatus,
}

/// Parameters of `exec/background/kill`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskKillParams {
    /// The session asking: it may stop its own tasks and its subagents'.
    pub session_id: SessionId,
    /// The task.
    pub task_id: String,
}

/// Result of `exec/background/kill`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskKillResult {
    /// The task after it stopped (or as it ended before).
    pub task: BackgroundTask,
    /// Whether this request stopped it (false: it had already ended).
    pub stopped: bool,
    /// The end of its output.
    pub tail: String,
}

/// The `core/tasks` snapshot: the tasks of the open workspaces' sessions, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TasksSnapshot {
    /// Increases with every snapshot; clients drop older ones.
    pub revision: u64,
    /// The tasks.
    pub tasks: Vec<BackgroundTask>,
}

request!(
    /// Method marker for `exec/monitor` (Agent Host → Core).
    ExecMonitor, "exec/monitor", ExecMonitorParams, ExecMonitorResult
);
request!(
    /// Method marker for `exec/background/list` (Agent Host → Core).
    TaskListMethod, "exec/background/list", TaskListParams, TaskList
);
request!(
    /// Method marker for `exec/background/read` (Agent Host → Core).
    TaskRead, "exec/background/read", TaskReadParams, TaskOutputChunk
);
request!(
    /// Method marker for `exec/background/kill` (Agent Host → Core).
    TaskKill, "exec/background/kill", TaskKillParams, TaskKillResult
);
