//! Launch configurations and development servers from the main process (ADR-0092, design
//! addendum `docs/architecture/addenda/browser.md` B4): the start page's list, the run and stop
//! buttons, and the agent's `startServer` (through the browser SDK's bindings).

use super::Hub;
use crate::error::{Error, Result};

fn encode<T: serde::Serialize>(value: &T) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the answer: {e}"),
    })
}

impl Hub {
    /// The launch configurations of open session `session_id`'s project and its servers.
    pub async fn launch_configs(&self, session_id: String) -> Result<serde_json::Value> {
        let view = self
            .ctx
            .tool_io
            .launch_view(&session_id)
            .await
            .map_err(|e| Error::feature(&e))?;
        encode(&view)
    }

    /// Starts a launch configuration: JSON
    /// [`piarc_protocol::dev_server::DevServerStart`] in, its
    /// [`piarc_protocol::dev_server::DevServerState`] out.
    pub async fn start_dev_server(&self, request_json: String) -> Result<serde_json::Value> {
        let request: piarc_protocol::dev_server::DevServerStart =
            serde_json::from_str(&request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason: "must be { sessionId, name, agent?: { sessionId, toolCallId }, wait? }"
                    .into(),
            })?;
        let state = self
            .ctx
            .tool_io
            .start_dev_server(request)
            .await
            .map_err(|e| Error::feature(&e))?;
        encode(&state)
    }

    /// Stops session `session_id`'s server `name` with its process tree.
    pub async fn stop_dev_server(
        &self,
        session_id: String,
        name: String,
    ) -> Result<serde_json::Value> {
        let state = self
            .ctx
            .tool_io
            .stop_dev_server(&session_id, &name)
            .await
            .map_err(|e| Error::feature(&e))?;
        encode(&state)
    }
}
