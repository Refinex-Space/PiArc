//! Test doubles for the supervisor: an in-memory spawner running scripted fake Agent Hosts,
//! and a clock the tests control. No processes, no sleeps: every fault is injected by the
//! script at a known point.

#![allow(
    dead_code,
    reason = "each test binary uses a different subset of the helpers"
)]

use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_host::{HostConfig, HostDeps, HostEvent, HostEvents, InboundHandler, NoInbound, Peer};
use piarc_ports::{
    BoxFuture, Clock, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};
use piarc_protocol::ErrorObject;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::{oneshot, watch};

/// Upper bound for waiting on an event. Only a safety net against hanging tests: assertions
/// never depend on timing.
pub const EVENT_WAIT: Duration = Duration::from_secs(20);

/// The script of one fake Agent Host run; returns its exit code.
pub type Script = Box<dyn FnOnce(FakeHost) -> BoxFuture<'static, i32> + Send>;

/// Wraps an async closure into a [`Script`].
pub fn script<F, Fut>(f: F) -> Script
where
    F: FnOnce(FakeHost) -> Fut + Send + 'static,
    Fut: Future<Output = i32> + Send + 'static,
{
    Box::new(move |host| Box::pin(f(host)))
}

/// The fake process's side of the pipes.
pub struct FakeHost {
    stdin: BufReader<DuplexStream>,
    pub stdout: DuplexStream,
    stderr: DuplexStream,
}

impl FakeHost {
    /// The next frame Core wrote, parsed. Panics when Core closed stdin.
    pub async fn recv(&mut self) -> Value {
        let mut line = Vec::new();
        let read = self
            .stdin
            .read_until(b'\n', &mut line)
            .await
            .expect("stdin reads");
        assert!(read > 0, "Core closed stdin");
        serde_json::from_slice(&line).expect("Core writes JSON frames")
    }

    /// Reads frames until a request for `method`, answering heartbeats on the way. Returns
    /// its id and params.
    pub async fn request(&mut self, method: &str) -> (Value, Value) {
        loop {
            let frame = self.recv().await;
            if frame["method"] == "host/ping" {
                let sent_at = frame["params"]["sentAt"].clone();
                self.respond(frame["id"].clone(), status(sent_at)).await;
                continue;
            }
            assert_eq!(frame["method"], method, "unexpected frame {frame}");
            return (frame["id"].clone(), frame["params"].clone());
        }
    }

    /// Serves like an idle Agent Host until Core closes stdin: answers heartbeats and
    /// `host/shutdown`, ignores everything else.
    pub async fn until_stdin_closes(&mut self) {
        let mut line = Vec::new();
        while self
            .stdin
            .read_until(b'\n', &mut line)
            .await
            .is_ok_and(|n| n > 0)
        {
            let frame: Value = serde_json::from_slice(&line).expect("Core writes JSON frames");
            line.clear();
            let id = frame["id"].clone();
            match frame["method"].as_str() {
                Some("host/ping") => {
                    self.respond(id, status(frame["params"]["sentAt"].clone()))
                        .await
                }
                Some("host/shutdown") => self.respond(id, json!({ "closedSessions": 0 })).await,
                _ => {}
            }
        }
    }

    pub async fn send(&mut self, value: &Value) {
        let mut bytes = serde_json::to_vec(value).expect("serializes");
        bytes.push(b'\n');
        self.send_raw(&bytes).await;
    }

    pub async fn send_raw(&mut self, bytes: &[u8]) {
        self.stdout.write_all(bytes).await.expect("stdout writes");
        self.stdout.flush().await.expect("stdout flushes");
    }

    pub async fn log(&mut self, line: &str) {
        self.stderr
            .write_all(format!("{line}\n").as_bytes())
            .await
            .expect("stderr writes");
    }

    /// Sends `host/hello` and returns Core's response.
    pub async fn hello(&mut self, protocol: &str, capabilities: &[&str]) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "host/hello",
            "params": { "protocol": protocol, "pi": "1.5.2", "capabilities": capabilities }
        }))
        .await;
        self.recv().await
    }

    pub async fn respond(&mut self, id: Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await;
    }

    /// Sends a session notification.
    pub async fn notify(&mut self, method: &str, session: &str, seq: u64, payload: Value) {
        let mut params = json!({ "sessionId": session, "seq": seq, "ts": 1_763_200_000_000_u64 });
        if let (Some(params), Value::Object(payload)) = (params.as_object_mut(), payload) {
            params.extend(payload);
        }
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await;
    }

    /// Answers `session/create` with `session_id`.
    pub async fn accept_session(&mut self, session_id: &str) {
        let (id, _) = self.request("session/create").await;
        self.respond(
            id,
            json!({ "sessionId": session_id, "restoredMessages": 0 }),
        )
        .await;
    }
}

/// A `host/ping` result.
pub fn status(sent_at: Value) -> Value {
    json!({
        "sentAt": sent_at, "rssBytes": 1, "outboundQueuedFrames": 0, "outboundQueuedBytes": 0,
        "outboundPeakBytes": 0, "sessions": 0
    })
}

/// Runs one queued script per spawn; a spawn with no script left fails like a missing binary.
pub struct FakeSpawner {
    scripts: Mutex<VecDeque<Script>>,
    spawned: AtomicUsize,
    pipe_bytes: usize,
}

