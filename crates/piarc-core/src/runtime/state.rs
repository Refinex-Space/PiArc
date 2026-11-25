//! Runtime entry points for storage, trust and workspace settings.
use super::CoreRuntime;
use crate::error::{Error, Result};
use crate::storage::{Storage, report_json};
use crate::trust::{TrustService, TrustView};
use crate::workspace_settings::WorkspaceSettings;
use std::path::PathBuf;
impl CoreRuntime {
    /// The database, when Core was started with a data directory.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`].
    pub fn storage(&self) -> Result<Storage> {
        self.services().map(|s| s.storage)
    }

    /// Project trust, when Core was started with a data directory. Its
    /// [`TrustService::trust_get`] answers the Agent Host's `trust/get`.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`].
    pub fn trust(&self) -> Result<TrustService> {
        self.services().map(|s| s.trust)
    }

    /// Loads the settings of `workspace` and keeps them current; changes arrive as events on
    /// the route `core/settings` ([`crate::workspace_settings`]).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`], or a watcher that cannot start.
    pub async fn open_settings(&self, workspace: PathBuf) -> Result<WorkspaceSettings> {
        self.ensure_running()?;
        let services = self.services()?;
        let dirs = services.storage.dirs().clone();
        let events = self.shared.events.clone();
        self.shared
            .handle
            .spawn(async move {
                WorkspaceSettings::open(&dirs, workspace, services.trust, events, true).await
            })
            .await
            .map_err(|e| Error::Internal {
                reason: format!("opening settings failed: {e}"),
            })?
    }

    /// The user's settings file as JSON (the client reads its preferences from it).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; reading errors go to `on_done`.
    pub fn user_settings(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.client_settings_job(on_done, crate::client_settings::read)
    }

    /// Writes one client preference (`pointer` under [`crate::client_settings::CLIENT_KEYS`];
    /// `None` removes it) and answers with the file's new content.
    ///
    /// # Errors
    ///
    /// As [`user_settings`](Self::user_settings).
    pub fn write_client_setting(
        &self,
        pointer: String,
        value: Option<serde_json::Value>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        let managed = self.storage()?.dirs().managed().clone();
        // A new proxy choice reaches the Agent Hosts (ADR-0082).
        let hub = pointer
            .starts_with("/proxy")
            .then(|| self.services().map(|s| s.sessions))
            .transpose()?;
        self.client_settings_job(on_done, move |dir| {
            let written = crate::client_settings::write(dir, &managed, &pointer, value)?;
            if let Some(hub) = &hub {
                hub.refresh_network();
            }
            Ok(written)
        })
    }

    /// Records the system's proxy as the main process resolved it (`None`: direct); with the
    /// proxy choice at `auto`, the workspaces' Agent Hosts restart with it once idle
    /// (ADR-0082).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn set_system_proxy(&self, url: Option<String>) -> Result<()> {
        self.ensure_running()?;
        let hub = self.services()?.sessions;
        hub.proxy().set_system(url.as_deref());
        hub.refresh_network();
        Ok(())
    }

    /// Reads or updates local Markdown image storage. Only the native host supplies folder grants.
    ///
    /// # Errors
    /// Invalid preferences or directory identity, inaccessible storage, managed setting, or shutdown.
    pub fn markdown_image_settings(
        &self,
        request: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        let managed = self.storage()?.dirs().managed().clone();
        self.client_settings_job(on_done, move |dir| {
            crate::markdown_images::update(dir, &managed, &request)
        })
    }

    fn client_settings_job(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
        job: impl FnOnce(&std::path::Path) -> Result<serde_json::Value> + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let data = self.storage()?.dirs().data().to_owned();
        self.shared.handle.spawn(async move {
            let result = tokio::task::spawn_blocking(move || job(&data))
                .await
                .map_err(|e| Error::Internal {
                    reason: format!("a settings task failed: {e}"),
                });
            on_done(result.and_then(|r| r));
        });
        Ok(())
    }

    /// Rebuilds the session index from Pi's files (the "rebuild index" diagnostic action)
    /// and calls `on_done` with the report as JSON.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; the rebuild's errors go to
    /// `on_done`.
    pub fn rebuild_session_index(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let storage = self.storage()?;
        self.shared.handle.spawn(async move {
            on_done(
                storage
                    .rebuild_session_index()
                    .await
                    .map(|r| report_json(&r)),
            );
        });
        Ok(())
    }

    /// The trust view of `path` (`decide`: `None` reads it, `Some(trusted)` records the user's
    /// decision first; [`revoke_trust`](Self::revoke_trust) forgets it), for the client.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`], [`Error::InvalidArgument`] for a
    /// relative path; lookup errors go to `on_done`.
    pub fn trust_view(
        &self,
        path: PathBuf,
        decide: Option<(bool, String)>,
        on_done: impl FnOnce(Result<TrustView>) + Send + 'static,
    ) -> Result<()> {
        let trust = self.trust_for(&path)?;
        let hub = self.services()?.sessions;
        self.shared.handle.spawn(async move {
            let result = match &decide {
                None => trust.view(&path).await,
                Some((trusted, version)) => trust.decide(&path, *trusted, version).await,
            };
            if let Ok(view) = &result
                && view.applied
            {
                hub.trust_changed(std::path::Path::new(&view.checkout))
                    .await;
            }
            on_done(result);
        });
        Ok(())
    }

    /// Revokes the trust decision of the project containing `path`; the open workspaces of the
    /// project restart their Agent Host without project resources before this answers.
    ///
    /// # Errors
    ///
    /// As [`trust_view`](Self::trust_view).
    pub fn revoke_trust(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<TrustView>) + Send + 'static,
    ) -> Result<()> {
        let trust = self.trust_for(&path)?;
        let hub = self.services()?.sessions;
        self.shared.handle.spawn(async move {
            let result = trust.revoke(&path).await;
            if let Ok(view) = &result {
                hub.trust_changed(std::path::Path::new(&view.checkout))
                    .await;
            }
            on_done(result);
        });
        Ok(())
    }

    fn trust_for(&self, path: &std::path::Path) -> Result<TrustService> {
        self.ensure_running()?;
        if !path.is_absolute() {
            return Err(Error::InvalidArgument {
                field: "path",
                reason: "must be an absolute path".into(),
            });
        }
        self.trust()
    }
}
