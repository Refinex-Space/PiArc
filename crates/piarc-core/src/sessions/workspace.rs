//! `WorkspaceActor`: one per open workspace. Owns the Agent Host supervisor, warms it up on
//! open, stops it when every session stayed idle past the threshold and starts it again on
//! demand, reopening the open sessions (architecture section 3.3, ADR-0010 rule 4).
//!
//! The actor never waits on the Agent Host: starts, restores and shutdowns run as tasks that
//! report back through its mailbox. The supervisor's events are drained by a consumer task:
//! session notifications go straight to the session actors (their mailboxes are bounded, which
//! is the backpressure on the Agent Host when the client stops reading), lifecycle events to
//! this actor.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use piarc_host::{HostEvent, HostEvents, HostSupervisor};
use piarc_protocol::ErrorKind;
use piarc_protocol::session::{SessionForkParams, SessionId};
use tokio::sync::{mpsc, oneshot};

use super::inbound::{SessionSet, WorkspaceInbound};
use super::session::SessionMsg;
use super::snapshot::{HostState, SnapshotMsg, WorkspaceView};
use super::{Ctx, host_error, lock, path_text};
use crate::error::{Error, Result};
use crate::storage::now_ms;
use crate::workspace_settings::WorkspaceSettings;

/// How the workspace actor reaches an open session.
#[derive(Clone)]
pub(crate) struct SessionLink {
    pub tx: mpsc::Sender<SessionMsg>,
    /// The highest `seq` the session delivered in order: a reopened session continues after it.
    pub last_seq: Arc<AtomicU64>,
    pub cwd: String,
}

type Links = Arc<Mutex<HashMap<String, SessionLink>>>;

enum WsMsg {
    Acquire(oneshot::Sender<Result<HostSupervisor>>),
    Peek(oneshot::Sender<Option<HostSupervisor>>),
    View(oneshot::Sender<WorkspaceView>),
    Busy {
        session: String,
        busy: bool,
    },
    Host {
        generation: u64,
        event: HostEvent,
    },
    Restored {
        generation: u64,
    },
    IdleTimeout {
        generation: u64,
    },
    /// The trust decision of a main checkout changed (answered once handled).
    TrustChanged {
        checkout: PathBuf,
        done: oneshot::Sender<()>,
    },
    Close(oneshot::Sender<()>),
}

/// The handle every other part holds. Cheap to clone.
#[derive(Clone)]
pub(crate) struct WorkspaceHandle {
    pub path: PathBuf,
    tx: mpsc::UnboundedSender<WsMsg>,
    links: Links,
    members: SessionSet,
}

