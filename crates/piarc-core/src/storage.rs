//! Core's database ([`piarc_store::Store`]) behind a mutex, used from the blocking pool, and
//! the session index kept in sync with Pi's files.

use std::sync::{Arc, Mutex, PoisonError};

use piarc_store::{Store, SyncReport};

use crate::dirs::DataDirs;
use crate::error::{Error, Result};

/// The database of one Core. Clones share it.
#[derive(Clone)]
pub struct Storage {
    store: Arc<Mutex<Store>>,
    dirs: DataDirs,
}

impl std::fmt::Debug for Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Storage")
            .field("dirs", &self.dirs)
            .finish_non_exhaustive()
    }
}

/// Unix milliseconds now.
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Storage {
    /// Opens (and migrates) `<data>/core.sqlite`. Blocking: call it at startup or on the
    /// blocking pool.
    ///
    /// # Errors
    ///
    /// The store's errors (a failed migration leaves the previous schema).
    pub fn open(dirs: DataDirs) -> Result<Self> {
        let store = Store::open(&dirs.database(), now_ms())?;
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            dirs,
        })
    }

    /// The directories.
    #[must_use]
    pub fn dirs(&self) -> &DataDirs {
        &self.dirs
    }

    /// Runs `f` with the store on the current thread (blocking).
    pub fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut store)
    }

    /// Runs `f` with the store on the blocking pool.
    ///
    /// # Errors
    ///
    /// [`Error::Internal`] when the blocking task panicked.
    pub async fn run<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Store) -> R + Send + 'static,
    ) -> Result<R> {
        let storage = self.clone();
        tokio::task::spawn_blocking(move || storage.with(f))
            .await
            .map_err(|error| Error::Internal {
                reason: format!("a storage task failed: {error}"),
            })
    }

    /// Brings the session index up to date with `pi/sessions/` (incremental).
    ///
    /// # Errors
    ///
    /// The store's errors.
    pub async fn sync_sessions(&self) -> Result<SyncReport> {
        let dir = self.dirs.pi_sessions();
        let report = self.run(move |store| store.sync_dir(&dir)).await??;
        log_report("session index synced", &report);
        Ok(report)
    }

    /// Rebuilds the session index from the files (the "rebuild index" diagnostic action).
    ///
    /// # Errors
    ///
    /// The store's errors.
    pub async fn rebuild_session_index(&self) -> Result<SyncReport> {
        let dir = self.dirs.pi_sessions();
        let report = self.run(move |store| store.rebuild_index(&dir)).await??;
        log_report("session index rebuilt", &report);
        Ok(report)
    }
}

fn log_report(what: &str, report: &SyncReport) {
    tracing::info!(target: "piarc_core::storage", files = report.files, rescanned = report.rescanned,
        appended = report.appended, removed = report.removed, "{what}");
    for (path, reason) in &report.unavailable {
        tracing::warn!(target: "piarc_core::storage", path = %path.display(), "session index unavailable: {reason}");
    }
    for line in &report.skipped_lines {
        tracing::warn!(target: "piarc_core::storage", path = %line.path.display(), offset = line.offset,
            "skipped a damaged session line: {}", line.reason);
    }
    for (path, reason) in &report.failed {
        tracing::warn!(target: "piarc_core::storage", path = %path.display(), "cannot index a session file: {reason}");
    }
}

/// The report as JSON for the client.
#[must_use]
pub fn report_json(report: &SyncReport) -> serde_json::Value {
    let paths = |list: &[(std::path::PathBuf, String)]| -> Vec<serde_json::Value> {
        list.iter()
            .map(|(path, reason)| serde_json::json!({ "path": path.to_string_lossy(), "reason": reason }))
            .collect()
    };
    serde_json::json!({
        "files": report.files,
        "rescanned": report.rescanned,
        "appended": report.appended,
        "unchanged": report.unchanged,
        "removed": report.removed,
        "unavailable": paths(&report.unavailable),
        "failed": paths(&report.failed),
        "skippedLines": report.skipped_lines.iter().map(|l| serde_json::json!({
            "path": l.path.to_string_lossy(), "offset": l.offset, "reason": l.reason
        })).collect::<Vec<_>>(),
    })
}
