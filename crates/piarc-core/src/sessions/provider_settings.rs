//! The settings Host is supervised but never opens a project or creates a Pi session. It
//! receives only the vault service as its inbound handler; session tools cannot run on it.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use piarc_host::{HostEvent, HostSupervisor};
use piarc_protocol::models::{
    CatalogProvider, CredentialStatusParams, ModelsCredential, ModelsCredentialStatus, ModelsList,
    ModelsListParams, ModelsReload, ModelsReloadParams,
};
use serde_json::{Value, json};

use super::{Hub, host_error, lock};
use crate::error::{Error, Result};
use crate::providers::{Operation, Settings, io_error};

impl Hub {
    pub async fn workspace_models(&self, path: PathBuf) -> Result<Value> {
        let host = self.workspace(path).await?.acquire().await?;
        let models = host
            .call::<ModelsList>(ModelsListParams { session_id: None })
            .await
            .map_err(host_error)?;
        Ok(json!(models))
    }

    /// A pending public change is resolved against the committed vault credential before a
    /// workspace Host is launched, or before another edit can replace the journal.
    pub(super) async fn recover_provider_settings(&self) -> Result<()> {
        let dir = self.ctx.storage.dirs().data();
        crate::providers::ensure_pi_defaults(dir)?;
        if !Settings::journal(dir).try_exists().map_err(io_error)? {
            return Ok(());
        }
        let mut settings = Settings::read(dir, self.ctx.catalog_network.load(Ordering::Acquire))?;
        if settings.pending() {
            let host = self.settings_host().await?;
            let result = self.recover(&mut settings, &host).await;
            host.shutdown().await;
            result?;
        }
        Ok(())
    }

    pub async fn provider_op(&self, op: Operation) -> Result<Value> {
        let _writer = self.ctx.provider_writer.lock().await;
        if self.ctx.cancel.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        crate::providers::ensure_pi_defaults(self.ctx.storage.dirs().data())?;
        let host = self.settings_host().await?;
        let result = self.run_provider_op(op, &host).await;
        host.shutdown().await;
        result
    }

    pub(super) async fn settings_host(&self) -> Result<HostSupervisor> {
        self.settings_host_with(Arc::new(self.ctx.secrets.clone()))
            .await
    }

    /// A settings Host answered by `inbound` (the vault, and during a sign-in its questions).
    pub(super) async fn settings_host_with(
        &self,
        inbound: Arc<dyn piarc_host::InboundHandler>,
    ) -> Result<HostSupervisor> {
        let launch = self
            .ctx
            .config
            .launch
            .as_ref()
            .ok_or_else(|| Error::Internal {
                reason: "no Agent Host configured".into(),
            })?;
        let dir = self.ctx.storage.dirs().data().to_owned();
        let root = dir.join("agent-host").join("settings");
        std::fs::create_dir_all(&root).map_err(io_error)?;
        let tune = self.ctx.config.tune_host.clone();
        let (host, mut events) =
            crate::agent_host::start_for(launch, root, dir, inbound, &|config| {
                // Catalog discovery for settings is local. A preference change refreshes workspaces.
                config.allow_model_network = None;
                if let Some(tune) = &tune {
                    tune(config);
                }
            })?;
        let result = tokio::select! {
            event=events.recv()=>match event{
                Some(HostEvent::Connected{..})=>Ok(()),
                Some(HostEvent::HandshakeRejected{error,..})=>Err(Error::feature(&error)),
                _=>Err(Error::Feature{kind:piarc_protocol::ErrorKind::HostUnavailable,retryable:true,message:"settings Agent Host failed to start".into(),details:None}),
            },
            ()=self.ctx.cancel.cancelled()=>Err(Error::ShuttingDown),
        };
        if let Err(error) = result {
            host.shutdown().await;
            return Err(error);
        }
        Ok(host)
    }

