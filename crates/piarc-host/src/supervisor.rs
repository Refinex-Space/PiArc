//! The supervisor of one workspace's Agent Host: starts it, keeps it alive, restarts it with
//! backoff, reopens its sessions and reconciles calls (architecture section 7.5).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_ports::{Clock, ExitStatus, ProcessSpawner};
use piarc_protocol::ErrorKind;
use piarc_protocol::host::{
    HostPing, HostPingParams, HostShutdown, HostShutdownParams, HostStatus,
};
use piarc_protocol::method::{Method, RequestMethod};
use piarc_protocol::session::{
    ModelRef, PromptAccepted, SessionAbort, SessionClose, SessionCreate, SessionCreateParams,
    SessionId, SessionOpened, SessionPrompt, SessionPromptParams, SessionResume,
    SessionResumeParams, SessionStopped, SessionTarget,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::config::HostConfig;
use crate::connection::{self, Connection, Link, Reply, Shared, StartError, TrackedSession, lock};

/// How long to wait for the reader to drain stdout after the process exited.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
use crate::error::{Error, Result};
use crate::events::{EventSender, ExitReason, HostEvent, HostEvents};
use crate::inbound::SharedInbound;
use crate::ledger::{CallRecord, CallState, Ledger};
use crate::restart::{RestartDecision, RestartPolicy};

/// The supervisor's injected I/O.
#[derive(Clone)]
pub struct HostDeps {
    /// Starts the Agent Host process.
    pub spawner: Arc<dyn ProcessSpawner>,
    /// Restart window and backoff time.
    pub clock: Arc<dyn Clock>,
    /// Answers the Agent Host's requests to Core.
    pub inbound: SharedInbound,
}

/// Where the supervisor stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    /// Starting connection `epoch`.
    Starting {
        /// The connection being started.
        epoch: u64,
    },
    /// Connection `epoch` is up.
    Connected {
        /// The live connection.
        epoch: u64,
    },
    /// Waiting before a restart.
    Restarting {
        /// Restart number within the window.
        attempt: u32,
    },
    /// `shutdown` is in progress.
    ShuttingDown,
    /// Stopped for good.
    Stopped,
}

enum Command {
    Shutdown(oneshot::Sender<()>),
    Kill(ExitReason),
}

struct Inner {
    config: HostConfig,
    deps: HostDeps,
    shared: Arc<Shared>,
    link: Mutex<Option<Link>>,
    state: Mutex<SupervisorState>,
    last_status: Mutex<Option<HostStatus>>,
    next_id: AtomicI64,
    commands: mpsc::Sender<Command>,
}

/// Handle to a supervised Agent Host. Clones share the same supervisor.
#[derive(Clone)]
pub struct HostSupervisor {
    inner: Arc<Inner>,
}

impl HostSupervisor {
    /// Starts supervising: launches the Agent Host on the current tokio runtime. Events arrive
    /// on the returned receiver; reading notifications slowly slows down reading the Agent
    /// Host's stdout, never the supervisor's restarts or shutdown.
    #[must_use]
    pub fn start(config: HostConfig, deps: HostDeps) -> (Self, HostEvents) {
        let (events, receiver) = EventSender::channel(config.event_queue);
        let (commands, command_rx) = mpsc::channel(8);
        let shared = Arc::new(Shared {
            ledger: Mutex::new(Ledger::default()),
            events,
            inbound: Arc::clone(&deps.inbound),
            workspace: config.workspace.to_string_lossy().into_owned(),
            sessions: Mutex::new(BTreeMap::new()),
        });
        let inner = Arc::new(Inner {
            config,
            deps,
            shared,
            link: Mutex::new(None),
            state: Mutex::new(SupervisorState::Starting { epoch: 1 }),
            last_status: Mutex::new(None),
            next_id: AtomicI64::new(1),
            commands,
        });
        tokio::spawn(Arc::clone(&inner).run(command_rx));
        (Self { inner }, receiver)
    }

    /// The current state.
    #[must_use]
    pub fn state(&self) -> SupervisorState {
        *lock(&self.inner.state)
    }

    /// Calls in flight (`sent` or `acknowledged`).
    #[must_use]
    pub fn calls(&self) -> Vec<CallRecord> {
        lock(&self.inner.shared.ledger).snapshot()
    }

