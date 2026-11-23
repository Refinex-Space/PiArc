//! Core's own worktree columns of `sessions` (T35, schema v8): a session's worktree, its
//! branch, when its cleanup is due after archiving, whether the cleanup waits for the user, and
//! when it was removed. The cleanup rules are `piarc-core::worktrees`'.

use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};
use crate::store::Store;

/// A session's worktree (T35): Core's own columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRecord {
    /// Its directory.
    pub path: String,
    /// Its branch, when known.
    pub branch: Option<String>,
    /// When the archived session's worktree is due for cleanup (Unix ms).
    pub cleanup_at: Option<i64>,
    /// The cleanup found uncommitted changes and waits for the user.
    pub confirm: bool,
    /// When it was removed (the branch stays).
    pub removed_at: Option<i64>,
}

/// An archived session's worktree due for cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueWorktree {
    /// The session.
    pub session_id: String,
    /// Its workspace.
    pub workspace: Option<String>,
    /// The worktree's directory.
    pub path: String,
}

/// The Core-owned record of a directory created by a WorktreeCreate hook.
#[derive(Debug, Clone)]
pub struct HookWorktree {
    /// Main workspace whose trusted settings select the hooks.
    pub workspace: String,
    /// Session that requested the directory.
    pub session_id: String,
    /// Original name passed to the hook, reused when restoring.
    pub name: String,
    /// Filesystem object identity at creation.
    pub identity: String,
}

impl Store {
    /// # Errors
    /// Returns a database error if ownership cannot be read.
    pub fn hook_worktree(&self, path: &str) -> Result<Option<HookWorktree>> {
        self.conn
            .query_row(
                "SELECT workspace, session_id, name, identity FROM hook_worktrees WHERE path = ?1",
                [path],
                |row| {
                    Ok(HookWorktree {
                        workspace: row.get(0)?,
                        session_id: row.get(1)?,
                        name: row.get(2)?,
                        identity: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Error::sqlite("cannot read hook worktree ownership"))
    }

    /// Records a new directory or a directory restored for the same owner.
    ///
    /// # Errors
    /// Returns a database error if registration fails. Another owner's record is preserved.
    pub fn register_hook_worktree(&self, path: &str, tree: &HookWorktree) -> Result<bool> {
        self.conn.execute("INSERT INTO hook_worktrees(path,workspace,session_id,name,identity)
            SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE worktree=?1 AND id<>?3)
            ON CONFLICT(path) DO UPDATE SET identity=excluded.identity
            WHERE workspace=excluded.workspace AND session_id=excluded.session_id AND name=excluded.name",
            params![path, tree.workspace, tree.session_id, tree.name, tree.identity])
            .map(|n| n == 1).map_err(Error::sqlite("cannot register hook worktree ownership"))
    }

    /// Releases ownership after the hook removed a directory that will not be restored.
    ///
    /// # Errors
    /// Returns a database error if the record cannot be deleted.
    pub fn release_hook_worktree(&self, path: &str, id: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM hook_worktrees WHERE path=?1 AND session_id=?2",
                params![path, id],
            )
            .map(drop)
            .map_err(Error::sqlite("cannot release hook worktree ownership"))
    }

    /// Records the worktree of session `id` (T35): its directory and branch. Returns false when
    /// the index has no row for it yet.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_session_worktree(&self, id: &str, path: &str, branch: Option<&str>) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE sessions SET worktree = ?2, worktree_branch = COALESCE(?3, worktree_branch)
                 WHERE id = ?1",
                params![id, path, branch],
            )
            .map_err(Error::sqlite("cannot write the session worktree"))?;
        Ok(changed > 0)
    }

    /// Sets when session `id`'s worktree is due for cleanup (`None`: never) and whether the
    /// cleanup waits for the user (T35).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_worktree_cleanup(&self, id: &str, at: Option<i64>, confirm: bool) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE sessions SET worktree_cleanup_at = ?2, worktree_confirm = ?3
                 WHERE id = ?1 AND worktree IS NOT NULL",
                params![id, at, confirm],
            )
            .map_err(Error::sqlite("cannot write the worktree cleanup"))?;
        Ok(changed > 0)
    }

    /// Records that session `id`'s worktree was removed at `at`, or (`None`) added again.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_worktree_removed(&self, id: &str, at: Option<i64>) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE sessions SET worktree_removed_at = ?2, worktree_cleanup_at = NULL,
                    worktree_confirm = 0
                 WHERE id = ?1 AND worktree IS NOT NULL",
                params![id, at],
            )
            .map_err(Error::sqlite("cannot write the worktree state"))?;
        Ok(changed > 0)
    }

    /// Archived sessions whose worktree is due for cleanup at `now` and not waiting for the
    /// user (T35).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the index cannot be read.
    pub fn due_worktrees(&self, now: i64) -> Result<Vec<DueWorktree>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, workspace_path, worktree FROM sessions
                 WHERE archived = 1 AND worktree IS NOT NULL AND worktree_removed_at IS NULL
                    AND worktree_confirm = 0 AND worktree_cleanup_at <= ?1
                 ORDER BY worktree_cleanup_at, id",
            )
            .map_err(Error::sqlite("cannot read sessions"))?;
        let rows = statement
            .query_map([now], |row| {
                Ok(DueWorktree {
                    session_id: row.get(0)?,
                    workspace: row.get(1)?,
                    path: row.get(2)?,
                })
            })
            .map_err(Error::sqlite("cannot read sessions"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read sessions"))
    }
}
