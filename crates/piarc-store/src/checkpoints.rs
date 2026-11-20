//! The checkpoint index (schema v5, ADR-0044 rules 1, 2 and 9): one row per user turn of a
//! session in `checkpoints`, one row per write through Core in `checkpoint_files`, and when each
//! session last used its snapshots in `checkpoint_sessions`. Hashes are hex strings; the rules
//! over them are `piarc-checkpoint`'s.

use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};
use crate::store::Store;

/// One row of `checkpoints`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRow {
    /// Its id: checkpoints of a session are created in turn order.
    pub id: i64,
    /// The PiArc turn id.
    pub turn_id: String,
    /// When it was created (Unix ms).
    pub created_at: i64,
}

/// One row of `checkpoint_files`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointFileRow {
    /// Its id: write order.
    pub id: i64,
    /// The checkpoint it belongs to.
    pub checkpoint_id: i64,
    /// The file (display form).
    pub path: String,
    /// Hex SHA-256 of the content before; `None`: the file did not exist.
    pub before_hash: Option<String>,
    /// Hex SHA-256 of the content after; `None`: the file was deleted.
    pub after_hash: Option<String>,
    /// `create`, `modify`, `restore`, `undo` or `discard`.
    pub operation: String,
    /// The rewind a `restore` row belongs to.
    pub restore_id: Option<String>,
    /// The subagent session that made the write, under its main session's turn (T31).
    pub subagent_session: Option<String>,
}

/// A row to add to `checkpoint_files`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewCheckpointFile<'a> {
    /// The file (display form).
    pub path: &'a str,
    /// Hex SHA-256 of the content before; `None`: the file did not exist.
    pub before_hash: Option<&'a str>,
    /// Hex SHA-256 of the content after; `None`: the file was deleted.
    pub after_hash: Option<&'a str>,
    /// `create`, `modify`, `restore`, `undo` or `discard`.
    pub operation: &'a str,
    /// The rewind a `restore` row belongs to.
    pub restore_id: Option<&'a str>,
    /// The subagent session that made the write (T31); `None` for the session itself.
    pub subagent_session: Option<&'a str>,
}

impl Store {
    /// The id of the checkpoint of `session`'s turn `turn`, created when missing; marks the
    /// session's snapshots accessed at `now_ms`.
    ///
    /// # Errors
    ///
    /// A database write failed.
    pub fn ensure_checkpoint(&self, session: &str, turn: &str, now_ms: i64) -> Result<i64> {
        self.conn
            .execute(
                "INSERT INTO checkpoints (session_id, turn_id, created_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (session_id, turn_id) DO NOTHING",
                params![session, turn, now_ms],
            )
            .map_err(Error::sqlite("cannot create a checkpoint"))?;
        self.touch_checkpoint_session(session, now_ms)?;
        self.conn
            .query_row(
                "SELECT id FROM checkpoints WHERE session_id = ?1 AND turn_id = ?2",
                params![session, turn],
                |row| row.get(0),
            )
            .map_err(Error::sqlite("cannot read a checkpoint"))
    }

    /// The id of the checkpoint of `session`'s turn `turn`.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn checkpoint_id(&self, session: &str, turn: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM checkpoints WHERE session_id = ?1 AND turn_id = ?2",
                params![session, turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(Error::sqlite("cannot read a checkpoint"))
    }

