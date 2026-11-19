//! T13-A01: migrations on an empty and on a migrated database, twice each; a failing migration
//! rolls back completely.

mod support;

use piarc_store::{Error, MIGRATIONS, Migration, Store, migrate};
use rusqlite::Connection;
use support::TempDir;

fn tables(path: &std::path::Path) -> Vec<String> {
    let conn = Connection::open(path).expect("open");
    let mut statement = conn
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .expect("query");
    statement
        .query_map([], |row| row.get(0))
        .expect("rows")
        .collect::<rusqlite::Result<_>>()
        .expect("names")
}

const EXPECTED_TABLES: [&str; 8] = [
    "audit_events",
    "background_tasks",
    "memory_imports",
    "project_trust",
    "schema_migrations",
    "session_files",
    "sessions",
    "workspaces",
];

#[test]
fn migrating_twice_from_empty_and_from_migrated_gives_the_same_schema() {
    let dir = TempDir::new("migrations");
    let path = dir.path().join("core.sqlite");

    let first = Store::open(&path, 1000).expect("empty database migrates");
    let ledger = vec![
        (1, "initial".to_owned()),
        (2, "session_titles".to_owned()),
        (3, "memory_imports".to_owned()),
    ];
    assert_eq!(first.migrations().expect("ledger"), ledger);
    drop(first);
    let schema_after_first = tables(&path);
    let expected: Vec<String> = EXPECTED_TABLES.iter().map(|t| (*t).to_owned()).collect();
    assert_eq!(schema_after_first, expected);

    // Opening an already migrated database applies nothing and keeps the ledger as it was.
    for _ in 0..2 {
        let again = Store::open(&path, 2000).expect("migrated database opens");
        assert_eq!(again.schema_version().expect("version"), 3);
        assert_eq!(again.migrations().expect("ledger"), ledger);
        drop(again);
        assert_eq!(tables(&path), schema_after_first);
    }
    let conn = Connection::open(&path).expect("open");
    let applied_at: i64 = conn
        .query_row(
            "SELECT applied_at FROM schema_migrations WHERE version = 1",
            [],
            |r| r.get(0),
        )
        .expect("row");
    assert_eq!(applied_at, 1000, "the first run's time is kept");

    // A second empty database migrated twice ends with the same schema.
    let other = dir.path().join("other.sqlite");
    let mut conn = Connection::open(&other).expect("open");
    assert_eq!(
        migrate::apply(&mut conn, MIGRATIONS, 5).expect("first"),
        vec![1, 2, 3]
    );
    assert_eq!(
        migrate::apply(&mut conn, MIGRATIONS, 6).expect("second"),
        Vec::<u32>::new()
    );
    drop(conn);
    assert_eq!(tables(&other), schema_after_first);
}

const FAILING: Migration = Migration {
    version: 2,
    name: "half-applied",
    // The first statement succeeds, the second fails: nothing of it may remain.
    sql: "CREATE TABLE added_by_two (x INTEGER) STRICT;
          ALTER TABLE sessions ADD COLUMN extra TEXT;
          INSERT INTO no_such_table VALUES (1);",
};

#[test]
fn a_failing_migration_rolls_back_and_the_database_stays_at_the_previous_version() {
    let dir = TempDir::new("failing migration");
    let path = dir.path().join("core.sqlite");
    Store::open_with(&path, &MIGRATIONS[..1], 1000).expect("version 1");
    let before = tables(&path);

    let migrations = [MIGRATIONS[0], FAILING];
    for _ in 0..2 {
        let error = Store::open_with(&path, &migrations, 2000).expect_err("version 2 fails");
        match &error {
            Error::Migration { version, name, .. } => {
                assert_eq!((*version, *name), (2, "half-applied"));
            }
            other => panic!("unexpected error {other:?}"),
        }
        assert_eq!(tables(&path), before, "no table of version 2 remains");
        let conn = Connection::open(&path).expect("open");
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('sessions')")
            .expect("query")
            .query_map([], |r| r.get(0))
            .expect("rows")
            .collect::<rusqlite::Result<_>>()
            .expect("names");
        assert!(
            !columns.contains(&"extra".to_owned()),
            "the column change was rolled back"
        );
        let versions: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .expect("query")
            .query_map([], |r| r.get(0))
            .expect("rows")
            .collect::<rusqlite::Result<_>>()
            .expect("versions");
        assert_eq!(versions, vec![1]);
    }

    // The same failure on an empty database keeps version 1, which succeeded first.
    let fresh = dir.path().join("fresh.sqlite");
    Store::open_with(&fresh, &migrations, 3000).expect_err("version 2 fails");
    let store = Store::open_with(&fresh, &MIGRATIONS[..1], 4000).expect("version 1 is complete");
    assert_eq!(store.schema_version().expect("version"), 1);
}

#[test]
fn a_database_from_a_newer_build_is_refused() {
    let dir = TempDir::new("newer");
    let path = dir.path().join("core.sqlite");
    let newer = [
        MIGRATIONS[0],
        MIGRATIONS[1],
        MIGRATIONS[2],
        Migration {
            version: 4,
            name: "future",
            sql: "CREATE TABLE future (x INTEGER) STRICT;",
        },
    ];
    Store::open_with(&path, &newer, 1).expect("newer build migrates");
    let error = Store::open(&path, 2).expect_err("this build does not know version 4");
    assert!(
        matches!(error, Error::SchemaTooNew { found: 4, known: 3 }),
        "{error:?}"
    );
}

#[test]
fn permanent_memory_consent_is_exact_and_survives_reopening() {
    let dir = TempDir::new("memory-consent");
    let path = dir.path().join("core.sqlite");
    let db = Store::open(&path, 1).unwrap();
    db.allow_memory_import("workspace-a", "target-a").unwrap();
    drop(db);
    let db = Store::open(&path, 2).unwrap();
    assert!(db.allows_memory_import("workspace-a", "target-a").unwrap());
    assert!(!db.allows_memory_import("workspace-b", "target-a").unwrap());
    assert!(!db.allows_memory_import("workspace-a", "target-b").unwrap());
}
