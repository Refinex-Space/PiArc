//! Terminal tasks (T33, ADR-0050): every terminal of a session is a task of kind `terminal`.
//! Its output file is the screen as text, which `crate::terminal` rewrites; the task manager
//! decides what the model may see (a user's terminal only while shared) and carries the
//! notices.

use std::path::PathBuf;
use std::sync::Arc;

use piarc_ports::BoxFuture;
use piarc_protocol::ErrorObject;
use piarc_protocol::context::ReminderType;
use piarc_protocol::tasks::{BackgroundTask, TaskKind, TaskStatus, TerminalOrigin, TerminalTask};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{Entry, Notice, Reserved, State, TaskManager, lock, record};

/// Rewrites a terminal task's screen file (`crate::terminal` implements it).
pub(crate) trait TerminalViews: Send + Sync {
    /// Brings the screen file of task `task_id` up to date, if it is a live terminal.
    fn refresh(&self, task_id: &str) -> BoxFuture<'static, ()>;
}

/// A terminal about to become a task.
#[derive(Debug, Clone)]
pub(crate) struct NewTerminal {
    pub session_id: String,
    pub owner_session_id: String,
    pub workspace: String,
    pub title: String,
    /// The model's command (`Bash` with `terminal`).
    pub command: Option<String>,
    pub cwd: String,
    pub tool_call_id: Option<String>,
    pub origin: TerminalOrigin,
    pub terminal_id: u32,
    /// `<data dir>/sessions/<owner>/tasks/`.
    pub output_dir: PathBuf,
}

/// Whether the model may see `task`: everything but a user's terminal that is not shared.
pub(super) fn visible(task: &BackgroundTask) -> bool {
    task.terminal
        .as_ref()
        .is_none_or(|t| t.origin == TerminalOrigin::Agent || t.shared)
}

/// Whether task `task_id` is a user's terminal.
pub(super) fn users(state: &State, task_id: &str) -> bool {
    state
        .tasks
        .get(task_id)
        .and_then(|e| e.task.terminal.as_ref())
        .is_some_and(|t| t.origin == TerminalOrigin::User)
}

impl TaskManager {
    /// Who rewrites terminal screen files.
    pub(crate) fn set_terminal_views(&self, views: Arc<dyn TerminalViews>) {
        let _ = self.inner.views.set(views);
    }

    pub(super) async fn refresh_view(&self, task_id: &str) {
        let terminal = lock(&self.inner.state)
            .tasks
            .get(task_id)
            .is_some_and(|e| e.task.kind == TaskKind::Terminal);
        if terminal && let Some(views) = self.inner.views.get() {
            views.refresh(task_id).await;
        }
    }

    /// Registers a running terminal; `cancel` closes it (KillShell, the stop button, the
    /// session being archived or deleted, PiArc quitting).
    ///
    /// # Errors
    ///
    /// No randomness for the id.
    pub(crate) fn register_terminal(
        &self,
        new: NewTerminal,
        cancel: CancellationToken,
    ) -> Result<Reserved, ErrorObject> {
        let reserved = self.reserve(&new.output_dir)?;
        let shared = new.origin == TerminalOrigin::Agent;
        let task = BackgroundTask {
            task_id: reserved.task_id.clone(),
            session_id: new.session_id,
            owner_session_id: new.owner_session_id,
            workspace: new.workspace,
            kind: TaskKind::Terminal,
            title: new.title,
            command: new.command,
            agent_type: None,
            subagent_session_id: None,
            tool_call_id: new.tool_call_id,
            cwd: new.cwd,
            status: TaskStatus::Running,
            started_at: record::now_ms(),
            ended_at: None,
            exit_code: None,
            signal: None,
            outcome: None,
            meaning: None,
            timeout_ms: None,
            output_path: Some(reserved.output_path.clone()),
            output_bytes: 0,
            tail: Vec::new(),
            terminal: Some(TerminalTask {
                terminal_id: Some(new.terminal_id),
                origin: new.origin,
                shared,
            }),
        };
        let (done, _) = watch::channel(false);
        let entry = Entry {
            task: task.clone(),
            log: None,
            file: Some(reserved.file.clone()),
            cancel: Some(cancel),
            done,
            feed: None,
            stop_by: None,
            tree: None,
        };
        lock(&self.inner.state)
            .tasks
            .insert(task.task_id.clone(), entry);
        self.changed(Some(task));
        Ok(reserved)
    }

    /// The screen file of task `task_id` was rewritten: `bytes` long, ending in `tail`.
    pub(crate) fn terminal_view_written(&self, task_id: &str, bytes: u64, tail: Vec<String>) {
        let mut state = lock(&self.inner.state);
        if let Some(entry) = state.tasks.get_mut(task_id) {
            entry.task.output_bytes = bytes;
            entry.task.tail = tail;
        }
        drop(state);
        self.output_grew();
    }

    /// Shares a user's terminal with the model, or stops sharing it; returns the task when
    /// the sharing changed.
    pub(crate) fn set_terminal_shared(
        &self,
        task_id: &str,
        shared: bool,
    ) -> Option<BackgroundTask> {
        let task = {
            let mut state = lock(&self.inner.state);
            let entry = state.tasks.get_mut(task_id)?;
            let terminal = entry.task.terminal.as_mut()?;
            if terminal.origin != TerminalOrigin::User || terminal.shared == shared {
                return None;
            }
            terminal.shared = shared;
            entry.task.clone()
        };
        self.changed(Some(task.clone()));
        Some(task)
    }

    /// The terminal of task `task_id` closed: its handle is gone.
    pub(crate) fn terminal_detached(&self, task_id: &str) {
        let task = {
            let mut state = lock(&self.inner.state);
            let Some(entry) = state.tasks.get_mut(task_id) else {
                return;
            };
            if let Some(terminal) = entry.task.terminal.as_mut() {
                terminal.terminal_id = None;
            }
            entry.task.clone()
        };
        self.changed(Some(task));
    }

    /// Leaves `text` for session `session_id` as a `backgroundTask` reminder from `source`
    /// (a terminal command that finished, a terminal the user shared).
    pub(crate) fn terminal_notice(
        &self,
        session_id: &str,
        key: String,
        source: String,
        text: String,
    ) {
        self.add_notice(
            session_id,
            Notice {
                key,
                source,
                kind: ReminderType::BackgroundTask,
                text,
                wake: false,
            },
        );
    }

    /// The model's command in terminal task `task_id` finished with `exit_code`: `text` waits
    /// for session `session_id` as a `backgroundTask` reminder from `source`, then the task
    /// shows the exit code and runs on (the terminal stays open). The notice is stored first,
    /// so whoever sees the exit code finds the notice waiting.
    pub(crate) fn terminal_command_finished(
        &self,
        task_id: &str,
        session_id: &str,
        source: String,
        text: String,
        exit_code: Option<i32>,
    ) {
        self.terminal_notice(session_id, format!("terminal:{task_id}"), source, text);
        let task = {
            let mut state = lock(&self.inner.state);
            let Some(entry) = state.tasks.get_mut(task_id) else {
                return;
            };
            if entry.task.status != TaskStatus::Running {
                return;
            }
            entry.task.exit_code = exit_code;
            entry.task.clone()
        };
        self.changed(Some(task));
    }

    /// Why task `task_id` is being stopped, while it is.
    #[must_use]
    pub(crate) fn stop_reason(&self, task_id: &str) -> Option<super::StopBy> {
        lock(&self.inner.state)
            .tasks
            .get(task_id)
            .and_then(|e| e.stop_by)
    }
}
