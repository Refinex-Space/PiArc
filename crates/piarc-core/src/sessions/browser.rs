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

    /// A file request of the agent's browser (stage an upload, save a download, B2.6.6).
    pub async fn browser_files(&self, request_json: String) -> Result<serde_json::Value> {
        let request: piarc_protocol::browser::BrowserFilesRequest =
            serde_json::from_str(&request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason: "must be { op: stage|save, sessionId, toolCallId, … }".into(),
            })?;
        let result = self
            .ctx
            .tool_io
            .browser_files(&request)
            .await
            .map_err(|e| Error::feature(&e))?;
        serde_json::to_value(result).map_err(|e| Error::Internal {
            reason: e.to_string(),
        })
    }

    /// What the user changed in a session's browser since the agent's last call (B2.7.3): kept
    /// as the session's `browserState` reminder.
    pub fn browser_state(&self, request_json: &str) -> Result<()> {
        let update: piarc_protocol::browser::BrowserStateUpdate =
            serde_json::from_str(request_json).map_err(|_| Error::InvalidArgument {
                field: "request",
                reason: "must be { sessionId, spaces, userTabs }".into(),
            })?;
        self.ctx
            .tool_io
            .browser_state(&update)
            .map_err(|e| Error::feature(&e))
    }

    /// Where the downloads of a session's agent tabs go.
    pub fn browser_downloads_dir(&self, session_id: &str) -> Result<String> {
        self.ctx
            .tool_io
            .browser_downloads_dir(session_id)
            .map(|path| piarc_fs::display(&path))
            .map_err(|e| Error::feature(&e))
    }

    /// Stops a browser partition's proxy; `{ stopped }`.
    pub async fn stop_browser_proxy(&self, partition: String) -> Result<serde_json::Value> {
        let stopped = self.ctx.browser.stop(&partition).await;
        Ok(serde_json::json!({ "stopped": stopped }))
    }
}
