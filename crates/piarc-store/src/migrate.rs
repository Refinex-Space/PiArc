//! Schema migrations: numbered SQL scripts applied in order, each in its own transaction and
//! recorded in `schema_migrations`.
//!
//! # Writing a migration
//!
//! Append a [`Migration`] to [`MIGRATIONS`] with the next version number. Never edit or
//! reorder a migration that has shipped: databases in the field already recorded it. A
//! migration's SQL runs inside one transaction together with its `schema_migrations` row, so
//! it either applies completely or not at all; do not put `BEGIN`/`COMMIT` in it.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use crate::error::{Error, Result};

/// One schema change.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Version number: 1, 2, 3, ... in [`MIGRATIONS`] order.
    pub version: u32,
    /// Short name recorded with the version.
    pub name: &'static str,
    /// The SQL, run with `execute_batch` inside the migration's transaction.
    pub sql: &'static str,
}

/// The migrations of this build, oldest first.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("sql/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "session_titles",
        sql: include_str!("sql/0002_session_titles.sql"),
    },
    Migration {
        version: 3,
        name: "memory_imports",
        sql: include_str!("sql/0003_memory_imports.sql"),
    },
    Migration {
        version: 4,
        name: "session_file_stamp",
        sql: include_str!("sql/0004_session_file_stamp.sql"),
    },
    Migration {
        version: 5,
        name: "checkpoints",
        sql: include_str!("sql/0005_checkpoints.sql"),
    },
    Migration {
        version: 6,
        name: "subagents",
        sql: include_str!("sql/0006_subagents.sql"),
    },
    Migration {
        version: 7,
        name: "background_tasks",
        sql: include_str!("sql/0007_background_tasks.sql"),
    },
    Migration {
        version: 8,
        name: "worktrees_and_search",
        sql: include_str!("sql/0008_worktrees_and_search.sql"),
    },
    Migration {
        version: 9,
        name: "mcp_servers",
        sql: include_str!("sql/0009_mcp_servers.sql"),
    },
    Migration {
        version: 10,
        name: "packages",
        sql: include_str!("sql/0010_packages.sql"),
    },
    Migration {
        version: 11,
        name: "usage",
        sql: include_str!("sql/0011_usage.sql"),
    },
    Migration {
        version: 12,
        name: "hook_worktrees",
        sql: include_str!("sql/0012_hook_worktrees.sql"),
    },
];

/// The highest version in `migrations`.
#[must_use]
pub fn latest_version(migrations: &[Migration]) -> u32 {
    migrations.iter().map(|m| m.version).max().unwrap_or(0)
}

const CREATE_LEDGER: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
) STRICT";

/// Applies the migrations of `migrations` that `conn` has not recorded yet, in version order.
/// `now_ms` is written as `applied_at`. Returns the versions applied by this call (empty when
/// the database was already up to date).
///
/// # Errors
///
/// - [`Error::Migration`] when a migration fails: its transaction is rolled back, the
///   versions before it stay applied and the ones after it are not tried.
/// - [`Error::SchemaTooNew`] when the database records a version newer than any in
///   `migrations` (a newer build wrote it); nothing is applied.
/// - [`Error::Sqlite`] when the ledger cannot be read or written.
pub fn apply(conn: &mut Connection, migrations: &[Migration], now_ms: i64) -> Result<Vec<u32>> {
    conn.execute_batch(CREATE_LEDGER)
        .map_err(Error::sqlite("cannot create schema_migrations"))?;
    let recorded: Option<u32> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(Error::sqlite("cannot read schema_migrations"))?
        .flatten();
    let known = latest_version(migrations);
    if let Some(found) = recorded
        && found > known
    {
        return Err(Error::SchemaTooNew { found, known });
    }
    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by_key(|m| m.version);
    let mut applied = Vec::new();
    for migration in ordered {
        if is_recorded(conn, migration.version)? {
            continue;
        }
        apply_one(conn, migration, now_ms)?;
        applied.push(migration.version);
    }
    Ok(applied)
}

fn is_recorded(conn: &Connection, version: u32) -> Result<bool> {
    conn.query_row(
        "SELECT 1 FROM schema_migrations WHERE version = ?1",
        [version],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(Error::sqlite("cannot read schema_migrations"))
}

fn apply_one(conn: &mut Connection, migration: &Migration, now_ms: i64) -> Result<()> {
    let failed = |source| Error::Migration {
        version: migration.version,
        name: migration.name,
        source,
    };
    // IMMEDIATE: take the write lock up front, so a second process cannot apply the same
    // version in between the check above and this transaction.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failed)?;
    if is_recorded(&tx, migration.version)? {
        return Ok(());
    }
    tx.execute_batch(migration.sql).map_err(failed)?;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![migration.version, migration.name, now_ms],
    )
    .map_err(failed)?;
    // Dropping the transaction on any error above rolls it back.
    tx.commit().map_err(failed)
}

/// The recorded versions with their names, oldest first.
///
/// # Errors
///
/// [`Error::Sqlite`] when the ledger cannot be read.
pub fn recorded(conn: &Connection) -> Result<Vec<(u32, String)>> {
    let mut statement = conn
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .map_err(Error::sqlite("cannot read schema_migrations"))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(Error::sqlite("cannot read schema_migrations"))?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(Error::sqlite("cannot read schema_migrations"))
}
