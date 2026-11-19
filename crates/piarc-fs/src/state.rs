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
//! - nothing else: the table never holds content.
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
}

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
        self.entries.insert(
            key,
            Entry {
                snapshot,
                read: Some(range),
            },
        );
        repeat
    }

    /// Records that the session wrote `snapshot` to the file `key`: it may change it again
    /// without reading it, and its next `Read` returns the content.
    pub fn record_write(&mut self, key: String, snapshot: Snapshot) {
        self.entries.insert(
            key,
            Entry {
                snapshot,
                read: None,
            },
        );
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
