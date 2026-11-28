//! The database connection: opening, pragmas and migrations.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::migrate::{self, MIGRATIONS, Migration};

/// SQLite's page cache per connection, in KiB (`PRAGMA cache_size = -N`). Bounds SQLite's own
/// memory while indexing large session files.
pub const CACHE_KIB: u32 = 2048;

/// How long a statement waits for another connection's write lock.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The Core database (`<data>/core.sqlite`). Not `Sync`: Core owns one behind a mutex and
/// uses it from blocking threads.
pub struct Store {
    pub(crate) conn: Connection,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

impl Store {
    /// Opens (creating if needed) the database at `path` and applies this build's
    /// migrations. `now_ms` is recorded for applied migrations.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the file cannot be opened; the errors of [`migrate::apply`].
    pub fn open(path: &Path, now_ms: i64) -> Result<Self> {
        Self::open_with(path, MIGRATIONS, now_ms)
    }

    /// As [`Store::open`] with another migration list (tests inject failing migrations).
    ///
    /// # Errors
    ///
    /// As [`Store::open`].
    pub fn open_with(path: &Path, migrations: &[Migration], now_ms: i64) -> Result<Self> {
        let conn = Connection::open(path).map_err(Error::sqlite("cannot open the database"))?;
        Self::configure(conn, migrations, now_ms)
    }

    /// An in-memory database with this build's schema.
    ///
    /// # Errors
    ///
    /// As [`Store::open`].
    pub fn open_in_memory(now_ms: i64) -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(Error::sqlite("cannot open an in-memory database"))?;
        Self::configure(conn, MIGRATIONS, now_ms)
    }

    fn configure(mut conn: Connection, migrations: &[Migration], now_ms: i64) -> Result<Self> {
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(Error::sqlite("cannot set the busy timeout"))?;
        conn.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA cache_size = -{CACHE_KIB};"
        ))
        .map_err(Error::sqlite("cannot configure the database"))?;
        migrate::apply(&mut conn, migrations, now_ms)?;
        Ok(Self { conn })
    }

    /// The highest applied schema version.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when `schema_migrations` cannot be read.
    pub fn schema_version(&self) -> Result<u32> {
        Ok(migrate::recorded(&self.conn)?
            .last()
            .map_or(0, |(version, _)| *version))
    }

    /// The applied migrations, oldest first.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when `schema_migrations` cannot be read.
    pub fn migrations(&self) -> Result<Vec<(u32, String)>> {
        migrate::recorded(&self.conn)
    }
}
