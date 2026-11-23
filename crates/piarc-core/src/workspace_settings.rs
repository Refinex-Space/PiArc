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
//!
//! The directories of skills, commands and output styles (T37) are watched too: every reload
//! advances [`WorkspaceSettings::changes`], which the workspace turns into `resources/reload`
//! for its Agent Host.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use piarc_config::{Issue, Settings, TrustState};
use piarc_fs::watch::{WatchEvent, Watcher};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
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

/// One settings layer whose file changed (T41: what `ConfigChange` hooks hear).
#[derive(Debug, Clone, PartialEq)]
pub struct LayerChange {
    /// The layer id.
    pub layer: &'static str,
    /// Its file.
    pub file: PathBuf,
    /// The value it had before.
    pub previous: Option<Value>,
}

/// One workspace's settings. Dropping it stops watching.
pub struct WorkspaceSettings {
    inner: Arc<Mutex<Settings>>,
    workspace: PathBuf,
    task: JoinHandle<()>,
    _watcher: Arc<Mutex<Watcher>>,
    /// Advances after every reload (files of settings or of skills, commands, styles) and
    /// trust change (T37).
    changes: watch::Receiver<u64>,
    /// The layers whose files changed, one event each (T41).
    layer_changes: broadcast::Sender<LayerChange>,
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
        wait_for_registration: bool,
    ) -> Result<Self> {
        let trust_changes = trust.subscribe();
        let managed = dirs.managed().clone();
        let managed_changes = managed.changes();
        let state = trust.state(&workspace).await;
        let table = dirs.layers(&workspace);
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
        let (registered, ready) = oneshot::channel();
        let (changed, changes) = watch::channel(0);
        let (layer_changes, _) = broadcast::channel(64);
        let task = tokio::spawn(run(
            Loop {
                inner: Arc::clone(&inner),
                watcher: Arc::clone(&watcher),
                workspace: workspace.clone(),
                resources: (
                    dirs.data().to_path_buf(),
                    dirs.home().map(Path::to_path_buf),
                ),
                trust,
                events,
                notifications: rx,
                changed,
                layer_changes: layer_changes.clone(),
                managed,
            },
            trust_changes,
            managed_changes,
            registered,
        ));
        let settings = Self {
            inner,
            workspace,
            task,
            _watcher: watcher,
            changes,
            layer_changes,
        };
        if wait_for_registration {
            ready.await.map_err(|_| Error::Internal {
                reason: "settings registration stopped".into(),
            })?;
        }
        Ok(settings)
    }

    /// The merged settings now.
    #[must_use]
    pub fn merged(&self) -> Value {
        lock(&self.inner).merged().clone()
    }

    /// Advances whenever the settings, skills, commands or output styles may have changed.
    #[must_use]
    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.changes.clone()
    }

    /// Hears each settings layer whose file changed (T41's `ConfigChange`).
    pub(crate) fn layer_changes(&self) -> broadcast::Receiver<LayerChange> {
        self.layer_changes.subscribe()
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
    /// The data and home directories (user skills, commands and styles).
    resources: (PathBuf, Option<PathBuf>),
    trust: TrustService,
    events: EventSender,
    notifications: mpsc::UnboundedReceiver<()>,
    changed: watch::Sender<u64>,
    layer_changes: broadcast::Sender<LayerChange>,
    /// Core's managed settings (T47): their changes replace the `enterprise` layer.
    managed: crate::managed::ManagedSettings,
}

async fn run(
    mut state: Loop,
    mut trust_changes: broadcast::Receiver<crate::trust::TrustChange>,
    mut managed_changes: watch::Receiver<u64>,
    registered: oneshot::Sender<()>,
) {
    // FSEvents can block in the system daemon while several streams start or stop.
    // Establish the watch off the runtime workers; then pick up edits made since load.
    let (watcher, inner, workspace, resources) = (
        state.watcher.clone(),
        state.inner.clone(),
        state.workspace.clone(),
        state.resources.clone(),
    );
    if let Err(error) = tokio::task::spawn_blocking(move || {
        watch_dirs(&watcher, &inner, &workspace, &resources);
    })
    .await
    {
        tracing::error!(target:"piarc_core::settings","settings registration failed: {error}");
        return;
    }
    state.reload().await;
    let _ = registered.send(());

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
            // The loop holds the managed settings, so their sender outlives this receiver.
            Ok(()) = managed_changes.changed() => state.remanage().await,
        }
    }
}

impl Loop {
    async fn reload(&self) {
        let inner = Arc::clone(&self.inner);
        let watcher = Arc::clone(&self.watcher);
        let workspace = self.workspace.clone();
        let resources = self.resources.clone();
        let managed_file = self.managed.snapshot().primary().map(Path::to_owned);
        let result = tokio::task::spawn_blocking(move || {
            let before = lock(&inner).issues().to_vec();
            let layers_before = lock(&inner).loaded_layers();
            let change = lock(&inner).reload();
            let layers = layer_changes(&lock(&inner), layers_before, managed_file.as_deref());
            // `.piarc/` or a skill directory may have been created since: watch it now.
            watch_dirs(&watcher, &inner, &workspace, &resources);
            (before, change, layers)
        })
        .await;
        // Skills, commands and styles have no event of their own: the Agent Host reloads.
        self.changed.send_modify(|n| *n += 1);
        match result {
            Ok((before, change, layers)) => {
                for layer in layers {
                    // Nobody listening (no open session) is fine.
                    let _ = self.layer_changes.send(layer);
                }
                if !change.changed.is_empty() || change.issues != before {
                    for issue in &change.issues {
                        log_issue(issue);
                    }
                }
                // Every reload: a memory file, rule, skill or definition may have changed
                // without a settings key (T41's diagnostics refresh on it).
                self.emit(change.changed, change.issues).await;
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::settings", "reloading settings failed: {error}");
            }
        }
    }

