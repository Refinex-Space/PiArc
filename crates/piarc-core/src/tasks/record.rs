//! A task's record: the protocol's [`BackgroundTask`] as the database stores it.

use piarc_protocol::exec::CommandOutcome;
use piarc_protocol::tasks::{BackgroundTask, TaskKind, TaskStatus, TerminalOrigin, TerminalTask};
use piarc_store::TaskRow;
use serde::{Deserialize, Serialize};

/// What `background_tasks.metadata` holds: the fields without a column.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signal: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<CommandOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meaning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    /// A terminal's origin and sharing (its handle is not kept: it belongs to one run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_origin: Option<TerminalOrigin>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    terminal_shared: bool,
}

/// A new task id: `bg-` and 12 hexadecimal digits.
pub(super) fn new_task_id() -> Result<String, piarc_protocol::ErrorObject> {
    let mut bytes = [0_u8; 6];
    getrandom::fill(&mut bytes).map_err(|e| {
        piarc_protocol::ErrorObject::new(
            piarc_protocol::ErrorKind::InternalError,
            format!("no randomness for a task id: {e}"),
            false,
        )
    })?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("bg-{hex}"))
}

/// Now, in Unix milliseconds.
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

pub(super) fn kind_text(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Command => "command",
        TaskKind::Subagent => "subagent",
        TaskKind::Monitor => "monitor",
        TaskKind::Terminal => "terminal",
    }
}

pub(super) fn status_text(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Running => "running",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Killed => "killed",
        TaskStatus::Interrupted => "interrupted",
    }
}

fn kind_of(text: &str) -> Option<TaskKind> {
    Some(match text {
        "command" => TaskKind::Command,
        "subagent" => TaskKind::Subagent,
        "monitor" => TaskKind::Monitor,
        "terminal" => TaskKind::Terminal,
        _ => return None,
    })
}

fn status_of(text: &str) -> TaskStatus {
    match text {
        "running" => TaskStatus::Running,
        "completed" => TaskStatus::Completed,
        "failed" => TaskStatus::Failed,
        "killed" => TaskStatus::Killed,
        _ => TaskStatus::Interrupted,
    }
}

/// The row of `task` (its tail is not stored).
pub(super) fn to_row(task: &BackgroundTask) -> TaskRow {
    let metadata = Metadata {
        command: task.command.clone(),
        agent_type: task.agent_type.clone(),
        subagent_session_id: task.subagent_session_id.clone(),
        tool_call_id: task.tool_call_id.clone(),
        signal: task.signal,
        outcome: task.outcome,
        meaning: task.meaning.clone(),
        timeout_ms: task.timeout_ms,
        terminal_origin: task.terminal.as_ref().map(|t| t.origin),
        terminal_shared: task.terminal.as_ref().is_some_and(|t| t.shared),
    };
    TaskRow {
        id: task.task_id.clone(),
        session_id: task.session_id.clone(),
        owner_session_id: task.owner_session_id.clone(),
        workspace: task.workspace.clone(),
        kind: kind_text(task.kind).to_owned(),
        title: task.title.clone(),
        cwd: task.cwd.clone(),
        status: status_text(task.status).to_owned(),
        output_path: task.output_path.clone(),
        output_bytes: task.output_bytes,
        started_at: i64::try_from(task.started_at).unwrap_or(i64::MAX),
        ended_at: task.ended_at.map(|t| i64::try_from(t).unwrap_or(i64::MAX)),
        exit_code: task.exit_code,
        metadata: serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_owned()),
    }
}

/// The task of a stored row; `None` for a kind this build does not know.
pub(super) fn from_row(row: TaskRow) -> Option<BackgroundTask> {
    let metadata: Metadata = serde_json::from_str(&row.metadata).unwrap_or_default();
    Some(BackgroundTask {
        task_id: row.id,
        session_id: row.session_id,
        owner_session_id: row.owner_session_id,
        workspace: row.workspace,
        kind: kind_of(&row.kind)?,
        title: row.title,
        command: metadata.command,
        agent_type: metadata.agent_type,
        subagent_session_id: metadata.subagent_session_id,
        tool_call_id: metadata.tool_call_id,
        cwd: row.cwd,
        status: status_of(&row.status),
        started_at: u64::try_from(row.started_at).unwrap_or(0),
        ended_at: row.ended_at.and_then(|t| u64::try_from(t).ok()),
        exit_code: row.exit_code,
        signal: metadata.signal,
        outcome: metadata.outcome,
        meaning: metadata.meaning,
        timeout_ms: metadata.timeout_ms,
        output_path: row.output_path,
        output_bytes: row.output_bytes,
        tail: Vec::new(),
        terminal: metadata.terminal_origin.map(|origin| TerminalTask {
            terminal_id: None,
            origin,
            shared: metadata.terminal_shared,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_survives_the_row_and_ids_have_their_shape() {
        let id = new_task_id().expect("id");
        assert!(id.starts_with("bg-") && id.len() == 15, "{id}");
        assert!(id[3..].chars().all(|c| c.is_ascii_hexdigit()));
        let task = BackgroundTask {
            task_id: id,
            session_id: "child".into(),
            owner_session_id: "main".into(),
            workspace: "/w 中文".into(),
            kind: TaskKind::Monitor,
            title: "日志".into(),
            command: Some("tail -f a.log".into()),
            agent_type: None,
            subagent_session_id: None,
            tool_call_id: Some("toolu_1".into()),
            cwd: "/w 中文".into(),
            status: TaskStatus::Completed,
            started_at: 10,
            ended_at: Some(20),
            exit_code: None,
            signal: Some(15),
            outcome: Some(CommandOutcome::Success),
            meaning: Some("timed out after 300 s".into()),
            timeout_ms: Some(300_000),
            output_path: Some("~/x.log".into()),
            output_bytes: 42,
            tail: Vec::new(),
            terminal: None,
        };
        assert_eq!(from_row(to_row(&task)), Some(task.clone()));
        let terminal = BackgroundTask {
            kind: TaskKind::Terminal,
            terminal: Some(TerminalTask {
                terminal_id: None,
                origin: TerminalOrigin::User,
                shared: true,
            }),
            ..task
        };
        assert_eq!(from_row(to_row(&terminal)), Some(terminal));
    }
}
