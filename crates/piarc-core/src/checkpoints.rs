//! File snapshots of sessions (architecture section 6.9, ADR-0044): the object store under
//! `<data dir>/checkpoints/objects/`, the index in `core.sqlite`, and the retention policy run
//! in the background.
//!
//! - A checkpoint is created when a session's turn starts ([`Checkpoints::ensure`], from the
//!   session actor) or with its first write; every write through Core adds a record
//!   ([`Checkpoints::record`], from `tool_io`) after the file was replaced, its old bytes
//!   already stored and pinned by `piarc-fs`.
//! - Rewinds, undos and the Changes panel read the records (`tool_io/checkpoints.rs`).
//! - After each turn the session keeps its newest [`RetentionPolicy::max_checkpoints`]
//!   ([`Checkpoints::prune`]); [`Checkpoints::sweep`] (at start and every
//!   [`CheckpointConfig::sweep_interval`]) drops the snapshots of sessions not used for
//!   [`RetentionPolicy::idle`] and removes objects no record refers to. Pins keep objects that a
//!   write or a rewind is still using.
//!
//! The methods block (SQLite and files): call them on the blocking pool.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use piarc_checkpoint::{
    Collected, FileRecord, Hash, ObjectStore, Operation, RetentionPolicy, from_hex, to_hex,
};
use piarc_store::NewCheckpointFile;

use crate::error::{Error, Result};
use crate::storage::{Storage, now_ms};

/// Retention and clock of the snapshots.
#[derive(Clone)]
pub struct CheckpointConfig {
    /// How many checkpoints a session keeps and how long an unused session keeps them.
    pub retention: RetentionPolicy,
    /// The wall clock, in Unix milliseconds; tests move it.
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// How often idle sessions are swept and unreferenced objects collected.
    pub sweep_interval: Duration,
}

impl Default for CheckpointConfig {
    fn default() -> Self {
        Self {
            retention: RetentionPolicy::default(),
            now_ms: Arc::new(now_ms),
            sweep_interval: Duration::from_secs(6 * 60 * 60),
        }
    }
}

impl std::fmt::Debug for CheckpointConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckpointConfig")
            .field("retention", &self.retention)
            .field("sweep_interval", &self.sweep_interval)
            .finish_non_exhaustive()
    }
}

/// One write to record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRecord {
    /// The file (display form).
    pub path: String,
    /// The content before; `None`: no file.
    pub before: Option<Hash>,
    /// The content after; `None`: no file.
    pub after: Option<Hash>,
    /// What wrote it.
    pub operation: Operation,
}

/// What a sweep did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Sessions whose snapshots were dropped.
    pub idle_sessions: Vec<String>,
    /// The object collection.
    pub collected: Collected,
}

/// The snapshot store and index. Cheap to clone.
#[derive(Clone)]
pub struct Checkpoints {
    inner: Arc<Inner>,
}

struct Inner {
    store: ObjectStore,
    storage: Storage,
    config: CheckpointConfig,
}

impl std::fmt::Debug for Checkpoints {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Checkpoints")
            .field("root", &self.inner.store.root())
            .field("config", &self.inner.config)
            .finish()
    }
}

fn feature(error: &piarc_checkpoint::Error) -> Error {
    Error::feature(&error.to_error_object())
}

fn hex(hash: Option<&Hash>) -> Option<String> {
    hash.map(to_hex)
}