impl WorkspaceHandle {
    /// Records the workspace, starts its actor, its settings watcher and its Agent Host.
    pub async fn open(ctx: &Arc<Ctx>, path: PathBuf) -> Result<Self> {
        if ctx.config.launch.is_none() {
            return Err(Error::Internal {
                reason: "Core has no Agent Host to start (no launch configuration)".into(),
            });
        }
        let record = record_workspace(ctx, &path).await?;
        let settings = match WorkspaceSettings::open(
            ctx.storage.dirs(),
            path.clone(),
            ctx.trust.clone(),
            ctx.events.clone(),
        )
        .await
        {
            Ok(settings) => Some(settings),
            Err(error) => {
                tracing::warn!(target: "piarc_core::sessions", workspace = %path.display(),
                    "the workspace settings are not watched: {error}");
                None
            }
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = Self {
            path: path.clone(),
            tx: tx.clone(),
            links: Arc::default(),
            members: Arc::default(),
        };
        let actor = WorkspaceActor {
            ctx: Arc::clone(ctx),
            handle: handle.clone(),
            tx,
            view: WorkspaceView {
                path: path_text(&path),
                display_name: record.display_name,
                main_checkout: record.main_checkout,
                open: true,
                host: HostState::Starting,
                last_opened_at: record.last_opened_at,
            },
            host: Host::Stopped,
            generation: 0,
            waiting: Vec::new(),
            busy: HashSet::new(),
            idle_generation: 0,
            connected_epoch: 0,
            trust_restart_epoch: None,
            settings,
        };
        ctx.handle.spawn(actor.run(rx));
        Ok(handle)
    }

    /// The running supervisor, starting the Agent Host (and reopening the open sessions) when
    /// it is stopped; waits until it is ready.
    pub async fn acquire(&self) -> Result<HostSupervisor> {
        let (tx, rx) = oneshot::channel();
        self.send(WsMsg::Acquire(tx))?;
        rx.await.map_err(|_| Error::ShuttingDown)?
    }

    /// The supervisor if the Agent Host runs; never starts it.
    pub async fn peek(&self) -> Option<HostSupervisor> {
        let (tx, rx) = oneshot::channel();
        self.send(WsMsg::Peek(tx)).ok()?;
        rx.await.ok().flatten()
    }

    pub async fn view(&self) -> WorkspaceView {
        let (tx, rx) = oneshot::channel();
        if self.send(WsMsg::View(tx)).is_err() {
            return closed_view(&self.path);
        }
        rx.await.unwrap_or_else(|_| closed_view(&self.path))
    }

    /// Tells the actor the trust of `checkout` changed; resolves once it acted on it.
    pub async fn trust_changed(&self, checkout: PathBuf) {
        let (done, rx) = oneshot::channel();
        if self.send(WsMsg::TrustChanged { checkout, done }).is_ok() {
            // A closed actor has no Agent Host to restart.
            let _ = rx.await;
        }
    }

    /// The session's activity changed: the Agent Host stays while any session is busy.
    pub fn busy(&self, session: &str, busy: bool) {
        // A closed workspace no longer counts activity.
        let _ = self.send(WsMsg::Busy {
            session: session.to_owned(),
            busy,
        });
    }

    /// Routes the session's notifications to it and lets its tool I/O through.
    pub fn attach(&self, id: &str, link: SessionLink) {
        lock(&self.links).insert(id.to_owned(), link);
        lock(&self.members).insert(id.to_owned());
    }

    pub fn detach(&self, id: &str) {
        lock(&self.links).remove(id);
        lock(&self.members).remove(id);
        self.busy(id, false);
    }

    /// Copies session `id` (working in `cwd`) into a new session; returns the new id.
    pub async fn fork(
        &self,
        id: &str,
        cwd: &std::path::Path,
        entry_id: Option<String>,
    ) -> Result<String> {
        let supervisor = self.acquire().await?;
        let opened = supervisor
            .fork_session(SessionForkParams {
                session_id: SessionId(id.to_owned()),
                cwd: path_text(cwd),
                entry_id,
            })
            .await
            .map_err(host_error)?;
        Ok(opened.session_id.0)
    }

    /// Stops the Agent Host and the actor.
    pub async fn close(&self) {
        let (tx, rx) = oneshot::channel();
        if self.send(WsMsg::Close(tx)).is_ok() {
            // The actor answers once the Agent Host is gone.
            let _ = rx.await;
        }
    }

    fn send(&self, msg: WsMsg) -> Result<()> {
        self.tx.send(msg).map_err(|_| Error::ShuttingDown)
    }
}

fn closed_view(path: &std::path::Path) -> WorkspaceView {
    WorkspaceView {
        path: path_text(path),
        display_name: path_text(path),
        main_checkout: path_text(path),
        open: false,
        host: HostState::Closed,
        last_opened_at: 0,
    }
}

enum Host {
    /// Not started yet, or stopped after the idle threshold.
    Stopped,
    /// Starting, or restoring the open sessions on a fresh process.
    Starting(HostSupervisor),
    Ready(HostSupervisor),
    /// Restarting after a crash (the supervisor reopens its sessions itself).
    Restarting(HostSupervisor),
    Failed(Error),
}

struct WorkspaceActor {
    ctx: Arc<Ctx>,
    handle: WorkspaceHandle,
    tx: mpsc::UnboundedSender<WsMsg>,
    view: WorkspaceView,
    host: Host,
    /// Increments with every Agent Host start: events of an older supervisor are ignored.
    generation: u64,
    waiting: Vec<oneshot::Sender<Result<HostSupervisor>>>,
    busy: HashSet<String>,
    /// Increments whenever the idle timer is armed or disarmed.
    idle_generation: u64,
    /// Kept for its watcher; dropped with the actor.
    #[expect(
        dead_code,
        reason = "held for its file watcher, which stops when it is dropped"
    )]
    settings: Option<WorkspaceSettings>,
    /// The epoch of the last `Connected` of the current supervisor (0 before the first).
    connected_epoch: u64,
    /// A trust restart was asked for: the host is ready only once a process of this epoch or
    /// later connected (the process before it is about to restart).
    trust_restart_epoch: Option<u64>,
}

