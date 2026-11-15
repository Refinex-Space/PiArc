//! Command execution the Agent Host delegates to Core (`exec/*`).
//!
//! The Agent Host's `Bash` tool runs nothing itself (ADR-0004): it sends `exec/run` and Core
//! starts the command with the user's shell in the session's working directory.
//!
//! # Streaming and completion
//!
//! While the command runs, Core sends `exec/output` notifications (Core → Agent Host) with the
//! caller's `requestId`, the stream (`stdout` or `stderr`) and a sequence number counting
//! from 1 across both streams. Output is decoded as UTF-8 per stream; a sequence split
//! between two reads waits for the next read, and invalid bytes become U+FFFD. Every
//! `exec/output` of a command is written before the `exec/run` response, which carries the
//! exit code (or the terminating signal) once the command has exited.
//!
//! # Cancellation
//!
//! `exec/kill` with the same `requestId` terminates the command's process; the pending
//! `exec/run` then completes with `killed: true`. A command whose connection to the Agent
//! Host ends is terminated as well. Only the direct child is terminated so far: the shell's
//! own children may outlive it until process groups and Job Objects arrive (T17).
//!
//! # Environment
//!
//! The command's environment is Core's own allow-listed environment (no credentials,
//! architecture section 5.4) plus the `env` overlay of the request, which carries what the
//! Agent Host adds for its sessions (Pi's `PI_*` session variables and `PATH`).

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
}

/// Result of `exec/run`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecRunResult {
    /// The exit code, when the command exited normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The terminating signal number on Unix, when a signal ended the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    /// Whether `exec/kill` terminated the command.
    pub killed: bool,
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
