//! Writing a file under the editing invariants (architecture section 6.1.2), behind `fs/write`:
//!
//! 1. the path must be writable without asking ([`Scope::check`]);
//! 2. the file's lock is held until the new content is in place ([`PathLocks`]);
//! 3. an existing file must be fresh for this session: read or written by it, with the content
//!    it saw ([`FileStates::freshness`]), else [`Error::NotRead`] or [`Error::Modified`];
//! 4. the new text keeps the old file's encoding and byte order mark, and with
//!    [`LineEndings::MatchFile`] its line ending style; a new file is UTF-8 without a byte order
//!    mark, its line breaks as written;
//! 5. the bytes replace the file atomically ([`crate::atomic`]); on any failure the file is
//!    unchanged;
//! 6. the session's table records the write.
//!
//! The result carries the old and new text (without a byte order mark) for the diff.

use std::borrow::Cow;
use std::fs::{File, Metadata};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_protocol::fs::{FileStat, LineEndings, ReadRange};
use sha2::{Digest, Sha256};

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
}

/// A completed write.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    let path = scope.check(spec.requested, Access::Write)?;
    let key = scope.key(&path);
    let _guard = locks.lock(&key);
    let existing = existing_file(&path)?;
    if let Some((_, bytes)) = &existing {
        let current: [u8; 32] = Sha256::digest(bytes).into();
        check(lock(states).freshness(&key, &current), &path)?;
    }
    let (encoding, before) = match &existing {
        Some((_, bytes)) => {
            let encoding = detect(bytes);
            let text = decode(encoding, bytes);
            if matches!(encoding, TextEncoding::Utf16 { .. })
                && text.contains(char::REPLACEMENT_CHARACTER)
                && encode(encoding, &text).as_deref() != Ok(bytes.as_slice())
            {
                return Err(Error::coded(
                    &path,
                    "EILSEQ",
                    "cannot safely rewrite malformed UTF-16 text",
                ));
            }
            (encoding, Some(text))
        }
        None => (TextEncoding::NEW_FILE, None),
    };
    if !matches(before.as_deref(), spec.text) {
        return Err(Error::ApprovalMismatch {
            path: display(&path),
        });
    }
    let ending = match spec.line_endings {
        LineEndings::MatchFile => before.as_deref().and_then(dominant_line_ending),
        LineEndings::AsWritten => None,
    };
    let addition = ending.map_or(Cow::Borrowed(spec.text), |e| {
        with_line_endings(spec.text, e)
    });
    let after = match (&before, spec.append) {
        (Some(old), true) => format!("{old}{addition}"),
        _ => addition.into_owned(),
    };
    let bytes = encode(encoding, &after).map_err(|u| Error::Unencodable {
        path: display(&path),
        encoding: encoding.name(),
        character: u.character,
        line: u.line,
    })?;
    let metadata = existing.as_ref().map(|(m, _)| m);
    crate::atomic::replace_with(&path, metadata, |file| put(file, &bytes))
        .map_err(|e| Error::io(&path, e))?;
    lock(states).record_write(key, Snapshot::of_bytes(&bytes, &path));
    Ok(Written {
        label: scope.label(&path),
        path,
        before: before.map(without_bom),
        after: without_bom(after),
        bytes_written: bytes.len() as u64,
        encoding,
    })
}

/// Fails unless this session may change `requested` as it last saw it: the check of an `Edit`
/// before it reads the file it changes (`fs/read` with `requireFresh`).
///
/// # Errors
///
/// [`Error::NeedsApproval`] (reading), `notFound`, [`Error::NotRead`], [`Error::Modified`].
pub fn check_fresh(scope: &Scope, states: &Mutex<FileStates>, requested: &str) -> Result<()> {
    let path = scope.check(requested, Access::Read)?;
    let snapshot = Snapshot::of_file(&path).map_err(|e| Error::io(&path, e))?;
    check(
        lock(states).freshness(&scope.key(&path), &snapshot.sha256),
        &path,
    )
}

/// `fs/stat` for the `Read` tool: [`crate::stat`], and for a regular file the read is recorded
/// with `range`; `unchanged` says whether it repeats the session's previous read.
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
) -> Result<FileStat> {
    let mut stat = crate::stat(scope, requested, detect_image)?;
    if stat.kind == piarc_protocol::fs::FileKind::File {
        let path = scope.check(requested, Access::Read)?;
        let snapshot = Snapshot::of_file(&path).map_err(|e| Error::io(&path, e))?;
        let repeat = lock(states).record_read(scope.key(&path), snapshot, range);
        stat.unchanged = Some(repeat);
    }
    Ok(stat)
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
fn existing_file(path: &Path) -> Result<Option<(Metadata, Vec<u8>)>> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err(Error::coded(path, "EISDIR", "is a directory")),
        Ok(metadata) if metadata.permissions().readonly() => {
            Err(Error::coded(path, "EACCES", "permission denied"))
        }
        Ok(metadata) => {
            let bytes = std::fs::read(path).map_err(|e| Error::io(path, e))?;
            Ok(Some((metadata, bytes)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match path.parent() {
            Some(parent) if !parent.is_dir() => Err(Error::NotFound {
                path: display(parent),
            }),
            _ => Ok(None),
        },
        Err(error) => Err(Error::io(path, error)),
    }
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
