//! `SessionActor`: one per open session.
//!
//! - Delivers the session's notifications to the client on the route `session/<id>`, as
//!   `{ "method", "params" }` with the Agent Host's `seq`, strictly in `seq` order. A gap (a
//!   notification lost on the way) holds back what follows, asks the Agent Host for the missing
//!   ones (`session/getEntries`) and delivers them first; when the Agent Host no longer has them
//!   the client gets `session/resync` and should reload the transcript.
//! - Computes the session's status (`running` while a turn runs, `error` after a failed turn or
//!   a lost Agent Host, otherwise `idle`) and unread flag (set when a turn completes), reports
//!   them to the snapshot task and, after every turn, syncs the index and stores them.
//! - Runs the client's requests as tasks: the actor itself never waits on the Agent Host, so its
//!   mailbox keeps draining while a request is in flight.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use piarc_host::{CallRecord, HostSupervisor};
use piarc_protocol::context::SessionGetContextUsage;
use piarc_protocol::history::{GetEntriesParams, SessionEntries, SessionGetEntries};
use piarc_protocol::method::RequestMethod;
use piarc_protocol::models::EffortLevel;
use piarc_protocol::session::{
    ModelRef, SessionAbort, SessionCompact, SessionCompactParams, SessionCreateParams,
    SessionEventNotification, SessionFollowUp, SessionId, SessionInputParams, SessionPrompt,
    SessionPromptParams, SessionSteer, SessionTarget,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::snapshot::{LiveSession, SessionStatus, SnapshotMsg};
use super::workspace::{SessionLink, WorkspaceHandle};
use super::{Ctx, host_error, new_session_id, path_text};
use crate::composer::UserInput;
use crate::error::{Error, Result};
use crate::events::Event;
use crate::route::RouteKey;

mod changes;
pub(crate) mod notices;
mod rewind;

pub use rewind::CheckpointOp;

/// Messages a session actor's mailbox holds at most; a full mailbox makes the workspace's event
/// consumer wait, which stops reading the Agent Host (backpressure, nothing lost).
const MAILBOX: usize = 1024;

/// A client request on an open session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// Starts a turn (the session must be idle).
    Prompt(UserInput),
    /// A steering message for the running turn (starts a turn when idle).
    Steer(UserInput),
    /// A follow-up for after the running turn (starts a turn when idle).
    FollowUp(UserInput),
    /// Compacts the conversation as a turn of its own (`/compact [focus]`; the session must be
    /// idle), with what the summary should focus on.
    Compact(Option<String>),
    /// The session's context usage (`session/getContextUsage`, T27).
    ContextUsage,
    /// Switches the session permission mode and records a transcript entry.
    SetPermissionMode(piarc_protocol::policy::PermissionMode),
    /// Reads or changes the model and effort selection.
    Model(ModelOp),
    /// Interrupts the running turn; the queue comes back.
    Abort,
    /// Edits the queue.
    Queue(QueueOp),
    /// Clears the unread flag.
    MarkRead,
    /// Changes Core's metadata of the session (title, pinned, archived).
    Prefs(piarc_store::SessionPrefsChange),
    /// Checkpoints, rewind, the Changes panel and branches (T28).
    Checkpoint(CheckpointOp),
}

/// Model-related requests on an open session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelOp {
    /// List the available models with the current model and effort.
    List,
    /// Preview the context and cost of a switch.
    Preview(ModelRef),
    /// Apply a confirmed model switch.
    Set(ModelRef, Option<EffortLevel>),
    /// Change the effort of the selected model.
    Effort(EffortLevel),
}

/// A change to a session's input queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueOp {
    /// New text of an item.
    Edit {
        /// The item.
        item_id: String,
        /// Its new text.
        text: String,
    },
    /// Removes an item.
    Delete {
        /// The item.
        item_id: String,
    },
    /// Every item's id in the new order.
    Reorder(Vec<String>),
}

pub(crate) enum SessionMsg {
    Notification(SessionEventNotification),
    Filled(Result<SessionEntries>),
    Op(Op, oneshot::Sender<Result<Value>>),
    OpDone(OpKind),
    Info(oneshot::Sender<Value>),
    Restored,
    RestoreFailed(Error),
    Uncertain(CallRecord),
    HostLost(String),
    Close(oneshot::Sender<Result<Value>>),
    /// Background-task notices wait for the session (T32).
    Notices,
    NoticesSent,
}

