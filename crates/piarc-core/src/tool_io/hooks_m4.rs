//! The M4 hook events Core observes itself (architecture section 6.3.2, T41): `CwdChanged`
//! when a command moves the session's working directory, `FileChanged` for the files hooks ask
//! to watch (`watchPaths` of `SessionStart`, `CwdChanged`, `FileChanged`), and `ConfigChange`
//! when a settings file changes while the session is open. `UserPromptExpansion` is in
//! `hooks.rs` (Core's command expansion) and `hooks/run` (MCP prompts); `InstructionsLoaded`
//! and `StopFailure` arrive over `hooks/run`.
//!
//! - **Watch list.** One list per session, replaced by each `watchPaths` output; relative
//!   paths are taken from the session's working directory. At most [`MAX_WATCH_PATHS`]
//!   entries: the rest are dropped and the user is told. The files are polled every
//!   [`FILE_POLL`] (existence, size, modification time): starting an FSEvents stream can block
//!   for many seconds when the system's event service is busy, while at most 64 `stat` calls
//!   are cheap, start at once and behave the same on every platform. Each changed file runs
//!   `FileChanged` once per poll (`event`: `change`, or `unlink` when it is gone).
//! - **Config pins.** A `ConfigChange` hook that blocks keeps the layer's earlier value for that
//!   session: its permission decisions and hooks use the pinned value
//!   ([`ToolIo::session_settings`]); the file is not rolled back. `policy_settings` (enterprise,
//!   T47) cannot be blocked.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use piarc_hooks::HookEvent;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{SessionIo, ToolIo, lock};
use crate::hooks::Request;

/// The most files one session's `FileChanged` hooks watch.
pub const MAX_WATCH_PATHS: usize = 64;

/// How often the watched files are checked.
pub const FILE_POLL: Duration = Duration::from_millis(500);

/// What a poll compares: whether the file exists, its size and modification time.
type Stamp = Option<(u64, Option<SystemTime>)>;

fn stamp(path: &Path) -> Stamp {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
}

/// A settings layer as a session last saw it: id, file, loaded value.
pub(crate) type SeenLayer = (&'static str, Option<PathBuf>, Option<Value>);

/// A session's watch list: the number of the latest replacement and its watcher.
#[derive(Default)]
pub(crate) struct WatchSlot {
    generation: u64,
    pub(crate) watch: Option<FileWatch>,
}

/// A replacement of a session's watch list.
struct WatchChange {
    session: Arc<SessionIo>,
    generation: u64,
    paths: Vec<PathBuf>,
    dropped: Vec<PathBuf>,
}

/// A session's watched files; dropping it stops their poll.
pub(crate) struct FileWatch {
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the tests read the installed list")
    )]
    pub(crate) paths: Vec<PathBuf>,
    stop: CancellationToken,
}

impl Drop for FileWatch {
    fn drop(&mut self) {
        self.stop.cancel();
    }
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
    /// Runs a Core-observed event's hooks for session `id` and applies `watchPaths`: in the
    /// background, or (`settle`) before returning, so a change made after the event is seen.
    async fn observed(
        &self,
        id: &str,
        request: Request,
        settle: bool,
    ) -> Option<crate::hooks::Answer> {
        let (Some(hooks), Ok(s)) = (self.hook_service(), self.session(id)) else {
            return None;
        };
        let token = CancellationToken::new();
        let facts = self.session_facts(&s, id, token);
        let answer = self.run_hooks(hooks, &facts, &request).await;
        if let Some(paths) = &answer.decision.watch_paths {
            if settle {
                self.set_watch_paths(id, paths).await;
            } else {
                self.replace_watch_paths(id, paths);
            }
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
        // The command's result waits for the new list: what the agent does next is watched.
        self.observed(id, request, true).await;
    }

    /// Replaces session `id`'s watch list with `paths` (relative ones from its working
    /// directory), at most [`MAX_WATCH_PATHS`], in the background (a hook's answer does not
    /// wait for the notice about dropped paths). The replacement's number is taken now, so a
    /// later list wins even if it is installed first.
    pub(super) fn replace_watch_paths(&self, id: &str, paths: &[String]) {
        let Some(change) = self.watch_change(id, paths) else {
            return;
        };
        let io = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move { io.install_watch(&id, change).await });
    }

    /// [`Self::replace_watch_paths`], returning once the watcher is in place: after a command
    /// changed directory (its result comes after, so a later change is seen), and in tests.
    pub(super) async fn set_watch_paths(&self, id: &str, paths: &[String]) {
        if let Some(change) = self.watch_change(id, paths) {
            self.install_watch(id, change).await;
        }
    }

    /// The resolved list and its replacement number for session `id`.
    fn watch_change(&self, id: &str, paths: &[String]) -> Option<WatchChange> {
        let s = self.session(id).ok()?;
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
        let dropped = if resolved.len() > MAX_WATCH_PATHS {
            resolved.split_off(MAX_WATCH_PATHS)
        } else {
            Vec::new()
        };
        let generation = {
            let mut slot = lock(&s.file_watch);
            slot.generation += 1;
            slot.generation
        };
        Some(WatchChange {
            session: s,
            generation,
            paths: resolved,
            dropped,
        })
    }

