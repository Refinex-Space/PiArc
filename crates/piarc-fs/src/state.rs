//! The file state table of a session, and the path locks that serialize writes (architecture
//! section 6.1.2: "先读后改", "外部修改检测", "重复读取", "并发").
//!
//! [`FileStates`] maps a file's key ([`crate::Scope::key`]) to what the session last saw of it:
//! the content hash, size and modification time, and the range of the `Read` call when it was a
//! read (a write by the session itself records no range). It answers three questions:
//!
//! - may the session replace the file ([`FileStates::freshness`]): only if it read or wrote it,
//!   and the content still has the hash it saw;
//! - is a `Read` a repeat ([`FileStates::record_read`]): the previous entry was a read of the
//!   same range and the content has not changed;
//! - which files changed outside the session since it saw them ([`FileStates::external_changes`],
//!   T27): the metadata first, the hash only when the metadata differs, each new version once;
//! - nothing else: the table never holds content.
//!
//! After a compaction the read ranges are forgotten ([`FileStates::forget_read_ranges`]): the
//! model no longer sees the earlier results, so the next `Read` must not be a stub, while the
//! hashes keep read-before-edit in force.
//!
//! The hash decides; a changed modification time with the same content (`touch`) is not a
//! change. A session has one table; a subagent gets its own (T31) by being its own session.
//!
//! [`PathLocks`] is shared by all sessions of a Core: a write holds the lock of its key from
//! the freshness check to the rename, so two writes of one file never interleave.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use piarc_protocol::context::ExternalChange;
use piarc_protocol::fs::ReadRange;
use sha2::{Digest, Sha256};

/// What a session saw of a file's content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// SHA-256 of the bytes.
    pub sha256: [u8; 32],
    /// Size in bytes.
    pub size: u64,
    /// Last modification, when the platform reports it.
    pub modified: Option<SystemTime>,
}

impl Snapshot {
    /// The snapshot of a regular file, hashing it as it is read.
    ///
    /// # Errors
    ///
    /// The file cannot be opened or read.
    pub fn of_file(path: &Path) -> io::Result<Self> {
        Self::from_handle(File::open(path)?)
    }

    pub(crate) fn from_handle(mut file: File) -> io::Result<Self> {
        let modified = file.metadata()?.modified().ok();
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut size = 0_u64;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            size += read as u64;
        }
        Ok(Self {
            sha256: hasher.finalize().into(),
            size,
            modified,
        })
    }

    /// The snapshot of `bytes` just written to `path`.
    #[must_use]
    pub fn of_bytes(bytes: &[u8], path: &Path) -> Self {
        Self {
            sha256: Sha256::digest(bytes).into(),
            size: bytes.len() as u64,
            modified: std::fs::metadata(path).and_then(|m| m.modified()).ok(),
        }
    }
}

/// Whether the session may replace a file it is about to change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// The session read or wrote it and the content is what it saw.
    Fresh,
    /// The session never read it.
    NotRead,
    /// The content changed since the session saw it.
    Modified,
}

#[derive(Debug, Clone)]
struct Entry {
    snapshot: Snapshot,
    /// The `Read` call's range; `None` after the session's own write.
    read: Option<ReadRange>,
    /// What the last [`FileStates::external_changes`] found when the metadata differed from
    /// the snapshot.
    observed: Option<Observed>,
}

impl Entry {
    fn new(snapshot: Snapshot, read: Option<ReadRange>) -> Self {
        Self {
            snapshot,
            read,
            observed: None,
        }
    }
}

/// A version of a file found outside the session's own reads and writes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Observed {
    size: u64,
    modified: Option<SystemTime>,
    /// The content's hash; `None` when the file was gone.
    sha256: Option<[u8; 32]>,
}

/// A file's size and modification time, as the platform reports them.
pub type Metadata = (u64, Option<SystemTime>);

/// One session's file state table.
#[derive(Debug, Default)]
pub struct FileStates {
    entries: HashMap<String, Entry>,
    pending: HashMap<String, PendingRead>,
}