/// How a request affects turns: a rewind or branch switch needs the session to itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpKind {
    /// May start a turn: a prompt, steer or follow-up.
    Starting,
    /// Moves the session's files or conversation: no turn may run or start meanwhile.
    Exclusive,
    Other,
}

impl OpKind {
    fn of(op: &Op) -> Self {
        match op {
            Op::Prompt(_) | Op::Steer(_) | Op::FollowUp(_) => Self::Starting,
            Op::Checkpoint(checkpoint) if checkpoint.needs_idle() => Self::Exclusive,
            _ => Self::Other,
        }
    }
}

/// The handle the hub keeps. Cheap to clone.
#[derive(Clone)]
pub(crate) struct SessionHandle {
    pub id: String,
    pub workspace: PathBuf,
    pub cwd: PathBuf,
    tx: mpsc::Sender<SessionMsg>,
    ws: WorkspaceHandle,
    /// Shared with the workspace's link: the session exists in the Agent Host.
    in_host: Arc<AtomicBool>,
    io: crate::tool_io::ToolIo,
}

impl SessionHandle {
    /// The running Agent Host of the session's workspace, without starting one.
    pub async fn host(&self) -> Option<piarc_host::HostSupervisor> {
        self.ws.peek().await
    }

    /// Starts the actor of session `id` in `workspace`, working in `cwd`, and registers it with
    /// the workspace and the tool I/O.
    pub fn spawn(
        ctx: &Arc<Ctx>,
        workspace: &WorkspaceHandle,
        id: String,
        cwd: PathBuf,
    ) -> Result<Self> {
        // A session in a worktree has the worktree's files and the workspace's settings (T35).
        let worktree = piarc_git::worktree::containing(&workspace.path, &cwd);
        let files = worktree.clone().unwrap_or_else(|| workspace.path.clone());
        ctx.tool_io
            .open_session_in(&id, &workspace.path, &files, &cwd)
            .map_err(|e| Error::feature(&e))?;
        ctx.tool_io.session_opened(&id);
        let (tx, rx) = mpsc::channel(MAILBOX);
        let last_seq = Arc::new(AtomicU64::new(0));
        let in_host = Arc::new(AtomicBool::new(false));
        workspace.attach(
            &id,
            SessionLink {
                tx: tx.clone(),
                last_seq: Arc::clone(&last_seq),
                cwd: path_text(&cwd),
                in_host: Arc::clone(&in_host),
            },
        );
        let actor = SessionActor {
            ctx: Arc::clone(ctx),
            id: id.clone(),
            ws: workspace.clone(),
            cwd: cwd.clone(),
            tx: tx.clone(),
            last_seq,
            pending: BTreeMap::new(),
            filling: false,
            active_turn: None,
            status: SessionStatus::Idle,
            error: None,
            unread: false,
            prefs: piarc_store::SessionPrefsChange::default(),
            first_message: None,
            worktree_branch: worktree
                .as_deref()
                .and_then(piarc_git::worktree::head_branch),
            worktree,
            ops: 0,
            starting: 0,
            exclusive: false,
            busy: false,
            notifying: false,
            notify_again: false,
            cancel: ctx.cancel.child_token(),
        };
        actor.publish();
        ctx.handle.spawn(actor.run(rx));
        Ok(Self {
            id,
            workspace: workspace.path.clone(),
            cwd,
            tx,
            ws: workspace.clone(),
            in_host,
            io: ctx.tool_io.clone(),
        })
    }

