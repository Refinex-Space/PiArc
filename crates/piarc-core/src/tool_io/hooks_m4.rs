//! The M4 hook events Core observes itself (architecture section 6.3.2, T41): `CwdChanged`
//! when a command moves the session's working directory, `FileChanged` for the files hooks ask
//! to watch (`watchPaths` of `SessionStart`, `CwdChanged`, `FileChanged`), and `ConfigChange`
//! when a settings file changes while the session is open. `UserPromptExpansion` is in
//! `hooks.rs` (Core's command expansion) and `hooks/run` (MCP prompts); `InstructionsLoaded`
//! and `StopFailure` arrive over `hooks/run`.
//!
//! - **Watch list.** One list per session, replaced by each `watchPaths` output; relative
//!   paths are taken from the session's working directory. At most [`MAX_WATCH_PATHS`]
//!   entries: the rest are dropped and the user is told. The files' directories are watched
//!   (`piarc_fs::watch::Watcher`); events are debounced for [`FILE_DEBOUNCE`] and each changed watched
//!   file runs `FileChanged` once (`event`: `change`, or `unlink` when it is gone).
//! - **Config pins.** A `ConfigChange` hook that blocks keeps the layer's earlier value for that
//!   session: its permission decisions and hooks use the pinned value
//!   ([`ToolIo::session_settings`]); the file is not rolled back. `policy_settings` (enterprise,
//!   T47) cannot be blocked.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_hooks::HookEvent;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{SessionIo, ToolIo, lock};
use crate::hooks::Request;

/// The most files one session's `FileChanged` hooks watch.
pub const MAX_WATCH_PATHS: usize = 64;

/// How long file events settle before `FileChanged` runs.
pub const FILE_DEBOUNCE: Duration = Duration::from_millis(150);

/// A session's watched files and the watcher of their directories.
pub(crate) struct FileWatch {
    pub(crate) paths: Vec<PathBuf>,
    _watcher: piarc_fs::watch::Watcher,
}

/// The `ConfigChange` source of a settings layer (Claude Code's matcher values).
#[must_use]
pub fn config_source(layer: &str) -> &'static str {
    match layer {
        piarc_config::ids::USER | piarc_config::ids::CLAUDE_USER => "user_settings",
        piarc_config::ids::PROJECT | piarc_config::ids::CLAUDE_PROJECT => "project_settings",
        piarc_config::ids::PROJECT_LOCAL | piarc_config::ids::CLAUDE_PROJECT_LOCAL => {
            "local_settings"
        }
        _ => "policy_settings",
    }
}

impl ToolIo {
    /// Runs a Core-observed event's hooks for session `id` and applies `watchPaths`.
    async fn observed(&self, id: &str, request: Request) -> Option<crate::hooks::Answer> {
        let (Some(hooks), Ok(s)) = (self.hook_service(), self.session(id)) else {
            return None;
        };
        let token = CancellationToken::new();
        let facts = self.session_facts(&s, id, token);
        let answer = self.run_hooks(hooks, &facts, &request).await;
        if let Some(paths) = &answer.decision.watch_paths {
            self.set_watch_paths(id, paths).await;
        }
        Some(answer)
    }

    /// `CwdChanged` (T41): a command moved session `id`'s working directory.
    pub(super) async fn cwd_changed(&self, id: &str, old: &Path, new: &Path) {
        let mut fields = Map::new();
        fields.insert("old_cwd".into(), json!(old.to_string_lossy()));
        fields.insert("new_cwd".into(), json!(new.to_string_lossy()));
        let request = Request {
            event: HookEvent::CwdChanged,
            subject: None,
            fields,
            tool: None,
        };
        self.observed(id, request).await;
    }

