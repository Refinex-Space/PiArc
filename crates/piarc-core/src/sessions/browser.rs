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

    /// Stops a browser partition's proxy; `{ stopped }`.
    pub async fn stop_browser_proxy(&self, partition: String) -> Result<serde_json::Value> {
        let stopped = self.ctx.browser.stop(&partition).await;
        Ok(serde_json::json!({ "stopped": stopped }))
    }
}