    async fn recover(&self, settings: &mut Settings, host: &HostSupervisor) -> Result<()> {
        let Some(id) = settings.pending_id() else {
            return Ok(());
        };
        let status = host
            .call::<ModelsCredentialStatus>(CredentialStatusParams {
                provider: id.into(),
            })
            .await
            .map_err(host_error)?;
        let committed = settings.committed(&status);
        let dir = self.ctx.storage.dirs().data();
        settings.project(dir, committed)?;
        settings.finish(committed);
        settings.persist(dir)?;
        self.reload_models(self.ctx.catalog_network.load(Ordering::Acquire))
            .await
    }

    async fn run_provider_op(&self, op: Operation, host: &HostSupervisor) -> Result<Value> {
        let dir = self.ctx.storage.dirs().data();
        let mut settings = Settings::read(dir, self.ctx.catalog_network.load(Ordering::Acquire))?;
        if settings.pending() {
            self.recover(&mut settings, host).await?;
        }
        let list = host
            .call::<ModelsList>(ModelsListParams { session_id: None })
            .await
            .map_err(host_error)?;
        let builtins = list.providers;
        match op {
            Operation::List => {}
            Operation::Refresh(enabled) => {
                settings.catalog_refresh = enabled;
                settings.persist(dir)?;
                self.ctx.catalog_network.store(enabled, Ordering::Release);
                self.reload_models(enabled).await?;
            }
            Operation::Preferences(prefs) => {
                let prefs = *prefs;
                settings.models = prefs.models;
                settings.auxiliary = prefs.auxiliary;
                settings.persist(dir)?;
                self.publish_preferences(&settings);
                self.reload_models(self.ctx.catalog_network.load(Ordering::Acquire))
                    .await?;
            }
            mutation => {
                self.change_provider(mutation, host, &mut settings, &builtins)
                    .await?
            }
        }
        let mut view = settings.view(&builtins);
        view["loginProviders"] = json!(list.login_providers);
        Ok(view)
    }

    async fn change_provider(
        &self,
        op: Operation,
        host: &HostSupervisor,
        settings: &mut Settings,
        builtins: &[CatalogProvider],
    ) -> Result<()> {
        let dir = self.ctx.storage.dirs().data();
        let params = settings.prepare(op, builtins)?;
        settings.write_pending(dir)?;
        // Pi's login needs to resolve a newly defined custom provider. Keep the previous
        // projection until after logout, so Pi can also resolve the provider being removed.
        if settings.saving() {
            settings.project(dir, true)?;
            host.call::<ModelsReload>(ModelsReloadParams {
                allow_network: false,
                preferences: None,
            })
            .await
            .map_err(host_error)?;
        }
        host.call::<ModelsCredential>(params)
            .await
            .map_err(host_error)?;
        settings.project(dir, true)?;
        settings.finish(true);
        settings.persist(dir)?;
        // A local endpoint's models are graded by the provider kind (T29).
        self.publish_preferences(settings);
        self.reload_models(self.ctx.catalog_network.load(Ordering::Acquire))
            .await
    }

    fn publish_preferences(&self, settings: &Settings) {
        *lock(&self.ctx.model_preferences) = settings.preferences();
    }

    pub(super) async fn reload_models(&self, allow_network: bool) -> Result<()> {
        let workspaces: Vec<_> = lock(&self.routes).workspaces.values().cloned().collect();
        let preferences = lock(&self.ctx.model_preferences).clone();
        let mut first_error = None;
        for ws in workspaces {
            if matches!(
                ws.view().await.host,
                super::HostState::Starting | super::HostState::Ready | super::HostState::Restarting
            ) {
                // A handshake already sent just before the setting changed may still be
                // initializing. Wait for that process and reload it before confirming the edit.
                let reload = async {
                    ws.acquire()
                        .await?
                        .call::<ModelsReload>(ModelsReloadParams {
                            allow_network,
                            preferences: Some(preferences.clone()),
                        })
                        .await
                        .map_err(host_error)
                }
                .await;
                if let Err(error) = reload {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}