#[derive(Debug)]
struct PendingRead {
    key: String,
    snapshot: Snapshot,
    range: ReadRange,
    delivered: bool,
}

impl FileStates {
    /// Start a tool observation without granting write freshness.
    pub fn begin_read(
        &mut self,
        call: &str,
        key: String,
        snapshot: Snapshot,
        range: ReadRange,
    ) -> bool {
        let repeated = self.entries.get(&key).is_some_and(|entry| {
            entry.read.as_ref() == Some(&range) && entry.snapshot.sha256 == snapshot.sha256
        });
        self.pending.remove(call);
        if !repeated {
            self.pending.insert(
                call.to_owned(),
                PendingRead {
                    key,
                    snapshot,
                    range,
                    delivered: false,
                },
            );
        }
        repeated
    }

    /// Content arrived successfully for this call.
    pub fn delivered_read(&mut self, call: &str) {
        if let Some(pending) = self.pending.get_mut(call) {
            pending.delivered = true;
        }
    }

    /// Publish only the version and range that this call actually observed.
    pub fn complete_read(
        &mut self,
        call: &str,
        key: &str,
        snapshot: &Snapshot,
        range: &ReadRange,
    ) -> bool {
        let Some(p) = self.pending.remove(call) else {
            return false;
        };
        if !p.delivered || p.key != key || p.snapshot.sha256 != snapshot.sha256 || &p.range != range
        {
            return false;
        }
        self.record_read(p.key, p.snapshot, p.range);
        true
    }

    /// Abandon pending observations when a call, turn, or connection ends.
    pub fn discard_pending(&mut self, call: Option<&str>) {
        if let Some(call) = call {
            self.pending.remove(call);
        } else {
            self.pending.clear();
        }
    }

    /// Records that the session's `Read` saw `snapshot` of the file `key` with `range`.
    /// Returns whether the read repeats the previous one: a read of the same range of the same
    /// content.
    pub fn record_read(&mut self, key: String, snapshot: Snapshot, range: ReadRange) -> bool {
        let repeat = self.entries.get(&key).is_some_and(|entry| {
            entry.read.as_ref() == Some(&range) && entry.snapshot.sha256 == snapshot.sha256
        });
        self.entries.insert(key, Entry::new(snapshot, Some(range)));
        repeat
    }

    /// Records that the session wrote `snapshot` to the file `key`: it may change it again
    /// without reading it, and its next `Read` returns the content.
    pub fn record_write(&mut self, key: String, snapshot: Snapshot) {
        self.entries.insert(key, Entry::new(snapshot, None));
    }