    /// Replaces session `id`'s watch list with `paths` (relative ones from its working
    /// directory), at most [`MAX_WATCH_PATHS`].
    pub(super) async fn set_watch_paths(&self, id: &str, paths: &[String]) {
        let Ok(s) = self.session(id) else {
            return;
        };
        let cwd = lock(&s.shell_cwd).clone();
        let mut resolved: Vec<PathBuf> = Vec::new();
        for path in paths {
            let path = Path::new(path);
            let full = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            let full = super::policy::lexical(&full);
            if !resolved.contains(&full) {
                resolved.push(full);
            }
        }
        if resolved.len() > MAX_WATCH_PATHS {
            let dropped = resolved.split_off(MAX_WATCH_PATHS);
            let message = format!(
                "FileChanged watches at most {MAX_WATCH_PATHS} files; {} were not watched: {}",
                dropped.len(),
                dropped
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            tracing::warn!(target: "piarc_core::hooks", session = id, "{message}");
            if let Some(hooks) = self.hook_service() {
                let facts = self.session_facts(&s, id, CancellationToken::new());
                hooks
                    .notify(&facts, HookEvent::FileChanged, "error", &message)
                    .await;
            }
        }
        let watch = self.watch(id, &resolved);
        *lock(&s.file_watch) = watch;
    }

    /// A watcher of `paths`' directories whose changes run `FileChanged` for session `id`.
    fn watch(&self, id: &str, paths: &[PathBuf]) -> Option<FileWatch> {
        if paths.is_empty() {
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel::<Vec<PathBuf>>();
        let mut watcher = match piarc_fs::watch::Watcher::new(move |event| {
            if let piarc_fs::watch::WatchEvent::Changed(paths) = event {
                let _ = tx.send(paths);
            }
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                tracing::warn!(target: "piarc_core::hooks", "cannot watch files: {error}");
                return None;
            }
        };
        let dirs: BTreeSet<PathBuf> = paths
            .iter()
            .filter_map(|p| p.parent().map(Path::to_owned))
            .filter(|d| d.is_dir())
            .collect();
        for error in watcher.watch_dirs(&dirs.into_iter().collect::<Vec<_>>()) {
            tracing::warn!(target: "piarc_core::hooks", "{error}");
        }
        tokio::spawn(file_events(self.clone(), id.to_owned(), paths.to_vec(), rx));
        Some(FileWatch {
            paths: paths.to_vec(),
            _watcher: watcher,
        })
    }

    /// `FileChanged` (T41) for one watched file of session `id`.
    async fn file_changed(&self, id: &str, path: &Path) {
        let mut fields = Map::new();
        fields.insert("file_path".into(), json!(path.to_string_lossy()));
        fields.insert(
            "event".into(),
            json!(if path.exists() { "change" } else { "unlink" }),
        );
        let request = Request {
            event: HookEvent::FileChanged,
            subject: path.file_name().map(|n| n.to_string_lossy().into_owned()),
            fields,
            tool: None,
        };
        self.observed(id, request).await;
    }

    /// `ConfigChange` (T41): settings layer `layer` (file `file`) changed while session `id`
    /// was open; `previous` is the value it had. A blocking hook pins `previous` for the
    /// session, except for policy settings. Returns whether the change was blocked.
    pub(crate) async fn config_change(
        &self,
        id: &str,
        layer: &'static str,
        file: &Path,
        previous: Option<Value>,
    ) -> bool {
        let source = config_source(layer);
        let mut fields = Map::new();
        fields.insert("source".into(), json!(source));
        fields.insert("file_path".into(), json!(file.to_string_lossy()));
        let request = Request {
            event: HookEvent::ConfigChange,
            subject: Some(source.to_owned()),
            fields,
            tool: None,
        };
        let Some(answer) = self.observed(id, request).await else {
            return false;
        };
        if answer.decision.block.is_none() || source == "policy_settings" {
            return false;
        }
        if let Ok(s) = self.session(id) {
            // The earliest value stays: a second change of a pinned layer is blocked too.
            lock(&s.config_pins).entry(layer).or_insert(previous);
        }
        true
    }

    /// Session `s`'s permission settings: the workspace's, with the layers its `ConfigChange`
    /// hooks pinned (T41).
    pub(super) fn apply_pins(s: &SessionIo, settings: &mut piarc_config::Settings) {
        for (layer, value) in lock(&s.config_pins).iter() {
            settings.pin_layer(layer, value.clone());
        }
    }
}

/// Runs `FileChanged` for the watched files among each debounced batch of events.
async fn file_events(
    io: ToolIo,
    id: String,
    watched: Vec<PathBuf>,
    mut rx: mpsc::UnboundedReceiver<Vec<PathBuf>>,
) {
    let watched = Arc::new(watched);
    while let Some(first) = rx.recv().await {
        let mut changed: BTreeSet<PathBuf> = first.into_iter().collect();
        while let Ok(Some(more)) = tokio::time::timeout(FILE_DEBOUNCE, rx.recv()).await {
            changed.extend(more);
        }
        // The session's list may have been replaced: this watcher's list is the one it had.
        let Ok(s) = io.session(&id) else {
            return;
        };
        let current = lock(&s.file_watch)
            .as_ref()
            .is_some_and(|w| w.paths == *watched);
        if !current {
            return;
        }
        for path in watched.iter().filter(|p| changed.contains(*p)) {
            io.file_changed(&id, path).await;
        }
    }
}
