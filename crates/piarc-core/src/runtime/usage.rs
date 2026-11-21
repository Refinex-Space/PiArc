//! Usage and cost's entry points (T41): [`Hub`](crate::sessions::Hub)'s usage report and the
//! user's prices on the runtime, results as JSON.

use std::path::PathBuf;

use super::CoreRuntime;
use crate::error::{Error, Result};

type Done = Box<dyn FnOnce(Result<serde_json::Value>) + Send + 'static>;

impl CoreRuntime {
    /// Usage by model and by session (`UsageReport`), for every workspace or `workspace`'s.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn usage_report(&self, workspace: Option<PathBuf>, on_done: Done) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.usage_report(workspace).await
        })
    }

    /// One main session's usage (`SessionUsage`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn session_usage(&self, session_id: String, on_done: Done) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.session_usage(session_id).await
        })
    }

    /// Sets the user's price of `provider/model` (`price_json`: `{input, output, cacheRead,
    /// cacheWrite}` in USD per million tokens), or removes it (`None`).
    ///
    /// # Errors
    ///
    /// Malformed JSON; otherwise as [`open_workspace`](Self::open_workspace).
    pub fn set_model_price(
        &self,
        provider: String,
        model: String,
        price_json: Option<&str>,
        on_done: Done,
    ) -> Result<()> {
        let price = price_json
            .map(|text| {
                serde_json::from_str::<serde_json::Value>(text).map_err(|_| {
                    Error::InvalidArgument {
                        field: "price",
                        reason: "a JSON object".into(),
                    }
                })
            })
            .transpose()?;
        self.on_sessions(on_done, move |hub| async move {
            hub.set_model_price(provider, model, price).await
        })
    }
}
