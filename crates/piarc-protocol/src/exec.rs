//! Command execution the Agent Host delegates to Core (`exec/*`).
//!
//! The Agent Host's `Bash` and `PowerShell` tools run nothing themselves (ADR-0004): they send
//! `exec/run` and Core runs the command with the session's shell (architecture section 6.11):
//! bash (Git Bash on Windows) or PowerShell (Windows only; `exec/shells` says which exist).
//!
//! # What Core does for a command
//!
//! - **Working directory.** Without `cwd`, a command runs where the session's previous bash
//!   command ended: `cd` carries over. A command that ends outside the workspace and the added
//!   directories sends the next one back to the workspace root (`cwdReset`). An explicit `cwd`
//!   runs there and is not carried over.
//! - **Timeout.** `timeoutMs`, at most Core's maximum (10 minutes; longer requests are cut,
//!   `timeout.requestedMs` says so), or Core's default (2 minutes). A command that runs out of
//!   time is stopped with everything it started (`timedOut`), and so is one `exec/kill` or the
//!   connection's end stops.
//! - **Output.** The result carries the output the model sees (`output`): all of it up to
//!   Core's inline budget, otherwise a start and an end with the full text in a file under the
//!   session's temporary directory.
//! - **Meaning of the exit code.** `outcome` judges the exit code by the program
//!   (`grep` exiting 1 found nothing, which is a success; `meaning` says so).
//!
//! # Streaming and completion
//!
//! While the command runs, Core sends `exec/output` notifications (Core → Agent Host) with the
//! caller's `requestId`, the stream (`stdout` or `stderr`) and a sequence number counting
//! from 1 across both streams: the live view of the output. Output is decoded as UTF-8 per
//! stream; a sequence split between two reads waits for the next read, and invalid bytes
//! become U+FFFD. When the Agent Host reads slower than the command writes, Core leaves out
//! part of a stream and says how much (`skipped`); the result's `output` is complete
//! regardless. Every `exec/output` of a command is written before the `exec/run` response.
//!
//! # Cancellation
//!
//! `exec/kill` with the same `requestId` stops the command and every process it started; the
//! pending `exec/run` then completes with `killed: true`. A command whose connection to the
//! Agent Host ends is stopped as well.
//!
//! # Environment
//!
//! The command's environment is the user's login shell environment without PiArc's internal
//! variables and without credentials (architecture section 5.4), plus the `env` overlay of
//! the request.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{Method, NotificationMethod, request};
use crate::session::SessionId;
use crate::tool_call::ToolOrigin;

/// Parameters of `exec/run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecRunParams {
    /// The session whose workspace and working directory apply.
    pub session_id: SessionId,
    /// Chosen by the Agent Host, unique among its running commands; `exec/output` and
    /// `exec/kill` refer to the command by it.
    pub request_id: String,
    /// The shell command line.
    pub command: String,
    /// Working directory, absolute or relative to the session's; the session's when absent.
    /// It must lie inside the workspace root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Variables set on top of Core's environment for this command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// The tool call this request serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ToolOrigin>,
    /// The shell; `bash` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<ExecShell>,
    /// How long the command may run, in milliseconds; Core's default when absent. With the
    /// capability `backgroundTasks` a command that reaches it keeps running as a background
    /// task (T32); without, it is stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Starts the command as a background task and answers at once (capability
    /// `backgroundTasks`, T32).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub background: bool,
    /// Runs the command in a PiArc terminal whose screen the model reads (capability
    /// `terminalTasks`, T33, ADR-0050); comes with `background`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
}

/// A shell commands run with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExecShell {
    /// bash; Git Bash on Windows.
    Bash,
    /// PowerShell 7, or Windows PowerShell 5.1 without it (Windows only).
    Powershell,
}

/// Result of `exec/run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecRunResult {
    /// The exit code, when the command exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The terminating signal number on Unix, when a signal ended the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    /// Whether `exec/kill` (or the connection's end) stopped the command.
    pub killed: bool,
    /// Whether the command was stopped because its timeout passed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    /// The timeout the command ran with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<ExecTimeout>,
    /// How long the command ran, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Whether the command did what it was asked, judged by what its exit code means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CommandOutcome>,
    /// What a non-zero exit code of a successful command means (`no matches`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meaning: Option<String>,
    /// The directory the command ran in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The session's next command will not start where this one ended, and why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_reset: Option<CwdReset>,
    /// The output the model sees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<CommandOutput>,
    /// The background task the command became, when it runs on (capability `backgroundTasks`,
    /// T32): asked for, or moved there by its timeout. The exit fields are then absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<crate::tasks::TaskStarted>,
    /// Present when the command ran in the sandbox (T39, architecture section 6.10): what the
    /// sandbox refused, as far as Core could tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxReport>,
}

