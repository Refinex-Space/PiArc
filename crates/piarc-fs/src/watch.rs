//! File watching over `notify` (FSEvents on macOS, `ReadDirectoryChangesW` on Windows).
//!
//! A [`Watcher`] watches directories, each without its subdirectories, and hands every change
//! to a callback on notify's thread as the paths involved. Callers decide what a change
//! means: events of one save often arrive as several notifications, and paths may be reported
//! in their canonical form (`/private/var/...` for `/var/...` on macOS), so callers debounce
//! and re-read what they care about instead of matching single events.

use std::path::{Path, PathBuf};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};

/// What the callback receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// Something under a watched directory was created, changed, renamed or removed.
    Changed(Vec<PathBuf>),
    /// The watcher reported an error (for example a watched directory was removed).
    Error(String),
}

/// Why watching failed.
#[derive(Debug, thiserror::Error)]
#[error("cannot watch {}: {reason}", path.display())]
pub struct WatchError {
    /// The directory.
    pub path: PathBuf,
    /// The watcher's message.
    pub reason: String,
}

/// Watches directories until dropped.
pub struct Watcher {
    inner: RecommendedWatcher,
    watched: Vec<PathBuf>,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watcher")
            .field("watched", &self.watched)
            .finish_non_exhaustive()
    }
}

impl Watcher {
    /// A watcher that calls `on_event` on notify's thread; it must not block for long.
    ///
    /// # Errors
    ///
    /// [`WatchError`] when the platform watcher cannot be created.
    pub fn new(on_event: impl Fn(WatchEvent) + Send + 'static) -> Result<Self, WatchError> {
        let inner =
            notify::recommended_watcher(
                move |result: notify::Result<notify::Event>| match result {
                    Ok(event) if matters(event.kind) => on_event(WatchEvent::Changed(event.paths)),
                    Ok(_) => {}
                    Err(error) => on_event(WatchEvent::Error(error.to_string())),
                },
            )
            .map_err(|error| WatchError {
                path: PathBuf::new(),
                reason: error.to_string(),
            })?;
        Ok(Self {
            inner,
            watched: Vec::new(),
        })
    }

    /// Starts watching `dir` (not its subdirectories). Watching a directory twice is a no-op.
    ///
    /// # Errors
    ///
    /// [`WatchError`] when the directory does not exist or cannot be watched.
    pub fn watch_dir(&mut self, dir: &Path) -> Result<(), WatchError> {
        if self.watched.iter().any(|d| d == dir) {
            return Ok(());
        }
        self.inner
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|error| WatchError {
                path: dir.to_owned(),
                reason: error.to_string(),
            })?;
        self.watched.push(dir.to_owned());
        Ok(())
    }

    /// Adds the new directories as one non-recursive batch. A path that cannot be added
    /// does not prevent valid paths from being watched. Returns the individual failures.
    #[must_use]
    pub fn watch_dirs(&mut self, dirs: &[PathBuf]) -> Vec<WatchError> {
        register_dirs(&mut self.inner, &mut self.watched, dirs)
    }

    /// Whether `dir` is watched.
    #[must_use]
    pub fn is_watching(&self, dir: &Path) -> bool {
        self.watched.iter().any(|d| d == dir)
    }
}

/// Registers all new roots for the settings files and reports each path that failed.
fn register_dirs(
    inner: &mut impl notify::Watcher,
    watched: &mut Vec<PathBuf>,
    dirs: &[PathBuf],
) -> Vec<WatchError> {
    let mut pending = Vec::new();
    for dir in dirs {
        if !watched.contains(dir) && !pending.contains(&dir) {
            pending.push(dir);
        }
    }
    let Some(first) = pending.first().copied() else {
        return Vec::new();
    };
    let error_for = |dir: &Path, error: notify::Error| WatchError {
        path: dir.to_owned(),
        reason: error.to_string(),
    };
    let mut errors = Vec::new();
    let mut added = Vec::new();
    let mut changes = inner.paths_mut();
    for dir in pending {
        match changes.add(dir, RecursiveMode::NonRecursive) {
            Ok(()) => added.push(dir),
            Err(error) => errors.push(error_for(dir, error)),
        }
    }

    // paths_mut on macOS stops the stream; commit must restart it even if each add failed.
    if let Err(error) = changes.commit() {
        errors.push(error_for(first, error));
        // notify keeps the proposed paths after a failed stream start. Restore the previous
        // set so adding a bad root cannot silently disable the working roots.
        let mut rollback = inner.paths_mut();
        for dir in added {
            if let Err(error) = rollback.remove(dir) {
                errors.push(error_for(dir, error));
            }
        }
        if let Err(error) = rollback.commit() {
            errors.push(error_for(first, error));
            watched.clear();
        }
    } else {
        watched.extend(added.into_iter().cloned());
    }
    errors
}

