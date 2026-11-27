//! Chrome's `Cookies` SQLite database, read from a private copy: Chrome keeps the file open and
//! may write to it at any time, so the database (and its `-wal`, which holds the latest
//! writes) is copied into a fresh folder first and the copy is opened. The folder is removed
//! when the [`CookieDb`] is dropped.
//!
//! Only `host_key`, the expiry and the other plain columns are read to list sites; the
//! encrypted values are read for the sites the user chose and handed to `crate::crypto`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

/// Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01.
const EPOCH_GAP: i64 = 11_644_473_600;
/// Columns every supported database has.
const REQUIRED: &[&str] = &[
    "host_key",
    "name",
    "value",
    "encrypted_value",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
    "samesite",
];

/// A Chrome time (microseconds since 1601) in Unix seconds.
#[must_use]
pub fn unix_seconds(chrome_us: i64) -> i64 {
    chrome_us / 1_000_000 - EPOCH_GAP
}

/// A Unix time in Chrome's microseconds.
#[must_use]
pub fn chrome_time(unix_seconds: i64) -> i64 {
    (unix_seconds + EPOCH_GAP) * 1_000_000
}

/// The site a cookie belongs to in the list: its `host_key` without the leading dot.
#[must_use]
pub fn site_of(host_key: &str) -> String {
    host_key.trim_start_matches('.').to_ascii_lowercase()
}

/// Whether `site` can name a site of the list (a host name or an IP literal).
#[must_use]
pub fn valid_site(site: &str) -> bool {
    !site.is_empty()
        && site.len() <= 253
        && !site.starts_with('.')
        && site
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-:[]".contains(c))
}

/// A site of the list with its cookies that have not expired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SiteCount {
    pub site: String,
    pub count: u32,
}

/// One row as stored; `value` and `encrypted` are secrets.
pub struct RawCookie {
    pub host_key: String,
    pub name: String,
    pub value: Zeroizing<String>,
    pub encrypted: Zeroizing<Vec<u8>>,
    pub path: String,
    pub expires_utc: i64,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: i64,
    pub persistent: bool,
    pub partitioned: bool,
}

impl std::fmt::Debug for RawCookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawCookie")
            .field("host_key", &self.host_key)
            .field("name", &self.name)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl RawCookie {
    /// Whether it expired by `now` (Unix seconds); session cookies never do here.
    #[must_use]
    pub fn expired(&self, now: i64) -> bool {
        self.persistent && self.expires_utc != 0 && unix_seconds(self.expires_utc) <= now
    }
}

/// The copy's folder, removed on drop.
#[derive(Debug)]
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An opened copy of a profile's cookies database.
#[derive(Debug)]
pub struct CookieDb {
    conn: Connection,
    version: i64,
    columns: HashSet<String>,
    _scratch: Scratch,
}

static COPIES: AtomicU64 = AtomicU64::new(0);