    /// Opens the session as new in the Agent Host, under this id.
    pub async fn create(
        &self,
        model: Option<ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
    ) -> Result<Value> {
        self.io
            .capture_opening_memory(&self.id)
            .await
            .map_err(|e| Error::feature(&e))?;
        let supervisor = self.ws.acquire().await?;
        let (default_model, default_effort) = self.io.session_defaults(&self.workspace).await;
        let mut params = SessionCreateParams::new(path_text(&self.cwd)).with_model(model);
        params.session_id = Some(SessionId(self.id.clone()));
        if params.model.is_none() {
            params.default_model = default_model;
        }
        params.default_effort = default_effort;
        let opened = match supervisor.create_session(params).await {
            Ok(opened) => opened,
            // The create may have happened: converge on the id Core chose (R1-A3).
            Err(error) if error.outcome_unknown() => supervisor
                .resume_session(&SessionId(self.id.clone()), &path_text(&self.cwd), None)
                .await
                .map_err(host_error)?,
            Err(error) => return Err(host_error(error)),
        };
        self.in_host.store(true, Ordering::Release);
        self.notices_waiting();
        if let Some(mode) = mode {
            supervisor
                .set_permission_mode(&SessionId(self.id.clone()), mode)
                .await
                .map_err(host_error)?;
        }
        self.io
            .set_initial_mode(&self.id, mode)
            .await
            .map_err(|e| Error::feature(&e))?;
        Ok(self.opened(opened.restored_messages))
    }

    /// Reopens the session from its file.
    pub async fn resume(&self) -> Result<Value> {
        let supervisor = self.ws.acquire().await?;
        let opened = supervisor
            .resume_session(&SessionId(self.id.clone()), &path_text(&self.cwd), None)
            .await
            .map_err(host_error)?;
        self.in_host.store(true, Ordering::Release);
        self.notices_waiting();
        self.io
            .set_initial_mode(&self.id, opened.permission_mode)
            .await
            .map_err(|e| Error::feature(&e))?;
        Ok(self.opened(opened.restored_messages))
    }

    /// The session was opened by someone else (a fork): only report it.
    pub async fn adopt(
        &self,
        mode: Option<piarc_protocol::policy::PermissionMode>,
    ) -> Result<Value> {
        self.io
            .set_initial_mode(&self.id, mode)
            .await
            .map_err(|e| Error::feature(&e))?;
        self.in_host.store(true, Ordering::Release);
        self.info().await
    }

    /// Background-task notices wait: the actor sends them (T32).
    pub fn notices_waiting(&self) {
        let _ = self.tx.try_send(SessionMsg::Notices);
    }

    pub async fn info(&self) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(SessionMsg::Info(tx))
            .await
            .map_err(|_| Error::ShuttingDown)?;
        rx.await.map_err(|_| Error::ShuttingDown)
    }

    pub async fn op(&self, op: Op) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(SessionMsg::Op(op, tx))
            .await
            .map_err(|_| Error::ShuttingDown)?;
        rx.await.map_err(|_| Error::ShuttingDown)?
    }

    /// Closes the session in the Agent Host (when one runs), forgets it and stops the actor.
    pub async fn close(&self) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(SessionMsg::Close(tx))
            .await
            .map_err(|_| Error::ShuttingDown)?;
        rx.await.map_err(|_| Error::ShuttingDown)?
    }

    fn opened(&self, restored_messages: u64) -> Value {
        json!({
            "sessionId": self.id,
            "workspace": path_text(&self.workspace),
            "cwd": path_text(&self.cwd),
            "restoredMessages": restored_messages,
        })
    }
}

struct SessionActor {
    ctx: Arc<Ctx>,
    id: String,
    ws: WorkspaceHandle,
    cwd: PathBuf,
    tx: mpsc::Sender<SessionMsg>,
    /// The highest `seq` delivered to the client; everything up to it went out in order.
    last_seq: Arc<AtomicU64>,
    /// Notifications that arrived after a gap, waiting for the gap to be filled.
    pending: BTreeMap<u64, SessionEventNotification>,
    filling: bool,
    active_turn: Option<String>,
    status: SessionStatus,
    error: Option<String>,
    unread: bool,
    /// Metadata changed while open, kept until the session closes (the index may not have the
    /// session's row yet: Pi writes the file with the first reply).
    prefs: piarc_store::SessionPrefsChange,
    /// The first message this actor sent (the title until the index has the session).
    first_message: Option<String>,
    /// The worktree it works in (T35), and its branch when the session opened.
    worktree: Option<PathBuf>,
    worktree_branch: Option<String>,
    /// Requests in flight.
    ops: u32,
    /// Prompts, steers and follow-ups in flight (each may start a turn).
    starting: u32,
    /// A rewind or branch switch in flight: no turn may start until it ends (ADR-0044 rule 5).
    exclusive: bool,
    busy: bool,
    /// Background-task notices are being sent; another round follows when more arrived.
    notifying: bool,
    notify_again: bool,
    /// Cancelled when the session closes: its requests in flight stop waiting.
    cancel: CancellationToken,
}

