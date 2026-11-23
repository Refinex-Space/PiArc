//! Usage records and catalog prices (T41, schema v11): the rows the index derives from session
//! files, summed per session, kind, purpose and model; single requests for models priced in
//! tiers; and the catalog prices Core last saw. Pricing is Core's (`piarc-core::usage`).

use rusqlite::params;

use crate::error::{Error, Result};
use crate::store::Store;

/// Summed tokens of one session's requests of one kind, purpose and model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageGroup {
    /// The session (a subagent's own id for its requests).
    pub session_id: String,
    /// `model` or `auxiliary`.
    pub kind: String,
    /// An auxiliary call's purpose.
    pub purpose: Option<String>,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// Requests.
    pub requests: i64,
    /// Input tokens.
    pub input: i64,
    /// Output tokens.
    pub output: i64,
    /// Cache-read tokens.
    pub cache_read: i64,
    /// Cache-write tokens.
    pub cache_write: i64,
    /// One-hour cache-write tokens (part of `cache_write`).
    pub cache_write_1h: i64,
    /// Reasoning tokens.
    pub reasoning: i64,
}

/// One request's tokens, for a model priced in tiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTokens {
    /// The session.
    pub session_id: String,
    /// `model` or `auxiliary`.
    pub kind: String,
    /// An auxiliary call's purpose.
    pub purpose: Option<String>,
    /// Input tokens.
    pub input: i64,
    /// Output tokens.
    pub output: i64,
    /// Cache-read tokens.
    pub cache_read: i64,
    /// Cache-write tokens.
    pub cache_write: i64,
    /// One-hour cache-write tokens.
    pub cache_write_1h: i64,
    /// Reasoning tokens.
    pub reasoning: i64,
}

/// A session with usage: what a report shows of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageSession {
    /// Its id.
    pub id: String,
    /// Its title (custom, then name, then first message).
    pub title: Option<String>,
    /// Its workspace.
    pub workspace: Option<String>,
    /// For a subagent's session: the session that started it.
    pub subagent_parent: Option<String>,
    /// For a subagent's session: its type.
    pub subagent_type: Option<String>,
    /// Latest entry timestamp.
    pub updated_at: Option<i64>,
}

pub(crate) fn insert_record(
    conn: &rusqlite::Connection,
    session: &str,
    u: &crate::RequestUsage,
    ephemeral_workspace: Option<&str>,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO usage_records (session_id, entry_id, at, kind, purpose, provider,
                    model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    cache_write_1h_tokens, reasoning_tokens, ephemeral_workspace)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )
    .and_then(|mut s| {
        s.execute(params![
            session,
            u.entry_id,
            u.at,
            u.kind,
            u.purpose,
            u.provider,
            u.model,
            u.input,
            u.output,
            u.cache_read,
            u.cache_write,
            u.cache_write_1h,
            u.reasoning,
            ephemeral_workspace
        ])
    })
    .map_err(Error::sqlite("cannot write usage_records"))?;
    Ok(())
}

impl Store {
    /// Records side-chat accounting which has no transcript source, in one transaction.
    ///
    /// # Errors
    /// A database write failed.
    pub fn record_side_chat(
        &mut self,
        id: &str,
        workspace: &str,
        records: &[crate::RequestUsage],
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot start usage transaction"))?;
        for row in records {
            insert_record(&tx, id, row, Some(workspace))?;
        }
        tx.commit()
            .map_err(Error::sqlite("cannot commit usage transaction"))
    }

