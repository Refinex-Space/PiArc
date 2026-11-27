//! Chrome sign-ins imported per workspace (ADR-0090, schema v14): the site, how many cookies,
//! the Chrome profile and when. A new import of the same site replaces its row.

use rusqlite::params;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::store::Store;

/// One imported site of a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImport {
    pub site: String,
    pub count: u32,
    /// The Chrome profile's display name.
    pub profile: String,
    /// Unix milliseconds.
    pub imported_at: i64,
}

impl Store {
    /// Records that `site` of `workspace` got `count` cookies from `profile` at `now_ms`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn put_browser_import(
        &self,
        workspace: &str,
        site: &str,
        count: u32,
        profile: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO browser_imports (workspace, site, count, profile, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (workspace, site) DO UPDATE SET
                   count = excluded.count, profile = excluded.profile,
                   imported_at = excluded.imported_at",
                params![workspace, site, i64::from(count), profile, now_ms],
            )
            .map_err(Error::sqlite("cannot write browser_imports"))?;
        Ok(())
    }

    /// The imported sites of `workspace`, by site.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn browser_imports(&self, workspace: &str) -> Result<Vec<BrowserImport>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT site, count, profile, imported_at FROM browser_imports
                 WHERE workspace = ?1 ORDER BY site",
            )
            .map_err(Error::sqlite("cannot read browser_imports"))?;
        let rows = statement
            .query_map([workspace], |row| {
                Ok(BrowserImport {
                    site: row.get(0)?,
                    count: u32::try_from(row.get::<_, i64>(1)?).unwrap_or(u32::MAX),
                    profile: row.get(2)?,
                    imported_at: row.get(3)?,
                })
            })
            .map_err(Error::sqlite("cannot read browser_imports"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::sqlite("cannot read browser_imports"))
    }

    /// Forgets `site` of `workspace`; whether there was a row.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be deleted.
    pub fn remove_browser_import(&self, workspace: &str, site: &str) -> Result<bool> {
        self.conn
            .execute(
                "DELETE FROM browser_imports WHERE workspace = ?1 AND site = ?2",
                params![workspace, site],
            )
            .map(|n| n > 0)
            .map_err(Error::sqlite("cannot write browser_imports"))
    }
}

#[cfg(test)]
mod tests {
    use super::BrowserImport;
    use crate::store::Store;

    #[test]
    fn imports_are_per_workspace_and_replaced_by_site() {
        let store = Store::open_in_memory(0).expect("store");
        store
            .put_browser_import("/工作区 a", "github.com", 3, "Default", 10)
            .expect("put");
        store
            .put_browser_import("/工作区 a", "example.test", 1, "Work", 11)
            .expect("put");
        store
            .put_browser_import("/b", "github.com", 9, "Default", 12)
            .expect("other workspace");
        store
            .put_browser_import("/工作区 a", "github.com", 5, "Work", 13)
            .expect("again");
        assert_eq!(
            store.browser_imports("/工作区 a").expect("read"),
            [
                BrowserImport {
                    site: "example.test".into(),
                    count: 1,
                    profile: "Work".into(),
                    imported_at: 11
                },
                BrowserImport {
                    site: "github.com".into(),
                    count: 5,
                    profile: "Work".into(),
                    imported_at: 13
                },
            ]
        );
        assert!(
            store
                .remove_browser_import("/工作区 a", "github.com")
                .expect("remove")
        );
        assert!(
            !store
                .remove_browser_import("/工作区 a", "github.com")
                .expect("again")
        );
        assert_eq!(store.browser_imports("/工作区 a").expect("read").len(), 1);
        assert_eq!(store.browser_imports("/b").expect("read").len(), 1);
    }
}
