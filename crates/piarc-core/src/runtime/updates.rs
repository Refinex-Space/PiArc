//! In-app updates' entry points (ADR-0111): [`Hub`](crate::sessions::Hub)'s update operations
//! on the runtime, results as JSON.

use super::CoreRuntime;
use crate::error::Result;

impl CoreRuntime {
    /// The update status (`UpdateStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn update_status(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move { hub.update_status() })
    }

    /// Reads the latest release (`UpdateStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn check_for_updates(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            move |hub| async move { hub.check_for_updates().await },
        )
    }

    /// Starts downloading the newer release (`UpdateStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn download_update(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move { hub.download_update() })
    }

    /// Cancels the running download (`UpdateStatus`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn cancel_update_download(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            move |hub| async move { hub.cancel_update_download() },
        )
    }

    /// The verified files of the ready release (`UpdateInstall`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn update_install_plan(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.update_install_plan().await
        })
    }
}
