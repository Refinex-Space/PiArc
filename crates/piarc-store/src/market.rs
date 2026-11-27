//! The Pi package market's cache (ADR-0102, schema v16): the npm registry's search answers and
//! the resource kinds of the packages' manifests, so the market opens without a request and
//! works offline. Parsing, classification and syncing are `piarc-core::market`'s; this module
//! only stores and queries.

use rusqlite::{OptionalExtension, params, params_from_iter};

use crate::error::{Error, Result};
use crate::store::Store;

/// Resource kind bits of `kw_kinds` and `manifest_kinds`.
pub mod kind {
    pub const EXTENSION: i64 = 1;
    pub const SKILL: i64 = 2;
    pub const PROMPT: i64 = 4;
    pub const THEME: i64 = 8;
}

/// One package as the registry search described it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketListing {
    pub name: String,
    pub version: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub publisher: String,
    pub license: Option<String>,
    /// Unix ms of the latest publish.
    pub updated_ms: i64,
    pub downloads_monthly: i64,
    pub insecure: bool,
    pub npm_url: Option<String>,
    pub repo_url: Option<String>,
    pub homepage_url: Option<String>,
    /// Kinds the keywords name.
    pub kw_kinds: i64,
}

/// A cached package: its listing and what Core learnt from its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketRow {
    pub listing: MarketListing,
    /// Kinds of the `pi` manifest of `manifest_version`.
    pub manifest_kinds: Option<i64>,
    pub manifest_version: Option<String>,
    pub deprecated: bool,
    /// Part of the popularity index (the last full sync).
    pub indexed: bool,
}

impl MarketRow {
    /// The kinds that apply: the manifest's when it describes the current version, otherwise
    /// the keywords'.
    #[must_use]
    pub fn kinds(&self) -> i64 {
        match (&self.manifest_version, self.manifest_kinds) {
            (Some(version), Some(kinds)) if *version == self.listing.version => kinds,
            _ => self.listing.kw_kinds,
        }
    }
}

/// Sort orders of [`MarketFilter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MarketSort {
    /// Monthly downloads, then name.
    #[default]
    Popular,
    /// Latest publish, then name.
    Updated,
}

/// What [`Store::market_query`] returns.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketFilter {
    /// Only packages with this kind bit (`None`: every package).
    pub kind: Option<i64>,
    /// Lowercase words that must all appear in the name, description, keywords or publisher.
    pub words: Vec<String>,
    /// Only these names (a live search's answer), when given.
    pub names: Option<Vec<String>>,
    /// Deprecated packages too (an exact name was asked for).
    pub deprecated_named: Option<String>,
    pub sort: MarketSort,
    pub offset: i64,
    pub limit: i64,
}

/// The sync state's one row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketSync {
    pub generation: i64,
    /// `idle`, `running` or `failed`.
    pub state: String,
    pub done: i64,
    pub total: i64,
    pub started_ms: i64,
    pub finished_ms: i64,
    /// When the last full sync succeeded (0: never).
    pub ok_ms: i64,
    pub last_error: Option<String>,
}

/// Counts per kind of a query, theme-only packages excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MarketCounts {
    pub all: i64,
    pub extension: i64,
    pub skill: i64,
    pub prompt: i64,
}

const COLUMNS: &str = "name, version, description, keywords, publisher, license, updated_ms, \
                       downloads_monthly, insecure, npm_url, repo_url, homepage_url, kw_kinds, \
                       manifest_kinds, manifest_version, deprecated, indexed";

/// The kinds that apply, in SQL.
const KINDS: &str = "(CASE WHEN manifest_version = version AND manifest_kinds IS NOT NULL \
                     THEN manifest_kinds ELSE kw_kinds END)";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MarketRow> {
    let keywords: String = row.get(3)?;
    Ok(MarketRow {
        listing: MarketListing {
            name: row.get(0)?,
            version: row.get(1)?,
            description: row.get(2)?,
            keywords: serde_json::from_str(&keywords).unwrap_or_default(),
            publisher: row.get(4)?,
            license: row.get(5)?,
            updated_ms: row.get(6)?,
            downloads_monthly: row.get(7)?,
            insecure: row.get::<_, i64>(8)? != 0,
            npm_url: row.get(9)?,
            repo_url: row.get(10)?,
            homepage_url: row.get(11)?,
            kw_kinds: row.get(12)?,
        },
        manifest_kinds: row.get(13)?,
        manifest_version: row.get(14)?,
        deprecated: row.get::<_, i64>(15)? != 0,
        indexed: row.get::<_, i64>(16)? != 0,
    })
}