impl WorkspaceActor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<WsMsg>) {
        // Warm-up: the Agent Host starts with the workspace, not with the first prompt.
        self.start_host();
        while let Some(msg) = rx.recv().await {
            match msg {
                WsMsg::Acquire(reply) => self.acquire(reply),
                WsMsg::Peek(reply) => {
                    let _ = reply.send(self.running());
                }
                WsMsg::View(reply) => {
                    let _ = reply.send(self.view.clone());
                }
                WsMsg::Busy { session, busy } => {
                    if busy {
                        self.busy.insert(session);
                    } else {
                        self.busy.remove(&session);
                    }
                    self.arm_idle();
                }
                WsMsg::Host { generation, event } if generation == self.generation => {
                    self.on_host_event(event);
                }
                WsMsg::Host { .. } => {}
                WsMsg::Restored { generation } if generation == self.generation => {
                    // Sessions reopened on a process that a trust change restarts next: the
                    // restarted process is the one to wait for.
                    if self.trust_restart_epoch.is_none() {
                        self.ready();
                    }
                }
                WsMsg::Restored { .. } => {}
                WsMsg::IdleTimeout { generation } => self.on_idle(generation),
                WsMsg::TrustChanged { checkout, done } => {
                    if checkout.as_path() == std::path::Path::new(&self.view.main_checkout) {
                        self.restart_for_trust();
                    }
                    let _ = done.send(());
                }
                WsMsg::Close(done) => {
                    self.stop_host().await;
                    self.publish(HostState::Closed, false);
                    let _ = done.send(());
                    return;
                }
            }
        }
    }

    fn running(&self) -> Option<HostSupervisor> {
        match &self.host {
            Host::Ready(supervisor) | Host::Restarting(supervisor) => Some(supervisor.clone()),
            Host::Starting(_) | Host::Stopped | Host::Failed(_) => None,
        }
    }

    fn acquire(&mut self, reply: oneshot::Sender<Result<HostSupervisor>>) {
        match &self.host {
            Host::Ready(supervisor) => {
                let _ = reply.send(Ok(supervisor.clone()));
                self.arm_idle();
            }
            Host::Starting(_) | Host::Restarting(_) => self.waiting.push(reply),
            Host::Failed(error) => {
                let _ = reply.send(Err(error.clone()));
            }
            Host::Stopped => {
                self.waiting.push(reply);
                self.start_host();
            }
        }
    }

    fn start_host(&mut self) {
        self.generation += 1;
        // A new process asks for the trust itself when it starts.
        self.connected_epoch = 0;
        self.trust_restart_epoch = None;
        self.idle_generation += 1;
        let Some(launch) = self.ctx.config.launch.clone() else {
            return;
        };
        let inbound = Arc::new(WorkspaceInbound {
            trust: self.ctx.trust.clone(),
            secrets: self.ctx.secrets.clone(),
            tool_io: self.ctx.tool_io.clone(),
            sessions: Arc::clone(&self.handle.members),
        });
        let tune = self.ctx.config.tune_host.clone();
        let started = {
            let _guard = self.ctx.handle.enter();
            crate::agent_host::start_for(
                &launch,
                self.handle.path.clone(),
                self.ctx.storage.dirs().data().to_owned(),
                inbound,
                &|config| {
                    if let Some(tune) = &tune {
                        tune(config);
                    }
                },
            )
        };
        match started {
            Ok((supervisor, events)) => {
                self.ctx.handle.spawn(consume(
                    events,
                    self.generation,
                    self.handle.clone(),
                    self.tx.clone(),
                ));
                self.host = Host::Starting(supervisor);
                self.publish(HostState::Starting, true);
            }
            Err(error) => self.fail(error),
        }
    }

    /// The project's trust changed: the Agent Host restarts so the new process loads (or no
    /// longer loads) project-level resources. Requests from now on wait for the new process,
    /// so a session created right after the decision starts on it (T18).
    fn restart_for_trust(&mut self) {
        let supervisor = match &self.host {
            Host::Ready(supervisor) | Host::Starting(supervisor) => supervisor.clone(),
            // A process that starts later asks for the trust itself.
            Host::Restarting(_) | Host::Stopped | Host::Failed(_) => return,
        };
        tracing::info!(target: "piarc_core::trust", workspace = %self.handle.path.display(),
            "project trust changed; restarting the workspace's Agent Host");
        self.host = Host::Restarting(supervisor.clone());
        // A process still starting will connect as epoch 1 and then restart: wait for epoch 2.
        self.trust_restart_epoch = Some(self.connected_epoch.max(1) + 1);
        self.publish(HostState::Restarting, true);
        self.ctx
            .handle
            .spawn(async move { supervisor.restart().await });
    }

    fn on_host_event(&mut self, event: HostEvent) {
        match event {
            HostEvent::Connected { epoch, .. } => {
                let supervisor = match &self.host {
                    Host::Starting(s) | Host::Restarting(s) | Host::Ready(s) => s.clone(),
                    Host::Stopped | Host::Failed(_) => return,
                };
                self.connected_epoch = epoch;
                // The process a pending trust restart replaces: requests keep waiting.
                let replaced = self
                    .trust_restart_epoch
                    .is_some_and(|wanted| epoch < wanted);
                if !replaced {
                    self.trust_restart_epoch = None;
                }
                if epoch == 1 {
                    // A fresh process: reopen the sessions that are open in Core (the
                    // supervisor carries them over if a trust change restarts it).
                    self.host = if replaced {
                        Host::Restarting(supervisor.clone())
                    } else {
                        Host::Starting(supervisor.clone())
                    };
                    self.restore(supervisor);
                } else if replaced {
                    self.host = Host::Restarting(supervisor);
                } else {
                    // A restart: the supervisor reopens its sessions itself.
                    self.host = Host::Ready(supervisor);
                    self.ready();
                }
            }
            HostEvent::Restarting { .. } | HostEvent::Exited { .. } => {
                if let Host::Ready(supervisor) | Host::Starting(supervisor) = &self.host {
                    self.host = Host::Restarting(supervisor.clone());
                    self.publish(HostState::Restarting, true);
                }
            }
            HostEvent::GaveUp { .. } | HostEvent::HandshakeRejected { .. } => {
                self.fail(Error::Feature {
                    kind: ErrorKind::HostUnavailable,
                    retryable: false,
                    message: "the Agent Host of this workspace could not be kept running".into(),
                    details: None,
                });
            }
            HostEvent::Stopped if !matches!(self.host, Host::Stopped | Host::Failed(_)) => {
                self.fail(Error::Feature {
                    kind: ErrorKind::HostUnavailable,
                    retryable: false,
                    message: "the Agent Host of this workspace stopped".into(),
                    details: None,
                });
            }
            _ => {}
        }
    }

    /// Reopens every open session on a fresh process, then reports ready.
    fn restore(&self, supervisor: HostSupervisor) {
        let links: Vec<(String, SessionLink)> = lock(&self.handle.links)
            .iter()
            .map(|(id, link)| (id.clone(), link.clone()))
            .collect();
        let generation = self.generation;
        let tx = self.tx.clone();
        self.ctx.handle.spawn(async move {
            for (id, link) in links {
                let last_seq = link.last_seq.load(Ordering::Acquire);
                let outcome = supervisor
                    .resume_session(&SessionId(id), &link.cwd, Some(last_seq))
                    .await;
                let msg = match outcome {
                    Ok(_) => SessionMsg::Restored,
                    Err(error) => SessionMsg::RestoreFailed(host_error(error)),
                };
                // A session that closed meanwhile needs nothing.
                let _ = link.tx.send(msg).await;
            }
            let _ = tx.send(WsMsg::Restored { generation });
        });
    }

    fn ready(&mut self) {
        let supervisor = match &self.host {
            Host::Starting(s) | Host::Ready(s) | Host::Restarting(s) => s.clone(),
            Host::Stopped | Host::Failed(_) => return,
        };
        self.host = Host::Ready(supervisor.clone());
        for waiter in self.waiting.drain(..) {
            let _ = waiter.send(Ok(supervisor.clone()));
        }
        self.publish(HostState::Ready, true);
        self.arm_idle();
    }

    fn fail(&mut self, error: Error) {
        tracing::error!(target: "piarc_core::sessions", workspace = %self.handle.path.display(),
            "the Agent Host is unavailable: {error}");
        for waiter in self.waiting.drain(..) {
            let _ = waiter.send(Err(error.clone()));
        }
        let links: Vec<SessionLink> = lock(&self.handle.links).values().cloned().collect();
        for link in links {
            let message = error.to_string();
            self.ctx.handle.spawn(async move {
                let _ = link.tx.send(SessionMsg::HostLost(message)).await;
            });
        }
        self.host = Host::Failed(error);
        self.publish(HostState::Unavailable, true);
    }

    /// Arms the idle timer when nothing keeps the Agent Host busy; any activity disarms it.
    fn arm_idle(&mut self) {
        self.idle_generation += 1;
        if !matches!(self.host, Host::Ready(_)) || !self.busy.is_empty() || !self.waiting.is_empty()
        {
            return;
        }
        let generation = self.idle_generation;
        let sleep = self.ctx.config.clock.sleep(self.ctx.config.idle_timeout);
        let tx = self.tx.clone();
        self.ctx.handle.spawn(async move {
            sleep.await;
            let _ = tx.send(WsMsg::IdleTimeout { generation });
        });
    }

    fn on_idle(&mut self, generation: u64) {
        if generation != self.idle_generation || !self.busy.is_empty() {
            return;
        }
        let Host::Ready(supervisor) = std::mem::replace(&mut self.host, Host::Stopped) else {
            return;
        };
        tracing::info!(target: "piarc_core::sessions", workspace = %self.handle.path.display(),
            "every session stayed idle; stopping the Agent Host until it is needed");
        self.ctx
            .handle
            .spawn(async move { supervisor.shutdown().await });
        self.publish(HostState::Reclaimed, true);
    }

    async fn stop_host(&mut self) {
        match std::mem::replace(&mut self.host, Host::Stopped) {
            Host::Starting(s) | Host::Ready(s) | Host::Restarting(s) => s.shutdown().await,
            Host::Stopped | Host::Failed(_) => {}
        }
        for waiter in self.waiting.drain(..) {
            let _ = waiter.send(Err(Error::ShuttingDown));
        }
    }

    fn publish(&mut self, host: HostState, open: bool) {
        self.view.host = host;
        self.view.open = open;
        self.ctx
            .snapshots
            .send(SnapshotMsg::Workspace(self.view.clone()));
    }
}