    /// The result of the last successful heartbeat.
    #[must_use]
    pub fn last_status(&self) -> Option<HostStatus> {
        *lock(&self.inner.last_status)
    }

    /// Ids of the sessions the supervisor reopens after a restart.
    #[must_use]
    pub fn open_sessions(&self) -> Vec<String> {
        lock(&self.inner.shared.sessions).keys().cloned().collect()
    }

    /// Calls `M` on the Agent Host and waits for the result.
    ///
    /// # Errors
    ///
    /// [`Error::HostUnavailable`] while no connection is up, [`Error::Busy`] when the write
    /// queue is full, [`Error::Timeout`], [`Error::Uncertain`] when the connection ends first,
    /// [`Error::Remote`] for an error response, [`Error::MalformedResult`].
    pub async fn call<M: RequestMethod>(&self, params: M::Params) -> Result<M::Result> {
        self.inner
            .call::<M>(
                params,
                Tracking::untracked(),
                self.inner.config.call_timeout,
            )
            .await
    }

    /// Opens a session in `cwd`; it is reopened automatically after a restart.
    ///
    /// # Errors
    ///
    /// As [`HostSupervisor::call`].
    pub async fn create_session(
        &self,
        cwd: &str,
        model: Option<ModelRef>,
    ) -> Result<SessionOpened> {
        let params = SessionCreateParams {
            cwd: cwd.to_owned(),
            model,
        };
        let opened = self
            .inner
            .call::<SessionCreate>(
                params,
                Tracking::untracked(),
                self.inner.config.call_timeout,
            )
            .await?;
        lock(&self.inner.shared.sessions).insert(
            opened.session_id.0.clone(),
            TrackedSession {
                cwd: cwd.to_owned(),
                last_seq: 0,
            },
        );
        Ok(opened)
    }

    /// Starts a turn. The result only acknowledges it: the turn's end arrives as a
    /// `turn/completed` notification, and the call stays `acknowledged` in [`HostSupervisor::calls`]
    /// until then.
    ///
    /// # Errors
    ///
    /// As [`HostSupervisor::call`].
    pub async fn prompt(
        &self,
        session_id: &SessionId,
        request_id: &str,
        text: &str,
    ) -> Result<PromptAccepted> {
        let params = SessionPromptParams {
            session_id: session_id.clone(),
            request_id: request_id.to_owned(),
            text: text.to_owned(),
        };
        let tracking = Tracking {
            session_id: Some(session_id.0.clone()),
            request_key: Some(request_id.to_owned()),
        };
        self.inner
            .call::<SessionPrompt>(params, tracking, self.inner.config.call_timeout)
            .await
    }

    /// Interrupts the session's running turn.
    ///
    /// # Errors
    ///
    /// As [`HostSupervisor::call`].
    pub async fn abort(&self, session_id: &SessionId) -> Result<SessionStopped> {
        let tracking = Tracking {
            session_id: Some(session_id.0.clone()),
            request_key: None,
        };
        let target = SessionTarget {
            session_id: session_id.clone(),
        };
        self.inner
            .call::<SessionAbort>(target, tracking, self.inner.config.call_timeout)
            .await
    }

    /// Closes a session; it is no longer reopened after a restart.
    ///
    /// # Errors
    ///
    /// As [`HostSupervisor::call`].
    pub async fn close_session(&self, session_id: &SessionId) -> Result<SessionStopped> {
        let tracking = Tracking {
            session_id: Some(session_id.0.clone()),
            request_key: None,
        };
        let target = SessionTarget {
            session_id: session_id.clone(),
        };
        let result = self
            .inner
            .call::<SessionClose>(target, tracking, self.inner.config.call_timeout)
            .await;
        if result.is_ok() || matches!(&result, Err(e) if e.kind() == ErrorKind::SessionNotFound) {
            lock(&self.inner.shared.sessions).remove(&session_id.0);
        }
        result
    }

    /// Kills the current Agent Host process as if it crashed: the restart policy applies.
    pub async fn kill(&self) {
        // A closed command channel means the supervisor already stopped.
        let _ = self
            .inner
            .commands
            .send(Command::Kill(ExitReason::Killed))
            .await;
    }