/// Access events (opening, reading) do not change anything.
fn matters(kind: EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    // Mimics the FSEvents backend: a direct watch or a committed batch starts a stream.
    #[derive(Default)]
    struct Probe {
        starts: usize,
        reject_commit: bool,
        paths: Vec<PathBuf>,
    }

    impl notify::Watcher for Probe {
        fn new<F: notify::EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
            Ok(Self::default())
        }
        fn watch(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
            self.starts += 1;
            self.paths.push(path.to_owned());
            Ok(())
        }
        fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
            self.paths.retain(|p| p != path);
            Ok(())
        }
        fn kind() -> notify::WatcherKind {
            notify::WatcherKind::NullWatcher
        }
        fn paths_mut(&mut self) -> Box<dyn notify::PathsMut + '_> {
            Box::new(Change(self))
        }
    }

    struct Change<'a>(&'a mut Probe);
    impl notify::PathsMut for Change<'_> {
        fn add(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
            if path == Path::new("missing") {
                return Err(notify::Error::path_not_found());
            }
            self.0.paths.push(path.to_owned());
            Ok(())
        }
        fn remove(&mut self, path: &Path) -> notify::Result<()> {
            self.0.unwatch(path)
        }
        fn commit(self: Box<Self>) -> notify::Result<()> {
            self.0.starts += 1;
            if std::mem::take(&mut self.0.reject_commit) {
                Err(notify::Error::generic("could not start stream"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn registers_settings_roots_in_one_stream_and_restores_prior_roots_on_failure() {
        let mut probe = Probe::default();
        let mut watched = Vec::new();
        let roots = ["user", "workspace", "user", "missing"].map(PathBuf::from);
        let errors = register_dirs(&mut probe, &mut watched, &roots);
        assert_eq!(probe.starts, 1, "one batch for all roots");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, Path::new("missing"));
        assert_eq!(watched, roots[..2]);
        assert!(register_dirs(&mut probe, &mut watched, &roots[..2]).is_empty());
        assert_eq!(
            probe.starts, 1,
            "no stream restart during a settings reload"
        );

        probe.reject_commit = true;
        let errors = register_dirs(&mut probe, &mut watched, &[PathBuf::from("new")]);
        assert!(
            errors
                .iter()
                .any(|e| e.reason.contains("could not start stream"))
        );
        assert_eq!(watched, roots[..2]);
        assert_eq!(probe.paths, watched, "old roots still active");
    }

    #[test]
    fn reports_changes_in_a_watched_directory() {
        let dir = std::env::temp_dir().join(format!("piarc-watch 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let (tx, rx) = mpsc::channel();
        let mut watcher = Watcher::new(move |event| {
            let _ = tx.send(event);
        })
        .expect("watcher");
        watcher.watch_dir(&dir).expect("watch");
        watcher.watch_dir(&dir).expect("watching twice is fine");
        assert!(watcher.is_watching(&dir));
        // FSEvents may deliver the first event only after its latency; write until seen.
        let file = dir.join("settings.json");
        let mut seen = false;
        for attempt in 0..50 {
            std::fs::write(&file, format!("{{\"n\":{attempt}}}")).expect("write");
            if let Ok(WatchEvent::Changed(paths)) = rx.recv_timeout(Duration::from_millis(200)) {
                seen = paths.iter().any(|p| p.file_name() == file.file_name());
                if seen {
                    break;
                }
            }
        }
        assert!(seen, "a change of the file was reported");
        assert!(
            Watcher::new(|_| {})
                .expect("watcher")
                .watch_dir(&dir.join("missing"))
                .is_err()
        );
        drop(watcher);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}
