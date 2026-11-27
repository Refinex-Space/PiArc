//! Runtime entry points of voice dictation (ADR-0094, voice dictation addendum 4.5, 4.6).
//! Every method returns at once; work that reads files or waits on the audio system runs on
//! the blocking pool and answers through its callback.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_protocol::dictation::{
    DictationStart, DictationStarted, DictationStatus, InputDevice, SpeechModels, StopMode,
};

use super::CoreRuntime;
use crate::dictation::VoicePreferences;
use crate::error::{Error, Result};

/// The user's dictation preferences (defaults without a data directory or settings file).
fn read_preferences(data: Option<&Path>) -> VoicePreferences {
    data.and_then(|dir| crate::client_settings::read(dir).ok())
        .map(|settings| VoicePreferences::from_settings(&settings))
        .unwrap_or_default()
}

impl CoreRuntime {
    /// The data directory, when Core has one.
    fn data_dir(&self) -> Option<PathBuf> {
        self.storage().ok().map(|s| s.dirs().data().to_owned())
    }

    /// Starts a dictation for `request` (the main process filled `window_id`); answers with
    /// the session id and its route. Vocabulary from `request.workspace` is used only when the
    /// project is trusted (`piarc_config::project_trust`, through [`crate::trust`]).
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`]; the service's refusals go to `on_done`.
    pub fn dictation_start(
        &self,
        request: DictationStart,
        on_done: impl FnOnce(Result<DictationStarted>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        // Not `Arc<Shared>`: dropping it on a runtime thread would stop the runtime.
        let dictation = Arc::clone(&self.shared.dictation);
        let data = self.data_dir();
        let trust = self.trust().ok();
        self.shared.handle.spawn(async move {
            let workspace = match (&request.workspace, trust) {
                (Some(dir), Some(trust)) if !request.test => {
                    let dir = PathBuf::from(dir);
                    trust.state(&dir).await.is_trusted().then_some(dir)
                }
                _ => None,
            };
            let result = tokio::task::spawn_blocking(move || {
                let preferences = read_preferences(data.as_deref());
                dictation.start(&request, &preferences, workspace.as_deref())
            })
            .await
            .map_err(|e| Error::Internal {
                reason: format!("starting dictation failed: {e}"),
            });
            on_done(result.and_then(|r| r));
        });
        Ok(())
    }

    /// Stops session `session` of window `window`.
    ///
    /// # Errors
    ///
    /// `notFound` when it is not that window's running session.
    pub fn dictation_stop(&self, window: u64, session: &str, mode: StopMode) -> Result<()> {
        self.ensure_running()?;
        self.shared.dictation.stop(window, session, mode)
    }

    /// Cancels session `session` of window `window`.
    ///
    /// # Errors
    ///
    /// As [`dictation_stop`](Self::dictation_stop).
    pub fn dictation_cancel(&self, window: u64, session: &str) -> Result<()> {
        self.ensure_running()?;
        self.shared.dictation.cancel(window, session)
    }

    /// Window `window` is gone (closed, reloaded or crashed): its dictation ends.
    pub fn dictation_release(&self, window: u64) {
        self.shared.dictation.release(window);
    }

    /// The running dictation, if any.
    #[must_use]
    pub fn dictation_status(&self) -> DictationStatus {
        self.shared.dictation.status()
    }

    /// Lists input devices.
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`]; audio system errors go to `on_done`.
    pub fn speech_devices(
        &self,
        on_done: impl FnOnce(Result<Vec<InputDevice>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let dictation = Arc::clone(&self.shared.dictation);
        self.shared.handle.spawn(async move {
            let result = tokio::task::spawn_blocking(move || dictation.devices())
                .await
                .map_err(|e| Error::Internal {
                    reason: format!("listing devices failed: {e}"),
                });
            on_done(result.and_then(|r| r));
        });
        Ok(())
    }

    /// The speech models' state (also broadcast on `core/speech`).
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`].
    pub fn speech_models(
        &self,
        on_done: impl FnOnce(Result<SpeechModels>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let dictation = Arc::clone(&self.shared.dictation);
        let data = self.data_dir();
        self.shared.handle.spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                let models = dictation.models(&read_preferences(data.as_deref()));
                dictation.broadcast(&models);
                models
            })
            .await
            .map_err(|e| Error::Internal {
                reason: format!("reading speech models failed: {e}"),
            });
            on_done(result);
        });
        Ok(())
    }

    /// One action on a speech model: `download` (enhanced, single-flight, runs on until done
    /// or cancelled), `cancel`, `delete` (enhanced; the main process confirmed natively),
    /// `verify`. Answers with the models' state; progress follows on `core/speech`.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for an unknown model or action, [`Error::ShuttingDown`];
    /// refusals (`busy`) go to `on_done`.
    pub fn speech_model_action(
        &self,
        model: &str,
        action: &str,
        on_done: impl FnOnce(Result<SpeechModels>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let enhanced = match model {
            piarc_speech::models::ENHANCED_MODEL_ID => true,
            piarc_speech::models::BASE_MODEL_ID => false,
            _ => {
                return Err(Error::InvalidArgument {
                    field: "model",
                    reason: "unknown speech model".into(),
                });
            }
        };
        if !matches!(action, "download" | "cancel" | "delete" | "verify")
            || (!enhanced && action != "verify")
        {
            return Err(Error::InvalidArgument {
                field: "action",
                reason: "not an action of this model".into(),
            });
        }
        let dictation = Arc::clone(&self.shared.dictation);
        let data = self.data_dir();
        let proxy = match (self.services().ok(), data.as_deref()) {
            (Some(services), Some(dir)) => services.sessions.proxy().effective(dir),
            _ => None,
        };
        let action = action.to_owned();
        self.shared.handle.spawn(async move {
            let report = {
                let dictation = Arc::clone(&dictation);
                let data = data.clone();
                move || {
                    let models = dictation.models(&read_preferences(data.as_deref()));
                    dictation.broadcast(&models);
                    models
                }
            };
            let outcome =
                run_model_action(&dictation, &action, enhanced, proxy, report.clone()).await;
            let models = tokio::task::spawn_blocking(report)
                .await
                .map_err(|e| Error::Internal {
                    reason: format!("reading speech models failed: {e}"),
                });
            on_done(outcome.and(models));
        });
        Ok(())
    }

    /// Re-reads the preferences after a `voiceDictation` change: turning the feature off stops
    /// any session (keeping its text) and frees the models.
    pub(crate) fn voice_preferences_changed(
        dictation: &crate::dictation::DictationService,
        data: &Path,
    ) {
        if !read_preferences(Some(data)).enabled {
            dictation.disable();
        }
    }

    /// Development builds: the open input fails like a removed microphone.
    pub fn dictation_fail_device(&self) {
        self.shared.dictation.fail_device();
    }
}

/// Runs one model action (see [`CoreRuntime::speech_model_action`]).
async fn run_model_action(
    dictation: &Arc<crate::dictation::DictationService>,
    action: &str,
    enhanced: bool,
    proxy: Option<String>,
    report: impl Fn() -> SpeechModels + Send + Sync + 'static,
) -> Result<()> {
    match action {
        "download" => {
            let Some(cancel) = dictation.downloads.begin() else {
                return Err(crate::dictation::speech_error(
                    &piarc_speech::SpeechError::Busy,
                ));
            };
            let broadcast: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                let _ = report();
            });
            tokio::spawn(crate::dictation::download::run(
                Arc::clone(&dictation.downloads),
                dictation.enhanced_store(),
                proxy,
                cancel,
                broadcast,
            ));
            Ok(())
        }
        "cancel" => {
            dictation.downloads.cancel();
            Ok(())
        }
        "delete" => {
            let dictation = Arc::clone(dictation);
            tokio::task::spawn_blocking(move || dictation.delete_enhanced())
                .await
                .unwrap_or_else(|e| {
                    Err(Error::Internal {
                        reason: format!("deleting the model failed: {e}"),
                    })
                })
        }
        _ => {
            let dictation = Arc::clone(dictation);
            tokio::task::spawn_blocking(move || dictation.verify(enhanced))
                .await
                .unwrap_or_else(|e| {
                    Err(Error::Internal {
                        reason: format!("verifying the model failed: {e}"),
                    })
                })
        }
    }
}
