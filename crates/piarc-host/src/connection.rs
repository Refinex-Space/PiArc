//! One connection: the Agent Host process, its three pipes and the handshake.
//!
//! Four tasks per connection:
//!
//! - process: waits for the exit, or kills on request;
//! - writer: writes queued frames to stdin; closing the queue closes stdin;
//! - reader: decodes stdout continuously, answers responses directly, hands the Agent Host's
//!   requests to the [`InboundHandler`](crate::InboundHandler) (with a [`Peer`] for
//!   notifications back) and session notifications to the
//!   event queue (where a slow consumer makes it wait: that is the backpressure on the Agent
//!   Host);
//! - stderr: forwards each line to `tracing` with workspace and session fields.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use piarc_ports::{ExitStatus, ProcessControl, ProcessSpawner, SpawnedProcess};
use piarc_protocol::handshake::{CoreWelcome, HostHello, HostHelloParams};
use piarc_protocol::jsonrpc::{ErrorResponse, Message, Request, RequestId, Version};
use piarc_protocol::method::{Method, ResultMessage};
use piarc_protocol::session::SessionEventNotification;
use piarc_protocol::turn::TurnCompleted;
use piarc_protocol::{ErrorKind, ErrorObject, FrameDecoder, encode_frame, negotiate};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, Semaphore, mpsc, oneshot, watch};

/// Notifications of the Agent Host itself rather than of a session: no `sessionId`, `seq` or
/// `ts` (T36). Every other notification must be a session event.
const HOST_NOTIFICATIONS: &[&str] = &[piarc_protocol::mcp::McpStatusChanged::NAME];

use crate::config::HostConfig;
use crate::events::{EventSender, HostEvent};
use crate::inbound::{Peer, SharedInbound};
use crate::ledger::Ledger;

/// Longest stderr line forwarded to the log; longer lines are cut.
const MAX_LOG_LINE: usize = 16 * 1024;

/// Locks `mutex`, recovering the data if a panicking thread poisoned it: every critical
/// section here leaves the data consistent.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// State shared by the supervisor and every connection.
pub(crate) struct Shared {
    pub ledger: Mutex<Ledger>,
    pub events: EventSender,
    pub inbound: SharedInbound,
    pub workspace: String,
    /// Sessions opened through the supervisor, reopened after a restart.
    pub sessions: Mutex<BTreeMap<String, TrackedSession>>,
}

/// What a restart needs to reopen a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TrackedSession {
    pub cwd: String,
    /// The highest `seq` received for the session, on any connection.
    pub last_seq: u64,
}

/// The answer a caller waits for.
pub(crate) enum Reply {
    Result(Value),
    Error(ErrorObject),
}

/// Callers waiting for responses, by request id. Closed when the connection ends: waiters are
/// dropped (their callers see the call as uncertain) and no new ones are admitted.
#[derive(Default)]
pub(crate) struct Pending {
    closed: bool,
    waiters: HashMap<i64, oneshot::Sender<Reply>>,
}

impl Pending {
    /// Registers a waiter; `None` once the connection ended.
    pub fn register(&mut self, id: i64) -> Option<oneshot::Receiver<Reply>> {
        if self.closed {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        self.waiters.insert(id, tx);
        Some(rx)
    }

    pub fn forget(&mut self, id: i64) {
        self.waiters.remove(&id);
    }

    fn close(&mut self) {
        self.closed = true;
        self.waiters.clear();
    }
}

/// Signs of life of the reader, for the heartbeat.
#[derive(Default)]
pub(crate) struct Activity {
    frames: AtomicU64,
    delivering: AtomicBool,
}

impl Activity {
    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Acquire)
    }

    /// The reader is waiting for the event consumer: the Agent Host is alive but backpressured.
    pub fn delivering(&self) -> bool {
        self.delivering.load(Ordering::Acquire)
    }
}

/// Each receiver belongs to this connection. The restore task owns the sender and reports
/// its outcome or drops it if the process exits before the session is ready.
pub(crate) type Restores = Mutex<BTreeMap<String, watch::Receiver<crate::Result<()>>>>;

