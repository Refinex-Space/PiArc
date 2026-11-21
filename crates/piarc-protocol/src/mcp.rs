//! MCP servers (architecture section 6.8, T36): the shared connection pool of a workspace's
//! Agent Host. Needs the handshake capability `mcpPool`.
//!
//! - `mcp/servers` (Agent Host → Core): the servers configured for the workspace, merged by
//!   name across the sources (`.mcp.json`, `~/.claude.json`, PiArc's settings), with what
//!   stdio servers start with. Core reads the files: it owns the home directory, project trust,
//!   the users' enable and disable choices and the command environment.
//! - `mcp/status` (Core → Agent Host): the state of every server in the pool.
//! - `mcp/reconnect`, `mcp/setEnabled` (Core → Agent Host): the settings window's actions.
//!   Core stores the enable choice before it tells the Agent Host.
//! - `mcp/login` (Core → Agent Host): signs in to an OAuth server; the authorization page goes
//!   to the client through `ui/loginInteraction`, the tokens go to the vault (`mcp/<server>`).
//! - `mcp/statusChanged` (Agent Host → Core): a server's state changed.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{notification, request};

/// Where a server definition comes from. The same name in several scopes takes the whole
/// definition of the first in this order: enterprise, local, project, user, plugin.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum McpScope {
    /// Managed configuration (T47).
    Enterprise,
    /// `~/.claude.json`, the workspace's entry under `projects`.
    Local,
    /// The workspace: `.piarc/settings.local.json`, `.piarc/settings.json`, `.mcp.json`. Needs
    /// the project's trust.
    Project,
    /// PiArc's user settings, then `~/.claude.json`'s top-level `mcpServers`.
    User,
    /// A plugin (T40).
    Plugin,
    /// Defined inline by a subagent definition, for its runs only.
    Subagent,
}

/// How the server is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    /// A local program speaking MCP on stdin and stdout.
    Stdio,
    /// Streamable HTTP.
    Http,
    /// The deprecated SSE transport: not supported.
    Sse,
    /// WebSocket: not supported.
    Ws,
}

/// Whether a configured server may be connected, before any connection is tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpAvailability {
    /// May be connected.
    Ready,
    /// The user or the configuration (`enabled: false`, `disabledMcpjsonServers`) turned it off.
    Disabled,
    /// PiArc cannot use its transport or definition (`reason`).
    Unsupported,
    /// A project server of a project that is not trusted yet.
    Untrusted,
}

/// A stdio server's program. Values are expanded (`${VAR}`, `${VAR:-default}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpStdio {
    /// The program.
    pub command: String,
    /// Its arguments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Variables the definition adds to the environment.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Working directory, relative to the workspace root unless absolute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// OAuth client settings of an HTTP server, for servers without dynamic client registration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuth {
    /// Pre-registered client id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Fixed port of the loopback callback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback_port: Option<u64>,
    /// Scopes to request, separated by spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Authorization server metadata to use instead of discovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_server_metadata_url: Option<String>,
}

/// A Streamable HTTP server. Values are expanded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpHttp {
    /// The endpoint.
    pub url: String,
    /// Sent with every request.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// OAuth client settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<McpOAuth>,
}

/// One configured server, as it applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDefinition {
    /// The name (`[A-Za-z0-9_-]`), unique in the workspace.
    pub name: String,
    /// Its scope.
    pub scope: McpScope,
    /// The file it is defined in.
    pub source: String,
    /// Its transport.
    pub transport: McpTransport,
    /// Whether it may be connected.
    pub availability: McpAvailability,
    /// Why not, for `unsupported`, `disabled` and `untrusted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The program of a `ready` stdio server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdio: Option<McpStdio>,
    /// The endpoint of a `ready` HTTP server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<McpHttp>,
    /// Limit of one tool call, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// What it offers, in a sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `true`: its tools are declared to the model even when MCP tools are deferred.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub always_load: bool,
}

/// A configuration problem: the entry is left out or a value is not used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigIssue {
    /// The file.
    pub source: String,
    /// JSON Pointer of the value in the file.
    pub pointer: String,
    /// What is wrong.
    pub message: String,
}