impl Checkpoints {
    /// The store under `storage`'s data directory.
    ///
    /// # Errors
    ///
    /// The object directory cannot be created.
    pub fn open(storage: Storage, config: CheckpointConfig) -> Result<Self> {
        let root = storage.dirs().checkpoint_objects();
        let store = ObjectStore::open(&root).map_err(|e| feature(&e))?;
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                storage,
                config,
            }),
        })
    }

    /// The object store.
    #[must_use]
    pub fn store(&self) -> &ObjectStore {
        &self.inner.store
    }

    /// The configuration.
    #[must_use]
    pub fn config(&self) -> &CheckpointConfig {
        &self.inner.config
    }

    fn now(&self) -> i64 {
        (self.inner.config.now_ms)()
    }

    /// The checkpoint of `session`'s turn `turn`, created when missing.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn ensure(&self, session: &str, turn: &str) -> Result<i64> {
        let now = self.now();
        self.inner
            .storage
            .with(|store| store.ensure_checkpoint(session, turn, now))?
            .map_err(Error::from)
    }

    /// The checkpoint of `session`'s turn `turn`, when it has one.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn checkpoint_of(&self, session: &str, turn: &str) -> Result<Option<i64>> {
        self.inner
            .storage
            .with(|store| store.checkpoint_id(session, turn))?
            .map_err(Error::from)
    }

    /// Adds `records` to the checkpoint of `turn` (created when missing), or to the session's
    /// latest checkpoint without a turn; returns false when the session has no checkpoint to
    /// add them to. `restore_id` marks a rewind's records.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn record(
        &self,
        session: &str,
        turn: Option<&str>,
        records: &[NewRecord],
        restore_id: Option<&str>,
    ) -> Result<bool> {
        if records.is_empty() {
            return Ok(true);
        }
        let checkpoint = match turn {
            Some(turn) => Some(self.ensure(session, turn)?),
            None => self
                .inner
                .storage
                .with(|store| store.latest_checkpoint(session))??,
        };
        let Some(checkpoint) = checkpoint else {
            return Ok(false);
        };
        let hashes: Vec<(Option<String>, Option<String>)> = records
            .iter()
            .map(|r| (hex(r.before.as_ref()), hex(r.after.as_ref())))
            .collect();
        let rows: Vec<NewCheckpointFile<'_>> = records
            .iter()
            .zip(&hashes)
            .map(|(r, (before, after))| NewCheckpointFile {
                path: &r.path,
                before_hash: before.as_deref(),
                after_hash: after.as_deref(),
                operation: r.operation.as_str(),
                restore_id,
            })
            .collect();
        self.inner
            .storage
            .with(|store| store.add_checkpoint_files(checkpoint, &rows))??;
        Ok(true)
    }

    /// Every record of `session`, in write order. Rows the index holds with an unknown
    /// operation or a malformed hash are skipped (they come from no build of this code).
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn records(&self, session: &str) -> Result<Vec<FileRecord>> {
        let rows = self
            .inner
            .storage
            .with(|store| store.checkpoint_files(session))??;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let hash = |text: Option<String>| -> Option<Option<Hash>> {
                    match text {
                        None => Some(None),
                        Some(text) => from_hex(&text).map(Some),
                    }
                };
                Some(FileRecord {
                    id: row.id,
                    checkpoint: row.checkpoint_id,
                    before: hash(row.before_hash)?,
                    after: hash(row.after_hash)?,
                    operation: Operation::parse(&row.operation)?,
                    path: row.path,
                    restore_id: row.restore_id,
                })
            })
            .collect())
    }

    /// Marks `session`'s snapshots used now (the session was opened).
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn touch(&self, session: &str) -> Result<()> {
        let now = self.now();
        self.inner
            .storage
            .with(|store| store.touch_checkpoint_session(session, now))?
            .map_err(Error::from)
    }

    /// Keeps `session`'s newest checkpoints; collects objects when some went.
    ///
    /// # Errors
    ///
    /// The database or the object directory failed.
    pub fn prune(&self, session: &str) -> Result<usize> {
        let keep = self.inner.config.retention.max_checkpoints;
        let pruned = self
            .inner
            .storage
            .with(|store| store.prune_checkpoints(session, keep))??;
        if pruned > 0 {
            self.collect()?;
        }
        Ok(pruned)
    }

    /// Drops the snapshots of sessions idle past the policy, then collects unreferenced
    /// objects.
    ///
    /// # Errors
    ///
    /// The database or the object directory failed.
    pub fn sweep(&self) -> Result<SweepReport> {
        let before = self.inner.config.retention.idle_before(self.now());
        let idle_sessions = self
            .inner
            .storage
            .with(|store| store.drop_idle_checkpoints(before))??;
        let collected = self.collect()?;
        Ok(SweepReport {
            idle_sessions,
            collected,
        })
    }

    /// Deletes every snapshot record of `session` (the session was deleted); objects go with
    /// the next collection.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub fn forget_session(&self, session: &str) -> Result<()> {
        self.inner
            .storage
            .with(|store| store.delete_session_checkpoints(session))?
            .map_err(Error::from)
    }

    fn collect(&self) -> Result<Collected> {
        // Begun before the references are read: a write that records a row and releases its
        // pin after this read keeps its object (R3).
        let collection = self.inner.store.begin_collection();
        let referenced: HashSet<Hash> = self
            .inner
            .storage
            .with(|store| store.referenced_snapshots())??
            .iter()
            .filter_map(|text| from_hex(text))
            .collect();
        collection.collect(&referenced).map_err(|e| feature(&e))
    }

    /// Runs [`Checkpoints::sweep`] now and every [`CheckpointConfig::sweep_interval`] on
    /// `clock`, until `cancel`.
    pub(crate) fn spawn_sweeper(
        &self,
        handle: &tokio::runtime::Handle,
        clock: Arc<dyn piarc_ports::Clock>,
        cancel: tokio_util::sync::CancellationToken,
    ) {
        let this = self.clone();
        handle.spawn(async move {
            loop {
                let run = this.clone();
                match tokio::task::spawn_blocking(move || run.sweep()).await {
                    Ok(Ok(report)) => {
                        if !report.idle_sessions.is_empty() || report.collected.removed > 0 {
                            tracing::info!(target: "piarc_core::checkpoints",
                                sessions = report.idle_sessions.len(),
                                removed = report.collected.removed,
                                "dropped idle snapshots");
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(target: "piarc_core::checkpoints", "sweeping snapshots failed: {error}");
                    }
                    Err(error) => {
                        tracing::warn!(target: "piarc_core::checkpoints", "the snapshot sweep stopped: {error}");
                    }
                }
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = clock.sleep(this.inner.config.sweep_interval) => {}
                }
            }
        });
    }
}
