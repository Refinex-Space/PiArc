//! The session index: Pi session files folded into `sessions`, kept current incrementally.
//!
//! # Incremental sync state (`session_files`)
//!
//! Each session file has a row with the byte offset read so far (just after the last complete
//! line), the offset where that last line starts and the SHA-256 of its bytes, and the id of
//! the last entry. A sync of a file
//!
//! - does nothing when the file length equals the offset;
//! - continues from the offset, folding only the new lines into the stored metadata, when the
//!   file grew and its last synced line is unchanged;
//! - reads the whole file again when it is shorter than the offset or the last synced line
//!   changed (the file was replaced or rewritten).
//!
//! An unfinished last line is left for the next sync. A line that is not valid JSON is
//! skipped and counted; a header with an unknown format version marks the session
//! `unavailable` without failing the sync.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result, path_text};
use crate::jsonl::{LineReader, Parsed};
use crate::pi_session::{Entry, SessionMeta, Unindexable, Usage};
use crate::store::Store;

/// Whether a session's metadata could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexStatus {
    /// The file was read.
    Indexed,
    /// The file cannot be read by this build (see `index_error`).
    Unavailable,
}

impl IndexStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Indexed => "indexed",
            Self::Unavailable => "unavailable",
        }
    }

    fn parse(text: &str) -> Self {
        if text == "indexed" {
            Self::Indexed
        } else {
            Self::Unavailable
        }
    }
}

/// One row of `sessions`.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecord {
    /// Session id (the header's `id`, or the file name for a file without a readable header).
    pub id: String,
    /// The session file.
    pub file_path: String,
    /// Derived metadata.
    pub meta: SessionMeta,
    /// Whether the file could be read.
    pub index_status: IndexStatus,
    /// Why not, when unavailable.
    pub index_error: Option<String>,
    /// Core's own state: the workspace the session belongs to.
    pub workspace_path: Option<String>,
    /// Core's own state: the session's last state (`idle`, `error`).
    pub status: Option<String>,
    /// Core's own state: pinned.
    pub pinned: bool,
    /// Core's own state: archived.
    pub archived: bool,
    /// Core's own state: unread.
    pub unread: bool,
    /// Core's own state: the title the user gave the session in PiArc.
    pub custom_title: Option<String>,
}

impl SessionRecord {
    /// The display title: the user's title, else the session name, else the first user
    /// message.
    #[must_use]
    pub fn title(&self) -> Option<&str> {
        self.custom_title
            .as_deref()
            .or(self.meta.name.as_deref())
            .or(self.meta.first_message.as_deref())
    }
}

/// A change to Core's own metadata of a session; `None` fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionPrefsChange {
    /// The user's title; `Some(None)` removes it (the derived title shows again).
    pub custom_title: Option<Option<String>>,
    /// Pinned to the top of its workspace.
    pub pinned: Option<bool>,
    /// Archived (hidden from the default list).
    pub archived: Option<bool>,
}

/// What a sync of one file did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOutcome {
    /// Nothing new since the last sync.
    Unchanged,
    /// New lines were folded in.
    Appended {
        /// Entries read.
        entries: u64,
    },
    /// The file was read from the start.
    Rescanned {
        /// Entries read.
        entries: u64,
    },
    /// The file has no complete line yet.
    Empty,
    /// The session is marked unavailable.
    Unavailable {
        /// Why.
        reason: String,
    },
}

/// A line that was skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedLine {
    /// The file.
    pub path: PathBuf,
    /// Byte offset of the line.
    pub offset: u64,
    /// The parser's message.
    pub reason: String,
}

/// What a sync of a directory did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Session files found.
    pub files: usize,
    /// Files read from the start.
    pub rescanned: usize,
    /// Files that grew and were continued.
    pub appended: usize,
    /// Files without change.
    pub unchanged: usize,
    /// Sessions marked unavailable, with the reason.
    pub unavailable: Vec<(PathBuf, String)>,
    /// Lines skipped because they were not valid entries.
    pub skipped_lines: Vec<SkippedLine>,
    /// Index rows removed because their file is gone.
    pub removed: usize,
    /// Files that could not be read at all (I/O errors); their rows are left as they were.
    pub failed: Vec<(PathBuf, String)>,
}