    /// The newest checkpoint of `session`.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn latest_checkpoint(&self, session: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT MAX(id) FROM checkpoints WHERE session_id = ?1",
                params![session],
                |row| row.get(0),
            )
            .map_err(Error::sqlite("cannot read the latest checkpoint"))
    }

    /// The checkpoints of `session`, oldest first.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn session_checkpoints(&self, session: &str) -> Result<Vec<CheckpointRow>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT id, turn_id, created_at FROM checkpoints WHERE session_id = ?1 ORDER BY id",
            )
            .map_err(Error::sqlite("cannot read checkpoints"))?;
        statement
            .query_map(params![session], |row| {
                Ok(CheckpointRow {
                    id: row.get(0)?,
                    turn_id: row.get(1)?,
                    created_at: row.get(2)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(Error::sqlite("cannot read checkpoints"))
    }

    /// Adds `files` to the checkpoint `checkpoint`, in order, in one transaction.
    ///
    /// # Errors
    ///
    /// A database write failed (nothing was added).
    pub fn add_checkpoint_files(
        &mut self,
        checkpoint: i64,
        files: &[NewCheckpointFile<'_>],
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot record file snapshots"))?;
        {
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO checkpoint_files
                     (checkpoint_id, path, before_hash, after_hash, operation, restore_id,
                      subagent_session)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(Error::sqlite("cannot record file snapshots"))?;
            for file in files {
                insert
                    .execute(params![
                        checkpoint,
                        file.path,
                        file.before_hash,
                        file.after_hash,
                        file.operation,
                        file.restore_id,
                        file.subagent_session
                    ])
                    .map_err(Error::sqlite("cannot record file snapshots"))?;
            }
        }
        tx.commit()
            .map_err(Error::sqlite("cannot record file snapshots"))
    }

    /// Every file row of `session`, in write order.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn checkpoint_files(&self, session: &str) -> Result<Vec<CheckpointFileRow>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT f.id, f.checkpoint_id, f.path, f.before_hash, f.after_hash, f.operation,
                        f.restore_id, f.subagent_session
                 FROM checkpoint_files f JOIN checkpoints c ON c.id = f.checkpoint_id
                 WHERE c.session_id = ?1 ORDER BY f.id",
            )
            .map_err(Error::sqlite("cannot read file snapshots"))?;
        statement
            .query_map(params![session], |row| {
                Ok(CheckpointFileRow {
                    id: row.get(0)?,
                    checkpoint_id: row.get(1)?,
                    path: row.get(2)?,
                    before_hash: row.get(3)?,
                    after_hash: row.get(4)?,
                    operation: row.get(5)?,
                    restore_id: row.get(6)?,
                    subagent_session: row.get(7)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(Error::sqlite("cannot read file snapshots"))
    }

    /// Marks `session`'s snapshots accessed at `now_ms`.
    ///
    /// # Errors
    ///
    /// A database write failed.
    pub fn touch_checkpoint_session(&self, session: &str, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO checkpoint_sessions (session_id, accessed_at) VALUES (?1, ?2)
                 ON CONFLICT (session_id) DO UPDATE SET accessed_at = MAX(accessed_at, ?2)",
                params![session, now_ms],
            )
            .map(drop)
            .map_err(Error::sqlite("cannot mark snapshots accessed"))
    }

    /// Deletes `session`'s oldest checkpoints (and their file rows) beyond the newest `keep`;
    /// returns how many went.
    ///
    /// # Errors
    ///
    /// A database write failed.
    pub fn prune_checkpoints(&self, session: &str, keep: usize) -> Result<usize> {
        let keep = i64::try_from(keep).unwrap_or(i64::MAX);
        self.conn
            .execute(
                "DELETE FROM checkpoints WHERE session_id = ?1 AND id NOT IN
                 (SELECT id FROM checkpoints WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2)",
                params![session, keep],
            )
            .map_err(Error::sqlite("cannot prune checkpoints"))
    }

    /// Deletes every checkpoint of the sessions last accessed before `before_ms`, and returns
    /// those sessions.
    ///
    /// # Errors
    ///
    /// A database write failed (nothing was deleted).
    pub fn drop_idle_checkpoints(&mut self, before_ms: i64) -> Result<Vec<String>> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot drop idle snapshots"))?;
        let sessions: Vec<String> = {
            let mut select = tx
                .prepare("SELECT session_id FROM checkpoint_sessions WHERE accessed_at < ?1")
                .map_err(Error::sqlite("cannot drop idle snapshots"))?;
            select
                .query_map(params![before_ms], |row| row.get(0))
                .and_then(Iterator::collect)
                .map_err(Error::sqlite("cannot drop idle snapshots"))?
        };
        for session in &sessions {
            tx.execute(
                "DELETE FROM checkpoints WHERE session_id = ?1",
                params![session],
            )
            .and_then(|_| {
                tx.execute(
                    "DELETE FROM checkpoint_sessions WHERE session_id = ?1",
                    params![session],
                )
            })
            .map_err(Error::sqlite("cannot drop idle snapshots"))?;
        }
        tx.commit()
            .map_err(Error::sqlite("cannot drop idle snapshots"))?;
        Ok(sessions)
    }

    /// Deletes every checkpoint of `session` (the session was deleted).
    ///
    /// # Errors
    ///
    /// A database write failed.
    pub fn delete_session_checkpoints(&self, session: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM checkpoints WHERE session_id = ?1",
                params![session],
            )
            .and_then(|_| {
                self.conn.execute(
                    "DELETE FROM checkpoint_sessions WHERE session_id = ?1",
                    params![session],
                )
            })
            .map(drop)
            .map_err(Error::sqlite("cannot delete a session's snapshots"))
    }

    /// Every object hash a file row still needs (the "before" contents: what rewinds, undos and
    /// the Changes panel read).
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn referenced_snapshots(&self) -> Result<Vec<String>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT DISTINCT before_hash FROM checkpoint_files WHERE before_hash IS NOT NULL",
            )
            .map_err(Error::sqlite("cannot read file snapshots"))?;
        statement
            .query_map([], |row| row.get(0))
            .and_then(Iterator::collect)
            .map_err(Error::sqlite("cannot read file snapshots"))
    }
}

#[cfg(test)]
mod tests;