/// What calls need to reach the current connection. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Link {
    pub epoch: u64,
    pub models_enabled: bool,
    pub side_chat_enabled: bool,
    pub writer: mpsc::Sender<Vec<u8>>,
    /// Closes the Agent Host's stdin once the queued frames are written: the signal for an
    /// orderly exit.
    pub close_stdin: Arc<Notify>,
    pub pending: Arc<Mutex<Pending>>,
    pub activity: Arc<Activity>,
    pub restoring: Arc<Restores>,
    /// Set once Core accepted the handshake: requests from the Agent Host are dispatched only
    /// on an accepted connection, never before `core/welcome` or after a refusal (R1-A7).
    pub accepted: Arc<AtomicBool>,
}

/// A connection that completed its handshake.
pub(crate) struct Connection {
    pub link: Link,
    /// Resolves once the reader saw the end of stdout: no more responses can arrive.
    pub reader_done: oneshot::Receiver<()>,
    pub pid: Option<u32>,
    pub hello: HostHelloParams,
    pub enabled: Vec<piarc_protocol::Capability>,
    kill: Option<oneshot::Sender<()>>,
    pub exited: oneshot::Receiver<io::Result<ExitStatus>>,
}

impl Connection {
    /// Kills the process; the exit arrives on `exited`.
    pub fn kill(&mut self) {
        if let Some(kill) = self.kill.take() {
            // The process task is gone only after the process exited: nothing left to kill.
            let _ = kill.send(());
        }
    }
}

/// Why a connection did not come up.
pub(crate) enum StartError {
    Spawn(io::Error),
    /// No `host/hello` in time; the process was killed.
    HandshakeTimeout(Option<ExitStatus>),
    /// The process ended before saying hello.
    Exited(Option<ExitStatus>),
    /// Core refused the hello (version mismatch or malformed); the process was told so.
    Rejected {
        error: ErrorObject,
        status: Option<ExitStatus>,
    },
}

/// Starts the Agent Host and performs the handshake.
pub(crate) async fn start(
    config: &HostConfig,
    spawner: &dyn ProcessSpawner,
    shared: &Arc<Shared>,
    epoch: u64,
) -> Result<Connection, StartError> {
    let spec = config.spawn_spec(&|name| std::env::var_os(name));
    let SpawnedProcess {
        stdin,
        stdout,
        stderr,
        control,
    } = spawner.spawn(spec).map_err(StartError::Spawn)?;
    let pid = control.pid();
    let (kill_tx, kill_rx) = oneshot::channel();
    let (exit_tx, mut exited) = oneshot::channel();
    tokio::spawn(watch_process(control, kill_rx, exit_tx));
    let (writer, queue) = mpsc::channel(config.write_queue_frames);
    let close_stdin = Arc::new(Notify::new());
    tokio::spawn(write_frames(stdin, queue, Arc::clone(&close_stdin)));
    tokio::spawn(log_stderr(stderr, shared.workspace.clone(), epoch));
    let mut link = Link {
        models_enabled: false,
        side_chat_enabled: false,
        epoch,
        writer,
        close_stdin,
        pending: Arc::new(Mutex::new(Pending::default())),
        activity: Arc::new(Activity::default()),
        restoring: Arc::default(),
        accepted: Arc::new(AtomicBool::new(false)),
    };
    let (hello_rx, reader_done) = spawn_reader(config, shared, &link, stdout);

    let mut kill = Some(kill_tx);
    let hello = match tokio::time::timeout(config.handshake_timeout, hello_rx).await {
        Ok(Ok(hello)) => hello,
        Ok(Err(_)) => return Err(StartError::Exited(exit_status(&mut exited, None).await)),
        Err(_) => {
            return Err(StartError::HandshakeTimeout(
                exit_status(&mut exited, kill.take()).await,
            ));
        }
    };
    match accept_hello(config, epoch, &hello) {
        Ok((params, welcome)) => {
            link.side_chat_enabled = welcome.enabled.iter().any(|c| c.as_str() == "sideChat");
            link.models_enabled = welcome.enabled.iter().any(|c| c.as_str() == "models");
            let frame = encode(&ResultMessage::<HostHello>::new(
                hello.id.clone(),
                welcome.clone(),
            ));
            // Before the welcome is queued: the Agent Host may send a request as soon as it
            // reads it.
            link.accepted.store(true, Ordering::Release);
            if link.writer.send(frame).await.is_err() {
                return Err(StartError::Exited(exit_status(&mut exited, None).await));
            }
            Ok(Connection {
                link,
                reader_done,
                pid,
                hello: params,
                enabled: welcome.enabled,
                kill,
                exited,
            })
        }
        Err(error) => {
            let response = ErrorResponse {
                jsonrpc: Version,
                id: Some(hello.id.clone()),
                error: error.clone(),
            };
            // If stdin is already closed the Agent Host learns nothing new; the outcome is the same.
            let _ = link.writer.send(encode(&response)).await;
            drop(link);
            let status = match tokio::time::timeout(config.shutdown_timeout, &mut exited).await {
                Ok(Ok(status)) => status.ok(),
                _ => exit_status(&mut exited, kill.take()).await,
            };
            Err(StartError::Rejected { error, status })
        }
    }
}