/// Whether a copy failed because another process holds the file (Windows sharing and lock
/// violations).
fn held(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

fn copy(from: &Path, to: &Path) -> Result<()> {
    std::fs::copy(from, to).map(|_| ()).map_err(|e| {
        if held(&e) {
            Error::Locked
        } else {
            Error::io("copy Chrome's cookies database", &e)
        }
    })
}

impl CookieDb {
    /// Copies `cookies` (and its `-wal`) into a new folder under `scratch` and opens the copy.
    ///
    /// # Errors
    ///
    /// [`Error::Locked`] when Chrome holds the file; [`Error::Io`], [`Error::Database`],
    /// [`Error::Format`] for a database PiArc cannot read.
    pub fn open(cookies: &Path, scratch: &Path) -> Result<Self> {
        let n = COPIES.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = scratch.join(format!("chrome-cookies-{}-{stamp}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| Error::io("make a scratch folder", &e))?;
        let scratch = Scratch(dir);
        let target = scratch.0.join("Cookies");
        copy(cookies, &target)?;
        let mut wal = cookies.as_os_str().to_owned();
        wal.push("-wal");
        let wal = PathBuf::from(wal);
        if wal.is_file() {
            copy(&wal, &scratch.0.join("Cookies-wal"))?;
        }
        let conn = Connection::open_with_flags(
            &target,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| Error::database(&e))?;
        let version: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
                row.get::<_, rusqlite::types::Value>(0)
            })
            .map_err(|_| Error::Format("no meta version".into()))
            .map(|value| match value {
                rusqlite::types::Value::Integer(n) => n.to_string(),
                rusqlite::types::Value::Text(text) => text,
                _ => String::new(),
            })?;
        let version: i64 = version
            .trim()
            .parse()
            .map_err(|_| Error::Format("the meta version is not a number".into()))?;
        let columns = {
            let mut statement = conn
                .prepare("SELECT name FROM pragma_table_info('cookies')")
                .map_err(|e| Error::database(&e))?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| Error::database(&e))?
                .collect::<rusqlite::Result<HashSet<String>>>()
                .map_err(|e| Error::database(&e))?
        };
        if let Some(missing) = REQUIRED.iter().find(|c| !columns.contains(**c)) {
            return Err(Error::Format(format!("the cookies table has no {missing}")));
        }
        Ok(Self {
            conn,
            version,
            columns,
            _scratch: scratch,
        })
    }

    /// The database's `meta` version.
    #[must_use]
    pub fn version(&self) -> i64 {
        self.version
    }

    fn column_or(&self, name: &str, fallback: &str) -> String {
        if self.columns.contains(name) {
            name.to_owned()
        } else {
            fallback.to_owned()
        }
    }

    /// Every site with the number of its cookies that have not expired by `now`, by site.
    ///
    /// # Errors
    ///
    /// [`Error::Database`].
    pub fn sites(&self, now: i64) -> Result<Vec<SiteCount>> {
        let persistent = self.column_or("is_persistent", "1");
        let mut statement = self
            .conn
            .prepare(&format!(
                "SELECT host_key, expires_utc, {persistent} FROM cookies"
            ))
            .map_err(|e| Error::database(&e))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            })
            .map_err(|e| Error::database(&e))?;
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        for row in rows {
            let (host, expires, persistent) = row.map_err(|e| Error::database(&e))?;
            if persistent && expires != 0 && unix_seconds(expires) <= now {
                continue;
            }
            let site = site_of(&host);
            if valid_site(&site) {
                *counts.entry(site).or_default() += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(site, count)| SiteCount { site, count })
            .collect())
    }

    /// The rows of `site` (its host-only and domain cookies).
    ///
    /// # Errors
    ///
    /// [`Error::Database`].
    pub fn rows(&self, site: &str) -> Result<Vec<RawCookie>> {
        let persistent = self.column_or("is_persistent", "1");
        let partition = self.column_or("top_frame_site_key", "''");
        let sql = format!(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, \
             is_httponly, samesite, {persistent}, {partition} FROM cookies \
             WHERE host_key = ?1 OR host_key = ?2 ORDER BY host_key, name, path"
        );
        let mut statement = self.conn.prepare(&sql).map_err(|e| Error::database(&e))?;
        let dotted = format!(".{site}");
        let rows = statement
            .query_map([site, dotted.as_str()], |row| {
                Ok(RawCookie {
                    host_key: row.get(0)?,
                    name: row.get(1)?,
                    value: Zeroizing::new(row.get::<_, Option<String>>(2)?.unwrap_or_default()),
                    encrypted: Zeroizing::new(
                        row.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
                    ),
                    path: row.get(4)?,
                    expires_utc: row.get(5)?,
                    secure: row.get::<_, i64>(6)? != 0,
                    http_only: row.get::<_, i64>(7)? != 0,
                    same_site: row.get(8)?,
                    persistent: row.get::<_, i64>(9)? != 0,
                    partitioned: !row
                        .get::<_, Option<String>>(10)?
                        .unwrap_or_default()
                        .is_empty(),
                })
            })
            .map_err(|e| Error::database(&e))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| Error::database(&e))
    }
}

/// Writing Chrome-shaped cookie databases for tests (this crate's, Core's and the L4
/// fixtures' builders use the same schema).
pub mod fixture {
    use std::path::Path;

    use rusqlite::{Connection, params};

    /// One row to write; `encrypted` is the `encrypted_value` (see `crate::crypto::seal`).
    #[derive(Debug, Clone, Default)]
    pub struct Row {
        pub host_key: String,
        pub name: String,
        pub value: String,
        pub encrypted: Vec<u8>,
        pub path: String,
        pub expires_utc: i64,
        pub secure: bool,
        pub http_only: bool,
        pub same_site: i64,
        pub persistent: bool,
        pub top_frame_site_key: String,
    }

    /// Chrome's `cookies` table (database version 24) and `meta`.
    pub const SCHEMA: &str = "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, has_cross_site_ancestor INTEGER NOT NULL, UNIQUE (host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port));";

