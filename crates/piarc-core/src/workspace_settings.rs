//! A workspace's settings kept current: `piarc_config::Settings` reloaded when its files
//! change (`piarc_fs::watch`) or the project's trust changes, with an event on
//! [`SETTINGS_ROUTE`] for every change.
//!
//! piarc-config and piarc-fs do not depend on each other: this module forwards the watcher's
//! notifications to the settings. Changes are debounced ([`DEBOUNCE`]): an editor's save
//! arrives as several notifications.
//!
//! Event payload: `{ "workspace": <path>, "changed": [<JSON Pointer>...], "issues": [...] }`
//! (`piarc_config::Issue`: `layer`, `file`, `pointer`, `message`, `severity`). An event is sent
//! when merged values changed or the problems of the files changed; an invalid file keeps its
//! last valid content, so its event has issues and no changed keys.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use piarc_config::{Issue, LayerTable, Settings, TrustState};
use piarc_fs::watch::{WatchEvent, Watcher};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::dirs::DataDirs;
use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::trust::TrustService;

/// Route of settings change events.
pub const SETTINGS_ROUTE: &str = "core/settings";

/// Quiet time after the last file notification before the files are read again.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// One workspace's settings. Dropping it stops watching.
pub struct WorkspaceSettings {
    inner: Arc<Mutex<Settings>>,
    workspace: PathBuf,
    task: JoinHandle<()>,
    _watcher: Arc<Mutex<Watcher>>,
}

impl std::fmt::Debug for WorkspaceSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceSettings")
            .field("workspace", &self.workspace)
            .finish_non_exhaustive()
    }
}

impl Drop for WorkspaceSettings {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl WorkspaceSettings {
    /// Loads the settings of `workspace` and starts watching their files.
    pub(crate) async fn open(
        dirs: &DataDirs,
        workspace: PathBuf,
        trust: TrustService,
        events: EventSender,
    ) -> Result<Self> {
        let state = trust.state(&workspace).await;
        let table = LayerTable::piarc(dirs.data(), &workspace);
        let settings = tokio::task::spawn_blocking(move || Settings::load(table, state))
            .await
            .map_err(|e| Error::Internal {
                reason: format!("loading settings failed: {e}"),
            })?;
        for issue in settings.issues() {
            log_issue(issue);
        }
        let inner = Arc::new(Mutex::new(settings));
        let (tx, rx) = mpsc::unbounded_channel();
        let watcher = Watcher::new(move |event| {
            if let WatchEvent::Error(reason) = &event {
                tracing::warn!(target: "piarc_core::settings", "settings watcher: {reason}");
            }
            // The receiver lives as long as the task; after that nobody needs the event.
            let _ = tx.send(());
        })
        .map_err(|e| Error::Internal {
            reason: e.to_string(),
        })?;
        let watcher = Arc::new(Mutex::new(watcher));
        watch_dirs(&watcher, &inner, &workspace);
        let task = tokio::spawn(run(Loop {
            inner: Arc::clone(&inner),
            watcher: Arc::clone(&watcher),
            workspace: workspace.clone(),
            trust,
            events,
            notifications: rx,
        }));
        Ok(Self {
            inner,
            workspace,
            task,
            _watcher: watcher,
        })
    }

    /// The merged settings now.
    #[must_use]
    pub fn merged(&self) -> Value {
        lock(&self.inner).merged().clone()
    }

    /// Problems of the last read.
    #[must_use]
    pub fn issues(&self) -> Vec<Issue> {
        lock(&self.inner).issues().to_vec()
    }

    /// The trust the merge was made for.
    #[must_use]
    pub fn trust(&self) -> TrustState {
        lock(&self.inner).trust()
    }