/// Starts the reader of `stdout`; returns where `host/hello` arrives and the signal that the
/// reader saw the end of stdout.
fn spawn_reader(
    config: &HostConfig,
    shared: &Arc<Shared>,
    link: &Link,
    stdout: Pin<Box<dyn AsyncRead + Send>>,
) -> (oneshot::Receiver<Request>, oneshot::Receiver<()>) {
    let (hello_tx, hello_rx) = oneshot::channel();
    let (done_tx, reader_done) = oneshot::channel();
    let reader = Reader {
        shared: Arc::clone(shared),
        link: link.clone(),
        hello: Some(hello_tx),
        inbound_permits: Arc::new(Semaphore::new(config.inbound_concurrency.max(1))),
    };
    tokio::spawn(reader.run(
        stdout,
        FrameDecoder::with_max_frame_bytes(config.max_frame_bytes),
        done_tx,
    ));
    (hello_rx, reader_done)
}

/// Checks `host/hello` and builds `core/welcome`, or the error to refuse it with.
fn accept_hello(
    config: &HostConfig,
    epoch: u64,
    hello: &Request,
) -> Result<(HostHelloParams, CoreWelcome), ErrorObject> {
    let params: HostHelloParams = serde_json::from_value(Value::Object(
        hello.params.clone().unwrap_or_default(),
    ))
    .map_err(|e| {
        ErrorObject::new(
            ErrorKind::InvalidParams,
            format!("malformed host/hello: {e}"),
            false,
        )
    })?;
    let enabled = negotiate(
        config.protocol,
        &config.capabilities,
        params.protocol,
        &params.capabilities,
    )
    .map_err(|e| e.to_error_object())?;
    let welcome = CoreWelcome {
        protocol: config.protocol,
        enabled,
        workspace: config.workspace.to_string_lossy().into_owned(),
        connection_epoch: epoch,
        allow_model_network: config
            .allow_model_network
            .as_ref()
            .map(|v| v.load(Ordering::Acquire)),
        model_preferences: config.model_preferences.as_ref().map(|p| {
            p.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }),
    };
    Ok((params, welcome))
}

/// Waits for the exit after optionally killing; `None` if the status cannot be read.
async fn exit_status(
    exited: &mut oneshot::Receiver<io::Result<ExitStatus>>,
    kill: Option<oneshot::Sender<()>>,
) -> Option<ExitStatus> {
    if let Some(kill) = kill {
        // The process task ends only after the exit, so a closed channel means it exited.
        let _ = kill.send(());
    }
    exited.await.ok().and_then(Result::ok)
}

/// Encodes a message Core builds itself; serialization of these types cannot fail.
pub(crate) fn encode<T: serde::Serialize>(message: &T) -> Vec<u8> {
    encode_frame(message).unwrap_or_else(|error| {
        tracing::error!(target: "piarc_host", %error, "failed to encode a frame");
        Vec::new()
    })
}

async fn watch_process(
    mut control: Box<dyn ProcessControl>,
    mut kill: oneshot::Receiver<()>,
    exit: oneshot::Sender<io::Result<ExitStatus>>,
) {
    let killed = tokio::select! {
        status = control.wait() => Err(status),
        request = &mut kill => Ok(request.is_ok()),
    };
    let status = match killed {
        Err(status) => status,
        Ok(requested) => {
            if requested && let Err(error) = control.kill() {
                tracing::warn!(target: "piarc_host", %error, "failed to kill the Agent Host");
            }
            control.wait().await
        }
    };
    // Nobody waits for the exit any more when the supervisor is gone.
    let _ = exit.send(status);
}

