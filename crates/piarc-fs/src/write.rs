//! Writing a file under the editing invariants (architecture section 6.1.2), behind `fs/write`:
//!
//! 1. the path must be writable without asking ([`Scope::check`]);
//! 2. the file's lock is held until the new content is in place ([`PathLocks`]);
//! 3. an existing file must be fresh for this session: read or written by it, with the content
//!    it saw ([`FileStates::freshness`]), else [`Error::NotRead`] or [`Error::Modified`];
//! 4. the new text keeps the old file's encoding and byte order mark, and with
//!    [`LineEndings::MatchFile`] its line ending style; a new file is UTF-8 without a byte order
//!    mark, its line breaks as written;
//! 5. with a snapshot store ([`WriteSpec::snapshots`]), the old bytes are stored in it first,
//!    still under the lock (architecture section 6.9: the checkpoint's "before" content);
//! 6. the bytes replace the file atomically ([`crate::atomic`]); on any failure the file is
//!    unchanged;
//! 7. the session's table records the write.
//!
//! The result carries the old and new text (without a byte order mark) for the diff, and the
//! hashes of the old and new bytes for the checkpoint index.

use std::borrow::Cow;
use std::fs::{File, Metadata};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_checkpoint::{ObjectStore, Pin};
use piarc_protocol::fs::{FileStat, LineEndings, ReadRange};

use crate::access::Access;
use crate::encoding::{
    self, TextEncoding, decode, detect, dominant_line_ending, encode, with_line_endings,
};
use crate::error::{Error, Result};
use crate::scope::{Scope, display};
use crate::state::{FileStates, Freshness, PathLocks, Snapshot};

/// What to write.
#[derive(Debug, Clone, Copy)]
pub struct WriteSpec<'a> {
    /// The file, as the tool named it.
    pub requested: &'a str,
    /// The new text, or the text to append.
    pub text: &'a str,
    /// Append `text` to the current text instead of replacing it.
    pub append: bool,
    /// How the line breaks of `text` are written into an existing file.
    pub line_endings: LineEndings,
    /// Where the old bytes of an existing file go before it is replaced; `None` keeps no
    /// snapshot.
    pub snapshots: Option<&'a ObjectStore>,
}

/// A completed write.
#[derive(Debug)]
pub struct Written {
    /// The file, resolved.
    pub path: PathBuf,
    /// The file as diffs name it ([`Scope::label`]).
    pub label: String,
    /// The old text, without a byte order mark; `None` for a new file.
    pub before: Option<String>,
    /// The new text, without a byte order mark.
    pub after: String,
    /// Bytes now in the file.
    pub bytes_written: u64,
    /// The encoding the file was written in.
    pub encoding: TextEncoding,
    /// SHA-256 of the replaced bytes; `None` for a new file.
    pub before_sha256: Option<[u8; 32]>,
    /// SHA-256 of the bytes now in the file.
    pub after_sha256: [u8; 32],
    /// The stored old bytes, pinned until the caller recorded them in the index.
    pub snapshot: Option<Pin>,
}

/// Writes the file under the invariants above.
///
/// # Errors
///
/// [`Error::NeedsApproval`], [`Error::NotRead`], [`Error::Modified`], [`Error::Unencodable`];
/// `notFound` when the parent directory is missing; `EISDIR`, `EACCES` (read-only file) and
/// other I/O errors. The file is unchanged in every case.
pub fn write(
    scope: &Scope,
    states: &Mutex<FileStates>,
    locks: &PathLocks,
    spec: &WriteSpec<'_>,
) -> Result<Written> {
    write_checked(scope, states, locks, spec, |_, _| true)
}

