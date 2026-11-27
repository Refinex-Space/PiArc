//! Launch configurations and development servers (ADR-0092, design addendum
//! `docs/architecture/addenda/browser.md` B4). Core API types for the desktop client:
//!
//! - `launchConfigs(sessionId)` answers a [`LaunchView`]: the configurations of the session's
//!   project (`.piarc/launch.json` over `.claude/launch.json`), their problems, whether the
//!   project is trusted to run them, and the servers the session started.
//! - `startDevServer` ([`DevServerStart`]) and `stopDevServer` answer a [`DevServerState`].
//! - The `core/browser` route carries the session's servers (`servers`) and the TCP ports its
//!   process trees listen on (`ports`, [`ListeningPort`]) whenever they change.
//!
//! A server runs as a background task of kind `devServer`, outside the sandbox, in the
//! session's command environment.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::session::SessionId;
use crate::tasks::TaskKind;

/// The file a configuration comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LaunchSource {
    /// `.piarc/launch.json`.
    Piarc,
    /// `.claude/launch.json` (read only, ADR-0038).
    Claude,
}

/// One launch configuration as the start page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfigView {
    /// Its name, unique in the project.
    pub name: String,
    /// The file it comes from.
    pub source: LaunchSource,
    /// The command line, quoted for reading.
    pub command: String,
    /// The directory it runs in.
    pub cwd: String,
    /// The port it serves on (`port`, the `url`'s, `env.PORT`, `--port`/`-p`, or 3000).
    #[schemars(with = "u64")]
    pub port: u16,
    /// The address to open once it is ready.
    pub url: String,
    /// Another free port is taken when this one is busy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_port: bool,
    /// SHA-256 of what it runs (command, arguments, directory, environment, port), lowercase
    /// hex: the agent's start is approved per fingerprint.
    pub fingerprint: String,
}

/// A problem in a launch file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchIssue {
    /// The file, relative to the project with `/`.
    pub file: String,
    /// 1-based line, when the problem has a place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    /// 1-based column, when the problem has a place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
    /// What is wrong.
    pub message: String,
}

/// Where a development server stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DevServerStatus {
    /// Started; its port does not answer yet.
    Starting,
    /// Its process tree listens on the port.
    Ready,
    /// It exited, or did not become ready in time.
    Failed,
    /// Stopped by the user, the agent or the session.
    Stopped,
}

/// Who started a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DevServerStarter {
    /// The user, from the browser panel.
    User,
    /// The agent, through the browser SDK's `startServer`.
    Agent,
}

/// Why a server failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DevServerFailure {
    /// The process exited.
    Exited,
    /// The port did not answer within 180 seconds.
    Timeout,
    /// It could not be started.
    Spawn,
}

/// One server a session started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevServerState {
    /// The configuration's name.
    pub name: String,
    /// Where it stands.
    pub status: DevServerStatus,
    /// Who started it.
    pub started_by: DevServerStarter,
    /// Its background task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The port it was started on (after `autoPort`).
    #[schemars(with = "u64")]
    pub port: u16,
    /// The address to open.
    pub url: String,
    /// Why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<DevServerFailure>,
    /// The exit code, when it exited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The last lines of its output when it failed (at most 20).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<String>,
}

/// What `launchConfigs` answers for a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LaunchView {
    /// The configurations, `.piarc` ones first, in file order.
    pub configs: Vec<LaunchConfigView>,
    /// `autoVerify` (default true): the agent is reminded to look at the page after it changes
    /// a running server's front-end files.
    pub auto_verify: bool,
    /// Problems of the launch files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<LaunchIssue>,
    /// The project is trusted: its configurations may run (ADR-0025).
    pub trusted: bool,
    /// The servers the session started.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub servers: Vec<DevServerState>,
}

/// `startDevServer`'s request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevServerStart {
    /// The main session whose panel or agent starts it.
    pub session_id: SessionId,
    /// The configuration.
    pub name: String,
    /// Set when the agent's running `Browser` call starts it: the first start of a
    /// configuration's fingerprint in the session asks the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<DevServerAgent>,
    /// Answer once the server is ready or failed instead of once it started.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wait: bool,
}

/// The `Browser` call that starts a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevServerAgent {
    /// The session of the call (a subagent's own id for a subagent).
    pub session_id: SessionId,
    /// The running `Browser` call; the question goes away with it.
    pub tool_call_id: String,
}

/// A TCP port a process tree of a session listens on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    /// The port.
    #[schemars(with = "u64")]
    pub port: u16,
    /// The background task whose process tree listens on it.
    pub task_id: String,
    /// What the task runs.
    pub kind: TaskKind,
    /// The task's title (the command, the configuration's name).
    pub title: String,
}