    /// The usage of every indexed session, summed per session, kind, purpose and model.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn usage_groups(&self) -> Result<Vec<UsageGroup>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT session_id, kind, purpose, provider, model, COUNT(*),
                    SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                    SUM(cache_write_tokens), SUM(cache_write_1h_tokens), SUM(reasoning_tokens)
                 FROM usage_records
                 GROUP BY session_id, kind, purpose, provider, model
                 ORDER BY session_id, kind, purpose, provider, model",
            )
            .map_err(Error::sqlite("cannot read usage_records"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(UsageGroup {
                    session_id: row.get(0)?,
                    kind: row.get(1)?,
                    purpose: row.get(2)?,
                    provider: row.get(3)?,
                    model: row.get(4)?,
                    requests: row.get(5)?,
                    input: row.get(6)?,
                    output: row.get(7)?,
                    cache_read: row.get(8)?,
                    cache_write: row.get(9)?,
                    cache_write_1h: row.get(10)?,
                    reasoning: row.get(11)?,
                })
            })
            .map_err(Error::sqlite("cannot read usage_records"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read usage_records"))
    }

    /// Every request of one model, for tiered prices.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn usage_requests(&self, provider: &str, model: &str) -> Result<Vec<RequestTokens>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT session_id, kind, purpose, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens
                 FROM usage_records WHERE provider = ?1 AND model = ?2 ORDER BY rowid",
            )
            .map_err(Error::sqlite("cannot read usage_records"))?;
        let rows = statement
            .query_map(params![provider, model], |row| {
                Ok(RequestTokens {
                    session_id: row.get(0)?,
                    kind: row.get(1)?,
                    purpose: row.get(2)?,
                    input: row.get(3)?,
                    output: row.get(4)?,
                    cache_read: row.get(5)?,
                    cache_write: row.get(6)?,
                    cache_write_1h: row.get(7)?,
                    reasoning: row.get(8)?,
                })
            })
            .map_err(Error::sqlite("cannot read usage_records"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read usage_records"))
    }

    /// The sessions that have usage records.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn usage_sessions(&self) -> Result<Vec<UsageSession>> {
        let mut statement = self
            .conn
            .prepare_cached(
                "SELECT billed.session_id, COALESCE(s.custom_title, s.name, s.first_message),
                    COALESCE(s.workspace_path, billed.workspace), s.subagent_parent,
                    s.subagent_type, COALESCE(s.updated_at, billed.at)
                 FROM (SELECT session_id, MAX(ephemeral_workspace) AS workspace, MAX(at) AS at
                       FROM usage_records GROUP BY session_id) AS billed
                 LEFT JOIN sessions AS s ON s.id = billed.session_id
                 ORDER BY 6 DESC, billed.session_id",
            )
            .map_err(Error::sqlite("cannot read sessions"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(UsageSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    workspace: row.get(2)?,
                    subagent_parent: row.get(3)?,
                    subagent_type: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(Error::sqlite("cannot read sessions"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read sessions"))
    }

    /// Records catalog prices (`provider`, `model`, pi-ai's `cost` as JSON) seen at `now`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be written.
    pub fn put_model_prices(
        &mut self,
        prices: &[(String, String, String)],
        now: i64,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(Error::sqlite("cannot start a transaction"))?;
        for (provider, model, price) in prices {
            tx.execute(
                "INSERT INTO model_prices (provider, model, price, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (provider, model) DO UPDATE SET
                    price = excluded.price, updated_at = excluded.updated_at",
                params![provider, model, price, now],
            )
            .map_err(Error::sqlite("cannot write model_prices"))?;
        }
        tx.commit()
            .map_err(Error::sqlite("cannot commit model_prices"))
    }

    /// Forgets the catalog price of models the catalog no longer prices.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be deleted.
    pub fn remove_model_prices(&mut self, models: &[(String, String)]) -> Result<()> {
        for (provider, model) in models {
            self.conn
                .execute(
                    "DELETE FROM model_prices WHERE provider = ?1 AND model = ?2",
                    params![provider, model],
                )
                .map_err(Error::sqlite("cannot delete from model_prices"))?;
        }
        Ok(())
    }

    /// The recorded catalog prices: `(provider, model, price JSON)`.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the rows cannot be read.
    pub fn model_prices(&self) -> Result<Vec<(String, String, String)>> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT provider, model, price FROM model_prices ORDER BY 1, 2")
            .map_err(Error::sqlite("cannot read model_prices"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(Error::sqlite("cannot read model_prices"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read model_prices"))
    }
}