/// `%`, `_` and `\` escaped for `LIKE … ESCAPE '\'`.
fn like(word: &str) -> String {
    let mut out = String::with_capacity(word.len() + 2);
    out.push('%');
    for c in word.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The `WHERE` clause of `filter` (kind left out) and its parameters.
fn conditions(filter: &MarketFilter) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;
    let mut sql = vec![format!("{KINDS} != {}", kind::THEME)];
    let mut values = Vec::new();
    match &filter.deprecated_named {
        Some(name) => {
            sql.push("(deprecated = 0 OR name = ?)".to_owned());
            values.push(Value::Text(name.clone()));
        }
        None => sql.push("deprecated = 0".to_owned()),
    }
    for word in &filter.words {
        sql.push(
            "(lower(name) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' \
             OR lower(keywords) LIKE ? ESCAPE '\\' OR lower(publisher) LIKE ? ESCAPE '\\')"
                .to_owned(),
        );
        for _ in 0..4 {
            values.push(Value::Text(like(word)));
        }
    }
    // Without names (browsing): the popularity index and what earlier searches found.
    if let Some(names) = &filter.names {
        sql.push(format!(
            "name IN ({})",
            vec!["?"; names.len().max(1)].join(", ")
        ));
        if names.is_empty() {
            values.push(Value::Null);
        }
        values.extend(names.iter().cloned().map(Value::Text));
    }
    (sql.join(" AND "), values)
}

impl Store {
    /// Writes `listings`, keeping what Core learnt from their manifests; `index` marks them as
    /// part of index generation `index` (a full sync's page).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be written.
    pub fn market_put(
        &mut self,
        listings: &[MarketListing],
        index: Option<i64>,
        now: i64,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot write the market"))?;
        {
            let mut statement = tx
                .prepare(
                    "INSERT INTO market_packages (name, version, description, keywords, publisher,
                        license, updated_ms, downloads_monthly, insecure, npm_url, repo_url,
                        homepage_url, kw_kinds, indexed, sync_gen, seen_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(name) DO UPDATE SET version = excluded.version,
                        description = excluded.description, keywords = excluded.keywords,
                        publisher = excluded.publisher, license = excluded.license,
                        updated_ms = excluded.updated_ms,
                        downloads_monthly = excluded.downloads_monthly,
                        insecure = excluded.insecure, npm_url = excluded.npm_url,
                        repo_url = excluded.repo_url, homepage_url = excluded.homepage_url,
                        kw_kinds = excluded.kw_kinds,
                        indexed = max(indexed, excluded.indexed),
                        sync_gen = CASE WHEN excluded.indexed = 1 THEN excluded.sync_gen
                                   ELSE sync_gen END,
                        seen_ms = excluded.seen_ms",
                )
                .map_err(Error::sqlite("cannot write the market"))?;
            for l in listings {
                let keywords = serde_json::to_string(&l.keywords).unwrap_or_else(|_| "[]".into());
                statement
                    .execute(params![
                        l.name,
                        l.version,
                        l.description,
                        keywords,
                        l.publisher,
                        l.license,
                        l.updated_ms,
                        l.downloads_monthly,
                        i64::from(l.insecure),
                        l.npm_url,
                        l.repo_url,
                        l.homepage_url,
                        l.kw_kinds,
                        i64::from(index.is_some()),
                        index.unwrap_or(0),
                        now,
                    ])
                    .map_err(Error::sqlite("cannot write the market"))?;
            }
        }
        tx.commit()
            .map_err(Error::sqlite("cannot write the market"))
    }