impl SessionActor {
    async fn run(mut self, mut rx: mpsc::Receiver<SessionMsg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                SessionMsg::Notification(notification) => self.on_notification(notification).await,
                SessionMsg::Filled(entries) => self.on_filled(entries).await,
                SessionMsg::Op(op, reply) => self.start_op(op, reply),
                SessionMsg::OpDone(kind) => {
                    self.ops = self.ops.saturating_sub(1);
                    match kind {
                        OpKind::Starting => self.starting = self.starting.saturating_sub(1),
                        OpKind::Exclusive => self.exclusive = false,
                        OpKind::Other => {}
                    }
                    self.report_busy();
                }
                SessionMsg::Info(reply) => {
                    let _ = reply.send(self.info());
                }
                SessionMsg::Restored => {
                    if self.error.take().is_some() {
                        self.status = SessionStatus::Idle;
                        self.publish();
                    }
                    self.send_notices();
                }
                SessionMsg::Notices => self.send_notices(),
                SessionMsg::NoticesSent => {
                    self.notifying = false;
                    if std::mem::take(&mut self.notify_again) {
                        self.send_notices();
                    }
                }
                SessionMsg::RestoreFailed(error) => self.fail(error.to_string()),
                SessionMsg::Uncertain(call) => self.on_uncertain(&call).await,
                SessionMsg::HostLost(message) => {
                    self.active_turn = None;
                    self.fail(message);
                }
                SessionMsg::Close(reply) => {
                    self.close(reply);
                    return;
                }
            }
        }
    }

    fn info(&self) -> Value {
        json!({
            "sessionId": self.id,
            "workspace": path_text(&self.ws.path),
            "cwd": path_text(&self.cwd),
            "status": self.status,
            "activeTurnId": self.active_turn,
        })
    }

    // ---- notifications, in seq order ----

    async fn on_notification(&mut self, notification: SessionEventNotification) {
        let seq = notification.params.header.seq;
        let last = self.last_seq.load(Ordering::Acquire);
        if seq <= last {
            return; // already delivered (a replay overlapping what arrived)
        }
        if self.filling || seq > last + 1 {
            self.pending.insert(seq, notification);
            if !self.filling {
                self.start_fill(last);
            }
            return;
        }
        self.deliver(notification).await;
        self.drain_pending().await;
    }

    fn start_fill(&mut self, since: u64) {
        self.filling = true;
        tracing::warn!(target: "piarc_core::sessions", session = %self.id, since,
            "a session notification is missing; asking the Agent Host for it");
        let (ws, tx, id) = (self.ws.clone(), self.tx.clone(), self.id.clone());
        self.ctx.handle.spawn(async move {
            let entries = match ws.peek().await {
                Some(supervisor) => supervisor
                    .call::<SessionGetEntries>(GetEntriesParams {
                        session_id: SessionId(id),
                        since,
                    })
                    .await
                    .map_err(host_error),
                None => Err(Error::ShuttingDown),
            };
            let _ = tx.send(SessionMsg::Filled(entries)).await;
        });
    }

    async fn on_filled(&mut self, entries: Result<SessionEntries>) {
        self.filling = false;
        let mut complete = false;
        match entries {
            Ok(entries) => {
                complete = entries.complete;
                for entry in entries.entries {
                    let last = self.last_seq.load(Ordering::Acquire);
                    if entry.params.header.seq == last + 1 {
                        self.deliver(entry).await;
                    }
                }
            }
            Err(error) => {
                tracing::warn!(target: "piarc_core::sessions", session = %self.id,
                    "the missing notifications could not be fetched: {error}");
            }
        }
        let last = self.last_seq.load(Ordering::Acquire);
        // Still a hole before what is waiting: those notifications are gone for good.
        if let Some(first) = self
            .pending
            .keys()
            .next()
            .copied()
            .filter(|f| *f > last + 1)
        {
            if complete {
                tracing::warn!(target: "piarc_core::sessions", session = %self.id,
                    "the Agent Host's replay did not reach the waiting notifications");
            }
            self.resync(last, first).await;
        }
        self.drain_pending().await;
    }

    /// The Agent Host no longer has notifications `since + 1 .. next`: the client reloads.
    async fn resync(&mut self, since: u64, next: u64) {
        tracing::warn!(target: "piarc_core::sessions", session = %self.id, since, next,
            "session notifications were lost; the client must reload the transcript");
        self.last_seq.store(next - 1, Ordering::Release);
        let payload = json!({
            "method": "session/resync",
            "params": { "sessionId": self.id, "since": since, "next": next },
        });
        self.emit(&payload).await;
    }

    async fn drain_pending(&mut self) {
        loop {
            let last = self.last_seq.load(Ordering::Acquire);
            let Some(entry) = self.pending.first_entry() else {
                return;
            };
            if *entry.key() <= last {
                entry.remove();
            } else if *entry.key() == last + 1 {
                let next = entry.remove();
                self.deliver(next).await;
            } else {
                return;
            }
        }
    }

    async fn deliver(&mut self, notification: SessionEventNotification) {
        let seq = notification.params.header.seq;
        self.observe(&notification);
        let payload = json!({ "method": notification.method, "params": notification.params });
        self.emit(&payload).await;
        self.last_seq.store(seq, Ordering::Release);
    }

    /// Updates the session's state from a notification it delivers.
    fn observe(&mut self, notification: &SessionEventNotification) {
        let turn = notification
            .params
            .payload
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match notification.method.as_str() {
            "turn/started" => {
                if let Some(turn) = &turn {
                    self.ctx.tool_io.turn_started(&self.id, turn);
                }
                self.ctx.tool_io.tasks().turn_started(&self.id);
                self.active_turn = turn;
                self.status = SessionStatus::Running;
                self.error = None;
            }
            "item/completed" => {
                let item = notification.params.payload.get("item");
                if let Some(id) = item.and_then(|i| i.get("itemId")).and_then(Value::as_str) {
                    self.ctx.tool_io.finish_tool(&self.id, id);
                }
                if let Some(item) = item.filter(|i| i.get("type") == Some(&json!("reminder"))) {
                    self.reminders_delivered(item);
                }
                return;
            }
            "turn/completed" => {
                self.ctx.tool_io.clear_approvals(
                    &self.id,
                    turn.as_deref().map_or(
                        crate::tool_io::policy::Cleanup::Interrupted,
                        crate::tool_io::policy::Cleanup::Completed,
                    ),
                );
                self.active_turn = None;
                self.ctx.tool_io.turn_completed(&self.id);
                self.ctx.tool_io.tasks().turn_completed(&self.id);
                let failed = notification.params.payload.get("status") == Some(&json!("failed"));
                self.status = if failed {
                    SessionStatus::Error
                } else {
                    SessionStatus::Idle
                };
                self.error = failed.then(|| {
                    notification
                        .params
                        .payload
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or("the turn failed")
                        .to_owned()
                });
                self.unread = true;
                self.persist();
                // `Notification` hooks: the turn is over and the session waits for input.
                let (io, id) = (self.ctx.tool_io.clone(), self.id.clone());
                self.ctx.handle.spawn(async move {
                    io.notification_hooks(&id, "idle_prompt", "PiArc is waiting for your input")
                        .await;
                });
            }
            _ => return,
        }
        self.publish();
        self.report_busy();
    }

    async fn emit(&self, payload: &Value) {
        let route = match RouteKey::session(&self.id) {
            Ok(route) => route,
            Err(error) => {
                tracing::error!(target: "piarc_core::sessions", session = %self.id, "no route: {error}");
                return;
            }
        };
        match Event::from_json(route, payload) {
            // Waits while the client is behind: the backpressure reaches the Agent Host.
            Ok(event) => {
                let _ = self.ctx.events.send(event).await;
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::sessions", session = %self.id, "cannot encode an event: {error}");
            }
        }
    }

    // ---- requests ----

    fn start_op(&mut self, op: Op, reply: oneshot::Sender<Result<Value>>) {
        match op {
            Op::MarkRead => {
                self.unread = false;
                self.publish();
                self.persist();
                let _ = reply.send(Ok(Value::Null));
                return;
            }
            Op::Prefs(change) => {
                merge_prefs(&mut self.prefs, change);
                self.publish();
                self.persist();
                let _ = reply.send(Ok(Value::Null));
                return;
            }
            _ => {}
        }
        let kind = OpKind::of(&op);
        let refusal = match kind {
            OpKind::Exclusive if self.active_turn.is_some() || self.starting > 0 => {
                Some("Stop the running turn before rewinding or switching branches")
            }
            OpKind::Exclusive | OpKind::Starting if self.exclusive => {
                Some("Wait for the rewind or branch switch to finish")
            }
            _ => None,
        };
        if let Some(message) = refusal {
            let _ = reply.send(Err(Error::feature(&piarc_protocol::ErrorObject::new(
                piarc_protocol::ErrorKind::SessionBusy,
                message,
                true,
            ))));
            return;
        }
        match kind {
            OpKind::Starting => self.starting += 1,
            OpKind::Exclusive => self.exclusive = true,
            OpKind::Other => {}
        }
        if let Op::Prompt(input) | Op::Steer(input) | Op::FollowUp(input) = &op
            && self.first_message.is_none()
            && !input.text.trim().is_empty()
        {
            self.first_message = Some(
                input
                    .text
                    .chars()
                    .take(piarc_store::pi_session::FIRST_MESSAGE_CHARS)
                    .collect(),
            );
            self.publish();
        }
        self.ops += 1;
        self.report_busy();
        let request = Request {
            id: SessionId(self.id.clone()),
            ws: self.ws.clone(),
            tool_io: self.ctx.tool_io.clone(),
            cancel: self.cancel.clone(),
            events: self.ctx.events.clone(),
        };
        let tx = self.tx.clone();
        self.ctx.handle.spawn(async move {
            let result = tokio::select! {
                result = request.run(op) => result,
                () = request.cancel.cancelled() => Err(Error::ShuttingDown),
            };
            let _ = reply.send(result);
            let _ = tx.send(SessionMsg::OpDone(kind)).await;
        });
    }

    async fn on_uncertain(&mut self, call: &CallRecord) {
        let payload = json!({
            "method": "session/uncertain",
            "params": {
                "sessionId": self.id,
                "method": call.method,
                "turnId": call.turn_id,
            },
        });
        self.emit(&payload).await;
        if call.turn_id.is_some() && call.turn_id == self.active_turn {
            self.active_turn = None;
            self.fail("the Agent Host restarted during the turn; its outcome is unknown".into());
        }
    }

    fn fail(&mut self, message: String) {
        self.status = SessionStatus::Error;
        self.error = Some(message);
        self.publish();
        self.report_busy();
    }

    fn close(&mut self, reply: oneshot::Sender<Result<Value>>) {
        self.cancel.cancel();
        self.ws.detach(&self.id);
        self.ctx.tool_io.tasks().session_closed(&self.id);
        self.ctx.tool_io.close_session(&self.id);
        self.ctx
            .snapshots
            .send(SnapshotMsg::SessionClosed(self.id.clone()));
        let (ws, id) = (self.ws.clone(), SessionId(self.id.clone()));
        self.ctx.handle.spawn(async move {
            let result = match ws.peek().await {
                Some(supervisor) => {
                    supervisor
                        .close_session(&id)
                        .await
                        .map(to_value)
                        .or_else(|error| {
                            if error.kind() == piarc_protocol::ErrorKind::SessionNotFound {
                                Ok(json!({ "sessionId": id.0 }))
                            } else {
                                Err(host_error(error))
                            }
                        })
                }
                // No Agent Host runs: the session is open nowhere.
                None => Ok(json!({ "sessionId": id.0 })),
            };
            let _ = reply.send(result);
        });
    }

    // ---- state reports ----

    fn publish(&self) {
        self.ctx.snapshots.send(SnapshotMsg::Session(LiveSession {
            id: self.id.clone(),
            workspace: path_text(&self.ws.path),
            cwd: path_text(&self.cwd),
            status: self.status,
            unread: self.unread,
            error: self.error.clone(),
            prefs: self.prefs.clone(),
            first_message: self.first_message.clone(),
            worktree: self
                .worktree
                .as_deref()
                .map(|tree| (path_text(tree), self.worktree_branch.clone())),
        }));
    }

    fn report_busy(&mut self) {
        let busy = self.ops > 0 || self.active_turn.is_some();
        if busy != self.busy {
            self.busy = busy;
            self.ws.busy(&self.id, busy);
        }
    }

    /// Syncs the index with the session file and stores Core's state of the session.
    fn persist(&self) {
        let storage = self.ctx.storage.clone();
        let snapshots = self.ctx.snapshots.clone();
        let (id, workspace) = (self.id.clone(), path_text(&self.ws.path));
        let (status, unread, prefs) = (self.status, self.unread, self.prefs.clone());
        let worktree = self.worktree.clone();
        self.ctx.handle.spawn(async move {
            if let Err(error) = storage.sync_sessions().await {
                tracing::warn!(target: "piarc_core::sessions", session = %id, "syncing the index failed: {error}");
            }
            let stored = storage
                .run(move |store| {
                    store.set_session_state(&id, &workspace, status.as_str(), unread)?;
                    if let Some(tree) = &worktree {
                        // The branch as checked out now (the agent may have switched it).
                        let branch = piarc_git::worktree::head_branch(tree);
                        store.set_session_worktree(&id, &path_text(tree), branch.as_deref())?;
                    }
                    store.set_session_prefs(&id, &prefs)
                })
                .await;
            if let Ok(Err(error)) = stored {
                tracing::warn!(target: "piarc_core::sessions", "storing the session state failed: {error}");
            }
            snapshots.send(SnapshotMsg::Reload);
        });
    }
}

