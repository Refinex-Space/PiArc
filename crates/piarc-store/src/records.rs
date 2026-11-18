//! Workspaces, project trust and audit events.

use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};
use crate::store::Store;

/// One row of `workspaces`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRecord {
    /// Canonical path of the workspace directory.
    pub path: String,
    /// Name shown in the client.
    pub display_name: String,
    /// Canonical path of the repository's main checkout (the trust key).
    pub main_checkout: String,
    /// When it was last opened (Unix ms).
    pub last_opened_at: i64,
    /// Default permission mode, when the user chose one.
    pub default_mode: Option<String>,
    /// Default model (`provider/id`), when the user chose one.
    pub default_model: Option<String>,
}

/// A trust decision for a main checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustDecision {
    /// The user trusted the project.
    Trusted,
    /// The user declined.
    Denied,
}

impl TrustDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Denied => "denied",
        }
    }
}

/// One row of `project_trust`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustRecord {
    /// Canonical path of the main checkout.
    pub checkout: String,
    /// The decision.
    pub decision: TrustDecision,
    /// When it was made (Unix ms).
    pub decided_at: i64,
    /// JSON list of the executable items the user saw when deciding.
    pub snapshot: String,
}

/// One row of `audit_events`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    /// Unix ms.
    pub at: i64,
    /// Category, for example `permission` or `hook`.
    pub kind: String,
    /// The session, when the event belongs to one.
    pub session_id: Option<String>,
    /// The workspace path, when the event belongs to one.
    pub workspace: Option<String>,
    /// JSON details.
    pub detail: String,
}

impl Store {
    /// Inserts or updates a workspace.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn upsert_workspace(&self, workspace: &WorkspaceRecord) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO workspaces (path, display_name, main_checkout, last_opened_at, default_mode, default_model)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(path) DO UPDATE SET display_name = excluded.display_name,
                    main_checkout = excluded.main_checkout, last_opened_at = excluded.last_opened_at,
                    default_mode = excluded.default_mode, default_model = excluded.default_model",
                params![
                    workspace.path,
                    workspace.display_name,
                    workspace.main_checkout,
                    workspace.last_opened_at,
                    workspace.default_mode,
                    workspace.default_model
                ],
            )
            .map(|_| ())
            .map_err(Error::sqlite("cannot write workspaces"))
    }

    /// Workspaces, most recently opened first.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the table cannot be read.
    pub fn workspaces(&self) -> Result<Vec<WorkspaceRecord>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT path, display_name, main_checkout, last_opened_at, default_mode, default_model
                 FROM workspaces ORDER BY last_opened_at DESC, path",
            )
            .map_err(Error::sqlite("cannot read workspaces"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(WorkspaceRecord {
                    path: row.get(0)?,
                    display_name: row.get(1)?,
                    main_checkout: row.get(2)?,
                    last_opened_at: row.get(3)?,
                    default_mode: row.get(4)?,
                    default_model: row.get(5)?,
                })
            })
            .map_err(Error::sqlite("cannot read workspaces"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read workspaces"))
    }

    /// The trust decision for `checkout`, if one was made.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the table cannot be read.
    pub fn trust(&self, checkout: &str) -> Result<Option<TrustRecord>> {
        self.conn
            .query_row(
                "SELECT checkout, decision, decided_at, snapshot FROM project_trust WHERE checkout = ?1",
                [checkout],
                |row| {
                    let decision: String = row.get(1)?;
                    Ok(TrustRecord {
                        checkout: row.get(0)?,
                        // The CHECK constraint allows only the two values.
                        decision: if decision == "trusted" {
                            TrustDecision::Trusted
                        } else {
                            TrustDecision::Denied
                        },
                        decided_at: row.get(2)?,
                        snapshot: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Error::sqlite("cannot read project_trust"))
    }

    /// Records a trust decision, replacing an earlier one.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_trust(&self, record: &TrustRecord) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO project_trust (checkout, decision, decided_at, snapshot) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(checkout) DO UPDATE SET decision = excluded.decision,
                    decided_at = excluded.decided_at, snapshot = excluded.snapshot",
                params![
                    record.checkout,
                    record.decision.as_str(),
                    record.decided_at,
                    record.snapshot
                ],
            )
            .map(|_| ())
            .map_err(Error::sqlite("cannot write project_trust"))
    }

    /// Forgets the decision for `checkout` (revocation): the project is untrusted until the
    /// user decides again. Returns whether there was one.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be deleted.
    pub fn remove_trust(&self, checkout: &str) -> Result<bool> {
        self.conn
            .execute("DELETE FROM project_trust WHERE checkout = ?1", [checkout])
            .map(|n| n > 0)
            .map_err(Error::sqlite("cannot write project_trust"))
    }

    /// Appends an audit event; returns its row id.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn append_audit(&self, event: &AuditEvent) -> Result<i64> {
        self.conn
            .execute(
                "INSERT INTO audit_events (at, kind, session_id, workspace, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    event.at,
                    event.kind,
                    event.session_id,
                    event.workspace,
                    event.detail
                ],
            )
            .map_err(Error::sqlite("cannot write audit_events"))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The latest `limit` audit events, newest first.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the table cannot be read.
    pub fn audit_events(&self, limit: u32) -> Result<Vec<AuditEvent>> {
        self.read_audit("SELECT at, kind, session_id, workspace, detail FROM audit_events ORDER BY at DESC, id DESC LIMIT ?1", [limit])
    }

    /// The latest audit events of one session, newest first.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn session_audit_events(&self, session: &str, limit: u32) -> Result<Vec<AuditEvent>> {
        self.read_audit("SELECT at, kind, session_id, workspace, detail FROM audit_events WHERE session_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2", params![session, limit])
    }

    fn read_audit(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<AuditEvent>> {
        let mut statement = self
            .conn
            .prepare(sql)
            .map_err(Error::sqlite("cannot read audit_events"))?;
        let rows = statement
            .query_map(params, |row| {
                Ok(AuditEvent {
                    at: row.get(0)?,
                    kind: row.get(1)?,
                    session_id: row.get(2)?,
                    workspace: row.get(3)?,
                    detail: row.get(4)?,
                })
            })
            .map_err(Error::sqlite("cannot read audit_events"))?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(Error::sqlite("cannot read audit_events"))
    }
}
