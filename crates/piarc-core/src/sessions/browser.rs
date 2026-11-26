//! The built-in browser's requests from the main process (ADR-0088).

use super::Hub;
use crate::browser::BrowserProxyRequest;
use crate::error::{Error, Result};

impl Hub {
    /// The port of a browser partition's proxy; JSON `{ partition, localNames, deniedPorts }`
    /// in, `{ port }` out.
    pub async fn browser_proxy(&self, request_json: String) -> Result<serde_json::Value> {
        let request: BrowserProxyRequest =
            serde_json::from_str(&request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason: "must be { partition, localNames, deniedPorts }".into(),
            })?;
        let port = self.ctx.browser.port(request).await?;
        Ok(serde_json::json!({ "port": port }))
    }

    /// The desktop client runs `Browser` scripts from now on (ADR-0089).
    pub fn attach_browser_client(&self) {
        self.ctx.tool_io.attach_browser_client();
    }

    /// The client's answer to a run; whether a run was waiting for it.
    pub fn answer_browser_run(&self, run_id: &str, answer_json: &str) -> Result<bool> {
        let answer: piarc_protocol::browser::BrowserRunAnswer =
            serde_json::from_str(answer_json).map_err(|_| Error::InvalidArgument {
                field: "answer",
                reason: "must be { output, images?, error?, blockedHosts? }".into(),
            })?;
        Ok(self.ctx.tool_io.answer_browser_run(run_id, answer))
    }

    /// Whether a page of a running `Browser` call may reach a host (site cards, ADR-0089).
    pub async fn browser_site(&self, request_json: String) -> Result<serde_json::Value> {
        let request: piarc_protocol::browser::BrowserSiteRequest =
            serde_json::from_str(&request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason:
                    "must be { sessionId, toolCallId, url, host, local?, sensitive?, pending? }"
                        .into(),
            })?;
        let decision = self
            .ctx
            .tool_io
            .browser_site(&request)
            .await
            .map_err(|e| Error::feature(&e))?;
        serde_json::to_value(decision).map_err(|e| Error::Internal {
            reason: e.to_string(),
        })
    }

    /// Stops a browser partition's proxy; `{ stopped }`.
    pub async fn stop_browser_proxy(&self, partition: String) -> Result<serde_json::Value> {
        let stopped = self.ctx.browser.stop(&partition).await;
        Ok(serde_json::json!({ "stopped": stopped }))
    }
}