    /// The files whose content changed outside the session since it last read or wrote them,
    /// sorted by key. `stat` gives a file's metadata (an `io::ErrorKind::NotFound` error means
    /// it is gone); `hash` its content's hash, asked only when the metadata differs from what
    /// the session saw. A version is reported once; the recorded snapshots do not change, so
    /// replacing a changed file still needs a new read. Files `stat` or `hash` cannot read are
    /// skipped.
    pub fn external_changes(
        &mut self,
        mut stat: impl FnMut(&str) -> io::Result<Metadata>,
        mut hash: impl FnMut(&str) -> io::Result<[u8; 32]>,
    ) -> Vec<(String, ExternalChange)> {
        let mut changes = Vec::new();
        for (key, entry) in &mut self.entries {
            let previous = entry.observed.as_ref().map(|o| o.sha256);
            let (size, modified) = match stat(key) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if previous != Some(None) {
                        changes.push((key.clone(), ExternalChange::Deleted));
                        entry.observed = Some(Observed {
                            size: 0,
                            modified: None,
                            sha256: None,
                        });
                    }
                    continue;
                }
                Err(_) => continue,
            };
            let known = |m: Option<SystemTime>| m.is_some() && m == modified;
            if size == entry.snapshot.size && known(entry.snapshot.modified) {
                entry.observed = None;
                continue;
            }
            if let Some(seen) = &entry.observed
                && seen.sha256.is_some()
                && seen.size == size
                && known(seen.modified)
            {
                continue;
            }
            let Ok(sha256) = hash(key) else { continue };
            entry.observed = Some(Observed {
                size,
                modified,
                sha256: Some(sha256),
            });
            if sha256 != entry.snapshot.sha256 && previous != Some(Some(sha256)) {
                changes.push((key.clone(), ExternalChange::Modified));
            }
        }
        changes.sort_by(|a, b| a.0.cmp(&b.0));
        changes
    }

    /// Forgets the read range of every file (after a compaction, I72): the next `Read` returns
    /// the content again. Hashes stay, so replacing a file still needs no new read when it has
    /// not changed. Returns how many files had a range.
    pub fn forget_read_ranges(&mut self) -> usize {
        let mut forgotten = 0;
        for entry in self.entries.values_mut() {
            if entry.read.take().is_some() {
                forgotten += 1;
            }
        }
        forgotten
    }

    /// Whether the file `key`, whose content now hashes to `current`, may be replaced.
    #[must_use]
    pub fn freshness(&self, key: &str, current: &[u8; 32]) -> Freshness {
        match self.entries.get(key) {
            None => Freshness::NotRead,
            Some(entry) if &entry.snapshot.sha256 == current => Freshness::Fresh,
            Some(_) => Freshness::Modified,
        }
    }

    /// Number of files in the table.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the table is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Locks by file key, shared by every session of a Core.
#[derive(Debug, Default)]
pub struct PathLocks {
    held: Mutex<HashSet<String>>,
    released: Condvar,
}

/// Holds the lock of one key until dropped.
#[derive(Debug)]
pub struct PathGuard<'a> {
    locks: &'a PathLocks,
    key: String,
}

impl PathLocks {
    /// Waits until no one holds `key`, then holds it.
    pub fn lock(&self, key: &str) -> PathGuard<'_> {
        let mut held = lock(&self.held);
        while held.contains(key) {
            held = self
                .released
                .wait(held)
                .unwrap_or_else(PoisonError::into_inner);
        }
        held.insert(key.to_owned());
        PathGuard {
            locks: self,
            key: key.to_owned(),
        }
    }
}

impl Drop for PathGuard<'_> {
    fn drop(&mut self) {
        lock(&self.locks.held).remove(&self.key);
        self.locks.released.notify_all();
    }
}