    /// Ends index generation `generation`: rows of older generations leave the index (they stay as
    /// search results).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be written.
    pub fn market_end_index(&self, generation: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE market_packages SET indexed = 0 WHERE indexed = 1 AND sync_gen < ?1",
                [generation],
            )
            .map_err(Error::sqlite("cannot write the market"))?;
        Ok(())
    }

    /// Records what the manifest of `name@version` says.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn market_set_manifest(
        &self,
        name: &str,
        version: &str,
        kinds: i64,
        deprecated: bool,
    ) -> Result<()> {
        self.conn
            .execute(
                "UPDATE market_packages SET manifest_kinds = ?3, manifest_version = ?2,
                    deprecated = ?4 WHERE name = ?1",
                params![name, version, kinds, i64::from(deprecated)],
            )
            .map_err(Error::sqlite("cannot write the market"))?;
        Ok(())
    }

    /// Index rows whose manifest Core has not read for their current version, most
    /// downloaded first: `(name, version)`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn market_unclassified(&self, limit: i64) -> Result<Vec<(String, String)>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT name, version FROM market_packages
                 WHERE indexed = 1 AND (manifest_version IS NULL OR manifest_version != version)
                 ORDER BY downloads_monthly DESC, name LIMIT ?1",
            )
            .map_err(Error::sqlite("cannot read the market"))?;
        let rows = statement
            .query_map([limit], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(Error::sqlite("cannot read the market"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::sqlite("cannot read the market"))
    }

    /// How many index rows still wait for their manifest, and how many there are.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn market_classified(&self) -> Result<(i64, i64)> {
        self.conn
            .query_row(
                "SELECT count(*) FILTER (WHERE manifest_version = version), count(*)
                 FROM market_packages WHERE indexed = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(Error::sqlite("cannot read the market"))
    }

    /// The page of packages `filter` selects, with the total it would select.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn market_query(&self, filter: &MarketFilter) -> Result<(Vec<MarketRow>, i64)> {
        let (mut sql, mut values) = conditions(filter);
        if let Some(bit) = filter.kind {
            sql.push_str(&format!(" AND ({KINDS} & ?) != 0"));
            values.push(rusqlite::types::Value::Integer(bit));
        }
        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT count(*) FROM market_packages WHERE {sql}"),
                params_from_iter(values.iter()),
                |r| r.get(0),
            )
            .map_err(Error::sqlite("cannot read the market"))?;
        let order = match filter.sort {
            MarketSort::Popular => "downloads_monthly DESC, name",
            MarketSort::Updated => "updated_ms DESC, name",
        };
        values.push(rusqlite::types::Value::Integer(filter.limit));
        values.push(rusqlite::types::Value::Integer(filter.offset));
        let mut statement = self
            .conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM market_packages WHERE {sql} ORDER BY {order} LIMIT ? OFFSET ?"
            ))
            .map_err(Error::sqlite("cannot read the market"))?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), row)
            .map_err(Error::sqlite("cannot read the market"))?;
        let rows = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Error::sqlite("cannot read the market"))?;
        Ok((rows, total))
    }

    /// Counts per kind of what `filter` selects (its kind, sort and page ignored).
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn market_counts(&self, filter: &MarketFilter) -> Result<MarketCounts> {
        let (sql, values) = conditions(filter);
        self.conn
            .query_row(
                &format!(
                    "SELECT count(*), count(*) FILTER (WHERE ({KINDS} & 1) != 0),
                        count(*) FILTER (WHERE ({KINDS} & 2) != 0),
                        count(*) FILTER (WHERE ({KINDS} & 4) != 0)
                     FROM market_packages WHERE {sql}"
                ),
                params_from_iter(values.iter()),
                |r| {
                    Ok(MarketCounts {
                        all: r.get(0)?,
                        extension: r.get(1)?,
                        skill: r.get(2)?,
                        prompt: r.get(3)?,
                    })
                },
            )
            .map_err(Error::sqlite("cannot read the market"))
    }

    /// The cached package `name`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be read.
    pub fn market_package(&self, name: &str) -> Result<Option<MarketRow>> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM market_packages WHERE name = ?1"),
                [name],
                row,
            )
            .optional()
            .map_err(Error::sqlite("cannot read the market"))
    }

    /// The sync state.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be read.
    pub fn market_sync(&self) -> Result<MarketSync> {
        self.conn
            .query_row(
                "SELECT gen, state, done, total, started_ms, finished_ms, ok_ms, last_error
                 FROM market_sync WHERE id = 1",
                [],
                |r| {
                    Ok(MarketSync {
                        generation: r.get(0)?,
                        state: r.get(1)?,
                        done: r.get(2)?,
                        total: r.get(3)?,
                        started_ms: r.get(4)?,
                        finished_ms: r.get(5)?,
                        ok_ms: r.get(6)?,
                        last_error: r.get(7)?,
                    })
                },
            )
            .optional()
            .map(Option::unwrap_or_default)
            .map_err(Error::sqlite("cannot read the market"))
    }

    /// Replaces the sync state.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_market_sync(&self, sync: &MarketSync) -> Result<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO market_sync
                    (id, gen, state, done, total, started_ms, finished_ms, ok_ms, last_error)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    sync.generation,
                    sync.state,
                    sync.done,
                    sync.total,
                    sync.started_ms,
                    sync.finished_ms,
                    sync.ok_ms,
                    sync.last_error,
                ],
            )
            .map_err(Error::sqlite("cannot write the market"))?;
        Ok(())
    }
}
