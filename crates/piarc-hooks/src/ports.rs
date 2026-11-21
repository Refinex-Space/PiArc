//! What `http` and `prompt` handlers reach through (ADR-0055): Core injects one port for each,
//! the runner bounds every call with the handler's timeout and the event's cancellation (it
//! drops the future), and reads the answer with Claude Code's output protocol.

use piarc_ports::BoxFuture;

/// One `http` handler's request: the hook input JSON as the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpCall {
    pub url: String,
    /// Headers after interpolation, `Content-Type` included.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The response of an `http` handler's request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Posts `http` handlers' requests (Core: `piarc-web`).
pub trait HttpPort: Send + Sync {
    /// Sends `call`.
    ///
    /// # Errors
    ///
    /// Why no response arrived (connection, TLS, size), for the user.
    fn post(&self, call: HttpCall) -> BoxFuture<'static, Result<HttpReply, String>>;
}

/// One `prompt` handler's question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeCall {
    /// The handler's prompt with the input JSON in place of `$ARGUMENTS`.
    pub prompt: String,
    /// The handler's `model`, unresolved.
    pub model: Option<String>,
    /// The handler's timeout, so the model call ends with it.
    pub timeout_ms: u64,
}

/// The model's answer to a [`JudgeCall`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JudgeReply {
    /// The model's text.
    pub text: String,
    /// `provider/model` that answered.
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Asks a model (Core: the session's Agent Host, `hooks/prompt`).
pub trait JudgePort: Send + Sync {
    /// Asks `call`.
    ///
    /// # Errors
    ///
    /// Why there is no answer (no Agent Host, the model request failed), for the user.
    fn judge(&self, call: JudgeCall) -> BoxFuture<'static, Result<JudgeReply, String>>;
}

/// One `mcp_tool` handler's call (T41).
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolCall {
    /// The server's name in the workspace.
    pub server: String,
    /// The tool on it.
    pub tool: String,
    /// The arguments, placeholders filled.
    pub arguments: serde_json::Value,
    /// The handler's timeout, so the call ends with it.
    pub timeout_ms: u64,
}

/// What an MCP tool answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolReply {
    /// The text content, joined: read as a command's stdout.
    pub text: String,
    /// The tool reported an error (`isError`).
    pub is_error: bool,
}

/// Calls tools on the workspace's MCP servers (Core: the Agent Host's pool, `hooks/mcpTool`).
pub trait McpToolPort: Send + Sync {
    /// Calls `call`.
    ///
    /// # Errors
    ///
    /// Why there is no answer (the server is not connected, no Agent Host, the call failed).
    fn call(&self, call: McpToolCall) -> BoxFuture<'static, Result<McpToolReply, String>>;
}
