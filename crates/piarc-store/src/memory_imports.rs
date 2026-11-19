//! Persistent consent to import one particular file into this workspace's model context.
use rusqlite::params;

use crate::{Error, Result, Store};

impl Store {
    /// Whether the user selected permanent consent for this workspace and resolved target.
    ///
    /// # Errors
    /// A database read failed.
    pub fn allows_memory_import(&self, workspace: &str, target: &str) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_imports WHERE workspace=?1 AND target=?2)",
                params![workspace, target],
                |row| row.get(0),
            )
            .map_err(Error::sqlite("cannot check memory import consent"))
    }

    /// Records permanent consent, idempotently.
    ///
    /// # Errors
    /// A database write failed.
    pub fn allow_memory_import(&self, workspace: &str, target: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO memory_imports(workspace,target) VALUES (?1,?2) ON CONFLICT DO NOTHING",
            params![workspace,target],
        ).map(|_| ()).map_err(Error::sqlite("cannot save memory import consent"))
    }
}
