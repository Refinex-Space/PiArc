//! Exports of T36: the settings window's MCP page. Results are JSON text; state changes arrive
//! on the `core/mcp` route, sign-in steps on `core/login` (answered with `answerLogin`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// Every configured MCP server of `workspace` with its state, as JSON text (`McpStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mcp_status<'env>(
        &self,
        env: &'env Env,
        workspace: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.mcpStatus", |core, done| {
            core.mcp_status(workspace.into(), done)
        })
    }

    /// Connects MCP server `name` of `workspace` anew; its state as JSON text.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mcp_reconnect<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.mcpReconnect", |core, done| {
            core.mcp_reconnect(workspace.into(), name, done)
        })
    }

    /// Turns MCP server `name` of `workspace` on or off; its state as JSON text.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mcp_set_enabled<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        name: String,
        enabled: bool,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.mcpSetEnabled", |core, done| {
            core.mcp_set_enabled(workspace.into(), name, enabled, done)
        })
    }

    /// Adds MCP server `name` (definition as JSON text) to `workspace` in `scope` (`user` or
    /// `projectLocal`); the main process confirms it natively first. The workspace's status as
    /// JSON text.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mcp_add_server<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        scope: String,
        name: String,
        definition: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.mcpAddServer", |core, done| {
            core.mcp_add_server(workspace.into(), scope, name, definition, done)
        })
    }

    /// Signs in to OAuth MCP server `name` of `workspace`; its state and `loginId` as JSON
    /// text once the tokens are stored.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mcp_login<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.mcpLogin", |core, done| {
            core.mcp_login(workspace.into(), name, done)
        })
    }
}