    /// Tells the user about dropped paths and starts the poll unless a later list replaced
    /// this one meanwhile.
    async fn install_watch(&self, id: &str, change: WatchChange) {
        let WatchChange {
            session: s,
            generation,
            paths,
            dropped,
        } = change;
        if !dropped.is_empty() {
            let message = format!(
                "FileChanged watches at most {MAX_WATCH_PATHS} files; {} were not watched.",
                dropped.len()
            );
            let names = dropped
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            tracing::warn!(target: "piarc_core::hooks", session = id, "{message} {names}");
            if let Some(hooks) = self.hook_service() {
                let facts = self.session_facts(&s, id, CancellationToken::new());
                hooks
                    .notify(&facts, HookEvent::FileChanged, "error", &message)
                    .await;
            }
        }
        let built = self.watch(id, generation, paths);
        let mut slot = lock(&s.file_watch);
        if slot.generation == generation {
            // Replacing the slot's watch drops (stops) the earlier one.
            slot.watch = built;
        }
    }

    /// Starts polling `paths` for session `id`: their state now is the baseline.
    fn watch(&self, id: &str, generation: u64, paths: Vec<PathBuf>) -> Option<FileWatch> {
        if paths.is_empty() {
            return None;
        }
        let stop = CancellationToken::new();
        let baseline: Vec<Stamp> = paths.iter().map(|p| stamp(p)).collect();
        tokio::spawn(poll_files(
            self.clone(),
            id.to_owned(),
            generation,
            paths.clone(),
            baseline,
            stop.clone(),
        ));
        Some(FileWatch { paths, stop })
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
        // Replacing the list from inside its own event loop: in the background.
        self.observed(id, request, false).await;
    }

    /// Compares the settings files with what session `id` last saw and runs `ConfigChange` for
    /// each layer that changed (T41). The first check only records them. Runs before every input
    /// and when the settings watcher sees a change, whichever comes first.
    pub(crate) async fn check_config(&self, id: &str) {
        let Ok(s) = self.session(id) else {
            return;
        };
        let mut seen = s.config_seen.lock().await;
        let table = self.layers(s.project());
        // The managed layer has no file of its own: `file_path` names its first document.
        let managed = self.managed().snapshot().primary().map(Path::to_owned);
        let Ok(now) = tokio::task::spawn_blocking(move || {
            let settings = piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
            settings
                .loaded_layers()
                .into_iter()
                .map(|(layer, value)| {
                    let file = settings
                        .table()
                        .get(layer)
                        .and_then(|spec| spec.file().map(Path::to_owned))
                        .or_else(|| {
                            (layer == piarc_config::ids::ENTERPRISE)
                                .then(|| managed.clone())
                                .flatten()
                        });
                    (layer, file, value)
                })
                .collect::<Vec<SeenLayer>>()
        })
        .await
        else {
            return;
        };
        if let Some(before) = seen.as_ref() {
            for (layer, file, value) in &now {
                let previous = before
                    .iter()
                    .find(|(l, _, _)| l == layer)
                    .and_then(|(_, _, v)| v.clone());
                if let Some(file) = file
                    && previous != *value
                {
                    self.config_change(id, layer, file, previous).await;
                }
            }
            // A layer that is gone (the managed settings removed, T47) changed too.
            for (layer, file, value) in before {
                if let Some(file) = file
                    && value.is_some()
                    && !now.iter().any(|(l, _, _)| l == layer)
                {
                    self.config_change(id, layer, file, value.clone()).await;
                }
            }
        }
        *seen = Some(now);
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
        let Some(answer) = self.observed(id, request, false).await else {
            return false;
        };
        let Some(reason) = answer.decision.block.as_deref() else {
            return false;
        };
        if source == "policy_settings" {
            return false;
        }
        let Ok(s) = self.session(id) else {
            return false;
        };
        // The earliest value stays: a second change of a pinned layer is blocked too.
        lock(&s.config_pins).entry(layer).or_insert(previous);
        if let Some(hooks) = self.hook_service() {
            let facts = self.session_facts(&s, id, CancellationToken::new());
            let message = format!("The {source} change is not applied in this session: {reason}");
            hooks
                .notify(&facts, HookEvent::ConfigChange, "message", &message)
                .await;
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

/// Polls the watched files every [`FILE_POLL`] and runs `FileChanged` for each that changed,
/// until the list is replaced or the session is gone.
async fn poll_files(
    io: ToolIo,
    id: String,
    generation: u64,
    paths: Vec<PathBuf>,
    mut seen: Vec<Stamp>,
    stop: CancellationToken,
) {
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep(FILE_POLL) => {}
        }
        let checked = paths.clone();
        let Ok(now) = tokio::task::spawn_blocking(move || {
            checked.iter().map(|p| stamp(p)).collect::<Vec<Stamp>>()
        })
        .await
        else {
            return;
        };
        let changed: Vec<&PathBuf> = paths
            .iter()
            .zip(seen.iter().zip(&now))
            .filter(|(_, (before, after))| before != after)
            .map(|(p, _)| p)
            .collect();
        seen = now;
        let current = io
            .session(&id)
            .is_ok_and(|s| lock(&s.file_watch).generation == generation);
        if !current {
            return;
        }
        for path in changed {
            io.file_changed(&id, path).await;
        }
    }
}
