//! The MCP page's entry points (T36): [`Hub`](crate::sessions::Hub)'s MCP operations on the
//! runtime, results as JSON.

use std::path::PathBuf;

use super::CoreRuntime;
use crate::error::Result;

impl CoreRuntime {
    /// Every configured MCP server of `workspace` with its state (`McpStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn mcp_status(
        &self,
        workspace: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.mcp_status(workspace).await
        })
    }

    /// Connects server `name` of `workspace` anew; answers its state.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn mcp_reconnect(
        &self,
        workspace: PathBuf,
        name: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.mcp_reconnect(workspace, name).await
        })
    }

    /// Turns server `name` of `workspace` on or off (stored per workspace); answers its state.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn mcp_set_enabled(
        &self,
        workspace: PathBuf,
        name: String,
        enabled: bool,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.mcp_set_enabled(workspace, name, enabled).await
        })
    }

    /// Signs in to OAuth server `name` of `workspace`; steps on `core/login`, answered with
    /// `answer_login`. Resolves with the server's state and the sign-in's `loginId`.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn mcp_login(
        &self,
        workspace: PathBuf,
        name: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.mcp_login(workspace, name).await
        })
    }
}
