//! The Pi package market's entry points (ADR-0102): [`Hub`](crate::sessions::Hub)'s market
//! operations on the runtime, results as JSON.

use std::path::PathBuf;

use piarc_protocol::market::{MarketInstallRequest, MarketQuery};

use super::CoreRuntime;
use crate::error::{Error, Result};

impl CoreRuntime {
    /// One page of the market (`MarketPage`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn market_query(
        &self,
        query_json: &str,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        let query: MarketQuery =
            serde_json::from_str(query_json).map_err(|e| Error::InvalidArgument {
                field: "query",
                reason: format!("not a market query: {e}"),
            })?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.market_query(query).await },
        )
    }

    /// One package's details (`MarketDetail`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn market_detail(
        &self,
        name: String,
        workspace: Option<PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.market_detail(name, workspace).await
        })
    }

    /// Syncs the catalog now; answers its status (`MarketStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn market_refresh(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            move |hub| async move { hub.market_refresh().await },
        )
    }

    /// Installs a market package off (`PackageInstallResult`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn market_install(
        &self,
        request_json: &str,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        let request: MarketInstallRequest =
            serde_json::from_str(request_json).map_err(|e| Error::InvalidArgument {
                field: "request",
                reason: format!("not a market install request: {e}"),
            })?;
        self.on_sessions(on_done, move |hub| async move {
            hub.market_install(request).await
        })
    }
}