    /// The managed settings changed (T47): the `enterprise` layer is replaced and merged, its
    /// change reported like a file's (`ConfigChange` hears `policy_settings`).
    async fn remanage(&self) {
        let snapshot = self.managed.snapshot();
        let inner = Arc::clone(&self.inner);
        let result = tokio::task::spawn_blocking(move || {
            let before = lock(&inner).issues().to_vec();
            let layers_before = lock(&inner).loaded_layers();
            let change = lock(&inner).set_layer(piarc_config::ids::ENTERPRISE, snapshot.layer());
            let layers = layer_changes(&lock(&inner), layers_before, snapshot.primary());
            (before, change, layers)
        })
        .await;
        self.changed.send_modify(|n| *n += 1);
        match result {
            Ok((_, change, layers)) => {
                for layer in layers {
                    let _ = self.layer_changes.send(layer);
                }
                self.emit(change.changed, change.issues).await;
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::settings", "applying managed settings failed: {error}");
            }
        }
    }

    async fn retrust(&self) {
        let state = self.trust.state(&self.workspace).await;
        let change = lock(&self.inner).set_trust(state);
        self.changed.send_modify(|n| *n += 1);
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

/// The layers whose loaded value differs from `before`, with their file and earlier value. The
/// managed layer has no file: `managed_file` (its first document) stands for it (T47); a layer
/// that came or went counts as changed.
fn layer_changes(
    settings: &Settings,
    before: Vec<(&'static str, Option<Value>)>,
    managed_file: Option<&Path>,
) -> Vec<LayerChange> {
    let after = settings.loaded_layers();
    let value_of = |layers: &[(&'static str, Option<Value>)], id: &str| {
        layers
            .iter()
            .find(|(l, _)| *l == id)
            .and_then(|(_, v)| v.clone())
    };
    let mut ids: Vec<&'static str> = before.iter().map(|(l, _)| *l).collect();
    for (layer, _) in &after {
        if !ids.contains(layer) {
            ids.push(layer);
        }
    }
    ids.into_iter()
        .filter_map(|layer| {
            let previous = value_of(&before, layer);
            if previous == value_of(&after, layer) {
                return None;
            }
            let file = settings
                .table()
                .get(layer)
                .and_then(|spec| spec.file().map(Path::to_owned))
                .or_else(|| {
                    (layer == piarc_config::ids::ENTERPRISE)
                        .then(|| managed_file.map(Path::to_owned))
                        .flatten()
                })?;
            Some(LayerChange {
                layer,
                file,
                previous,
            })
        })
        .collect()
}

/// Watches the directories of the layer files; for a directory that does not exist yet
/// (`.piarc/`, `.claude/`, `~/.claude/`), its nearest existing ancestor, so its creation is
/// noticed.
fn watch_dirs(
    watcher: &Mutex<Watcher>,
    settings: &Mutex<Settings>,
    workspace: &Path,
    (data, home): &(PathBuf, Option<PathBuf>),
) {
    let mut dirs: Vec<PathBuf> = {
        let settings = lock(settings);
        settings
            .table()
            .files()
            .filter_map(Path::parent)
            .map(Path::to_owned)
            .collect()
    };
    // Directories above the home directory are nobody's skills: not watched.
    dirs.extend(
        piarc_config::skills::watch_dirs(&piarc_config::skills::ResourceDirs {
            cwd: workspace,
            data: Some(data),
            home: home.as_deref(),
            packages: &[],
        })
        .into_iter()
        .filter(|dir| {
            dir.starts_with(workspace)
                || dir.starts_with(data)
                || home.as_deref().is_some_and(|h| dir.starts_with(h))
        }),
    );
    // The configuration diagnostics' other sources (T41): memory files and `.mcp.json` at the
    // workspace root, rules and subagent definitions.
    dirs.push(workspace.to_owned());
    for base in [Some(workspace), home.as_deref()].into_iter().flatten() {
        dirs.push(base.join(".claude").join("rules"));
        dirs.push(base.join(".claude").join("agents"));
    }
    dirs.push(workspace.join(".piarc").join("agents"));
    dirs.push(data.join("agents"));
    let mut roots: Vec<PathBuf> = dirs
        .iter()
        .map(|dir| {
            dir.ancestors()
                .find(|d| d.is_dir())
                .unwrap_or(workspace)
                .to_owned()
        })
        .collect();
    roots.sort();
    roots.dedup();
    for error in lock(watcher).watch_dirs(&roots) {
        tracing::warn!(target: "piarc_core::settings", "{error}");
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
