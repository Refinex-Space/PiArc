//! Core's task manager (architecture sections 6.11 and 7.3, T32, ADR-0049): background
//! commands, background subagents and Monitor commands in one model.
//!
//! - **Registry.** One [`TaskManager`] per Core, held by the tool I/O. A task is registered
//!   when a command starts in the background (or its timeout moves it there), when a Monitor
//!   starts, or when the Agent Host reports a background subagent (`subagent/start`). Every
//!   change is written to `background_tasks` and published as the `core/tasks` snapshot
//!   (`{ revision, tasks }`, at most every [`TaskLimits::snapshot_interval`]).
//! - **Processes.** The command itself runs in the tool I/O (`tool_io/tasks.rs`) with
//!   `piarc-exec`; the manager holds its cancellation token and output log and learns how it
//!   ended ([`TaskManager::ended`]). Stopping ([`TaskManager::stop`]) cancels the token, which
//!   ends the whole process tree (process group / Job Object), and waits for the end.
//! - **Notices.** A command that ends leaves a `backgroundTask` notice for the session that
//!   started it; a Monitor's new lines leave a `monitorOutput` notice (`feed.rs`). Notices wait
//!   here until the session layer reports them delivered (the reminder item, or `session/remind`
//!   answering `delivered`); the session layer sends them through the [`TaskOutlet`] whenever
//!   one is waiting, when the session opens or its Agent Host restarts, and before each prompt.
//! - **Monitor pace.** While a turn runs, new lines go out at once (each batch replaces the
//!   queued one). When the session is idle, the notice wakes it, at most once per
//!   [`TaskLimits::monitor_wake_interval`] on the injected clock.
//! - **End of PiArc.** [`TaskManager::shutdown`] stops every running task and records it
//!   `interrupted`; [`TaskManager::start`] marks rows left `running` by a crash the same way.

mod entry;
mod feed;
mod limits;
mod monitor;
mod record;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use piarc_exec::TaskLog;
use piarc_ports::BoxFuture;
use piarc_protocol::context::ReminderType;
use piarc_protocol::subagent::SubagentStatus;
use piarc_protocol::tasks::{BackgroundTask, TaskKind, TaskOutputChunk, TaskStatus, TasksSnapshot};
use piarc_protocol::{ErrorKind, ErrorObject};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

pub(crate) use feed::MonitorEnd;
use feed::MonitorFeed;
pub use limits::{TaskLimits, TasksConfig};

use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::storage::Storage;

/// How long [`TaskManager::stop`] waits for a stopped task to end before reporting it anyway.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// What the session layer does for the task manager.
pub(crate) trait TaskOutlet: Send + Sync {
    /// Notices wait for session `session_id`: send them if it is open.
    fn notices_waiting(&self, session_id: &str);
    /// Stops subagent `child` of main session `owner` (`subagent/stop`).
    fn stop_subagent(
        &self,
        owner: &str,
        child: &str,
    ) -> BoxFuture<'static, Result<(), ErrorObject>>;
}

/// A reminder waiting for a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Notice {
    /// Replaces a queued reminder with the same key.
    pub key: String,
    /// Identifies this reminder; delivery is reported by it.
    pub source: String,
    pub kind: ReminderType,
    pub text: String,
    /// Wake the session when it is idle.
    pub wake: bool,
}

/// Why a task is being stopped; decides its final status and whether the model is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopBy {
    /// `KillShell`: the model knows from the tool result.
    Model,
    /// The stop button.
    User,
    /// Its session is archived or deleted, or (a Monitor) closed.
    Session,
    /// A Monitor's timeout.
    Timeout,
    /// PiArc quits.
    Shutdown,
}

/// A command or Monitor about to become a task.
#[derive(Debug, Clone)]
pub(crate) struct NewTask {
    pub session_id: String,
    pub owner_session_id: String,
    pub workspace: String,
    pub kind: TaskKind,
    pub title: String,
    pub command: String,
    pub cwd: String,
    pub tool_call_id: Option<String>,
    /// `<data dir>/sessions/<owner>/tasks/`.
    pub output_dir: PathBuf,
    /// A Monitor's timeout.
    pub timeout: Option<Duration>,
}