struct SyncState {
    byte_offset: u64,
    tail_start: u64,
    tail_hash: Vec<u8>,
    identity: Option<String>,
    modified: Option<String>,
    skipped: i64,
}

/// File identity distinguishes atomic replacements. Modification time also detects
/// edits to earlier lines when the length and the last complete entry stay equal.
struct Stamp {
    identity: Option<String>,
    modified: Option<String>,
}

impl From<&std::fs::Metadata> for Stamp {
    fn from(metadata: &std::fs::Metadata) -> Self {
        let timestamp = |time: std::time::SystemTime| {
            time.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|t| t.as_nanos().to_string())
        };
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt as _;
            Some(format!("{}:{}", metadata.dev(), metadata.ino()))
        };
        #[cfg(not(unix))]
        let identity = metadata.created().ok().and_then(timestamp);
        Self {
            identity,
            modified: metadata.modified().ok().and_then(timestamp),
        }
    }
}

struct Scan {
    meta: SessionMeta,
    entries: u64,
    offset: u64,
    tail_start: u64,
    skipped: Vec<SkippedLine>,
    unindexable: Option<Unindexable>,
}

impl Store {
    /// Brings the index of one session file up to date.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the file cannot be read; [`Error::Sqlite`] when the index cannot be
    /// written. A malformed file is not an error (see [`FileOutcome::Unavailable`]).
    pub fn sync_file(
        &mut self,
        path: &Path,
        skipped: &mut Vec<SkippedLine>,
    ) -> Result<FileOutcome> {
        let key = path_text(path)?.to_owned();
        let mut file = File::open(path).map_err(Error::io("cannot open", path))?;
        let metadata = file
            .metadata()
            .map_err(Error::io("cannot read the metadata of", path))?;
        let len = metadata.len();
        let stamp = Stamp::from(&metadata);
        let state = self.sync_state(&key)?;
        let stored = self.session_by_file(&key)?;
        let resume = match (&state, &stored) {
            (Some(state), Some(record))
                if len >= state.byte_offset
                    && stamp.identity.is_some()
                    && stamp.identity == state.identity
                    && (len > state.byte_offset
                        || (stamp.modified.is_some() && stamp.modified == state.modified)) =>
            {
                let hash = hash_range(&mut file, state.tail_start, state.byte_offset)
                    .map_err(Error::io("cannot read", path))?;
                if hash != state.tail_hash {
                    None
                } else if len == state.byte_offset
                    || record.index_status == IndexStatus::Unavailable
                {
                    return Ok(FileOutcome::Unchanged);
                } else {
                    Some((state, record))
                }
            }
            _ => None,
        };
        let appending = resume.is_some();
        let scan = match resume {
            Some((state, record)) => {
                let mut meta = record.meta.clone();
                meta.last_entry_id = self.last_entry_id(&key)?;
                scan_file(
                    &mut file,
                    path,
                    state.byte_offset,
                    state.tail_start,
                    Some(meta),
                )
            }
            None => scan_file(&mut file, path, 0, 0, None),
        }
        .map_err(Error::io("cannot read", path))?;
        if appending
            && state.as_ref().is_some_and(|s| s.byte_offset == scan.offset)
            && scan.skipped.is_empty()
        {
            // Only an unfinished line was added since the last sync.
            return Ok(FileOutcome::Unchanged);
        }
        let prior_skips = state
            .as_ref()
            .filter(|_| appending)
            .map_or(0, |s| s.skipped);
        let outcome = self.store_scan(path, &mut file, &scan, prior_skips, appending, &stamp)?;
        skipped.extend(scan.skipped);
        Ok(outcome)
    }