    /// Writes a database at `path` with `version` in `meta` and `rows`; `wal` leaves it in
    /// WAL mode with the rows still in the `-wal` file (the connection is leaked open
    /// through the returned handle so no checkpoint runs).
    ///
    /// # Errors
    ///
    /// SQLite errors.
    pub fn write(
        path: &Path,
        version: i64,
        rows: &[Row],
        wal: bool,
    ) -> rusqlite::Result<Option<Connection>> {
        let conn = Connection::open(path)?;
        if wal {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "wal_autocheckpoint", 0)?;
        }
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('version', ?1)",
            [version.to_string()],
        )?;
        for row in rows {
            conn.execute(
                "INSERT INTO cookies VALUES (0, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10, 1, ?11, 2, 443, 0, 0, 0)",
                params![
                    row.host_key,
                    row.top_frame_site_key,
                    row.name,
                    row.value,
                    row.encrypted,
                    row.path,
                    row.expires_utc,
                    i64::from(row.secure),
                    i64::from(row.http_only),
                    i64::from(row.persistent),
                    row.same_site,
                ],
            )?;
        }
        Ok(if wal { Some(conn) } else { None })
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{Row, write};
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-cookies-{tag}-{}-{}",
            std::process::id(),
            COPIES.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("temp");
        dir
    }

    fn row(host: &str, name: &str, expires_utc: i64) -> Row {
        Row {
            host_key: host.into(),
            name: name.into(),
            path: "/".into(),
            expires_utc,
            persistent: expires_utc != 0,
            encrypted: b"v10xxxxxxxxxxxxxxxx".to_vec(),
            ..Row::default()
        }
    }

    #[test]
    fn sites_group_host_and_domain_cookies_and_skip_expired_ones() {
        let dir = temp("sites");
        let db = dir.join("Cookies");
        let now = 1_800_000_000;
        let future = chrome_time(now + 3600);
        let past = chrome_time(now - 3600);
        write(
            &db,
            24,
            &[
                row(".github.com", "_gh_sess", future),
                row("github.com", "logged_in", future),
                row("gist.github.com", "a", 0),
                row(".example.test", "old", past),
                row("localhost", "dev", 0),
            ],
            false,
        )
        .expect("fixture");
        let opened = CookieDb::open(&db, &dir.join("scratch")).expect("open");
        assert_eq!(opened.version(), 24);
        assert_eq!(
            opened.sites(now).expect("sites"),
            vec![
                SiteCount {
                    site: "gist.github.com".into(),
                    count: 1
                },
                SiteCount {
                    site: "github.com".into(),
                    count: 2
                },
                SiteCount {
                    site: "localhost".into(),
                    count: 1
                },
            ]
        );
        let rows = opened.rows("github.com").expect("rows");
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["_gh_sess", "logged_in"]);
        assert!(!format!("{:?}", rows[0]).contains("v10"));
        drop(opened);
        // The copy's folder is gone; the original stays.
        assert_eq!(
            std::fs::read_dir(dir.join("scratch"))
                .expect("scratch")
                .count(),
            0
        );
        assert!(db.is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rows_still_in_the_wal_are_read_from_the_copy() {
        let dir = temp("wal");
        let db = dir.join("Cookies");
        let open = write(&db, 23, &[row(".wal.test", "fresh", 0)], true)
            .expect("fixture")
            .expect("connection kept open");
        let mut wal = db.as_os_str().to_owned();
        wal.push("-wal");
        assert!(PathBuf::from(wal).is_file(), "the rows are in the WAL");
        let opened = CookieDb::open(&db, &dir).expect("open");
        assert_eq!(opened.version(), 23);
        assert_eq!(opened.rows("wal.test").expect("rows").len(), 1);
        drop(opened);
        drop(open);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn databases_without_meta_or_columns_are_refused() {
        let dir = temp("bad");
        let db = dir.join("Cookies");
        let conn = Connection::open(&db).expect("db");
        conn.execute_batch("CREATE TABLE cookies(host_key TEXT);")
            .expect("table");
        drop(conn);
        assert!(matches!(CookieDb::open(&db, &dir), Err(Error::Format(_))));
        let other = dir.join("Other");
        let conn = Connection::open(&other).expect("db");
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
             CREATE TABLE cookies(host_key TEXT);",
        )
        .expect("tables");
        drop(conn);
        let error = CookieDb::open(&other, &dir).expect_err("no columns");
        assert!(error.to_string().contains("name"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn time_and_site_helpers() {
        assert_eq!(unix_seconds(chrome_time(1_700_000_000)), 1_700_000_000);
        assert_eq!(site_of(".GitHub.com"), "github.com");
        assert!(valid_site("127.0.0.1"));
        assert!(valid_site("[::1]"));
        assert!(!valid_site(".a.test"));
        assert!(!valid_site("a b"));
        assert!(!valid_site(""));
    }
}