/// Drains one supervisor's events: notifications and restore outcomes to the sessions,
/// lifecycle events to the workspace actor. Never waits on anything but a session's mailbox.
async fn consume(
    mut events: HostEvents,
    generation: u64,
    handle: WorkspaceHandle,
    tx: mpsc::UnboundedSender<WsMsg>,
) {
    while let Some(event) = events.recv().await {
        let routed = match &event {
            HostEvent::Notification { notification, .. } => Some((
                notification.params.header.session_id.0.clone(),
                SessionMsg::Notification(notification.clone()),
            )),
            HostEvent::SessionRestored { session_id, .. } => {
                Some((session_id.clone(), SessionMsg::Restored))
            }
            HostEvent::SessionRestoreFailed {
                session_id, error, ..
            } => Some((
                session_id.clone(),
                SessionMsg::RestoreFailed(Error::feature(error)),
            )),
            HostEvent::Uncertain { calls, .. } => {
                for call in calls {
                    if let Some(session) = &call.session_id {
                        route(&handle, session, SessionMsg::Uncertain(call.clone())).await;
                    }
                }
                None
            }
            _ => None,
        };
        match routed {
            Some((session, msg)) => route(&handle, &session, msg).await,
            None => {
                if tx.send(WsMsg::Host { generation, event }).is_err() {
                    return;
                }
            }
        }
    }
}