    /// Stops supervising: asks the Agent Host to shut down (`host/shutdown`), waits for its
    /// exit (killing it after `shutdown_timeout`) and does not restart it.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self
            .inner
            .commands
            .send(Command::Shutdown(tx))
            .await
            .is_ok()
        {
            // The supervisor drops the sender only once it stopped.
            let _ = rx.await;
        }
    }
}

/// Ledger fields of a call; untracked calls (heartbeats) stay out of the ledger.
struct Tracking {
    session_id: Option<String>,
    request_key: Option<String>,
}

impl Tracking {
    fn untracked() -> Self {
        Self {
            session_id: None,
            request_key: None,
        }
    }
}

impl Inner {
    async fn emit(&self, event: HostEvent) {
        self.shared.events.lifecycle(event);
    }

    fn set_state(&self, state: SupervisorState) {
        *lock(&self.state) = state;
    }

    fn current_link(&self) -> Result<Link> {
        let state = *lock(&self.state);
        if matches!(
            state,
            SupervisorState::ShuttingDown | SupervisorState::Stopped
        ) {
            return Err(Error::ShuttingDown);
        }
        lock(&self.link)
            .clone()
            .ok_or_else(|| Error::HostUnavailable {
                state: format!("{state:?}"),
            })
    }

    async fn call<M: RequestMethod>(
        &self,
        params: M::Params,
        tracking: Tracking,
        timeout: Duration,
    ) -> Result<M::Result> {
        let params = serde_json::to_value(params).map_err(|e| Error::Encode {
            method: M::NAME.into(),
            reason: e.to_string(),
        })?;
        let track = M::NAME != HostPing::NAME;
        let value = self
            .send(M::NAME, params, track.then_some(tracking), timeout)
            .await?;
        serde_json::from_value(value).map_err(|e| Error::MalformedResult {
            method: M::NAME.into(),
            reason: e.to_string(),
        })
    }

