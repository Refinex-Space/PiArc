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
use piarc_protocol::history::{GetEntriesParams, SessionEntries, SessionGetEntries};
use piarc_protocol::method::RequestMethod;
use piarc_protocol::models::{self, EffortLevel};
use piarc_protocol::queue::{
    QueueDelete, QueueDeleteParams, QueueEdit, QueueEditParams, QueueReorder, QueueReorderParams,
};
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
    /// Compacts the conversation as a turn of its own (`/compact`; the session must be idle).
    Compact,
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
    OpDone,
    Info(oneshot::Sender<Value>),
    Restored,
    RestoreFailed(Error),
    Uncertain(CallRecord),
    HostLost(String),
    Close(oneshot::Sender<Result<Value>>),
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
    /// Starts the actor of session `id` in `workspace`, working in `cwd`, and registers it with
    /// the workspace and the tool I/O.
    pub fn spawn(
        ctx: &Arc<Ctx>,
        workspace: &WorkspaceHandle,
        id: String,
        cwd: PathBuf,
    ) -> Result<Self> {
        ctx.tool_io
            .open_session(&id, &workspace.path, &cwd)
            .map_err(|e| Error::feature(&e))?;
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
            ops: 0,
            busy: false,
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
        let mut params = SessionCreateParams::new(path_text(&self.cwd)).with_model(model);
        params.session_id = Some(SessionId(self.id.clone()));
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
    /// Requests in flight.
    ops: u32,
    busy: bool,
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
                SessionMsg::OpDone => {
                    self.ops = self.ops.saturating_sub(1);
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
                self.active_turn = turn;
                self.status = SessionStatus::Running;
                self.error = None;
            }
            "item/completed" => {
                if let Some(id) = notification
                    .params
                    .payload
                    .get("item")
                    .and_then(|i| i.get("itemId"))
                    .and_then(Value::as_str)
                {
                    self.ctx.tool_io.finish_tool(&self.id, id);
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
        };
        let tx = self.tx.clone();
        self.ctx.handle.spawn(async move {
            let result = tokio::select! {
                result = request.run(op) => result,
                () = request.cancel.cancelled() => Err(Error::ShuttingDown),
            };
            let _ = reply.send(result);
            let _ = tx.send(SessionMsg::OpDone).await;
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
        self.ctx.handle.spawn(async move {
            if let Err(error) = storage.sync_sessions().await {
                tracing::warn!(target: "piarc_core::sessions", session = %id, "syncing the index failed: {error}");
            }
            let stored = storage
                .run(move |store| {
                    store.set_session_state(&id, &workspace, status.as_str(), unread)?;
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
}

impl Request {
    async fn run(&self, op: Op) -> Result<Value> {
        let supervisor = self.ws.acquire().await?;
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
                };
                self.call::<SessionPrompt>(&supervisor, Some(&request_id), params)
                    .await
            }
            Op::Steer(input) => self.input::<SessionSteer>(&supervisor, input).await,
            Op::FollowUp(input) => self.input::<SessionFollowUp>(&supervisor, input).await,
            Op::Compact => {
                let request_id = new_session_id()?;
                let params = SessionCompactParams {
                    session_id: self.id.clone(),
                    request_id: request_id.clone(),
                };
                self.call::<SessionCompact>(&supervisor, Some(&request_id), params)
                    .await
            }
            Op::SetPermissionMode(mode) => {
                self.tool_io
                    .check_mode(&self.id.0, mode)
                    .await
                    .map_err(|e| Error::feature(&e))?;
                supervisor
                    .set_permission_mode(&self.id, mode)
                    .await
                    .map_err(host_error)?;
                self.tool_io
                    .changed_mode(&self.id.0, mode)
                    .await
                    .map_err(|e| Error::feature(&e))?;
                Ok(Value::Null)
            }
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
            // Answered by the actor itself.
            Op::MarkRead | Op::Prefs(_) => Ok(Value::Null),
        }
    }

    async fn model(&self, supervisor: &HostSupervisor, change: ModelOp) -> Result<Value> {
        match change {
            ModelOp::List => {
                self.call::<models::ModelsList>(
                    supervisor,
                    None,
                    models::ModelsListParams {
                        session_id: Some(self.id.clone()),
                    },
                )
                .await
            }
            ModelOp::Preview(model) => {
                self.call::<models::SessionPreviewModelSwitch>(
                    supervisor,
                    None,
                    models::ModelSwitchParams {
                        session_id: self.id.clone(),
                        model,
                    },
                )
                .await
            }
            ModelOp::Set(model, effort) => {
                self.call::<models::SessionSetModel>(
                    supervisor,
                    None,
                    models::SetModelParams {
                        session_id: self.id.clone(),
                        model,
                        effort,
                    },
                )
                .await
            }
            ModelOp::Effort(effort) => {
                self.call::<models::SessionSetEffort>(
                    supervisor,
                    None,
                    models::SetEffortParams {
                        session_id: self.id.clone(),
                        effort,
                    },
                )
                .await
            }
        }
    }

    async fn input<M>(&self, supervisor: &HostSupervisor, input: UserInput) -> Result<Value>
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
        };
        self.call::<M>(supervisor, Some(&request_id), params).await
    }

    async fn queue(&self, supervisor: &HostSupervisor, change: QueueOp) -> Result<Value> {
        let session_id = self.id.clone();
        match change {
            QueueOp::Edit { item_id, text } => {
                let params = QueueEditParams {
                    session_id,
                    item_id,
                    text,
                };
                self.call::<QueueEdit>(supervisor, None, params).await
            }
            QueueOp::Delete { item_id } => {
                let params = QueueDeleteParams {
                    session_id,
                    item_id,
                };
                self.call::<QueueDelete>(supervisor, None, params).await
            }
            QueueOp::Reorder(item_ids) => {
                let params = QueueReorderParams {
                    session_id,
                    item_ids,
                };
                self.call::<QueueReorder>(supervisor, None, params).await
            }
        }
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
