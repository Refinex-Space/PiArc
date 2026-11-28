//! The user's MCP server choices per workspace (T36, schema v9): turned on or off in the
//! settings window. The server definitions stay in the configuration files
//! (`piarc-config::mcp`); a row here overrides a definition's `enabled`.

use rusqlite::params;

use crate::error::{Error, Result};
use crate::store::Store;

impl Store {
    /// Records that the user turned server `name` of `workspace` on or off.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_mcp_enabled(
        &self,
        workspace: &str,
        name: &str,
        enabled: bool,
        now_ms: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO mcp_servers (workspace, name, enabled, changed_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace, name)
                 DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at",
                params![workspace, name, i64::from(enabled), now_ms],
            )
            .map_err(Error::sqlite("cannot write the MCP server choice"))?;
        Ok(())
    }

    /// The servers of `workspace` the user turned on or off: `(name, enabled)` by name.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn mcp_choices(&self, workspace: &str) -> Result<Vec<(String, bool)>> {
        let mut statement = self
            .conn
            .prepare("SELECT name, enabled FROM mcp_servers WHERE workspace = ?1 ORDER BY name")
            .map_err(Error::sqlite("cannot read the MCP server choices"))?;
        let rows = statement
            .query_map([workspace], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })
            .map_err(Error::sqlite("cannot read the MCP server choices"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::sqlite("cannot read the MCP server choices"))
    }
}

#[cfg(test)]
mod tests {
    use crate::store::Store;

    #[test]
    fn choices_are_per_workspace_and_the_last_one_wins() {
        let store = Store::open_in_memory(0).expect("store");
        store
            .set_mcp_enabled("/工作区 a", "db", false, 1)
            .expect("off");
        store
            .set_mcp_enabled("/工作区 a", "docs", true, 2)
            .expect("on");
        store
            .set_mcp_enabled("/b", "db", true, 3)
            .expect("other workspace");
        store
            .set_mcp_enabled("/工作区 a", "db", true, 4)
            .expect("on again");
        assert_eq!(
            store.mcp_choices("/工作区 a").expect("read"),
            [("db".to_owned(), true), ("docs".to_owned(), true)]
        );
        assert_eq!(
            store.mcp_choices("/b").expect("read"),
            [("db".to_owned(), true)]
        );
        assert!(store.mcp_choices("/none").expect("read").is_empty());
    }
}