/// One request on its way to the Agent Host.
struct Request {
    id: SessionId,
    ws: WorkspaceHandle,
    tool_io: crate::tool_io::ToolIo,
    cancel: CancellationToken,
    events: crate::events::EventSender,
}

impl Request {
    async fn run(&self, op: Op) -> Result<Value> {
        // Files only need Core; the conversation steps acquire the Agent Host themselves.
        if let Op::Checkpoint(op) = op {
            return self.checkpoint(op).await;
        }
        // A `/name` input becomes its command's text (T37); `UserPromptSubmit` sees what the
        // user typed, before the Agent Host does.
        let mut op = op;
        let mut expansion = None;
        let hook_context = match &mut op {
            Op::Prompt(input) | Op::Steer(input) | Op::FollowUp(input) => {
                expansion = self
                    .tool_io
                    .expand_command(&self.id.0, &input.text)
                    .await
                    .map_err(|e| Error::feature(&e))?;
                let context = self.prompt_hooks(&input.text).await;
                if let Some(expanded) = &expansion {
                    input.text.clone_from(&expanded.text);
                    // A blocked input starts no turn: its grant must not reach the next one.
                    if let (Err(_), Some(grant)) = (&context, expanded.grant) {
                        self.tool_io.revoke_turn_grant(&self.id.0, grant);
                    }
                }
                context?
            }
            _ => None,
        };
        let command = expansion.as_ref().map(|e| e.command.clone());
        let grant = expansion.as_ref().and_then(|e| e.grant);
        let result = self.send(op, hook_context, command).await;
        // A command's `allowed-tools` belong to the turn its input starts or joins: none when
        // the input failed or waits in the queue.
        if let Some(grant) = grant
            && result.as_ref().map_or(true, |value| {
                value.get("disposition").and_then(Value::as_str) == Some("queued")
            })
        {
            self.tool_io.revoke_turn_grant(&self.id.0, grant);
        }
        result
    }

