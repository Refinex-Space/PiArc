//! Installed extension packages (T40, schema v10): Claude Code plugins and Pi packages. The
//! settings say whether a package is on and where (`plugins`); a row here says what is
//! installed, from where, at which version, and which executable items the user confirmed.

use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};
use crate::store::Store;

/// One installed package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageRecord {
    /// The package's id (plugin or package name).
    pub id: String,
    /// `claudePlugin` or `piPackage`.
    pub kind: String,
    /// `directory`, `git` or `npm`.
    pub source_kind: String,
    /// The directory, URL or npm spec as given.
    pub location: String,
    /// Where it is on disk.
    pub path: String,
    /// The git commit checked out.
    pub commit: Option<String>,
    /// The version installed.
    pub version: Option<String>,
    /// npm's integrity value.
    pub integrity: Option<String>,
    /// Names of the executable items the user confirmed.
    pub confirmed: Vec<String>,
    /// Unix ms.
    pub installed_at: i64,
    /// Unix ms.
    pub updated_at: i64,
}

const COLUMNS: &str = "id, kind, source_kind, location, path, git_commit, version, integrity, \
                       confirmed, installed_at, updated_at";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PackageRecord> {
    let confirmed: String = row.get(8)?;
    Ok(PackageRecord {
        id: row.get(0)?,
        kind: row.get(1)?,
        source_kind: row.get(2)?,
        location: row.get(3)?,
        path: row.get(4)?,
        commit: row.get(5)?,
        version: row.get(6)?,
        integrity: row.get(7)?,
        // A value that is not a list of strings confirms nothing.
        confirmed: serde_json::from_str(&confirmed).unwrap_or_default(),
        installed_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

impl Store {
    /// Inserts or replaces the row of `record.id`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn put_package(&self, record: &PackageRecord) -> Result<()> {
        let confirmed = serde_json::to_string(&record.confirmed).map_err(|e| Error::Sqlite {
            context: "cannot encode the confirmed items",
            source: rusqlite::Error::ToSqlConversionFailure(Box::new(e)),
        })?;
        self.conn
            .execute(
                &format!(
                    "INSERT OR REPLACE INTO packages ({COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
                ),
                params![
                    record.id,
                    record.kind,
                    record.source_kind,
                    record.location,
                    record.path,
                    record.commit,
                    record.version,
                    record.integrity,
                    confirmed,
                    record.installed_at,
                    record.updated_at,
                ],
            )
            .map_err(Error::sqlite("cannot write the package"))?;
        Ok(())
    }

    /// The package `id`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be read.
    pub fn package(&self, id: &str) -> Result<Option<PackageRecord>> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM packages WHERE id = ?1"),
                [id],
                row,
            )
            .optional()
            .map_err(Error::sqlite("cannot read the package"))
    }

    /// Every installed package, by id.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn packages(&self) -> Result<Vec<PackageRecord>> {
        let mut statement = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM packages ORDER BY id"))
            .map_err(Error::sqlite("cannot read the packages"))?;
        let rows = statement
            .query_map([], row)
            .map_err(Error::sqlite("cannot read the packages"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::sqlite("cannot read the packages"))
    }

    /// Removes the package `id`; `false` when there was none.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be deleted.
    pub fn remove_package(&self, id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute("DELETE FROM packages WHERE id = ?1", [id])
            .map_err(Error::sqlite("cannot remove the package"))?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::PackageRecord;
    use crate::store::Store;

    fn record(id: &str) -> PackageRecord {
        PackageRecord {
            id: id.to_owned(),
            kind: "claudePlugin".to_owned(),
            source_kind: "git".to_owned(),
            location: "file:///仓库/插件.git".to_owned(),
            path: "/数据/pi/git/插件".to_owned(),
            commit: Some("abc".to_owned()),
            version: Some("1.0.0".to_owned()),
            integrity: None,
            confirmed: vec!["PreToolUse[Bash] echo hi".to_owned()],
            installed_at: 1,
            updated_at: 2,
        }
    }

    #[test]
    fn packages_round_trip_and_are_removed() {
        let store = Store::open_in_memory(0).expect("store");
        store.put_package(&record("b")).expect("b");
        store.put_package(&record("a")).expect("a");
        let mut changed = record("a");
        changed.confirmed.push("mcp db".to_owned());
        changed.integrity = Some("sha512-x".to_owned());
        store.put_package(&changed).expect("replace");
        assert_eq!(store.package("a").expect("read"), Some(changed));
        assert_eq!(
            store
                .packages()
                .expect("all")
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(store.remove_package("a").expect("remove"));
        assert!(!store.remove_package("a").expect("again"));
        assert_eq!(store.package("a").expect("read"), None);
    }
}
