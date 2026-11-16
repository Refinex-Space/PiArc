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

    /// Whether `dir` is watched.
    #[must_use]
    pub fn is_watching(&self, dir: &Path) -> bool {
        self.watched.iter().any(|d| d == dir)
    }
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