    async fn send(
        &self,
        op: Op,
        hook_context: Option<String>,
        command: Option<piarc_protocol::skills::PromptCommand>,
    ) -> Result<Value> {
        let supervisor = self.ws.acquire().await?;
        // A turn starting now takes every finished task's notice with it (ADR-0049 rule 5).
        if matches!(op, Op::Prompt(_) | Op::Steer(_) | Op::FollowUp(_)) {
            notices::deliver(&supervisor, &self.id.0, &self.tool_io).await;
        }
        match op {
            Op::Prompt(input) => {
                let request_id = match input.request_id {
                    Some(key) => key,
                    None => new_session_id()?,
                };
                let params = SessionPromptParams {
                    session_id: self.id.clone(),
                    request_id: request_id.clone(),
                    text: input.text,
                    mentions: input.mentions,
                    attachments: input.attachments,
                    hook_context,
                    command,
                };
                self.call::<SessionPrompt>(&supervisor, Some(&request_id), params)
                    .await
            }
            Op::Steer(input) => {
                self.input::<SessionSteer>(&supervisor, input, hook_context, command)
                    .await
            }
            Op::FollowUp(input) => {
                self.input::<SessionFollowUp>(&supervisor, input, hook_context, command)
                    .await
            }
            Op::Compact(instructions) => {
                let request_id = new_session_id()?;
                let params = SessionCompactParams {
                    session_id: self.id.clone(),
                    request_id: request_id.clone(),
                    instructions: instructions.filter(|text| !text.trim().is_empty()),
                };
                self.call::<SessionCompact>(&supervisor, Some(&request_id), params)
                    .await
            }
            Op::ContextUsage => {
                let params = SessionTarget {
                    session_id: self.id.clone(),
                };
                self.call::<SessionGetContextUsage>(&supervisor, None, params)
                    .await
            }
            Op::SetPermissionMode(mode) => self.set_mode(&supervisor, mode).await,
            Op::Model(change) => self.model(&supervisor, change).await,
            Op::Abort => {
                let target = SessionTarget {
                    session_id: self.id.clone(),
                };
                let stopped = self.call::<SessionAbort>(&supervisor, None, target).await;
                // Pi sets the turn signal before its preflight returns. Releasing the ledger
                // first would race the host marking these tool items as interrupted.
                self.tool_io
                    .clear_approvals(&self.id.0, crate::tool_io::policy::Cleanup::Interrupted);
                // The turn is over: commands it left running stop too.
                self.tool_io.cancel_running(&self.id.0);
                stopped
            }
            Op::Queue(change) => self.queue(&supervisor, change).await,
            // Answered by the actor itself, or above.
            Op::MarkRead | Op::Prefs(_) | Op::Checkpoint(_) => Ok(Value::Null),
        }
    }