    async fn send(
        &self,
        method: &str,
        params: Value,
        tracking: Option<Tracking>,
        timeout: Duration,
    ) -> Result<Value> {
        let link = self.current_link()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let Some(reply) = lock(&link.pending).register(id) else {
            return Err(Error::HostUnavailable {
                state: "connection ended".into(),
            });
        };
        if let Some(tracking) = tracking {
            lock(&self.shared.ledger).sent(CallRecord {
                call_id: id,
                epoch: link.epoch,
                method: method.to_owned(),
                session_id: tracking.session_id,
                request_key: tracking.request_key,
                turn_id: None,
                state: CallState::Sent,
            });
        }
        let frame = connection::encode(
            &serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        );
        if let Err(error) = link.writer.try_send(frame) {
            lock(&link.pending).forget(id);
            lock(&self.shared.ledger).withdraw(id);
            return Err(match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy {
                    method: method.to_owned(),
                },
                mpsc::error::TrySendError::Closed(_) => Error::HostUnavailable {
                    state: "connection ended".into(),
                },
            });
        }
        drop(link);
        match tokio::time::timeout(timeout, reply).await {
            Err(_) => {
                if let Some(link) = lock(&self.link).as_ref() {
                    lock(&link.pending).forget(id);
                }
                let timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
                Err(Error::Timeout {
                    method: method.to_owned(),
                    timeout_ms,
                })
            }
            Ok(Err(_)) => Err(Error::Uncertain {
                method: method.to_owned(),
            }),
            Ok(Ok(Reply::Result(value))) => Ok(value),
            Ok(Ok(Reply::Error(error))) => Err(Error::Remote {
                method: method.to_owned(),
                error,
            }),
        }
    }

    async fn run(self: Arc<Self>, mut commands: mpsc::Receiver<Command>) {
        let mut policy = RestartPolicy::new(self.config.restart);
        let mut epoch = 0;
        loop {
            epoch += 1;
            self.set_state(SupervisorState::Starting { epoch });
            let (reason, status, stop) = match connection::start(
                &self.config,
                self.deps.spawner.as_ref(),
                &self.shared,
                epoch,
            )
            .await
            {
                Ok(connection) => self.serve(connection, &mut commands).await,
                Err(StartError::Spawn(error)) => {
                    tracing::error!(target: "piarc_host", workspace = %self.shared.workspace, %error, "failed to start the Agent Host");
                    (ExitReason::SpawnFailed, None, None)
                }
                Err(StartError::HandshakeTimeout(status)) => {
                    (ExitReason::HandshakeTimeout, status, None)
                }
                Err(StartError::Exited(status)) => (ExitReason::Crashed, status, None),
                Err(StartError::Rejected { error, status }) => {
                    tracing::error!(target: "piarc_host", workspace = %self.shared.workspace, epoch,
                        "refused the Agent Host's handshake: {}", error.message);
                    self.emit(HostEvent::HandshakeRejected { epoch, error })
                        .await;
                    self.connection_ended(epoch, ExitReason::HandshakeRejected, status)
                        .await;
                    return self.stop(None).await;
                }
            };
            self.connection_ended(epoch, reason, status).await;
            if reason == ExitReason::Shutdown {
                return self.stop(stop).await;
            }
            match policy.on_failure(self.deps.clock.now()) {
                RestartDecision::Restart { attempt, delay } => {
                    self.set_state(SupervisorState::Restarting { attempt });
                    self.emit(HostEvent::Restarting { attempt, delay }).await;
                    tokio::select! {
                        () = self.deps.clock.sleep(delay) => {}
                        command = commands.recv() => {
                            if let Some(Command::Shutdown(done)) = command {
                                return self.stop(Some(done)).await;
                            }
                        }
                    }
                }
                RestartDecision::GiveUp { restarts } => {
                    tracing::error!(target: "piarc_host", workspace = %self.shared.workspace, restarts,
                        "the Agent Host failed too often; not restarting it");
                    self.emit(HostEvent::GaveUp { restarts }).await;
                    return self.stop(None).await;
                }
            }
        }
    }

    /// Runs a connection until it ends. Returns the reason, the exit status and, after a
    /// shutdown request, whom to tell once stopped.
    async fn serve(
        self: &Arc<Self>,
        mut connection: Connection,
        commands: &mut mpsc::Receiver<Command>,
    ) -> (ExitReason, Option<ExitStatus>, Option<oneshot::Sender<()>>) {
        let epoch = connection.link.epoch;
        *lock(&self.link) = Some(connection.link.clone());
        self.set_state(SupervisorState::Connected { epoch });
        tracing::info!(target: "piarc_host", workspace = %self.shared.workspace, epoch, pid = ?connection.pid,
            pi = %connection.hello.pi, "Agent Host connected");
        self.emit(HostEvent::Connected {
            epoch,
            pi_version: connection.hello.pi.clone(),
            enabled: connection.enabled.clone(),
            pid: connection.pid,
        })
        .await;
        let heartbeat = self.spawn_heartbeat(connection.link.clone());
        if epoch > 1 {
            self.restore_sessions(epoch).await;
        }
        let mut reason = ExitReason::Crashed;
        let mut stop = None;
        let status = loop {
            tokio::select! {
                status = &mut connection.exited => break status.ok().and_then(Result::ok),
                command = commands.recv(), if stop.is_none() => match command {
                    Some(Command::Kill(why)) => {
                        reason = why;
                        connection.kill();
                    }
                    Some(Command::Shutdown(done)) => {
                        stop = Some(done);
                        reason = ExitReason::Shutdown;
                        if let Some(status) = self.request_shutdown(&mut connection).await {
                            break status;
                        }
                    }
                    None => {}
                },
            }
        };
        heartbeat.abort();
        // End the write queue: requests still running hold `Peer` clones of it, and their
        // `Peer::closed()` (which cancels a delegated command) completes only once the writer
        // task drops the queue.
        connection.link.close_stdin.notify_one();
        // Frames written just before the exit are still in the pipe: read them before the
        // open calls are judged uncertain.
        if tokio::time::timeout(DRAIN_TIMEOUT, &mut connection.reader_done)
            .await
            .is_err()
        {
            tracing::warn!(target: "piarc_host", workspace = %self.shared.workspace, epoch,
                "stdout stayed open after the Agent Host exited");
        }
        (reason, status, stop)
    }

    /// Sends `host/shutdown`, waits for the exit and kills the process when it does not come.
    /// Returns the exit status if the exit was observed here.
    async fn request_shutdown(&self, connection: &mut Connection) -> Option<Option<ExitStatus>> {
        self.set_state(SupervisorState::ShuttingDown);
        let params = serde_json::json!(HostShutdownParams {
            reason: "coreShutdown".into()
        });
        let link = connection.link.clone();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let reply = lock(&link.pending).register(id);
        let frame = connection::encode(
            &serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": HostShutdown::NAME, "params": params }),
        );
        if let (Some(reply), Ok(())) = (reply, link.writer.try_send(frame)) {
            // No answer in time still ends in the kill below.
            let _ = tokio::time::timeout(self.config.shutdown_timeout, reply).await;
        }
        link.close_stdin.notify_one();
        drop(link);
        *lock(&self.link) = None;
        match tokio::time::timeout(self.config.shutdown_timeout, &mut connection.exited).await {
            Ok(status) => Some(status.ok().and_then(Result::ok)),
            Err(_) => {
                connection.kill();
                None
            }
        }
    }

    fn spawn_heartbeat(self: &Arc<Self>, link: Link) -> JoinHandle<()> {
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let mut failures = 0;
            loop {
                tokio::time::sleep(inner.config.heartbeat_interval).await;
                let frames_before = link.activity.frames();
                let sent_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| {
                        u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
                    });
                let result = inner
                    .call::<HostPing>(
                        HostPingParams { sent_at },
                        Tracking::untracked(),
                        inner.config.heartbeat_timeout,
                    )
                    .await;
                match result {
                    Ok(status) => {
                        failures = 0;
                        *lock(&inner.last_status) = Some(status);
                    }
                    Err(Error::Timeout { .. } | Error::Busy { .. }) => {
                        if link.activity.delivering() || link.activity.frames() > frames_before {
                            failures = 0; // alive, only held back by Core's own consumer
                        } else {
                            failures += 1;
                            tracing::warn!(target: "piarc_host", workspace = %inner.shared.workspace, epoch = link.epoch,
                                failures, "the Agent Host missed a heartbeat");
                        }
                    }
                    Err(_) => return,
                }
                if failures >= inner.config.heartbeat_failures {
                    tracing::error!(target: "piarc_host", workspace = %inner.shared.workspace, epoch = link.epoch,
                        "the Agent Host is hung; killing it");
                    // A closed channel means the supervisor stopped.
                    let _ = inner.commands.send(Command::Kill(ExitReason::Hung)).await;
                    return;
                }
            }
        })
    }

    async fn restore_sessions(&self, epoch: u64) {
        let sessions: Vec<(String, TrackedSession)> = lock(&self.shared.sessions)
            .iter()
            .map(|(id, tracked)| (id.clone(), tracked.clone()))
            .collect();
        for (session_id, tracked) in sessions {
            let params = SessionResumeParams {
                session_id: SessionId(session_id.clone()),
                cwd: tracked.cwd,
                last_seq: Some(tracked.last_seq),
            };
            match self
                .call::<SessionResume>(params, Tracking::untracked(), self.config.call_timeout)
                .await
            {
                Ok(opened) => {
                    self.emit(HostEvent::SessionRestored {
                        epoch,
                        session_id,
                        restored_messages: opened.restored_messages,
                    })
                    .await;
                }
                Err(error) => {
                    lock(&self.shared.sessions).remove(&session_id);
                    self.emit(HostEvent::SessionRestoreFailed {
                        epoch,
                        session_id,
                        error: error.to_error_object(),
                    })
                    .await;
                }
            }
        }
    }

    /// The connection is gone: refuse new calls on it, fail its waiters, report its open calls
    /// as uncertain and report the exit.
    async fn connection_ended(&self, epoch: u64, reason: ExitReason, status: Option<ExitStatus>) {
        *lock(&self.link) = None;
        let uncertain = lock(&self.shared.ledger).connection_lost(epoch);
        tracing::warn!(target: "piarc_host", workspace = %self.shared.workspace, epoch, ?reason, ?status,
            uncertain = uncertain.len(), "Agent Host connection ended");
        self.emit(HostEvent::Exited {
            epoch,
            reason,
            status,
        })
        .await;
        if !uncertain.is_empty() {
            self.emit(HostEvent::Uncertain {
                epoch,
                calls: uncertain,
            })
            .await;
        }
    }

    async fn stop(&self, done: Option<oneshot::Sender<()>>) {
        self.set_state(SupervisorState::Stopped);
        self.emit(HostEvent::Stopped).await;
        if let Some(done) = done {
            // The caller may have stopped waiting.
            let _ = done.send(());
        }
    }
}
