//! The extension packages' entry points (T40): [`Hub`](crate::sessions::Hub)'s package
//! operations on the runtime, results as JSON.

use std::path::PathBuf;

use piarc_protocol::plugins::{PackageInstallRequest, PackageScope};

use super::CoreRuntime;
use crate::error::{Error, Result};

type Done = Box<dyn FnOnce(Result<serde_json::Value>) + Send + 'static>;

impl CoreRuntime {
    /// The installed packages as `workspace` (or the user settings) sees them
    /// (`PackagesList`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn packages_list(&self, workspace: Option<PathBuf>, on_done: Done) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.packages_list(workspace).await
        })
    }

    /// Installs a package, off (`PackageInstallResult`); `request_json` is a
    /// `PackageInstallRequest`.
    ///
    /// # Errors
    ///
    /// A malformed request; otherwise as [`open_workspace`](Self::open_workspace).
    pub fn package_install(&self, request_json: &str, on_done: Done) -> Result<()> {
        let request: PackageInstallRequest =
            serde_json::from_str(request_json).map_err(|e| Error::InvalidArgument {
                field: "request",
                reason: format!("not a package install request: {e}"),
            })?;
        self.on_sessions(on_done, move |hub| async move {
            hub.package_install(request).await
        })
    }

    /// Updates package `id` (`PackageInstallResult`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn package_update(
        &self,
        id: String,
        workspace: Option<PathBuf>,
        on_done: Done,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.package_update(id, workspace).await
        })
    }

    /// Turns package `id` on (confirming `confirm`) or off (`PackagesList`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn package_set_enabled(
        &self,
        id: String,
        enabled: bool,
        scope: &str,
        workspace: Option<PathBuf>,
        confirm: Vec<String>,
        on_done: Done,
    ) -> Result<()> {
        let scope = match scope {
            "user" => PackageScope::User,
            "project" => PackageScope::Project,
            _ => {
                return Err(Error::InvalidArgument {
                    field: "scope",
                    reason: "must be user or project".into(),
                });
            }
        };
        self.on_sessions(on_done, move |hub| async move {
            hub.package_set_enabled(id, enabled, scope, workspace, confirm)
                .await
        })
    }

    /// Confirms executable items of package `id` (`PackagesList`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn package_confirm(
        &self,
        id: String,
        items: Vec<String>,
        workspace: Option<PathBuf>,
        on_done: Done,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.package_confirm(id, items, workspace).await
        })
    }

    /// Uninstalls package `id` (`PackagesList`).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn package_uninstall(
        &self,
        id: String,
        workspace: Option<PathBuf>,
        on_done: Done,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.package_uninstall(id, workspace).await
        })
    }
}