/// The id and output file of a task being set up.
#[derive(Debug, Clone)]
pub(crate) struct Reserved {
    pub task_id: String,
    pub file: PathBuf,
    /// The file as the model is told it.
    pub output_path: String,
}

/// How a command task ended.
#[derive(Debug, Clone, Default)]
pub(crate) struct Ended {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// The meaning of the exit code says it succeeded.
    pub success: bool,
    pub meaning: Option<String>,
    /// Why it could not be run or watched to its end.
    pub error: Option<String>,
}

/// A background subagent the Agent Host reported.
#[derive(Debug, Clone)]
pub(crate) struct NewSubagent {
    pub child_session_id: String,
    pub session_id: String,
    pub owner_session_id: String,
    pub workspace: String,
    pub agent_type: String,
    pub title: String,
    pub cwd: String,
    pub tool_call_id: String,
}

struct Entry {
    task: BackgroundTask,
    log: Option<Arc<Mutex<TaskLog>>>,
    file: Option<PathBuf>,
    cancel: Option<CancellationToken>,
    done: watch::Sender<bool>,
    feed: Option<MonitorFeed>,
    stop_by: Option<StopBy>,
}

#[derive(Default)]
struct State {
    tasks: HashMap<String, Entry>,
    /// Waiting notices: session → key → notice.
    notices: HashMap<String, BTreeMap<String, Notice>>,
    /// Sessions with a turn running.
    running: HashSet<String>,
    revision: u64,
}

struct Inner {
    config: TasksConfig,
    state: Mutex<State>,
    storage: OnceLock<Storage>,
    outlet: OnceLock<Arc<dyn TaskOutlet>>,
    publish: Notify,
}

/// The task manager; see the module documentation. Cheap to clone.
#[derive(Clone)]
pub struct TaskManager {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TaskManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskManager").finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_found(task_id: &str) -> ErrorObject {
    let mut error = ErrorObject::new(
        ErrorKind::NotFound,
        format!("no background task {task_id} belongs to this session"),
        false,
    );
    error.data.details = Some(serde_json::json!({ "taskId": task_id }));
    error
}