    /// Runs `UserPromptSubmit` hooks; a block refuses the input with the hook's reason.
    async fn prompt_hooks(&self, text: &str) -> Result<Option<String>> {
        self.tool_io
            .user_prompt_submit(&self.id.0, text, &self.cancel)
            .await
            .map_err(|reason| {
                let mut error = piarc_protocol::ErrorObject::new(
                    piarc_protocol::ErrorKind::PermissionDenied,
                    format!("A UserPromptSubmit hook blocked this input: {reason}"),
                    false,
                );
                error.data.details = Some(json!({ "reason": "hookBlocked", "hookReason": reason }));
                Error::feature(&error)
            })
    }

    async fn input<M>(
        &self,
        supervisor: &HostSupervisor,
        input: UserInput,
        hook_context: Option<String>,
        command: Option<piarc_protocol::skills::PromptCommand>,
    ) -> Result<Value>
    where
        M: RequestMethod<Params = SessionInputParams>,
    {
        let request_id = match input.request_id {
            Some(key) => key,
            None => new_session_id()?,
        };
        let params = SessionInputParams {
            session_id: self.id.clone(),
            request_id: request_id.clone(),
            text: input.text,
            mentions: input.mentions,
            attachments: input.attachments,
            hook_context,
            command,
        };
        self.call::<M>(supervisor, Some(&request_id), params).await
    }

    async fn call<M: RequestMethod>(
        &self,
        supervisor: &HostSupervisor,
        key: Option<&str>,
        params: M::Params,
    ) -> Result<Value> {
        supervisor
            .session_call::<M>(&self.id, key, params)
            .await
            .map(to_value)
            .map_err(host_error)
    }
}

/// Later changes win field by field.
fn merge_prefs(
    into: &mut piarc_store::SessionPrefsChange,
    change: piarc_store::SessionPrefsChange,
) {
    if change.custom_title.is_some() {
        into.custom_title = change.custom_title;
    }
    if change.pinned.is_some() {
        into.pinned = change.pinned;
    }
    if change.archived.is_some() {
        into.archived = change.archived;
    }
}

fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}