    fn store_scan(
        &mut self,
        path: &Path,
        file: &mut File,
        scan: &Scan,
        prior_skips: i64,
        appending: bool,
        stamp: &Stamp,
    ) -> Result<FileOutcome> {
        let key = path_text(path)?;
        if scan.offset == 0 {
            return Ok(FileOutcome::Empty);
        }
        let tail_hash = hash_range(file, scan.tail_start, scan.offset)
            .map_err(Error::io("cannot read", path))?;
        let (status, error) = match &scan.unindexable {
            None => (IndexStatus::Indexed, None),
            Some(reason) => (IndexStatus::Unavailable, Some(reason.to_string())),
        };
        let id = scan.meta.id.clone().unwrap_or_else(|| fallback_id(path));
        let skipped_total = prior_skips + i64::try_from(scan.skipped.len()).unwrap_or(i64::MAX);
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot start the index transaction"))?;
        write_session(&tx, &id, key, &scan.meta, status, error.as_deref())?;
        tx.execute(
            "INSERT INTO session_files (file_path, session_id, byte_offset, tail_start, tail_hash, last_entry_id, skipped_lines, file_identity, modified_ns)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(file_path) DO UPDATE SET session_id = excluded.session_id,
                byte_offset = excluded.byte_offset, tail_start = excluded.tail_start,
                tail_hash = excluded.tail_hash, last_entry_id = excluded.last_entry_id,
                skipped_lines = excluded.skipped_lines, file_identity = excluded.file_identity, modified_ns = excluded.modified_ns",
            params![
                key,
                id,
                to_i64(scan.offset),
                to_i64(scan.tail_start),
                tail_hash,
                scan.meta.last_entry_id,
                skipped_total, stamp.identity, stamp.modified
            ],
        )
        .map_err(Error::sqlite("cannot write session_files"))?;
        tx.commit()
            .map_err(Error::sqlite("cannot commit the index transaction"))?;
        Ok(match (&scan.unindexable, appending) {
            (Some(reason), _) => FileOutcome::Unavailable {
                reason: reason.to_string(),
            },
            (None, true) => FileOutcome::Appended {
                entries: scan.entries,
            },
            (None, false) => FileOutcome::Rescanned {
                entries: scan.entries,
            },
        })
    }

    /// Syncs every session file under `sessions_dir` (Pi's `<agentDir>/sessions/`: one
    /// directory per working directory, `*.jsonl` inside) and removes index rows of files
    /// under it that no longer exist.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the directory cannot be listed; [`Error::Sqlite`] when the index
    /// cannot be written. Unreadable files are reported in [`SyncReport::failed`].
    pub fn sync_dir(&mut self, sessions_dir: &Path) -> Result<SyncReport> {
        let files = session_files(sessions_dir)?;
        let mut report = SyncReport {
            files: files.len(),
            ..SyncReport::default()
        };
        for path in &files {
            match self.sync_file(path, &mut report.skipped_lines) {
                Ok(FileOutcome::Unchanged | FileOutcome::Empty) => report.unchanged += 1,
                Ok(FileOutcome::Appended { .. }) => report.appended += 1,
                Ok(FileOutcome::Rescanned { .. }) => report.rescanned += 1,
                Ok(FileOutcome::Unavailable { reason }) => {
                    report.unavailable.push((path.clone(), reason));
                }
                Err(error @ (Error::Io { .. } | Error::NonUtf8Path { .. })) => {
                    report.failed.push((path.clone(), error.to_string()));
                }
                Err(error) => return Err(error),
            }
        }
        report.removed = self.remove_missing(sessions_dir, &files)?;
        Ok(report)
    }

    /// Rebuilds the session index from the files: drops the sync state and every derived
    /// column, then reads every file under `sessions_dir` from the start. Core's own columns
    /// (pinned, archived, unread, workspace) of sessions whose file still exists are kept.
    ///
    /// # Errors
    ///
    /// As [`Store::sync_dir`].
    pub fn rebuild_index(&mut self, sessions_dir: &Path) -> Result<SyncReport> {
        self.conn
            .execute_batch(
                "BEGIN;
                 DELETE FROM session_files;
                 UPDATE sessions SET cwd = NULL, parent_session = NULL, name = NULL,
                    first_message = NULL, model_provider = NULL, model_id = NULL,
                    message_count = 0, input_tokens = 0, output_tokens = 0,
                    cache_read_tokens = 0, cache_write_tokens = 0, cost_total = 0,
                    created_at = NULL, updated_at = NULL, format_version = NULL,
                    index_status = 'unavailable', index_error = 'rebuilding';
                 COMMIT;",
            )
            .map_err(Error::sqlite("cannot clear the derived index"))?;
        self.sync_dir(sessions_dir)
    }