impl TaskManager {
    /// A manager without a database or snapshots (tests and tool I/O without Core's state).
    #[must_use]
    pub fn new(config: TasksConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                state: Mutex::default(),
                storage: OnceLock::new(),
                outlet: OnceLock::new(),
                publish: Notify::new(),
            }),
        }
    }

    /// The thresholds.
    #[must_use]
    pub fn limits(&self) -> &TaskLimits {
        &self.inner.config.limits
    }

    /// The clock of the timers.
    #[must_use]
    pub fn clock(&self) -> &Arc<dyn piarc_ports::Clock> {
        &self.inner.config.clock
    }

    /// Connects the database and the client: marks rows a crash left `running` as
    /// `interrupted`, loads the recent tasks and publishes `core/tasks` snapshots until
    /// `cancel` fires.
    pub(crate) fn start(&self, storage: Storage, events: EventSender, cancel: CancellationToken) {
        let limit = u32::try_from(self.limits().snapshot_tasks).unwrap_or(u32::MAX);
        let now = i64::try_from(record::now_ms()).unwrap_or(i64::MAX);
        let loaded = storage.with(|store| {
            let interrupted = store.interrupt_running_tasks(now)?;
            store.recent_tasks(limit).map(|rows| (interrupted, rows))
        });
        match loaded {
            Ok(Ok((interrupted, rows))) => {
                if interrupted > 0 {
                    tracing::info!(target: "piarc_core::tasks", interrupted,
                        "background tasks of the last run were interrupted");
                }
                let data = storage.dirs().data().to_owned();
                let mut state = lock(&self.inner.state);
                for task in rows.into_iter().filter_map(record::from_row) {
                    let (done, _) = watch::channel(true);
                    let file = task
                        .output_path
                        .as_ref()
                        .map(|_| task_file(&data, &task.owner_session_id, &task.task_id));
                    state
                        .tasks
                        .insert(task.task_id.clone(), Entry::ended(task, file, done));
                }
            }
            Ok(Err(error)) => {
                tracing::warn!(target: "piarc_core::tasks", %error, "cannot load background tasks");
            }
            Err(error) => {
                tracing::warn!(target: "piarc_core::tasks", %error, "cannot load background tasks");
            }
        }
        let _ = self.inner.storage.set(storage);
        let manager = self.clone();
        tokio::spawn(async move { manager.publish_loop(events, cancel).await });
        self.inner.publish.notify_one();
    }

    /// Who sends notices and stops subagents (the session layer).
    pub(crate) fn set_outlet(&self, outlet: Arc<dyn TaskOutlet>) {
        let _ = self.inner.outlet.set(outlet);
    }

    async fn publish_loop(self, events: EventSender, cancel: CancellationToken) {
        loop {
            tokio::select! {
                () = self.inner.publish.notified() => {}
                () = cancel.cancelled() => return,
            }
            let snapshot = self.snapshot();
            if let Ok(event) = Event::from_json(RouteKey::tasks(), &snapshot)
                && events.send(event).await.is_err()
            {
                return;
            }
            tokio::select! {
                () = tokio::time::sleep(self.limits().snapshot_interval) => {}
                () = cancel.cancelled() => return,
            }
        }
    }

    /// The `core/tasks` snapshot now.
    #[must_use]
    pub fn snapshot(&self) -> TasksSnapshot {
        let limits = *self.limits();
        let mut state = lock(&self.inner.state);
        state.revision += 1;
        let mut tasks: Vec<BackgroundTask> = state
            .tasks
            .values()
            .map(|entry| entry.view(limits.snapshot_tail_lines, limits.snapshot_line_chars))
            .collect();
        tasks.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then(b.task_id.cmp(&a.task_id))
        });
        tasks.truncate(limits.snapshot_tasks);
        TasksSnapshot {
            revision: state.revision,
            tasks,
        }
    }

    fn changed(&self, task: Option<BackgroundTask>) {
        self.inner.publish.notify_one();
        let (Some(task), Some(storage)) = (task, self.inner.storage.get()) else {
            return;
        };
        let row = record::to_row(&task);
        let storage = storage.clone();
        tokio::spawn(async move {
            match storage.run(move |store| store.put_task(&row)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(target: "piarc_core::tasks", %error, "cannot store a background task");
                }
                Err(error) => {
                    tracing::warn!(target: "piarc_core::tasks", %error, "cannot store a background task");
                }
            }
        });
    }

    // ---- commands and Monitors ----

    /// An id and output file for a new task under `output_dir`.
    ///
    /// # Errors
    ///
    /// No randomness for the id.
    pub(crate) fn reserve(&self, output_dir: &Path) -> Result<Reserved, ErrorObject> {
        let task_id = record::new_task_id()?;
        let file = output_dir.join(format!("{task_id}.log"));
        Ok(Reserved {
            output_path: piarc_fs::model_path(&file),
            task_id,
            file,
        })
    }

    /// Registers a running command or Monitor whose output goes to `log`; `cancel` stops it.
    pub(crate) fn register(
        &self,
        reserved: &Reserved,
        new: NewTask,
        log: Arc<Mutex<TaskLog>>,
        cancel: CancellationToken,
    ) {
        let task = BackgroundTask {
            task_id: reserved.task_id.clone(),
            session_id: new.session_id,
            owner_session_id: new.owner_session_id,
            workspace: new.workspace,
            kind: new.kind,
            title: new.title.clone(),
            command: Some(new.command),
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
            timeout_ms: new
                .timeout
                .map(|t| u64::try_from(t.as_millis()).unwrap_or(u64::MAX)),
            output_path: Some(reserved.output_path.clone()),
            output_bytes: lock(&log).bytes(),
            tail: Vec::new(),
            terminal: None,
        };
        let (done, _) = watch::channel(false);
        let feed = (new.kind == TaskKind::Monitor).then(|| MonitorFeed::new(new.title));
        let entry = Entry {
            task: task.clone(),
            log: Some(log),
            file: Some(reserved.file.clone()),
            cancel: Some(cancel),
            done,
            feed,
            stop_by: None,
        };
        lock(&self.inner.state)
            .tasks
            .insert(task.task_id.clone(), entry);
        if let Some(timeout) = new.timeout {
            self.arm_timeout(&task.task_id, timeout);
        }
        self.changed(Some(task));
    }

    fn arm_timeout(&self, task_id: &str, timeout: Duration) {
        let Some(mut done) = self.done_receiver(task_id) else {
            return;
        };
        let sleep = self.clock().sleep(timeout);
        let (manager, task_id) = (self.clone(), task_id.to_owned());
        tokio::spawn(async move {
            let ended = async move {
                let _ = done.wait_for(|ended| *ended).await;
            };
            tokio::select! {
                () = sleep => {
                    let _ = manager.stop(&task_id, StopBy::Timeout).await;
                }
                () = ended => {}
            }
        });
    }

    fn done_receiver(&self, task_id: &str) -> Option<watch::Receiver<bool>> {
        lock(&self.inner.state)
            .tasks
            .get(task_id)
            .map(|entry| entry.done.subscribe())
    }

    /// Sends the snapshot again (a client subscribed or reloaded).
    pub fn republish(&self) {
        self.inner.publish.notify_one();
    }

    /// The output of a running task grew (the snapshot shows its size and last lines).
    pub(crate) fn output_grew(&self) {
        self.inner.publish.notify_one();
    }

    /// The command of task `task_id` ended.
    pub(crate) fn ended(&self, task_id: &str, ended: Ended) {
        let (task, notice, end) = {
            let mut state = lock(&self.inner.state);
            let Some(entry) = state.tasks.get_mut(task_id) else {
                return;
            };
            if entry.task.status != TaskStatus::Running {
                return;
            }
            entry.finish(&ended);
            let _ = entry.done.send(true);
            entry.cancel = None;
            let notice = match (entry.task.kind, entry.stop_by) {
                (TaskKind::Command, None | Some(StopBy::User)) => {
                    Some(entry.completion(self.limits()))
                }
                _ => None,
            };
            let end = (entry.task.kind == TaskKind::Monitor).then(|| {
                match (entry.stop_by, &ended.error) {
                    (Some(StopBy::Timeout), _) => {
                        MonitorEnd::TimedOut(entry.task.timeout_ms.unwrap_or(0) / 1000)
                    }
                    (Some(_), _) => MonitorEnd::Stopped,
                    (None, Some(error)) => MonitorEnd::Exited(error.clone()),
                    (None, None) => MonitorEnd::Exited(exit_words(ended.exit_code, ended.signal)),
                }
            });
            (entry.task.clone(), notice, end)
        };
        if let Some(end) = end {
            self.monitor_ended(task_id, end);
        }
        if let Some(notice) = notice {
            self.add_notice(&task.session_id, notice);
        }
        self.changed(Some(task));
    }

    /// Stops task `task_id` (its whole process tree, or the subagent) and waits for it to
    /// end; returns the task, whether this call stopped it, and the end of its output.
    ///
    /// # Errors
    ///
    /// `notFound` when there is no such task.
    pub(crate) async fn stop(
        &self,
        task_id: &str,
        by: StopBy,
    ) -> Result<(BackgroundTask, bool, String), ErrorObject> {
        let (cancel, mut done, subagent) = {
            let mut state = lock(&self.inner.state);
            let entry = state
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| not_found(task_id))?;
            if entry.task.status != TaskStatus::Running {
                return Ok((entry.task.clone(), false, self.tail_text(entry)));
            }
            entry.stop_by.get_or_insert(by);
            let subagent = (entry.task.kind == TaskKind::Subagent)
                .then(|| entry.task.subagent_session_id.clone())
                .flatten()
                .map(|child| (entry.task.owner_session_id.clone(), child));
            (entry.cancel.clone(), entry.done.subscribe(), subagent)
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        if let Some((owner, child)) = subagent
            && let Some(outlet) = self.inner.outlet.get()
            && let Err(error) = outlet.stop_subagent(&owner, &child).await
        {
            tracing::warn!(target: "piarc_core::tasks", error = %error.message, task = task_id,
                "cannot stop the subagent");
        }
        let ended = async move {
            let _ = done.wait_for(|ended| *ended).await;
        };
        if tokio::time::timeout(STOP_WAIT, ended).await.is_err() {
            // The process or the Agent Host did not report the end: record it anyway.
            self.ended(
                task_id,
                Ended {
                    error: Some("it did not report its end after being stopped".into()),
                    ..Ended::default()
                },
            );
        }
        let state = lock(&self.inner.state);
        let entry = state.tasks.get(task_id).ok_or_else(|| not_found(task_id))?;
        Ok((entry.task.clone(), true, self.tail_text(entry)))
    }

    fn tail_text(&self, entry: &Entry) -> String {
        let tail = entry
            .log
            .as_ref()
            .map(|log| lock(log).tail(self.limits().notice_tail_lines))
            .unwrap_or_default();
        feed::preview(
            &tail,
            self.limits().notice_tail_lines,
            self.limits().notice_tail_chars,
        )
    }

    /// `exec/background/kill`: stops a task of `session_id` or of one of its subagents.
    ///
    /// # Errors
    ///
    /// `notFound` for an unknown task and for another session's.
    pub(crate) async fn kill_for(
        &self,
        session_id: &str,
        task_id: &str,
    ) -> Result<(BackgroundTask, bool, String), ErrorObject> {
        self.check_owner(session_id, task_id)?;
        self.stop(task_id, StopBy::Model).await
    }

    fn check_owner(&self, session_id: &str, task_id: &str) -> Result<(), ErrorObject> {
        let state = lock(&self.inner.state);
        match state.tasks.get(task_id) {
            Some(entry)
                if entry.task.session_id == session_id
                    || entry.task.owner_session_id == session_id =>
            {
                Ok(())
            }
            _ => Err(not_found(task_id)),
        }
    }

    /// `exec/background/list`: the tasks of `session_id` and of its subagents, newest first.
    #[must_use]
    pub(crate) fn list_for(&self, session_id: &str) -> Vec<BackgroundTask> {
        let limits = *self.limits();
        let state = lock(&self.inner.state);
        let mut tasks: Vec<BackgroundTask> = state
            .tasks
            .values()
            .filter(|e| e.task.session_id == session_id || e.task.owner_session_id == session_id)
            .map(|e| e.view(limits.snapshot_tail_lines, limits.snapshot_line_chars))
            .collect();
        tasks.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then(b.task_id.cmp(&a.task_id))
        });
        tasks
    }

    /// Reads part of a task's output (`exec/background/read` checks the session first,
    /// `readTaskOutput` does not).
    ///
    /// # Errors
    ///
    /// `notFound` for an unknown task or one without an output file; `ioError` when the file
    /// cannot be read.
    pub async fn read(
        &self,
        session_id: Option<&str>,
        task_id: &str,
        offset: u64,
        length: Option<u64>,
    ) -> Result<TaskOutputChunk, ErrorObject> {
        if let Some(session_id) = session_id {
            self.check_owner(session_id, task_id)?;
        }
        let (file, status) = {
            let state = lock(&self.inner.state);
            let entry = state.tasks.get(task_id).ok_or_else(|| not_found(task_id))?;
            (entry.file.clone(), entry.task.status)
        };
        let Some(file) = file else {
            return Err(not_found(task_id));
        };
        let max = length
            .map_or(self.limits().read_chunk, |l| {
                usize::try_from(l).unwrap_or(usize::MAX)
            })
            .min(self.limits().read_chunk);
        let task = task_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let chunk = piarc_exec::task_log::read_chunk(&file, offset, max)
                .map_err(|e| piarc_fs::Error::io(&file, e).to_error_object())?;
            Ok(TaskOutputChunk {
                task_id: task,
                offset: offset.min(chunk.total_bytes),
                text: chunk.text,
                next_offset: chunk.next_offset,
                total_bytes: chunk.total_bytes,
                status,
            })
        })
        .await
        .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))?
    }

    // ---- subagents ----

    /// The Agent Host started a background subagent.
    pub(crate) fn register_subagent(&self, new: NewSubagent) -> Result<(), ErrorObject> {
        let task_id = record::new_task_id()?;
        let task = BackgroundTask {
            task_id: task_id.clone(),
            session_id: new.session_id,
            owner_session_id: new.owner_session_id,
            workspace: new.workspace,
            kind: TaskKind::Subagent,
            title: new.title,
            command: None,
            agent_type: Some(new.agent_type),
            subagent_session_id: Some(new.child_session_id),
            tool_call_id: Some(new.tool_call_id),
            cwd: new.cwd,
            status: TaskStatus::Running,
            started_at: record::now_ms(),
            ended_at: None,
            exit_code: None,
            signal: None,
            outcome: None,
            meaning: None,
            timeout_ms: None,
            output_path: None,
            output_bytes: 0,
            tail: Vec::new(),
            terminal: None,
        };
        let (done, _) = watch::channel(false);
        lock(&self.inner.state)
            .tasks
            .insert(task_id, Entry::running_subagent(task.clone(), done));
        self.changed(Some(task));
        Ok(())
    }

    /// Background subagent `child` ended (`subagent/finish`), or its Agent Host connection
    /// ended (`None`).
    pub(crate) fn subagent_ended(&self, child: &str, status: Option<SubagentStatus>) {
        let task = {
            let mut state = lock(&self.inner.state);
            let Some(entry) = state.tasks.values_mut().find(|e| {
                e.task.status == TaskStatus::Running
                    && e.task.subagent_session_id.as_deref() == Some(child)
            }) else {
                return;
            };
            entry.task.status = match (status, entry.stop_by) {
                (_, Some(StopBy::Shutdown)) | (None, None) => TaskStatus::Interrupted,
                (_, Some(_)) => TaskStatus::Killed,
                (Some(SubagentStatus::Completed | SubagentStatus::Partial), None) => {
                    TaskStatus::Completed
                }
                (Some(SubagentStatus::Failed), None) => TaskStatus::Failed,
                (Some(SubagentStatus::Interrupted | SubagentStatus::Running), None) => {
                    TaskStatus::Interrupted
                }
            };
            entry.task.ended_at = Some(record::now_ms());
            let _ = entry.done.send(true);
            entry.task.clone()
        };
        self.changed(Some(task));
    }

    // ---- sessions ----

    /// A turn of `session_id` started.
    pub(crate) fn turn_started(&self, session_id: &str) {
        lock(&self.inner.state)
            .running
            .insert(session_id.to_owned());
    }

    /// A turn of `session_id` ended: Monitor lines it did not deliver wake the session.
    pub(crate) fn turn_completed(&self, session_id: &str) {
        let monitors: Vec<String> = {
            let mut state = lock(&self.inner.state);
            state.running.remove(session_id);
            state
                .tasks
                .values()
                .filter(|e| {
                    e.task.session_id == session_id
                        && e.feed.as_ref().is_some_and(MonitorFeed::has_news)
                })
                .map(|e| e.task.task_id.clone())
                .collect()
        };
        for task_id in monitors {
            self.refresh_monitor(&task_id);
        }
    }

    /// Session `session_id` closed: its Monitors end.
    pub(crate) fn session_closed(&self, session_id: &str) {
        lock(&self.inner.state).running.remove(session_id);
        self.stop_matching(|t| t.session_id == session_id && t.kind == TaskKind::Monitor);
        self.drop_notices(session_id);
    }

    /// Main session `owner` is archived or deleted: all its tasks stop.
    pub(crate) async fn session_removed(&self, owner: &str, deleted: bool) {
        let ids = self.running_matching(|t| t.owner_session_id == owner || t.session_id == owner);
        for id in &ids {
            let _ = self.stop(id, StopBy::Session).await;
        }
        self.drop_notices(owner);
        if deleted {
            lock(&self.inner.state)
                .tasks
                .retain(|_, e| e.task.owner_session_id != owner);
            if let Some(storage) = self.inner.storage.get() {
                let owner = owner.to_owned();
                let _ = storage
                    .run(move |store| store.delete_session_tasks(&owner))
                    .await;
            }
            self.inner.publish.notify_one();
        }
    }

    fn running_matching(&self, keep: impl Fn(&BackgroundTask) -> bool) -> Vec<String> {
        lock(&self.inner.state)
            .tasks
            .values()
            .filter(|e| e.task.status == TaskStatus::Running && keep(&e.task))
            .map(|e| e.task.task_id.clone())
            .collect()
    }

    fn stop_matching(&self, keep: impl Fn(&BackgroundTask) -> bool) {
        for id in self.running_matching(keep) {
            let manager = self.clone();
            tokio::spawn(async move {
                let _ = manager.stop(&id, StopBy::Session).await;
            });
        }
    }

    /// PiArc quits: stops every running task and records it `interrupted`.
    pub async fn shutdown(&self) {
        let ids = self.running_matching(|_| true);
        let stops: Vec<_> = ids
            .iter()
            .map(|id| {
                let (manager, id) = (self.clone(), id.clone());
                tokio::spawn(async move { manager.stop(&id, StopBy::Shutdown).await })
            })
            .collect();
        for stop in stops {
            let _ = stop.await;
        }
        // The last writes must land before the database closes.
        let rows: Vec<piarc_store::TaskRow> = {
            let state = lock(&self.inner.state);
            ids.iter()
                .filter_map(|id| state.tasks.get(id))
                .map(|e| record::to_row(&e.task))
                .collect()
        };
        if let Some(storage) = self.inner.storage.get()
            && !rows.is_empty()
        {
            let _ = storage
                .run(move |store| rows.iter().try_for_each(|row| store.put_task(row)))
                .await;
        }
    }

    // ---- notices ----

    fn add_notice(&self, session_id: &str, notice: Notice) {
        lock(&self.inner.state)
            .notices
            .entry(session_id.to_owned())
            .or_default()
            .insert(notice.key.clone(), notice);
        if let Some(outlet) = self.inner.outlet.get() {
            outlet.notices_waiting(session_id);
        }
    }

    fn drop_notices(&self, session_id: &str) {
        lock(&self.inner.state).notices.remove(session_id);
    }

    /// The notices waiting for `session_id`.
    #[must_use]
    pub(crate) fn pending(&self, session_id: &str) -> Vec<Notice> {
        lock(&self.inner.state)
            .notices
            .get(session_id)
            .map(|n| n.values().cloned().collect())
            .unwrap_or_default()
    }

    /// The reminder `source` reached the model of `session_id` (a `reminder` item, or
    /// `session/remind` answering `delivered`).
    pub(crate) fn delivered(&self, session_id: &str, kind: ReminderType, source: &str) {
        let refresh = {
            let mut guard = lock(&self.inner.state);
            let state = &mut *guard;
            if let Some(notices) = state.notices.get_mut(session_id) {
                notices.retain(|_, n| n.source != source);
            }
            match (kind, feed::parse_source(source)) {
                (ReminderType::MonitorOutput, Some((task_id, upto, end))) => {
                    let task_id = task_id.to_owned();
                    if let Some(feed) = state.tasks.get_mut(&task_id).and_then(|e| e.feed.as_mut())
                    {
                        feed.acknowledge(source, upto, end);
                    }
                    Some(task_id)
                }
                _ => None,
            }
        };
        if let Some(task_id) = refresh {
            self.refresh_monitor(&task_id);
        }
    }
}

/// Where a task's output file is: `<data dir>/sessions/<owner>/tasks/<task id>.log`.
pub(crate) fn task_file(data_dir: &Path, owner: &str, task_id: &str) -> PathBuf {
    data_dir
        .join("sessions")
        .join(owner)
        .join("tasks")
        .join(format!("{task_id}.log"))
}

fn exit_words(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        (None, None) => "no exit status".to_owned(),
    }
}

#[cfg(test)]
mod tests;