async fn write_frames(
    mut stdin: Pin<Box<dyn AsyncWrite + Send>>,
    mut queue: mpsc::Receiver<Vec<u8>>,
    close: Arc<Notify>,
) {
    loop {
        let frame = tokio::select! {
            biased;
            frame = queue.recv() => frame,
            () = close.notified() => None,
        };
        let Some(frame) = frame else { break };
        if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
    // Asked to close, or every link is gone: EOF tells the Agent Host to shut down. A failure
    // means the pipe is already closed.
    let _ = stdin.shutdown().await;
}

struct Reader {
    shared: Arc<Shared>,
    link: Link,
    hello: Option<oneshot::Sender<Request>>,
    /// Bounds the Agent Host's requests in progress (R1-A14): the reader waits for a permit,
    /// which pushes back on the Agent Host like a slow notification consumer does.
    inbound_permits: Arc<Semaphore>,
}

impl Reader {
    async fn run(
        mut self,
        mut stdout: Pin<Box<dyn AsyncRead + Send>>,
        mut decoder: FrameDecoder,
        done: oneshot::Sender<()>,
    ) {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = match stdout.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    // No response can arrive any more: callers still waiting learn it now.
                    lock(&self.link.pending).close();
                    // The supervisor may not wait for this signal.
                    let _ = done.send(());
                    return;
                }
                Ok(read) => read,
            };
            for frame in decoder.decode(&buffer[..read]) {
                self.link.activity.frames.fetch_add(1, Ordering::AcqRel);
                match frame {
                    Ok(value) => self.dispatch(value).await,
                    Err(error) => self.frame_error(error.to_error_object()).await,
                }
            }
        }
    }

    async fn dispatch(&mut self, value: Value) {
        match Message::from_value(value) {
            Err(error) => self.frame_error(error.to_error_object()).await,
            Ok(Message::Request(request)) => self.request(request).await,
            Ok(Message::Notification(notification)) => {
                let params = notification.params.clone().unwrap_or_default();
                if HOST_NOTIFICATIONS.contains(&notification.method.as_str())
                    && !params.contains_key("sessionId")
                {
                    // The Agent Host's own state (T36). Any other notification is a session's.
                    self.shared
                        .events
                        .bounded(HostEvent::HostNotification {
                            epoch: self.link.epoch,
                            method: notification.method,
                            params,
                        })
                        .await;
                    return;
                }
                let value = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": notification.method,
                    "params": notification.params.unwrap_or_default(),
                });
                match serde_json::from_value::<SessionEventNotification>(value) {
                    Ok(event) => self.notification(event).await,
                    Err(error) => {
                        let message = format!(
                            "notification {} is not a session event: {error}",
                            notification.method
                        );
                        self.frame_error(ErrorObject::new(
                            ErrorKind::InvalidRequest,
                            message,
                            false,
                        ))
                        .await;
                    }
                }
            }
            Ok(Message::Success(response)) => {
                self.response(&response.id, Reply::Result(response.result))
            }
            Ok(Message::Error(response)) => match response.id {
                Some(id) => self.response(&id, Reply::Error(response.error)),
                None => {
                    tracing::warn!(target: "piarc_host", workspace = %self.shared.workspace, epoch = self.link.epoch,
                        error = %response.error.message, "the Agent Host rejected a frame from Core");
                }
            },
        }
    }

    async fn request(&mut self, request: Request) {
        if request.method == HostHello::NAME {
            match self.hello.take() {
                // The starter is gone only if the connection already failed.
                Some(hello) => drop(hello.send(request)),
                None => {
                    self.reply_error(
                        request.id,
                        ErrorKind::InvalidRequest,
                        "duplicate host/hello",
                    )
                    .await
                }
            }
            return;
        }
        if self.hello.is_some() || !self.link.accepted.load(Ordering::Acquire) {
            self.reply_error(
                request.id,
                ErrorKind::InvalidRequest,
                "the handshake has not completed: host/hello must come first and be accepted",
            )
            .await;
            return;
        }
        let Ok(permit) = Arc::clone(&self.inbound_permits).acquire_owned().await else {
            return; // the semaphore is never closed
        };
        let inbound = Arc::clone(&self.shared.inbound);
        let writer = self.link.writer.clone();
        let peer = Peer::new(writer.clone(), self.link.epoch);
        tokio::spawn(async move {
            let _permit = permit;
            let id = request.id;
            let frame = match inbound
                .handle(request.method, request.params.unwrap_or_default(), peer)
                .await
            {
                Ok(result) => {
                    encode(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                }
                Err(error) => encode(&ErrorResponse {
                    jsonrpc: Version,
                    id: Some(id),
                    error,
                }),
            };
            // A closed writer means the connection ended; the Agent Host treats that as a refusal.
            let _ = writer.send(frame).await;
        });
    }

    async fn notification(&self, event: SessionEventNotification) {
        let header = &event.params.header;
        if let Some(session) = lock(&self.shared.sessions).get_mut(&header.session_id.0) {
            session.last_seq = session.last_seq.max(header.seq);
        }
        if event.method == TurnCompleted::NAME
            && let Some(turn_id) = event.params.payload.get("turnId").and_then(Value::as_str)
        {
            lock(&self.shared.ledger).turn_completed(
                self.link.epoch,
                &event.params.header.session_id.0,
                turn_id,
            );
        }
        self.link.activity.delivering.store(true, Ordering::Release);
        self.shared
            .events
            .bounded(HostEvent::Notification {
                epoch: self.link.epoch,
                notification: event,
            })
            .await;
        self.link
            .activity
            .delivering
            .store(false, Ordering::Release);
    }

    fn response(&self, id: &RequestId, reply: Reply) {
        let RequestId::Number(id) = *id else {
            tracing::warn!(target: "piarc_host", workspace = %self.shared.workspace, "response with a string id ignored");
            return;
        };
        let turn_id = match &reply {
            Reply::Result(result) => result
                .get("turnId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            Reply::Error(_) => None,
        };
        lock(&self.shared.ledger).answered(id, turn_id);
        let waiter = lock(&self.link.pending).waiters.remove(&id);
        if let Some(waiter) = waiter {
            // The caller gave up (timeout); the ledger already has the outcome.
            let _ = waiter.send(reply);
        }
    }

    async fn reply_error(&self, id: RequestId, kind: ErrorKind, message: &str) {
        let response = ErrorResponse {
            jsonrpc: Version,
            id: Some(id),
            error: ErrorObject::new(kind, message, false),
        };
        // A closed writer means the connection ended.
        let _ = self.link.writer.send(encode(&response)).await;
    }

    async fn frame_error(&self, error: ErrorObject) {
        tracing::warn!(target: "piarc_host", workspace = %self.shared.workspace, epoch = self.link.epoch,
            kind = ?error.data.kind, "dropped an invalid frame from the Agent Host: {}", error.message);
        // Like a notification, a frame error waits for a permit: the heartbeat must see that
        // the reader is held back by Core's consumer, not by a hung Agent Host.
        self.link.activity.delivering.store(true, Ordering::Release);
        self.shared
            .events
            .bounded(HostEvent::FrameError {
                epoch: self.link.epoch,
                error,
            })
            .await;
        self.link
            .activity
            .delivering
            .store(false, Ordering::Release);
    }
}

/// Forwards stderr lines to `tracing`. A line starting with `[session <id>] ` carries that
/// session id as a field.
async fn log_stderr(mut stderr: Pin<Box<dyn AsyncRead + Send>>, workspace: String, epoch: u64) {
    let mut chunk = vec![0_u8; 8 * 1024];
    let mut line: Vec<u8> = Vec::new();
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for &byte in &chunk[..read] {
            if byte == b'\n' {
                log_line(&workspace, epoch, &line);
                line.clear();
            } else if line.len() < MAX_LOG_LINE {
                line.push(byte);
            }
        }
    }
    if !line.is_empty() {
        log_line(&workspace, epoch, &line);
    }
}

fn log_line(workspace: &str, epoch: u64, line: &[u8]) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end_matches('\r');
    let (session, message) = split_session(text);
    tracing::info!(target: "piarc_host::agent_host", workspace = %workspace, session = %session, epoch, "{message}");
}

/// Splits `[session <id>] message` into the id and the message; no prefix gives an empty id.
pub(crate) fn split_session(line: &str) -> (&str, &str) {
    line.strip_prefix("[session ")
        .and_then(|rest| rest.split_once("] "))
        .unwrap_or(("", line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_session_prefix_of_a_log_line() {
        assert_eq!(
            split_session("[session abc] opened in /w"),
            ("abc", "opened in /w")
        );
        assert_eq!(
            split_session("connected: AHP 1.0"),
            ("", "connected: AHP 1.0")
        );
        assert_eq!(split_session("[session broken"), ("", "[session broken"));
    }

    #[test]
    fn pending_refuses_waiters_after_the_connection_ended() {
        let mut pending = Pending::default();
        assert!(pending.register(1).is_some());
        pending.close();
        assert!(pending.register(2).is_none());
        assert!(pending.waiters.is_empty());
    }
}