async fn route(handle: &WorkspaceHandle, session: &str, msg: SessionMsg) {
    let link = lock(&handle.links).get(session).cloned();
    match link {
        // The bounded mailbox is the backpressure when the client stops reading.
        Some(link) => {
            let _ = link.tx.send(msg).await;
        }
        None => {
            tracing::debug!(target: "piarc_core::sessions", session, "an event for a closed session was dropped");
        }
    }
}

/// Upserts the `workspaces` row: display name, main checkout, last opened.
async fn record_workspace(
    ctx: &Ctx,
    path: &std::path::Path,
) -> Result<piarc_store::WorkspaceRecord> {
    let checkout = match piarc_git::resolve(path) {
        Ok(checkout) => path_text(&checkout.main),
        Err(_) => path_text(path),
    };
    let record = piarc_store::WorkspaceRecord {
        path: path_text(path),
        display_name: path.file_name().map_or_else(
            || path_text(path),
            |name| name.to_string_lossy().into_owned(),
        ),
        main_checkout: checkout,
        last_opened_at: now_ms(),
        default_mode: None,
        default_model: None,
    };
    // Reopening keeps what the user chose for the workspace.
    let stored = ctx
        .storage
        .run(move |store| {
            let mut row = record;
            if let Some(known) = store.workspaces()?.into_iter().find(|w| w.path == row.path) {
                row.default_mode = known.default_mode;
                row.default_model = known.default_model;
            }
            store.upsert_workspace(&row)?;
            Ok::<_, piarc_store::Error>(row)
        })
        .await??;
    Ok(stored)
}
