//! Background tasks (T32, ADR-0049): one row per task of Core's task manager, written when it
//! starts and whenever its state changes. The rows outlive the processes: after a restart the
//! panel shows them, and the ones still `running` become `interrupted`.

use rusqlite::{OptionalExtension, Row, params};

use crate::{Error, Result, Store};

/// One task as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    /// The task id.
    pub id: String,
    /// The session that started it.
    pub session_id: String,
    /// The main session it belongs to.
    pub owner_session_id: String,
    /// The session's workspace.
    pub workspace: String,
    /// `command`, `subagent`, `monitor`, ...
    pub kind: String,
    /// What the panel calls it.
    pub title: String,
    /// Working directory.
    pub cwd: String,
    /// `running`, `completed`, `failed`, `killed`, `interrupted`.
    pub status: String,
    /// The output file.
    pub output_path: Option<String>,
    /// Bytes written to it.
    pub output_bytes: u64,
    /// Unix milliseconds.
    pub started_at: i64,
    /// Unix milliseconds.
    pub ended_at: Option<i64>,
    /// The exit code.
    pub exit_code: Option<i32>,
    /// The rest of Core's record, as JSON.
    pub metadata: String,
}

const COLUMNS: &str = "id, session_id, owner_session_id, workspace, kind, title, cwd, status, \
                       output_path, output_bytes, started_at, ended_at, exit_code, metadata";

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        owner_session_id: row.get(2)?,
        workspace: row.get(3)?,
        kind: row.get(4)?,
        title: row.get(5)?,
        cwd: row.get(6)?,
        status: row.get(7)?,
        output_path: row.get(8)?,
        output_bytes: u64::try_from(row.get::<_, i64>(9)?).unwrap_or(0),
        started_at: row.get(10)?,
        ended_at: row.get(11)?,
        exit_code: row.get(12)?,
        metadata: row.get(13)?,
    })
}

impl Store {
    /// Writes `task`, replacing the row with its id.
    ///
    /// # Errors
    /// A database write failed.
    pub fn put_task(&self, task: &TaskRow) -> Result<()> {
        self.conn
            .execute(
                &format!(
                    "INSERT OR REPLACE INTO background_tasks ({COLUMNS}) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
                ),
                params![
                    task.id,
                    task.session_id,
                    task.owner_session_id,
                    task.workspace,
                    task.kind,
                    task.title,
                    task.cwd,
                    task.status,
                    task.output_path,
                    i64::try_from(task.output_bytes).unwrap_or(i64::MAX),
                    task.started_at,
                    task.ended_at,
                    task.exit_code,
                    task.metadata,
                ],
            )
            .map(|_| ())
            .map_err(Error::sqlite("cannot store a background task"))
    }

    /// One task.
    ///
    /// # Errors
    /// A database read failed.
    pub fn task(&self, id: &str) -> Result<Option<TaskRow>> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM background_tasks WHERE id = ?1"),
                params![id],
                task_from_row,
            )
            .optional()
            .map_err(Error::sqlite("cannot read a background task"))
    }

    /// The latest `limit` tasks, newest first.
    ///
    /// # Errors
    /// A database read failed.
    pub fn recent_tasks(&self, limit: u32) -> Result<Vec<TaskRow>> {
        let mut statement = self
            .conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM background_tasks \
                 ORDER BY started_at DESC, id DESC LIMIT ?1"
            ))
            .map_err(Error::sqlite("cannot list background tasks"))?;
        statement
            .query_map(params![limit], task_from_row)
            .and_then(Iterator::collect)
            .map_err(Error::sqlite("cannot list background tasks"))
    }

    /// Marks every task still `running` as `interrupted`, ended at `now_ms` (PiArc quit before
    /// they ended); returns how many.
    ///
    /// # Errors
    /// A database write failed.
    pub fn interrupt_running_tasks(&self, now_ms: i64) -> Result<usize> {
        self.conn
            .execute(
                "UPDATE background_tasks SET status = 'interrupted', ended_at = ?1 \
                 WHERE status = 'running'",
                params![now_ms],
            )
            .map_err(Error::sqlite("cannot mark background tasks interrupted"))
    }

    /// Removes the tasks of main session `owner` (the session was deleted).
    ///
    /// # Errors
    /// A database write failed.
    pub fn delete_session_tasks(&self, owner: &str) -> Result<usize> {
        self.conn
            .execute(
                "DELETE FROM background_tasks WHERE owner_session_id = ?1",
                params![owner],
            )
            .map_err(Error::sqlite("cannot delete background tasks"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, owner: &str, started_at: i64, status: &str) -> TaskRow {
        TaskRow {
            id: id.into(),
            session_id: owner.into(),
            owner_session_id: owner.into(),
            workspace: "/w 中文".into(),
            kind: "command".into(),
            title: "sleep 1".into(),
            cwd: "/w 中文".into(),
            status: status.into(),
            output_path: Some("/d/sessions/s/tasks/x.log".into()),
            output_bytes: 12,
            started_at,
            ended_at: None,
            exit_code: None,
            metadata: "{}".into(),
        }
    }

    #[test]
    fn stores_lists_interrupts_and_deletes_tasks() {
        let store = Store::open_in_memory(1).expect("store");
        store.put_task(&row("a", "s1", 10, "running")).expect("a");
        store.put_task(&row("b", "s2", 20, "running")).expect("b");
        let mut done = row("c", "s1", 30, "completed");
        done.exit_code = Some(0);
        done.ended_at = Some(31);
        store.put_task(&done).expect("c");
        let ids: Vec<String> = store
            .recent_tasks(10)
            .expect("list")
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["c", "b", "a"]);
        assert_eq!(store.task("c").expect("read"), Some(done.clone()));
        // A later write of the same id replaces the row.
        let mut grown = row("a", "s1", 10, "running");
        grown.output_bytes = 99;
        store.put_task(&grown).expect("again");
        assert_eq!(
            store.task("a").expect("read").map(|t| t.output_bytes),
            Some(99)
        );
        assert_eq!(store.interrupt_running_tasks(50).expect("interrupt"), 2);
        let a = store.task("a").expect("read").expect("row");
        assert_eq!((a.status.as_str(), a.ended_at), ("interrupted", Some(50)));
        assert_eq!(
            store.task("c").expect("read").map(|t| t.status),
            Some("completed".into())
        );
        assert_eq!(store.delete_session_tasks("s1").expect("delete"), 2);
        assert_eq!(store.recent_tasks(10).expect("list").len(), 1);
    }
}