/// Writes only if `matches` accepts the old decoded content and proposed text while holding
/// the file's mutation lock. See [`write`] for the other file invariants.
///
/// # Errors
///
/// [`Error::ApprovalMismatch`] if the change differs from what the user approved, and the
/// errors from [`write`].
pub fn write_checked(
    scope: &Scope,
    states: &Mutex<FileStates>,
    locks: &PathLocks,
    spec: &WriteSpec<'_>,
    matches: impl FnOnce(Option<&str>, &str) -> bool,
) -> Result<Written> {
    write_with(scope, states, locks, spec, matches, |file, bytes| {
        file.write_all(bytes)
    })
}

/// [`write`] with the bytes put into the temporary file by `put` (tests inject failures).
pub(crate) fn write_with(
    scope: &Scope,
    states: &Mutex<FileStates>,
    locks: &PathLocks,
    spec: &WriteSpec<'_>,
    matches: impl FnOnce(Option<&str>, &str) -> bool,
    put: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<Written> {
    write_inner(scope, Writer::Agent(states), locks, spec, matches, put)
}

/// Uses the displayed byte revision as the editor's read snapshot. A human read or save never
/// grants an agent permission to edit the same file without its own read.
pub(crate) fn write_editor(
    scope: &Scope,
    locks: &PathLocks,
    spec: &WriteSpec<'_>,
    expected: Option<[u8; 32]>,
    size_limit: u64,
) -> Result<Written> {
    write_inner(
        scope,
        Writer::Editor {
            expected,
            size_limit,
        },
        locks,
        spec,
        |_, _| true,
        |file, bytes| file.write_all(bytes),
    )
}

enum Writer<'a> {
    Agent(&'a Mutex<FileStates>),
    Editor {
        expected: Option<[u8; 32]>,
        size_limit: u64,
    },
}

impl Writer<'_> {
    fn record(&self, key: String, after_sha256: [u8; 32], written: &Metadata) {
        if let Writer::Agent(states) = self {
            lock(states).record_write(
                key,
                Snapshot {
                    sha256: after_sha256,
                    size: written.len(),
                    modified: written.modified().ok(),
                },
            );
        }
    }
    fn check(
        &self,
        scope: &Scope,
        requested: &str,
        bound: &crate::bound::BoundPath,
        key: &str,
        existing: Option<&(Metadata, Vec<u8>)>,
        original: Option<[u8; 32]>,
    ) -> Result<()> {
        let path = bound.path();
        match self {
            Writer::Agent(states) => {
                if let Some(current) = &original {
                    check(lock(states).freshness(key, current), path)?;
                }
            }
            Writer::Editor { expected, .. } => {
                if *expected != original {
                    return Err(Error::Changed {
                        path: display(path),
                    });
                }
                if let Some((_, bytes)) = existing
                    && crate::project::safe_text(bytes).is_none()
                {
                    return Err(Error::coded(
                        path,
                        "EILSEQ",
                        "file does not contain editable text",
                    ));
                }
                if expected.is_none() && !crate::project::can_create_at(scope, requested, bound)? {
                    return Err(Error::Changed {
                        path: display(path),
                    });
                }
            }
        }
        Ok(())
    }

    fn commit(
        &self,
        bound: &crate::bound::BoundPath,
        metadata: Option<&Metadata>,
        write: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> Result<Metadata> {
        match self {
            Writer::Editor { expected: None, .. } => crate::atomic::create_bound(bound, write),
            Writer::Editor {
                expected: Some(hash),
                size_limit,
            } => crate::atomic::replace_checked(bound, metadata, write, || {
                let mut current = bound
                    .open_file()
                    .map_err(io::Error::other)?
                    .take(*size_limit + 1);
                let mut bytes = Vec::new();
                current.read_to_end(&mut bytes)?;
                if bytes.len() as u64 > *size_limit || piarc_checkpoint::hash_of(&bytes) != *hash {
                    return Err(io::Error::other("the file changed during save"));
                }
                Ok(())
            }),
            Writer::Agent(_) => crate::atomic::replace_bound(bound, metadata, write),
        }
    }
}

fn write_inner(
    scope: &Scope,
    writer: Writer<'_>,
    locks: &PathLocks,
    spec: &WriteSpec<'_>,
    matches: impl FnOnce(Option<&str>, &str) -> bool,
    put: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<Written> {
    let bound = scope.bind(spec.requested, Access::Write)?;
    let path = bound.path();
    let key = scope.key(path);
    let _guard = locks.lock(&key);
    let size_limit = match writer {
        Writer::Agent(_) => None,
        Writer::Editor { size_limit, .. } => Some(size_limit),
    };
    let existing = existing_limited(&bound, size_limit)?;
    let before_sha256 = existing
        .as_ref()
        .map(|(_, bytes)| piarc_checkpoint::hash_of(bytes));
    writer.check(
        scope,
        spec.requested,
        &bound,
        &key,
        existing.as_ref(),
        before_sha256,
    )?;
    let (encoding, before) = match &existing {
        Some((_, bytes)) => {
            let (encoding, text) = decode_old(bytes, path)?;
            (encoding, Some(text))
        }
        None => (TextEncoding::NEW_FILE, None),
    };
    if matches!(writer, Writer::Editor { .. }) {
        crate::project::check_editor_change(path, before.as_deref(), spec.text)?;
    }
    if !matches(before.as_deref(), spec.text) {
        return Err(Error::ApprovalMismatch {
            path: display(path),
        });
    }
    let after = replacement_text(spec, before.as_deref());
    let bytes = encode(encoding, &after).map_err(|u| Error::Unencodable {
        path: display(path),
        encoding: encoding.name(),
        character: u.character,
        line: u.line,
    })?;
    let snapshot = match (spec.snapshots, &existing) {
        (Some(store), Some((_, old))) => {
            Some(store.put(old).map_err(|source| Error::Snapshot {
                path: display(path),
                source,
            })?)
        }
        _ => None,
    };
    let metadata = existing.as_ref().map(|(m, _)| m);
    if size_limit.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err(Error::coded(
            path,
            "EFBIG",
            "encoded file exceeds the editor limit",
        ));
    }
    let written = writer.commit(&bound, metadata, |file| put(file, &bytes))?;
    let after_sha256 = piarc_checkpoint::hash_of(&bytes);
    writer.record(key, after_sha256, &written);
    Ok(Written {
        label: scope.label(path),
        path: path.to_owned(),
        before: before.map(without_bom),
        after: without_bom(after),
        bytes_written: bytes.len() as u64,
        encoding,
        before_sha256,
        after_sha256,
        snapshot,
    })
}

fn replacement_text(spec: &WriteSpec<'_>, before: Option<&str>) -> String {
    let ending = match spec.line_endings {
        LineEndings::MatchFile => before.and_then(dominant_line_ending),
        LineEndings::AsWritten => None,
    };
    let addition = ending.map_or(Cow::Borrowed(spec.text), |e| {
        with_line_endings(spec.text, e)
    });
    match (before, spec.append) {
        (Some(old), true) => format!("{old}{addition}"),
        _ => addition.into_owned(),
    }
}

/// Fails unless this session may change `requested` as it last saw it: the check of an `Edit`
/// before it reads the file it changes (`fs/read` with `requireFresh`).
///
/// # Errors
///
/// [`Error::NeedsApproval`] (reading), `notFound`, [`Error::NotRead`], [`Error::Modified`].
pub fn check_fresh(scope: &Scope, states: &Mutex<FileStates>, requested: &str) -> Result<()> {
    let bound = scope.bind(requested, Access::Read)?;
    let path = bound.path();
    let snapshot = Snapshot::from_handle(bound.open_file()?).map_err(|e| Error::io(path, e))?;
    bound.verify()?;
    check(
        lock(states).freshness(&scope.key(path), &snapshot.sha256),
        path,
    )
}

/// Inspect or commit the version of a regular file observed by one Read call.
/// Beginning an observation never establishes write freshness.
///
/// # Errors
///
/// Those of [`crate::stat`]; the file cannot be read for its hash.
pub fn stat_for_read(
    scope: &Scope,
    states: &Mutex<FileStates>,
    requested: &str,
    detect_image: bool,
    range: ReadRange,
    call: &str,
    complete: bool,
) -> Result<FileStat> {
    let bound = scope.bind(requested, Access::Read)?;
    let mut stat = crate::entry::stat_bound(&bound, detect_image)?;
    if stat.kind == piarc_protocol::fs::FileKind::File {
        let path = bound.path();
        let snapshot = Snapshot::from_handle(bound.open_file()?).map_err(|e| Error::io(path, e))?;
        bound.verify()?;
        let key = scope.key(path);
        if complete {
            if !lock(states).complete_read(call, &key, &snapshot, &range) {
                return Err(Error::Modified {
                    path: display(path),
                });
            }
        } else {
            stat.unchanged = Some(lock(states).begin_read(call, key, snapshot, range));
        }
    } else if complete {
        return Err(Error::Modified {
            path: display(bound.path()),
        });
    }
    Ok(stat)
}

/// The encoding and text of a file about to be rewritten; malformed UTF-16 is refused so its
/// bytes are not lost.
fn decode_old(bytes: &[u8], path: &Path) -> Result<(TextEncoding, String)> {
    let encoding = detect(bytes);
    let text = decode(encoding, bytes);
    if matches!(encoding, TextEncoding::Utf16 { .. })
        && text.contains(char::REPLACEMENT_CHARACTER)
        && encode(encoding, &text).as_deref() != Ok(bytes)
    {
        return Err(Error::coded(
            path,
            "EILSEQ",
            "cannot safely rewrite malformed UTF-16 text",
        ));
    }
    Ok((encoding, text))
}

fn check(freshness: Freshness, path: &Path) -> Result<()> {
    match freshness {
        Freshness::Fresh => Ok(()),
        Freshness::NotRead => Err(Error::NotRead {
            path: display(path),
        }),
        Freshness::Modified => Err(Error::Modified {
            path: display(path),
        }),
    }
}

/// The metadata and bytes of the regular file at `path`; `None` when it does not exist (its
/// parent must).
pub(crate) fn existing_file(
    bound: &crate::bound::BoundPath,
) -> Result<Option<(Metadata, Vec<u8>)>> {
    existing_limited(bound, None)
}

fn existing_limited(
    bound: &crate::bound::BoundPath,
    size_limit: Option<u64>,
) -> Result<Option<(Metadata, Vec<u8>)>> {
    let path = bound.path();
    bound.parent()?;
    let mut file = match bound.open_file() {
        Ok(file) => file,
        Err(Error::NotFound { .. }) => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata().map_err(|e| Error::io(path, e))?;
    if metadata.permissions().readonly() {
        return Err(Error::coded(path, "EACCES", "permission denied"));
    }
    let mut bytes = Vec::new();
    if size_limit.is_some_and(|limit| metadata.len() > limit) {
        return Err(Error::coded(path, "EFBIG", "file exceeds the editor limit"));
    }
    (&mut file)
        .take(size_limit.map_or(u64::MAX, |n| n.saturating_add(1)))
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(path, e))?;
    if size_limit.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err(Error::coded(path, "EFBIG", "file exceeds the editor limit"));
    }
    bound.verify()?;
    Ok(Some((metadata, bytes)))
}

fn without_bom(text: String) -> String {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    }
}

fn lock(states: &Mutex<FileStates>) -> MutexGuard<'_, FileStates> {
    states.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The encoding name `fs/write` reports for `written` (only when not UTF-8).
#[must_use]
pub fn reported_encoding(written: &Written) -> Option<String> {
    encoding::TextEncoding::reported(written.encoding)
}

#[cfg(test)]
mod tests;