/// Locks `mutex`, recovering the data if a panicking thread poisoned it: every critical section
/// leaves the set consistent.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn snapshot(text: &str) -> Snapshot {
        Snapshot {
            sha256: Sha256::digest(text.as_bytes()).into(),
            size: text.len() as u64,
            modified: None,
        }
    }

    fn range(offset: Option<u64>, limit: Option<u64>) -> ReadRange {
        ReadRange {
            offset,
            limit,
            pages: None,
        }
    }

    #[test]
    fn a_repeat_needs_the_same_range_and_content() {
        let mut states = FileStates::default();
        assert!(!states.record_read("a".into(), snapshot("x"), range(None, None)));
        assert!(states.record_read("a".into(), snapshot("x"), range(None, None)));
        assert!(!states.record_read("a".into(), snapshot("x"), range(Some(5), None)));
        assert!(!states.record_read("a".into(), snapshot("y"), range(Some(5), None)));
        // After the session's own write, the next read is not a repeat.
        states.record_write("a".into(), snapshot("z"));
        assert!(!states.record_read("a".into(), snapshot("z"), range(Some(5), None)));
    }

    #[test]
    fn freshness_needs_a_read_or_write_of_the_current_content() {
        let mut states = FileStates::default();
        let x = snapshot("x").sha256;
        assert_eq!(states.freshness("a", &x), Freshness::NotRead);
        states.record_read("a".into(), snapshot("x"), range(Some(1), Some(2)));
        assert_eq!(states.freshness("a", &x), Freshness::Fresh);
        assert_eq!(
            states.freshness("a", &snapshot("y").sha256),
            Freshness::Modified
        );
        states.record_write("a".into(), snapshot("y"));
        assert_eq!(
            states.freshness("a", &snapshot("y").sha256),
            Freshness::Fresh
        );
    }

    #[test]
    fn external_changes_report_each_new_version_once() {
        use std::collections::HashMap;
        use std::time::Duration;

        let at = |s: u64| Some(SystemTime::UNIX_EPOCH + Duration::from_secs(s));
        let mut states = FileStates::default();
        let mut seen = snapshot("one");
        seen.modified = at(1);
        states.record_read("a".into(), seen.clone(), range(None, None));
        let mut other = snapshot("x");
        other.modified = at(1);
        states.record_write("b".into(), other);

        // (size, modified, content) of each file now; `None` means deleted.
        type Disk<'a> = HashMap<&'a str, Option<(u64, Option<SystemTime>, &'a str)>>;
        let mut disk: Disk = HashMap::new();
        disk.insert("a", Some((3, at(1), "one")));
        disk.insert("b", Some((1, at(1), "x")));
        let mut hashes = 0;
        let check = |states: &mut FileStates, disk: &Disk, hashes: &mut usize| {
            states.external_changes(
                |key| match disk.get(key).copied().flatten() {
                    Some((size, modified, _)) => Ok((size, modified)),
                    None => Err(io::Error::from(io::ErrorKind::NotFound)),
                },
                |key| {
                    *hashes += 1;
                    let text = disk.get(key).copied().flatten().map_or("", |f| f.2);
                    Ok(snapshot(text).sha256)
                },
            )
        };
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
        assert_eq!(hashes, 0, "same metadata: no hashing");

        // `touch`: new time, same content: not a change, hashed once.
        disk.insert("a", Some((3, at(2), "one")));
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
        assert_eq!(hashes, 1);

        // A real change is reported once, again only for a newer version.
        disk.insert("a", Some((3, at(3), "two")));
        assert_eq!(
            check(&mut states, &disk, &mut hashes),
            vec![("a".to_owned(), ExternalChange::Modified)]
        );
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
        disk.insert("a", Some((5, at(4), "three")));
        assert_eq!(
            check(&mut states, &disk, &mut hashes),
            vec![("a".to_owned(), ExternalChange::Modified)]
        );
        // The snapshot stays: replacing it still needs a read.
        assert_eq!(
            states.freshness("a", &snapshot("three").sha256),
            Freshness::Modified
        );

        // Deleted, reported once; the session's own write starts over.
        disk.insert("b", None);
        assert_eq!(
            check(&mut states, &disk, &mut hashes),
            vec![("b".to_owned(), ExternalChange::Deleted)]
        );
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
        let mut again = snapshot("three");
        again.modified = at(4);
        states.record_read("a".into(), again, range(None, None));
        assert!(check(&mut states, &disk, &mut hashes).is_empty());
    }

    #[test]
    fn forgetting_read_ranges_keeps_freshness_and_ends_repeats() {
        let mut states = FileStates::default();
        states.record_read("a".into(), snapshot("x"), range(None, None));
        states.record_write("b".into(), snapshot("y"));
        assert_eq!(states.forget_read_ranges(), 1);
        assert_eq!(
            states.freshness("a", &snapshot("x").sha256),
            Freshness::Fresh
        );
        assert!(!states.record_read("a".into(), snapshot("x"), range(None, None)));
        assert!(states.record_read("a".into(), snapshot("x"), range(None, None)));
    }

    #[test]
    fn path_locks_serialize_holders_of_one_key_only() {
        let locks = Arc::new(PathLocks::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (locks, inside, peak) = (locks.clone(), inside.clone(), peak.clone());
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        let _guard = locks.lock("same");
                        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::yield_now();
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("worker");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        // Different keys do not wait for each other.
        let _a = locks.lock("a");
        let _b = locks.lock("b");
    }
}