impl FakeSpawner {
    pub fn new(scripts: Vec<Script>) -> Arc<Self> {
        Self::with_pipe_bytes(scripts, 64 * 1024)
    }

    /// Pipes hold at most `pipe_bytes`, like an OS pipe buffer.
    pub fn with_pipe_bytes(scripts: Vec<Script>, pipe_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            scripts: Mutex::new(scripts.into()),
            spawned: AtomicUsize::new(0),
            pipe_bytes,
        })
    }

    pub fn spawned(&self) -> usize {
        self.spawned.load(Ordering::SeqCst)
    }
}

impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, _spec: SpawnSpec) -> io::Result<SpawnedProcess> {
        let Some(script) = self.scripts.lock().expect("lock").pop_front() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "no fake Agent Host script left",
            ));
        };
        let pid = u32::try_from(self.spawned.fetch_add(1, Ordering::SeqCst) + 1000).expect("small");
        let (core_stdin, host_stdin) = tokio::io::duplex(self.pipe_bytes);
        let (host_stdout, core_stdout) = tokio::io::duplex(self.pipe_bytes);
        let (host_stderr, core_stderr) = tokio::io::duplex(self.pipe_bytes);
        let host = FakeHost {
            stdin: BufReader::new(host_stdin),
            stdout: host_stdout,
            stderr: host_stderr,
        };
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (exit_tx, exit_rx) = watch::channel(None);
        tokio::spawn(async move {
            let status = tokio::select! {
                code = script(host) => ExitStatus { code: Some(code), signal: None },
                _ = kill_rx => ExitStatus { code: None, signal: Some(9) },
            };
            let _ = exit_tx.send(Some(status));
        });
        Ok(SpawnedProcess {
            stdin: Box::pin(core_stdin),
            stdout: Box::pin(core_stdout),
            stderr: Box::pin(core_stderr),
            control: Box::new(FakeControl {
                pid,
                kill: Some(kill_tx),
                exit: exit_rx,
            }),
        })
    }
}

struct FakeControl {
    pid: u32,
    kill: Option<oneshot::Sender<()>>,
    exit: watch::Receiver<Option<ExitStatus>>,
}

impl ProcessControl for FakeControl {
    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn kill(&mut self) -> io::Result<()> {
        if let Some(kill) = self.kill.take() {
            let _ = kill.send(());
        }
        Ok(())
    }

    fn wait(&mut self) -> BoxFuture<'_, io::Result<ExitStatus>> {
        let mut exit = self.exit.clone();
        Box::pin(async move {
            let status = exit
                .wait_for(Option::is_some)
                .await
                .map_err(io::Error::other)?;
            Ok(status.unwrap_or(ExitStatus {
                code: None,
                signal: None,
            }))
        })
    }
}

/// A clock that only moves when it sleeps: backoff completes at once, and the virtual time it
/// "waited" counts towards the restart window.
#[derive(Debug)]
pub struct TestClock {
    base: Instant,
    elapsed: Mutex<Duration>,
}

impl TestClock {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            elapsed: Mutex::new(Duration::ZERO),
        })
    }

    pub fn elapsed(&self) -> Duration {
        *self.elapsed.lock().expect("lock")
    }
}

impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.base + self.elapsed()
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        *self.elapsed.lock().expect("lock") += duration;
        Box::pin(tokio::task::yield_now())
    }
}

/// Answers `trust/get` with a fixed answer and records the paths asked about.
#[derive(Default)]
pub struct TrustTable {
    pub trusted: bool,
    pub asked: Mutex<Vec<String>>,
}

impl InboundHandler for TrustTable {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let trusted = self.trusted;
        if let Some(path) = params.get("path").and_then(Value::as_str) {
            self.asked.lock().expect("lock").push(path.to_owned());
        }
        Box::pin(async move {
            if method == "trust/get" {
                Ok(json!({ "trusted": trusted }))
            } else {
                NoInbound.handle(method, Map::new(), peer).await
            }
        })
    }
}

/// A config whose process fields are ignored by the fake spawner; heartbeats effectively off.
pub fn config() -> HostConfig {
    let mut config = HostConfig::new(
        PathBuf::from("work space/项目"),
        PathBuf::from("data"),
        PathBuf::from("node"),
        PathBuf::from("agent-host.mjs"),
    );
    config.heartbeat_interval = Duration::from_secs(24 * 3600);
    config
}

pub fn deps(spawner: Arc<FakeSpawner>, clock: Arc<TestClock>) -> HostDeps {
    HostDeps {
        spawner,
        clock,
        inbound: Arc::new(NoInbound),
    }
}

/// Waits for the first event matching `pred`, returning it with every event seen before.
pub async fn until(
    events: &mut HostEvents,
    pred: impl Fn(&HostEvent) -> bool,
) -> (HostEvent, Vec<HostEvent>) {
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(EVENT_WAIT, events.recv())
            .await
            .unwrap_or_else(|_| panic!("no matching event; saw {seen:#?}"))
            .unwrap_or_else(|| panic!("event stream ended; saw {seen:#?}"));
        if pred(&event) {
            return (event, seen);
        }
        seen.push(event);
    }
}
