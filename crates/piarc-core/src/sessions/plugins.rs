//! The settings window's extension packages (T40, ADR-0058): listing, installing, updating,
//! turning on and off, confirming and uninstalling. After a change every running Agent Host
//! hears `resources/reload` (skills, commands, subagent definitions, MCP servers and Pi
//! extensions are read again), so nothing waits for a restart.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_protocol::plugins::{PackageInstallRequest, PackageScope};
use piarc_protocol::skills::{ResourcesReload, ResourcesReloadParams};
use serde::Serialize;
use serde_json::Value;

use super::Hub;
use crate::error::{Error, Result};
use crate::plugins::PluginManager;

fn encode(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the packages: {e}"),
    })
}

impl Hub {
    pub(super) fn plugins(&self) -> PluginManager {
        PluginManager::new(
            self.ctx.storage.clone(),
            self.ctx.trust.clone(),
            self.ctx.tool_io.clone(),
            self.ctx.config.launch.as_ref().and_then(|l| l.node()),
            Arc::new(piarc_exec::ProcessTreeSpawner),
        )
        .with_npm_lock(self.ctx.npm_lock.clone())
        .with_proxy(self.ctx.proxy.effective(self.ctx.storage.dirs().data()))
    }

    /// Tells every running Agent Host to read its resources again.
    pub(super) async fn packages_changed(&self) {
        let handles: Vec<_> = self
            .routes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .workspaces
            .values()
            .cloned()
            .collect();
        for handle in handles {
            if let Some(supervisor) = handle.peek().await
                && let Err(error) = supervisor
                    .call::<ResourcesReload>(ResourcesReloadParams {})
                    .await
            {
                tracing::debug!(target: "piarc_core::sessions", "resources/reload after a package change: {error}");
            }
        }
    }

    /// The installed packages as `workspace` (or the user settings) sees them.
    pub async fn packages_list(&self, workspace: Option<PathBuf>) -> Result<Value> {
        encode(&self.plugins().list(workspace.as_deref()).await?)
    }

    /// Installs a package (off).
    pub async fn package_install(&self, request: PackageInstallRequest) -> Result<Value> {
        let result = self.plugins().install(request).await?;
        self.packages_changed().await;
        encode(&result)
    }

    /// Updates package `id`; new executable items wait for confirmation.
    pub async fn package_update(&self, id: String, workspace: Option<PathBuf>) -> Result<Value> {
        let result = self.plugins().update(&id, workspace.as_deref()).await?;
        self.packages_changed().await;
        encode(&result)
    }

    /// Turns package `id` on (confirming `confirm`) or off in `scope`.
    pub async fn package_set_enabled(
        &self,
        id: String,
        enabled: bool,
        scope: PackageScope,
        workspace: Option<PathBuf>,
        confirm: Vec<String>,
    ) -> Result<Value> {
        let list = self
            .plugins()
            .set_enabled(&id, enabled, scope, workspace.as_deref(), &confirm)
            .await?;
        self.packages_changed().await;
        encode(&list)
    }

    /// Confirms executable items of package `id`.
    pub async fn package_confirm(
        &self,
        id: String,
        items: Vec<String>,
        workspace: Option<PathBuf>,
    ) -> Result<Value> {
        let list = self
            .plugins()
            .confirm(&id, &items, workspace.as_deref())
            .await?;
        self.packages_changed().await;
        encode(&list)
    }

    /// Uninstalls package `id`.
    pub async fn package_uninstall(&self, id: String, workspace: Option<PathBuf>) -> Result<Value> {
        let list = self
            .plugins()
            .uninstall(&id, workspace.as_deref().map(Path::new))
            .await?;
        self.packages_changed().await;
        encode(&list)
    }
}
