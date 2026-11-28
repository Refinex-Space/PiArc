//! The enhanced model's download (ADR-0097): one at a time, file by file into the staging
//! directory with `piarc_web::download`, then verified and moved into place by
//! `piarc_speech::models::EnhancedStore::activate_staged`. Progress goes to `core/speech` at
//! most every 250 ms; closing the settings page does not stop it, `cancel` does.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use piarc_protocol::dictation::{SpeechModelState, SpeechModels};
use piarc_speech::models::{EnhancedStore, enhanced_manifest};
use piarc_web::download::{DownloadError, DownloadJob, Downloader};
use tokio_util::sync::CancellationToken;

/// Least time between two progress broadcasts.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// What the download is doing, for the models' status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadState {
    /// Running: bytes on disk so far.
    pub received: Option<u64>,
    /// Verifying the finished files.
    pub verifying: bool,
    /// The last failure's code (`network`, `checksum`, `cancelled`…).
    pub error: Option<String>,
}

/// The single download slot.
#[derive(Default)]
pub struct Downloads {
    state: Mutex<DownloadState>,
    cancel: Mutex<Option<CancellationToken>>,
}

impl Downloads {
    /// The current state.
    pub fn state(&self) -> DownloadState {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set(&self, change: impl FnOnce(&mut DownloadState)) {
        change(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// Claims the slot; `None` when a download already runs.
    pub fn begin(&self) -> Option<CancellationToken> {
        let mut cancel = self.cancel.lock().unwrap_or_else(PoisonError::into_inner);
        if cancel.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        *cancel = Some(token.clone());
        self.set(|s| {
            *s = DownloadState {
                received: Some(0),
                verifying: false,
                error: None,
            };
        });
        Some(token)
    }

    /// Cancels a running download; whether one ran.
    pub fn cancel(&self) -> bool {
        self.cancel
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .inspect(|token| token.cancel())
            .is_some()
    }

    fn finish(&self, error: Option<String>) {
        *self.cancel.lock().unwrap_or_else(PoisonError::into_inner) = None;
        self.set(|s| {
            *s = DownloadState {
                received: None,
                verifying: false,
                error,
            };
        });
    }

    /// Applies the download's state to the enhanced model's status.
    pub fn apply(&self, models: &mut SpeechModels) {
        let state = self.state();
        for model in &mut models.models {
            if model.kind != piarc_protocol::dictation::SpeechModelKind::Enhanced {
                continue;
            }
            if state.verifying {
                model.state = SpeechModelState::Verifying;
            } else if let Some(received) = state.received {
                model.state = SpeechModelState::Downloading;
                model.received_bytes = Some(received);
            } else if let Some(error) = &state.error {
                if model.state != SpeechModelState::Ready {
                    model.state = SpeechModelState::Failed;
                }
                model.error = Some(error.clone());
            }
        }
    }
}

/// Downloads every file of the enhanced manifest into `store`'s staging directory, verifies
/// and activates it. `proxy` is Core's effective proxy; `broadcast` is called with progress.
pub async fn run(
    downloads: Arc<Downloads>,
    store: EnhancedStore,
    proxy: Option<String>,
    cancel: CancellationToken,
    broadcast: Arc<dyn Fn() + Send + Sync>,
) {
    let result = download_all(&downloads, &store, proxy.as_deref(), &cancel, &broadcast).await;
    let error = match result {
        Ok(()) => {
            downloads.set(|s| {
                s.received = None;
                s.verifying = true;
            });
            broadcast();
            let activated = {
                let store = store.clone();
                tokio::task::spawn_blocking(move || store.activate_staged()).await
            };
            match activated {
                Ok(Ok(())) => None,
                Ok(Err(_)) => Some("checksum".to_owned()),
                Err(_) => Some("disk".to_owned()),
            }
        }
        Err(error) => {
            if matches!(error, DownloadError::Cancelled | DownloadError::Checksum) {
                store.clean_staging();
            }
            Some(error.code().to_owned())
        }
    };
    downloads.finish(error);
    broadcast();
}

async fn download_all(
    downloads: &Arc<Downloads>,
    store: &EnhancedStore,
    proxy: Option<&str>,
    cancel: &CancellationToken,
    broadcast: &Arc<dyn Fn() + Send + Sync>,
) -> Result<(), DownloadError> {
    let manifest = enhanced_manifest();
    let downloader = Downloader::new()?;
    let staging = store.staging_dir();
    let allows = |host: &str| manifest.allows_host(host);
    let mut done = 0_u64;
    for file in &manifest.files {
        let dest = EnhancedStore::file_path(&staging, &file.path)
            .map_err(|_| DownloadError::Refused("manifest path"))?;
        let job = DownloadJob {
            url: &file.url,
            dest: &dest,
            size: file.size,
            sha256: &file.sha256,
            allows_host: &allows,
            proxy,
        };
        let last = Mutex::new(Instant::now() - PROGRESS_EVERY);
        let base = done;
        let progress = |bytes: u64| {
            downloads.set(|s| s.received = Some(base + bytes));
            let mut at = last.lock().unwrap_or_else(PoisonError::into_inner);
            if at.elapsed() >= PROGRESS_EVERY {
                *at = Instant::now();
                broadcast();
            }
        };
        downloader.download(&job, cancel, &progress).await?;
        done += file.size;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_download_at_a_time_and_cancel_reaches_it() {
        let downloads = Downloads::default();
        let token = downloads.begin().expect("first");
        assert!(downloads.begin().is_none());
        assert!(downloads.cancel());
        assert!(token.is_cancelled());
        downloads.finish(Some("cancelled".into()));
        assert_eq!(downloads.state().error.as_deref(), Some("cancelled"));
        assert!(downloads.begin().is_some());
    }
}