    /// Every session, most recently updated first.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the index cannot be read.
    pub fn sessions(&self) -> Result<Vec<SessionRecord>> {
        let mut statement = self
            .conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, id"
            ))
            .map_err(Error::sqlite("cannot read sessions"))?;
        let rows = statement
            .query_map([], session_from_row)
            .map_err(Error::sqlite("cannot read sessions"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read sessions"))
    }

    /// Records Core's own state of session `id`: its workspace, last state and unread flag.
    /// Returns false when the index has no row for it yet (Pi writes the file with the first
    /// response; the next sync adds the row).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_session_state(
        &self,
        id: &str,
        workspace_path: &str,
        status: &str,
        unread: bool,
    ) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE sessions SET workspace_path = ?2, status = ?3, unread = ?4 WHERE id = ?1",
                params![id, workspace_path, status, unread],
            )
            .map_err(Error::sqlite("cannot write the session state"))?;
        Ok(changed > 0)
    }

    /// Applies `change` to session `id`. Returns false when the index has no row for it yet.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_session_prefs(&self, id: &str, change: &SessionPrefsChange) -> Result<bool> {
        let exists: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(Error::sqlite("cannot read sessions"))?;
        if !exists {
            return Ok(false);
        }
        let write = |sql: &str, value: &dyn rusqlite::ToSql| {
            self.conn
                .execute(sql, params![id, value])
                .map(|_| ())
                .map_err(Error::sqlite("cannot write the session metadata"))
        };
        if let Some(title) = &change.custom_title {
            write("UPDATE sessions SET custom_title = ?2 WHERE id = ?1", title)?;
        }
        if let Some(pinned) = change.pinned {
            write("UPDATE sessions SET pinned = ?2 WHERE id = ?1", &pinned)?;
        }
        if let Some(archived) = change.archived {
            write("UPDATE sessions SET archived = ?2 WHERE id = ?1", &archived)?;
        }
        Ok(true)
    }

    /// Forgets session `id`: its row and its file's sync state. Returns its file (to be
    /// deleted by the caller), or `None` when the index does not know it.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be deleted.
    pub fn remove_session(&mut self, id: &str) -> Result<Option<String>> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot start the index transaction"))?;
        let file: Option<String> = tx
            .query_row(
                "SELECT file_path FROM sessions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::sqlite("cannot read sessions"))?;
        if let Some(file) = &file {
            tx.execute("DELETE FROM sessions WHERE id = ?1", [id])
                .map_err(Error::sqlite("cannot delete from sessions"))?;
            tx.execute("DELETE FROM session_files WHERE file_path = ?1", [file])
                .map_err(Error::sqlite("cannot delete from session_files"))?;
        }
        tx.commit()
            .map_err(Error::sqlite("cannot commit the index transaction"))?;
        Ok(file)
    }

    /// One session by id.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the index cannot be read.
    pub fn session(&self, id: &str) -> Result<Option<SessionRecord>> {
        self.conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                [id],
                session_from_row,
            )
            .optional()
            .map_err(Error::sqlite("cannot read sessions"))
    }

    fn session_by_file(&self, key: &str) -> Result<Option<SessionRecord>> {
        self.conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE file_path = ?1"),
                [key],
                session_from_row,
            )
            .optional()
            .map_err(Error::sqlite("cannot read sessions"))
    }

    fn sync_state(&self, key: &str) -> Result<Option<SyncState>> {
        self.conn
            .query_row(
                "SELECT byte_offset, tail_start, tail_hash, skipped_lines, file_identity, modified_ns FROM session_files WHERE file_path = ?1",
                [key],
                |row| {
                    Ok(SyncState {
                        byte_offset: from_i64(row.get(0)?),
                        tail_start: from_i64(row.get(1)?),
                        tail_hash: row.get(2)?,
                        skipped: row.get(3)?,
                        identity: row.get(4)?,modified: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Error::sqlite("cannot read session_files"))
    }

    fn last_entry_id(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT last_entry_id FROM session_files WHERE file_path = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(Error::sqlite("cannot read session_files"))
    }

    fn remove_missing(&mut self, sessions_dir: &Path, present: &[PathBuf]) -> Result<usize> {
        let present: HashSet<&str> = present.iter().filter_map(|p| p.to_str()).collect();
        let prefix = path_text(sessions_dir)?;
        let indexed: Vec<String> = {
            let mut statement = self
                .conn
                .prepare("SELECT file_path FROM sessions")
                .map_err(Error::sqlite("cannot read sessions"))?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(Error::sqlite("cannot read sessions"))?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(Error::sqlite("cannot read sessions"))?
        };
        let gone: Vec<&String> = indexed
            .iter()
            .filter(|p| Path::new(p).starts_with(prefix) && !present.contains(p.as_str()))
            .collect();
        if gone.is_empty() {
            return Ok(0);
        }
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot start the index transaction"))?;
        for path in &gone {
            tx.execute("DELETE FROM sessions WHERE file_path = ?1", [path])
                .map_err(Error::sqlite("cannot delete from sessions"))?;
            tx.execute("DELETE FROM session_files WHERE file_path = ?1", [path])
                .map_err(Error::sqlite("cannot delete from session_files"))?;
        }
        tx.commit()
            .map_err(Error::sqlite("cannot commit the index transaction"))?;
        Ok(gone.len())
    }
}

const SESSION_COLUMNS: &str = "id, file_path, cwd, parent_session, name, first_message, \
    model_provider, model_id, message_count, input_tokens, output_tokens, cache_read_tokens, \
    cache_write_tokens, cost_total, created_at, updated_at, format_version, index_status, \
    index_error, workspace_path, pinned, archived, unread, status, custom_title";

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    let status: String = row.get(17)?;
    Ok(SessionRecord {
        id: row.get(0)?,
        file_path: row.get(1)?,
        meta: SessionMeta {
            id: Some(row.get(0)?),
            version: row.get(16)?,
            cwd: row.get(2)?,
            parent_session: row.get(3)?,
            name: row.get(4)?,
            first_message: row.get(5)?,
            model_provider: row.get(6)?,
            model_id: row.get(7)?,
            message_count: row.get(8)?,
            usage: Usage {
                input: row.get(9)?,
                output: row.get(10)?,
                cache_read: row.get(11)?,
                cache_write: row.get(12)?,
                cost: row.get(13)?,
            },
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            last_entry_id: None,
        },
        index_status: IndexStatus::parse(&status),
        index_error: row.get(18)?,
        workspace_path: row.get(19)?,
        pinned: row.get(20)?,
        archived: row.get(21)?,
        unread: row.get(22)?,
        status: row.get(23)?,
        custom_title: row.get(24)?,
    })
}

fn write_session(
    tx: &Transaction<'_>,
    id: &str,
    key: &str,
    meta: &SessionMeta,
    status: IndexStatus,
    error: Option<&str>,
) -> Result<()> {
    // The file now holds another session (it was replaced): drop the old row.
    tx.execute(
        "DELETE FROM sessions WHERE file_path = ?1 AND id <> ?2",
        params![key, id],
    )
    .map_err(Error::sqlite("cannot write sessions"))?;
    tx.execute(
        "INSERT INTO sessions (id, file_path, cwd, parent_session, name, first_message,
            model_provider, model_id, message_count, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_total, created_at, updated_at,
            format_version, index_status, index_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, cwd = excluded.cwd,
            parent_session = excluded.parent_session, name = excluded.name,
            first_message = excluded.first_message, model_provider = excluded.model_provider,
            model_id = excluded.model_id, message_count = excluded.message_count,
            input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_write_tokens = excluded.cache_write_tokens, cost_total = excluded.cost_total,
            created_at = excluded.created_at, updated_at = excluded.updated_at,
            format_version = excluded.format_version, index_status = excluded.index_status,
            index_error = excluded.index_error",
        params![
            id,
            key,
            meta.cwd,
            meta.parent_session,
            meta.name,
            meta.first_message,
            meta.model_provider,
            meta.model_id,
            meta.message_count,
            meta.usage.input,
            meta.usage.output,
            meta.usage.cache_read,
            meta.usage.cache_write,
            meta.usage.cost,
            meta.created_at,
            meta.updated_at,
            meta.version,
            status.as_str(),
            error
        ],
    )
    .map_err(Error::sqlite("cannot write sessions"))?;
    Ok(())
}

/// Reads `file` from `offset`. `meta` is the state folded so far (`None` reads from the
/// start, header first).
fn scan_file(
    file: &mut File,
    path: &Path,
    offset: u64,
    tail_start: u64,
    meta: Option<SessionMeta>,
) -> io::Result<Scan> {
    let fresh = meta.is_none();
    let mut scan = Scan {
        meta: meta.unwrap_or_default(),
        entries: 0,
        offset,
        tail_start,
        skipped: Vec::new(),
        unindexable: None,
    };
    let mut reader = LineReader::at(&mut *file, offset)?;
    let mut need_header = fresh;
    while let Some(line) = reader.next_line()? {
        let (parsed, bytes) = line.parse::<Entry>()?;
        match parsed {
            Parsed::Incomplete => break,
            Parsed::Blank => {}
            Parsed::Invalid(error) if need_header => {
                scan.unindexable = Some(Unindexable::NoHeader);
                scan.skipped.push(skipped(path, bytes.start, &error));
            }
            Parsed::Invalid(error) => scan.skipped.push(skipped(path, bytes.start, &error)),
            Parsed::Value(entry) if need_header => {
                need_header = false;
                if let Err(reason) = scan.meta.start(&entry) {
                    scan.unindexable = Some(reason);
                }
            }
            Parsed::Value(entry) => {
                scan.meta.fold(entry);
                scan.entries += 1;
            }
        }
        scan.tail_start = bytes.start;
        scan.offset = reader.offset();
        if scan.unindexable.is_some() {
            // Nothing after an unreadable header is used; stop at the header line.
            break;
        }
    }
    Ok(scan)
}

fn skipped(path: &Path, offset: u64, error: &serde_json::Error) -> SkippedLine {
    SkippedLine {
        path: path.to_owned(),
        offset,
        reason: error.to_string(),
    }
}

/// SHA-256 of `file[start..end]`, streamed.
fn hash_range(file: &mut File, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut hasher = Sha256::new();
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = end.saturating_sub(start);
    let mut buffer = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        let want = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(hasher.finalize().to_vec())
}

/// The id for a file without a readable header: Pi names files `<timestamp>_<id>.jsonl`.
fn fallback_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    match stem.rsplit_once('_') {
        Some((_, id)) if !id.is_empty() => id.to_owned(),
        _ => stem,
    }
}

/// `*.jsonl` files directly in `dir` and one directory level below, sorted.
fn session_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(error) => return Err(Error::io("cannot list", dir)(error)),
    };
    for entry in entries {
        let entry = entry.map_err(Error::io("cannot list", dir))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(Error::io("cannot inspect", &path))?;
        if kind.is_dir() {
            let inner = std::fs::read_dir(&path).map_err(Error::io("cannot list", &path))?;
            for file in inner {
                let file = file.map_err(Error::io("cannot list", &path))?;
                let file_path = file.path();
                if is_session_file(&file_path) && file.file_type().is_ok_and(|t| t.is_file()) {
                    files.push(file_path);
                }
            }
        } else if kind.is_file() && is_session_file(&path) {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn is_session_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_i64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}
