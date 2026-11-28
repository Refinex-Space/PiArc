//! Putting recorded content back into a file: rewinds, their undo, and discarding changes in the
//! Changes panel (architecture section 6.9, ADR-0044 rules 4 and 8). These are the user's
//! actions, not a tool's, so the session's read-before-edit check does not apply; instead the
//! caller names the content it expects to find, and under the file's path lock:
//!
//! 1. the current content must hash to [`Replacement::expected`] (`None`: no file), else
//!    [`Error::Changed`] and nothing is touched;
//! 2. content that is already the target is left alone;
//! 3. the current bytes are stored in the snapshot store (so the action can be undone);
//! 4. the target bytes replace the file atomically, creating missing parent directories, or the
//!    file is removed;
//! 5. the session forgets the file ([`FileStates::forget`]): the agent reads it again before it
//!    edits it.
//!
//! The bytes are written as recorded, so encoding, byte order mark and line endings are those of
//! the snapshot. A read-only file is refused like any write (`EACCES`).

use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_checkpoint::{ObjectStore, Pin, hash_of};

use crate::access::Access;
use crate::error::{Error, Result};
use crate::scope::{Scope, display};
use crate::state::{FileStates, PathLocks, Snapshot};
use crate::write::existing_file;

/// What to put at a path.
#[derive(Debug, Clone, Copy)]
pub struct Replacement<'a> {
    /// The file.
    pub requested: &'a str,
    /// SHA-256 of the content the caller expects there now; `None`: no file.
    pub expected: Option<[u8; 32]>,
    /// The bytes to put there; `None`: remove the file.
    pub content: Option<&'a [u8]>,
    /// Where the replaced bytes go first.
    pub snapshots: &'a ObjectStore,
}

/// A completed replacement.
#[derive(Debug)]
pub struct Replaced {
    /// The file, resolved.
    pub path: PathBuf,
    /// The file as diffs name it ([`Scope::label`]).
    pub label: String,
    /// SHA-256 of the replaced bytes; `None`: there was no file.
    pub before_sha256: Option<[u8; 32]>,
    /// SHA-256 of the bytes now there; `None`: no file.
    pub after_sha256: Option<[u8; 32]>,
    /// Whether anything changed (false when the file already had the target content).
    pub changed: bool,
    /// The stored replaced bytes, pinned until the caller recorded them.
    pub snapshot: Option<Pin>,
}

/// Replaces the file as described above.
///
/// # Errors
///
/// [`Error::Changed`] when the file is not as expected; [`Error::NeedsApproval`] for a path
/// the scope does not allow writing; [`Error::Snapshot`]; `EACCES` for a read-only file; other
/// I/O errors. The file is unchanged in every case.
pub fn replace(
    scope: &Scope,
    states: &Mutex<FileStates>,
    locks: &PathLocks,
    spec: &Replacement<'_>,
) -> Result<Replaced> {
    let bound = scope.bind(spec.requested, Access::Write)?;
    let path = bound.path().to_owned();
    let key = scope.key(&path);
    let _guard = locks.lock(&key);
    let existing = match existing_file(&bound) {
        Ok(existing) => existing,
        // The parent directory is gone too.
        Err(Error::NotFound { .. }) => None,
        Err(error) => return Err(error),
    };
    let before_sha256 = existing.as_ref().map(|(_, bytes)| hash_of(bytes));
    if before_sha256 != spec.expected {
        return Err(Error::Changed {
            path: display(&path),
        });
    }
    let after_sha256 = spec.content.map(hash_of);
    let mut replaced = Replaced {
        label: scope.label(&path),
        path,
        before_sha256,
        after_sha256,
        changed: false,
        snapshot: None,
    };
    if after_sha256 == before_sha256 {
        return Ok(replaced);
    }
    replaced.snapshot = existing
        .as_ref()
        .map(|(_, bytes)| spec.snapshots.put(bytes))
        .transpose()
        .map_err(|source| Error::Snapshot {
            path: display(&replaced.path),
            source,
        })?;
    match spec.content {
        Some(bytes) => {
            let bound = if existing.is_none() && bound.parent().is_err() {
                // Recreate the directories a command removed, then bind the file below them.
                let parent = replaced
                    .path
                    .parent()
                    .ok_or_else(|| Error::coded(&replaced.path, "EINVAL", "no parent"))?;
                scope.bind(&display(parent), Access::Write)?.mkdir()?;
                scope.bind(spec.requested, Access::Write)?
            } else {
                bound
            };
            let metadata = existing.as_ref().map(|(m, _)| m);
            crate::atomic::replace_bound(&bound, metadata, |file| file.write_all(bytes))?;
        }
        None => bound.remove_file()?,
    }
    lock(states).forget(&key);
    replaced.changed = true;
    Ok(replaced)
}

/// The SHA-256 of the file's content now; `None` when there is no file.
///
/// # Errors
///
/// [`Error::NeedsApproval`] for a path the scope does not allow reading; `EISDIR`; other I/O
/// errors.
pub fn current_sha256(scope: &Scope, requested: &str) -> Result<Option<[u8; 32]>> {
    let bound = scope.bind(requested, Access::Read)?;
    let file = match bound.open_file() {
        Ok(file) => file,
        Err(Error::NotFound { .. }) => return Ok(None),
        Err(error) => return Err(error),
    };
    let snapshot = Snapshot::from_handle(file).map_err(|e| Error::io(bound.path(), e))?;
    bound.verify()?;
    Ok(Some(snapshot.sha256))
}

/// A file's content as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Current {
    /// There is no file.
    Missing,
    /// The file's bytes.
    Bytes(Vec<u8>),
    /// The file is larger than the limit; only its size and hash are known.
    TooLarge {
        /// Its size in bytes.
        size: u64,
        /// SHA-256 of its content.
        sha256: [u8; 32],
    },
}

/// The file's bytes when it has at most `limit` of them.
///
/// # Errors
///
/// As [`current_sha256`].
pub fn read_current(scope: &Scope, requested: &str, limit: u64) -> Result<Current> {
    let bound = scope.bind(requested, Access::Read)?;
    let mut file = match bound.open_file() {
        Ok(file) => file,
        Err(Error::NotFound { .. }) => return Ok(Current::Missing),
        Err(error) => return Err(error),
    };
    let size = file
        .metadata()
        .map_err(|e| Error::io(bound.path(), e))?
        .len();
    if size > limit {
        let snapshot = Snapshot::from_handle(file).map_err(|e| Error::io(bound.path(), e))?;
        bound.verify()?;
        return Ok(Current::TooLarge {
            size: snapshot.size,
            sha256: snapshot.sha256,
        });
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| Error::io(bound.path(), e))?;
    bound.verify()?;
    Ok(Current::Bytes(bytes))
}

fn lock(states: &Mutex<FileStates>) -> MutexGuard<'_, FileStates> {
    states.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
