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

/// Which audit events to read ([`crate::Store::filter_audit_events`]); `None` matches all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditFilter {
    /// The session.
    pub session_id: Option<String>,
    /// The workspace path.
    pub workspace: Option<String>,
    /// The category (`permission`, ...).
    pub kind: Option<String>,
    /// The tool in the details.
    pub tool: Option<String>,
    /// `allow` or `deny` in the details.
    pub conclusion: Option<String>,
    /// From this Unix ms.
    pub since: Option<i64>,
    /// Up to this Unix ms.
    pub until: Option<i64>,
    /// At most this many rows.
    pub limit: u32,
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

    /// Remember the permission mode chosen in a workspace; false when the workspace has no row.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the row cannot be written.
    pub fn set_workspace_mode(&self, path: &str, mode: Option<&str>) -> Result<bool> {
        self.conn
            .execute(
                "UPDATE workspaces SET default_mode = ?2 WHERE path = ?1",
                params![path, mode],
            )
            .map(|n| n > 0)
            .map_err(Error::sqlite("cannot write workspaces"))
    }

    /// The permission mode remembered for a workspace.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the table cannot be read.
    pub fn workspace_mode(&self, path: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT default_mode FROM workspaces WHERE path = ?1",
                [path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
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

    /// Audit events matching `filter`, newest first. The tool and conclusion are read from the
    /// event's JSON details.
    ///
    /// # Errors
    ///
    /// A database read failed.
    pub fn filter_audit_events(&self, filter: &AuditFilter) -> Result<Vec<AuditEvent>> {
        self.read_audit(
            "SELECT at, kind, session_id, workspace, detail FROM audit_events
             WHERE (?1 IS NULL OR session_id = ?1)
               AND (?2 IS NULL OR json_extract(detail, '$.tool') = ?2)
               AND (?3 IS NULL OR json_extract(detail, '$.conclusion') = ?3)
               AND (?4 IS NULL OR at >= ?4)
               AND (?5 IS NULL OR at <= ?5)
               AND (?6 IS NULL OR workspace = ?6)
               AND (?7 IS NULL OR kind = ?7)
             ORDER BY at DESC, id DESC LIMIT ?8",
            params![
                filter.session_id,
                filter.tool,
                filter.conclusion,
                filter.since,
                filter.until,
                filter.workspace,
                filter.kind,
                filter.limit
            ],
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_modes_are_remembered() {
        let store = Store::open_in_memory(0).expect("store");
        assert!(
            !store
                .set_workspace_mode("/w", Some("plan"))
                .expect("update")
        );
        store
            .upsert_workspace(&WorkspaceRecord {
                path: "/w".into(),
                display_name: "w".into(),
                main_checkout: "/w".into(),
                last_opened_at: 1,
                default_mode: None,
                default_model: None,
            })
            .expect("workspace");
        assert!(
            store
                .set_workspace_mode("/w", Some("plan"))
                .expect("update")
        );
        assert_eq!(
            store.workspace_mode("/w").expect("read").as_deref(),
            Some("plan")
        );
        assert_eq!(store.workspace_mode("/other").expect("read"), None);
    }

    #[test]
    fn audit_events_filter_by_session_tool_conclusion_and_time() {
        let store = Store::open_in_memory(0).expect("store");
        for (at, session, tool, conclusion) in [
            (10, "a", "Bash", "deny"),
            (20, "a", "Read", "allow"),
            (30, "b", "Bash", "allow"),
        ] {
            store
                .append_audit(&AuditEvent {
                    at,
                    kind: "permission".into(),
                    session_id: Some(session.into()),
                    workspace: Some("/w".into()),
                    detail: format!(r#"{{"tool":"{tool}","conclusion":"{conclusion}"}}"#),
                })
                .expect("audit");
        }
        let times = |filter: AuditFilter| -> Vec<i64> {
            store
                .filter_audit_events(&AuditFilter {
                    limit: 10,
                    ..filter
                })
                .expect("query")
                .iter()
                .map(|e| e.at)
                .collect()
        };
        assert_eq!(times(AuditFilter::default()), [30, 20, 10]);
        assert_eq!(
            times(AuditFilter {
                tool: Some("Bash".into()),
                ..Default::default()
            }),
            [30, 10]
        );
        assert_eq!(
            times(AuditFilter {
                session_id: Some("a".into()),
                conclusion: Some("deny".into()),
                ..Default::default()
            }),
            [10]
        );
        assert_eq!(
            times(AuditFilter {
                since: Some(15),
                until: Some(25),
                ..Default::default()
            }),
            [20]
        );
        assert_eq!(
            store
                .filter_audit_events(&AuditFilter {
                    limit: 1,
                    ..Default::default()
                })
                .expect("q")
                .len(),
            1
        );
    }
}
