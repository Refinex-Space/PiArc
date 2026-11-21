//! `prompt` hooks' way to a model (T38, ADR-0055): Core runs the hook, the main session's Agent
//! Host makes the one model call (`hooks/prompt`) with its auxiliary model channel.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use piarc_ports::BoxFuture;
use piarc_protocol::hooks::{HooksPrompt, HooksPromptParams, HooksPromptResult};

use super::{Hub, Routes, lock};
use crate::hooks::HookOutlet;

/// What the transport may add to a judgement's own timeout before Core gives up on it.
const TRANSPORT_SLACK: Duration = Duration::from_secs(5);

impl Hub {
    /// Lets the tool I/O's hooks reach the sessions' Agent Hosts.
    pub(crate) fn connect_hooks(&self) {
        self.ctx.tool_io.set_hook_outlet(Arc::new(HubHooks {
            routes: Arc::downgrade(&self.routes),
        }));
    }
}

/// Weak, so the hooks service the tool I/O holds does not keep the hub alive.
struct HubHooks {
    routes: Weak<Mutex<Routes>>,
}

impl HookOutlet for HubHooks {
    fn judge(
        &self,
        params: HooksPromptParams,
    ) -> BoxFuture<'static, Result<HooksPromptResult, String>> {
        let session = self
            .routes
            .upgrade()
            .and_then(|routes| lock(&routes).sessions.get(&params.session_id).cloned());
        Box::pin(async move {
            let session = session.ok_or_else(|| "the session is not open".to_owned())?;
            let host = session
                .host()
                .await
                .ok_or_else(|| "the session's Agent Host is not running".to_owned())?;
            let timeout = Duration::from_millis(params.timeout_ms) + TRANSPORT_SLACK;
            host.call_within::<HooksPrompt>(params, timeout)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn mcp_tool(
        &self,
        params: piarc_protocol::hooks::HooksMcpToolParams,
    ) -> BoxFuture<'static, Result<piarc_protocol::hooks::HooksMcpToolResult, String>> {
        let session = self
            .routes
            .upgrade()
            .and_then(|routes| lock(&routes).sessions.get(&params.session_id).cloned());
        Box::pin(async move {
            let session = session.ok_or_else(|| "the session is not open".to_owned())?;
            let host = session
                .host()
                .await
                .ok_or_else(|| "the session's Agent Host is not running".to_owned())?;
            let timeout = Duration::from_millis(params.timeout_ms) + TRANSPORT_SLACK;
            host.call_within::<piarc_protocol::hooks::HooksMcpTool>(params, timeout)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
