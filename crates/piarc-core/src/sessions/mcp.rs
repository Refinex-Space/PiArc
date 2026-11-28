//! The settings window's MCP page (T36): the state of a workspace's servers, reconnecting,
//! turning a server on or off, and signing in to an OAuth server. The pool is in the
//! workspace's Agent Host; Core stores the on/off choice before it tells the pool, and runs an
//! MCP sign-in like a provider's (`core/login`, provider `mcp:<server>`).

use std::path::PathBuf;

use piarc_protocol::mcp::{
    McpLogin, McpLoginParams, McpReconnect, McpReconnectParams, McpSetEnabled, McpSetEnabledParams,
    McpStatusMethod, McpStatusParams,
};
use serde::Serialize;
use serde_json::{Value, json};

use super::login::{LOGIN_TIMEOUT, emit, end_payload};
use super::{Hub, host_error};
use crate::error::{Error, Result};
use crate::mcp::{AddScope, McpConfigSource};

fn encode(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the MCP answer: {e}"),
    })
}

impl Hub {
    fn mcp_config(&self) -> McpConfigSource {
        McpConfigSource::new(
            self.ctx.trust.clone(),
            self.ctx.storage.clone(),
            self.ctx.tool_io.clone(),
        )
    }

    /// Every configured server of `workspace` with its state in the pool.
    pub async fn mcp_status(&self, workspace: PathBuf) -> Result<Value> {
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let status = supervisor
            .call::<McpStatusMethod>(McpStatusParams {})
            .await
            .map_err(host_error)?;
        encode(&status)
    }

    /// Reads the configuration again and connects server `name` anew; answers its state.
    pub async fn mcp_reconnect(&self, workspace: PathBuf, name: String) -> Result<Value> {
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let status = supervisor
            .call::<McpReconnect>(McpReconnectParams { name })
            .await
            .map_err(host_error)?;
        encode(&status)
    }

    /// Turns server `name` of `workspace` on or off: stored first, then applied by the pool.
    pub async fn mcp_set_enabled(
        &self,
        workspace: PathBuf,
        name: String,
        enabled: bool,
    ) -> Result<Value> {
        self.mcp_config()
            .set_enabled(&workspace, &name, enabled)
            .await?;
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let status = supervisor
            .call::<McpSetEnabled>(McpSetEnabledParams { name, enabled })
            .await
            .map_err(host_error)?;
        encode(&status)
    }

    /// Adds server `name` (definition `definition`, JSON text) in `scope` (`user` or
    /// `projectLocal`) after the main process's native confirmation; answers the workspace's
    /// status, read again with the new server.
    pub async fn mcp_add_server(
        &self,
        workspace: PathBuf,
        scope: String,
        name: String,
        definition: String,
    ) -> Result<Value> {
        let scope = AddScope::parse(&scope)?;
        let raw: Value = serde_json::from_str(&definition).map_err(|_| Error::InvalidArgument {
            field: "definition",
            reason: "not JSON".into(),
        })?;
        self.mcp_config()
            .add_server(&workspace, scope, &name, raw)
            .await?;
        self.mcp_status(workspace).await
    }

    /// Signs in to OAuth server `name` of `workspace`; resolves once the tokens are in the
    /// vault and the server reconnected. The authorization page and the paste prompt go to
    /// `core/login`; `answer_login(id, None)` cancels.
    pub async fn mcp_login(&self, workspace: PathBuf, name: String) -> Result<Value> {
        let provider = format!("mcp:{name}");
        let (id, cancel) = self.ctx.logins.begin(&provider)?;
        let events = &self.ctx.events;
        emit(
            events,
            json!({"loginId": id, "provider": provider, "state": "started"}),
        )
        .await;
        let result = async {
            let handle = self.workspace(workspace).await?;
            let supervisor = handle.acquire().await?;
            let call = supervisor.call_within::<McpLogin>(
                McpLoginParams {
                    name,
                    login_id: id.clone(),
                },
                LOGIN_TIMEOUT,
            );
            // Cancelling answers the sign-in's open question with "cancelled", which ends the
            // Agent Host's flow; its answer still arrives.
            call.await.map_err(host_error)
        }
        .await;
        self.ctx.logins.end(&id);
        emit(
            events,
            end_payload(&id, &provider, result.as_ref().err(), &cancel),
        )
        .await;
        let status = result?;
        let mut answer = encode(&status)?;
        if let Value::Object(map) = &mut answer {
            map.insert("loginId".into(), Value::String(id));
        }
        Ok(answer)
    }
}
