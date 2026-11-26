//! Chrome sign-in import (ADR-0090): the runtime's entry points for the main process.

use std::path::PathBuf;

use zeroize::Zeroizing;

use super::CoreRuntime;
use crate::error::Result;

impl CoreRuntime {
    /// Chrome's profiles: `{ chrome, profiles: [{ id, name }] }`.
    ///
    /// # Errors
    ///
    /// [`crate::Error::NoDataDirectory`], [`crate::Error::ShuttingDown`]; the rest goes to
    /// `on_done`.
    pub fn chrome_profiles(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, |hub| async move { hub.chrome_profiles().await })
    }

    /// The sites of a Chrome profile with cookie counts: `{ sites: [{ site, count }] }`.
    ///
    /// # Errors
    ///
    /// As [`Self::chrome_profiles`].
    pub fn chrome_sites(
        &self,
        profile: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            |hub| async move { hub.chrome_sites(profile).await },
        )
    }

    /// Imports the chosen sites after the user's confirmation: JSON `{ workspace, profile,
    /// sites }` in; JSON text `{ cookies, sites }` out, in a zeroizing buffer (the cookie
    /// values are secrets for the main process only).
    ///
    /// # Errors
    ///
    /// As [`Self::chrome_profiles`].
    pub fn chrome_import(
        &self,
        request_json: String,
        on_done: impl FnOnce(Result<Zeroizing<String>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let hub = self.services()?.sessions;
        self.shared
            .handle
            .spawn(async move { on_done(hub.chrome_import(request_json).await) });
        Ok(())
    }

    /// The imported sites of a workspace: `{ imports: [{ site, count, profile, importedAt }] }`.
    ///
    /// # Errors
    ///
    /// As [`Self::chrome_profiles`].
    pub fn browser_imports(
        &self,
        workspace: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, |hub| async move {
            hub.browser_imports(workspace).await
        })
    }

    /// Forgets an imported site (its cookies were removed from the partition): `{ forgot }`.
    ///
    /// # Errors
    ///
    /// As [`Self::chrome_profiles`].
    pub fn forget_browser_import(
        &self,
        workspace: PathBuf,
        site: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, |hub| async move {
            hub.forget_browser_import(workspace, site).await
        })
    }
}