/// A definition that a higher scope's definition of the same name replaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOverridden {
    /// The server name.
    pub name: String,
    /// The file of the replaced definition.
    pub source: String,
    /// The file of the definition that applies.
    pub by: String,
}

/// Parameters of `mcp/servers`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServersParams {}

/// Result of `mcp/servers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServersResult {
    /// Every configured server, by name.
    pub servers: Vec<McpServerDefinition>,
    /// The environment stdio servers start from (the command environment of the user's login
    /// shell, ADR-0035), before the definition's own `env`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// After this long without a call from any session the pool disconnects a server.
    pub idle_timeout_ms: u64,
    /// More MCP tools than this in a session are deferred behind `ToolSearch`.
    pub defer_threshold: u64,
    /// Definitions replaced by higher scopes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overridden: Vec<McpOverridden>,
    /// Entries left out and values not used.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<McpConfigIssue>,
}

request!(
    /// Method marker for `mcp/servers` (Agent Host → Core).
    McpServersMethod, "mcp/servers", McpServersParams, McpServersResult
);

/// The state of a server in the pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpConnectionState {
    /// Connected; its tools are known.
    Connected,
    /// Connecting, or reconnecting after a failure.
    Connecting,
    /// Not connected: no session needed it yet, or it was idle; the next use connects it.
    Idle,
    /// The server asked for a sign-in (OAuth 401 or 403).
    NeedsAuth,
    /// The last attempt failed (`error`); the pool retries with backoff while sessions need it.
    Failed,
    /// Turned off.
    Disabled,
    /// PiArc cannot use it (`error` says why).
    Unsupported,
    /// Waits for the project's trust.
    Untrusted,
}

/// One server's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    /// The name.
    pub name: String,
    /// Its scope.
    pub scope: McpScope,
    /// Its file.
    pub source: String,
    /// Its transport.
    pub transport: McpTransport,
    /// The state.
    pub state: McpConnectionState,
    /// Tools it offers (from the last connection).
    pub tools: u64,
    /// The last error, or why it is unsupported, disabled or waiting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Sessions using it now.
    pub sessions: u64,
    /// The process id of a connected stdio server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    /// Whether it signs in with OAuth.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub oauth: bool,
}

/// Parameters of `mcp/status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusParams {}

/// Result of `mcp/status` and the parameters of `mcp/statusChanged`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Every configured server, by name.
    pub servers: Vec<McpServerStatus>,
    /// Definitions replaced by higher scopes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overridden: Vec<McpOverridden>,
    /// Entries left out and values not used.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<McpConfigIssue>,
}

request!(
    /// Method marker for `mcp/status` (Core → Agent Host).
    McpStatusMethod, "mcp/status", McpStatusParams, McpStatus
);

notification!(
    /// Method marker for `mcp/statusChanged` (Agent Host → Core).
    McpStatusChanged, "mcp/statusChanged", McpStatus
);

/// Parameters of `mcp/reconnect`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReconnectParams {
    /// The server.
    pub name: String,
}

request!(
    /// Method marker for `mcp/reconnect` (Core → Agent Host): reads the configuration again and
    /// connects the server anew. Answers its state afterwards.
    McpReconnect, "mcp/reconnect", McpReconnectParams, McpServerStatus
);

/// Parameters of `mcp/setEnabled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSetEnabledParams {
    /// The server.
    pub name: String,
    /// On or off.
    pub enabled: bool,
}

request!(
    /// Method marker for `mcp/setEnabled` (Core → Agent Host): Core stored the choice; the
    /// pool reads the configuration again and closes or allows the server.
    McpSetEnabled, "mcp/setEnabled", McpSetEnabledParams, McpServerStatus
);

/// Parameters of `mcp/login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpLoginParams {
    /// The server.
    pub name: String,
    /// The sign-in's id, for `ui/loginInteraction`.
    pub login_id: String,
}

request!(
    /// Method marker for `mcp/login` (Core → Agent Host): resolves once the tokens are stored
    /// and the server reconnected, with its state.
    McpLogin, "mcp/login", McpLoginParams, McpServerStatus
);