    /// Sets (`Some`) or removes (`None`) a value in a writable layer (`user`, `project`,
    /// `projectLocal`); the watcher then reloads and reports the change.
    ///
    /// # Errors
    ///
    /// [`Error::Feature`] for a read-only or unknown layer, a bad pointer or an I/O failure.
    pub async fn write(&self, layer: &str, pointer: &str, value: Option<Value>) -> Result<PathBuf> {
        let inner = Arc::clone(&self.inner);
        let (layer, pointer) = (layer.to_owned(), pointer.to_owned());
        tokio::task::spawn_blocking(move || {
            let settings = lock(&inner);
            piarc_config::write_value(settings.table(), &layer, &pointer, value)
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("writing settings failed: {e}"),
        })?
        .map_err(Error::from)
    }
}

struct Loop {
    inner: Arc<Mutex<Settings>>,
    watcher: Arc<Mutex<Watcher>>,
    workspace: PathBuf,
    trust: TrustService,
    events: EventSender,
    notifications: mpsc::UnboundedReceiver<()>,
}

async fn run(mut state: Loop) {
    let mut trust_changes = state.trust.subscribe();
    loop {
        tokio::select! {
            notified = state.notifications.recv() => {
                if notified.is_none() {
                    return;
                }
                // Debounce: wait until no notification arrived for DEBOUNCE.
                while let Ok(Some(())) = tokio::time::timeout(DEBOUNCE, state.notifications.recv()).await {}
                state.reload().await;
            }
            change = trust_changes.recv() => match change {
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => state.retrust().await,
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

impl Loop {
    async fn reload(&self) {
        let inner = Arc::clone(&self.inner);
        let watcher = Arc::clone(&self.watcher);
        let workspace = self.workspace.clone();
        let result = tokio::task::spawn_blocking(move || {
            let before = lock(&inner).issues().to_vec();
            let change = lock(&inner).reload();
            // `.piarc/` may have been created since: watch it now.
            watch_dirs(&watcher, &inner, &workspace);
            (before, change)
        })
        .await;
        match result {
            Ok((before, change)) => {
                if !change.changed.is_empty() || change.issues != before {
                    for issue in &change.issues {
                        log_issue(issue);
                    }
                    self.emit(change.changed, change.issues).await;
                }
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::settings", "reloading settings failed: {error}");
            }
        }
    }

    async fn retrust(&self) {
        let state = self.trust.state(&self.workspace).await;
        let change = lock(&self.inner).set_trust(state);
        if !change.changed.is_empty() {
            let issues = lock(&self.inner).issues().to_vec();
            self.emit(change.changed, issues).await;
        }
    }

    async fn emit(&self, changed: Vec<String>, issues: Vec<Issue>) {
        let payload = serde_json::json!({
            "workspace": self.workspace.to_string_lossy(),
            "changed": changed,
            "issues": issues,
        });
        let event = Event::from_json(RouteKey::settings(), &payload);
        match event {
            Ok(event) => {
                // Shutting down: nobody receives it.
                let _ = self.events.send(event).await;
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::settings", "cannot build the settings event: {error}");
            }
        }
    }
}

/// Watches the directories of the layer files that exist; for a missing `.piarc/`, the
/// workspace itself, so its creation is noticed.
fn watch_dirs(watcher: &Mutex<Watcher>, settings: &Mutex<Settings>, workspace: &Path) {
    let dirs: Vec<PathBuf> = {
        let settings = lock(settings);
        settings
            .table()
            .files()
            .filter_map(Path::parent)
            .map(Path::to_owned)
            .collect()
    };
    let mut watcher = lock(watcher);
    for dir in dirs {
        let target = if dir.is_dir() {
            dir
        } else {
            workspace.to_owned()
        };
        if !watcher.is_watching(&target)
            && let Err(error) = watcher.watch_dir(&target)
        {
            tracing::warn!(target: "piarc_core::settings", "{error}");
        }
    }
}

fn log_issue(issue: &Issue) {
    let file = issue
        .file
        .as_ref()
        .map_or_else(String::new, |f| f.display().to_string());
    tracing::warn!(target: "piarc_core::settings", layer = issue.layer, file = %file,
        pointer = %issue.pointer, severity = ?issue.severity, "{}", issue.message);
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