/// What the sandbox did to one command (T39).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxReport {
    /// What the sandbox refused: paths named in the command's failure output that its policy
    /// forbids, and hosts the proxy refused while it ran. Empty when nothing was recognized.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub denials: Vec<SandboxDenial>,
    /// The sandbox itself could not start, so the command did not run; later commands run
    /// without it and go through the normal approval (risk R10).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub failed_to_start: bool,
}

/// One thing the sandbox refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDenial {
    /// What was refused.
    pub kind: SandboxDenialKind,
    /// The path (`read`, `write`) or `host:port` (`network`).
    pub target: String,
}

/// The kinds of [`SandboxDenial`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SandboxDenialKind {
    /// Reading a `denyRead` path.
    Read,
    /// Writing outside the writable directories or a protected path.
    Write,
    /// Reaching a host the allowlist does not name (and the user did not allow), or one that
    /// resolves to a refused address.
    Network,
}

/// The timeout a command ran with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecTimeout {
    /// The timeout applied, in milliseconds.
    pub ms: u64,
    /// The timeout asked for, when it was longer than Core's maximum and was cut to `ms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_ms: Option<u64>,
}

/// Whether a command succeeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommandOutcome {
    /// It did what it was asked: exit code 0, or an exit code that is an answer.
    Success,
    /// It failed, was stopped or timed out.
    Failure,
}

/// Why a session's next command starts somewhere else than where the last one ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CwdReset {
    /// The directory the shell ended in (or the remembered one that no longer exists).
    pub ended_in: String,
    /// Where the next command starts: the workspace root.
    pub reset_to: String,
    /// Why.
    pub reason: CwdResetReason,
}

/// Reasons for a [`CwdReset`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CwdResetReason {
    /// Outside the workspace root and the added directories.
    OutsideWorkspace,
    /// The directory no longer exists.
    Missing,
}

/// A command's output as the model sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    /// All of the output (stdout and stderr in the order they were read), or its start when
    /// `tail` is present.
    pub head: String,
    /// The end of the output, when its middle was left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    /// Characters of the whole output.
    pub total_chars: u64,
    /// Characters left out between `head` and `tail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted_chars: Option<u64>,
    /// The file holding the full output (`~` for the home directory), when it was saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    /// Why the full output could not be saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_error: Option<String>,
}

/// Which output stream a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum OutputStream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

/// Parameters of `exec/output` (Core → Agent Host): one chunk of a running command's output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutputParams {
    /// The `requestId` of the `exec/run` that started the command.
    pub request_id: String,
    /// The stream the chunk came from.
    pub stream: OutputStream,
    /// 1, 2, 3, ... across both streams of the command, in the order Core read them.
    pub seq: u64,
    /// The chunk, decoded as UTF-8.
    pub data: String,
    /// Bytes of this stream left out right before this chunk, because the Agent Host read
    /// slower than the command wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<u64>,
}

/// Parameters of `exec/kill`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecKillParams {
    /// The session that started the command.
    pub session_id: SessionId,
    /// The `requestId` of the command's `exec/run`.
    pub request_id: String,
}

/// Result of `exec/kill`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecKillResult {
    /// False when no such command was running (it already ended, or never started).
    pub killed: bool,
}

/// Parameters of `exec/shells`. Which shells exist is a fact about the machine, asked while a
/// session's tools are set up, before Core has registered the session: Core answers whatever
/// the session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecShellsParams {
    /// The session whose tools are being set up; need not be registered with Core yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

/// Result of `exec/shells`: which shells the session's command tools can use. When bash is
/// missing (Windows without Git Bash) the session gets no `Bash` tool, and Core has told the
/// user how to install it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecShellsResult {
    /// bash (Git Bash on Windows) was found.
    pub bash: bool,
    /// PowerShell was found (Windows only).
    pub powershell: bool,
}

request!(
    /// Method marker for `exec/shells` (Agent Host → Core).
    ExecShells, "exec/shells", ExecShellsParams, ExecShellsResult
);
request!(
    /// Method marker for `exec/run` (Agent Host → Core).
    ExecRun, "exec/run", ExecRunParams, ExecRunResult
);
request!(
    /// Method marker for `exec/kill` (Agent Host → Core).
    ExecKill, "exec/kill", ExecKillParams, ExecKillResult
);

/// Method marker for `exec/output` (Core → Agent Host notification).
#[derive(Debug, Clone, Copy)]
pub struct ExecOutput;

impl Method for ExecOutput {
    const NAME: &'static str = "exec/output";
    const TYPE_NAME: &'static str = "ExecOutput";
}

impl NotificationMethod for ExecOutput {
    type Params = ExecOutputParams;
}
