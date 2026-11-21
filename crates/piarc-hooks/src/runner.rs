//! Running handlers (architecture section 6.3.1, ADR-0055): `command` handlers as processes,
//! `http` and `prompt` handlers through the injected [`HttpPort`] and [`JudgePort`] under the
//! same timeouts and cancellation.
//!
//! - Every handler of one event runs at the same time. Each gets the event's input JSON on
//!   stdin (then EOF); stdout and stderr are read while it runs, each into its own buffer, so a
//!   full pipe never stalls it (output past [`RunnerConfig::output_limit`] is read and dropped).
//! - A handler stops at its timeout or when the event's token is cancelled (the session turn
//!   was interrupted or the session closed): first [`ProcessControl::terminate`], then
//!   [`ProcessControl::kill`] after [`RunnerConfig::kill_grace`]. Once the process has exited,
//!   its control is dropped, which ends whatever it left running (Core injects
//!   `piarc_exec::ProcessTreeSpawner`: a process group on macOS, a Job Object on Windows).
//! - Processes start through the injected [`ProcessSpawner`]; which program runs a command
//!   (`sh -c`, Git Bash, PowerShell, or the exec form) is the injected [`Launcher`]'s choice.

use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_ports::{ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec};
use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::config::{Action, Command, Handler, Http, Prompt};
use crate::error::Error;
use crate::event::{HookEvent, Timeouts};
use crate::http::{HttpRules, read_reply};
use crate::ports::{HttpPort, JudgeCall, JudgePort};

/// After the handler exits, how long its pipes may stay quiet before reading stops.
const EXIT_GRACE: Duration = Duration::from_millis(100);

/// Builds the process of a handler.
pub trait Launcher: Send + Sync {
    /// The program, arguments and environment that run `command` in `cwd`.
    ///
    /// # Errors
    ///
    /// Why it cannot run here, for example no shell of the requested kind.
    fn spec(&self, command: &Command, cwd: &Path) -> Result<SpawnSpec, Error>;
}

/// The runner's limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerConfig {
    /// Default timeouts per event.
    pub timeouts: Timeouts,
    /// Between the request to stop and the kill.
    pub kill_grace: Duration,
    /// Bytes of stdout and of stderr kept per handler.
    pub output_limit: usize,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            timeouts: Timeouts::default(),
            kill_grace: Duration::from_secs(2),
            output_limit: 4 * 1024 * 1024,
        }
    }
}

/// How one handler ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStatus {
    /// It exited with this status.
    Exited(ExitStatus),
    /// Its timeout passed; it was stopped.
    TimedOut(Duration),
    /// The event was cancelled; it was stopped.
    Cancelled,
    /// It could not start.
    NotStarted(String),
    /// An `http` or `prompt` handler answered: the JSON output a command would print (empty:
    /// no output).
    Replied(Map<String, Value>),
    /// An `http` or `prompt` handler failed without blocking: why.
    Failed(String),
}

/// What the audit records of a run besides its status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detail {
    /// A command.
    Process,
    /// An `http` handler: the response status, when one arrived.
    Http { status: Option<u16> },
    /// A `prompt` handler: the model that answered and its tokens.
    Prompt {
        model: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
    },
}

/// One handler's run.
#[derive(Debug, Clone)]
pub struct HandlerRun {
    /// The handler.
    pub handler: Arc<Handler>,
    /// How it ended.
    pub status: RunStatus,
    /// Its stdout (UTF-8, lossy), up to the output limit.
    pub stdout: String,
    /// Its stderr (UTF-8, lossy), up to the output limit.
    pub stderr: String,
    /// From start to exit.
    pub duration: Duration,
    /// For the audit.
    pub detail: Detail,
}

/// Runs handlers through the injected process start.
#[derive(Clone)]
pub struct Runner {
    spawner: Arc<dyn ProcessSpawner>,
    launcher: Arc<dyn Launcher>,
    config: RunnerConfig,
    http: Option<(Arc<dyn HttpPort>, Arc<HttpRules>)>,
    judge: Option<Arc<dyn JudgePort>>,
}

impl std::fmt::Debug for Runner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runner")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Runner {
    /// A runner starting processes with `spawner`, built by `launcher`.
    #[must_use]
    pub fn new(
        spawner: Arc<dyn ProcessSpawner>,
        launcher: Arc<dyn Launcher>,
        config: RunnerConfig,
    ) -> Self {
        Self {
            spawner,
            launcher,
            config,
            http: None,
            judge: None,
        }
    }

    /// Runs `http` handlers through `port` under `rules`; without it they fail to start.
    #[must_use]
    pub fn with_http(mut self, port: Arc<dyn HttpPort>, rules: HttpRules) -> Self {
        self.http = Some((port, Arc::new(rules)));
        self
    }

    /// Runs `prompt` handlers through `port`; without it they fail to start.
    #[must_use]
    pub fn with_judge(mut self, port: Arc<dyn JudgePort>) -> Self {
        self.judge = Some(port);
        self
    }

    /// The limits.
    #[must_use]
    pub fn config(&self) -> &RunnerConfig {
        &self.config
    }

    /// Runs every handler of `event` in parallel with `input` on stdin, in `cwd`; results come
    /// back in the handlers' order.
    pub async fn run(
        &self,
        event: HookEvent,
        handlers: &[Arc<Handler>],
        input: &serde_json::Value,
        cwd: &Path,
        cancel: &CancellationToken,
    ) -> Vec<HandlerRun> {
        let bytes: Arc<[u8]> = serde_json::to_vec(input).unwrap_or_default().into();
        let mut tasks = tokio::task::JoinSet::new();
        for (index, handler) in handlers.iter().enumerate() {
            let timeout = event.timeout(handler.kind(), handler.timeout, &self.config.timeouts);
            let handler = Arc::clone(handler);
            let cancel = cancel.clone();
            match &handler.action {
                Action::Command(command) => {
                    let one = One {
                        spec: self.launcher.spec(command, cwd),
                        handler: Arc::clone(&handler),
                        spawner: Arc::clone(&self.spawner),
                        input: Arc::clone(&bytes),
                        timeout,
                        grace: self.config.kill_grace,
                        limit: self.config.output_limit,
                        cancel,
                    };
                    tasks.spawn(async move { (index, one.run().await) });
                }
                Action::Http(http) => {
                    let call = self.http.clone();
                    let (http, input) = (http.clone(), Arc::clone(&bytes));
                    tasks.spawn(async move {
                        let run = post(event, &http, call, &input, timeout, &cancel).await;
                        (index, run.finish(handler))
                    });
                }
                Action::Prompt(prompt) => {
                    let judge = self.judge.clone();
                    let (prompt, input) = (prompt.clone(), Arc::clone(&bytes));
                    tasks.spawn(async move {
                        let run = ask(event, &prompt, judge, &input, timeout, &cancel).await;
                        (index, run.finish(handler))
                    });
                }
            }
        }
        let mut runs: Vec<Option<HandlerRun>> = vec![None; handlers.len()];
        while let Some(joined) = tasks.join_next().await {
            if let Ok((index, run)) = joined {
                runs[index] = Some(run);
            }
        }
        runs.into_iter()
            .zip(handlers)
            .map(|(run, handler)| {
                run.unwrap_or_else(|| HandlerRun {
                    handler: Arc::clone(handler),
                    status: RunStatus::NotStarted("the hook task stopped".into()),
                    stdout: String::new(),
                    stderr: String::new(),
                    duration: Duration::ZERO,
                    detail: Detail::Process,
                })
            })
            .collect()
    }
}

/// The result of an `http` or `prompt` handler before it is tied to its handler.
struct Remote {
    status: RunStatus,
    detail: Detail,
    duration: Duration,
}

impl Remote {
    fn finish(self, handler: Arc<Handler>) -> HandlerRun {
        HandlerRun {
            handler,
            status: self.status,
            stdout: String::new(),
            stderr: String::new(),
            duration: self.duration,
            detail: self.detail,
        }
    }
}

/// How a bounded call ended.
enum Bounded<T> {
    Done(T),
    TimedOut,
    Cancelled,
}

/// `call` within `timeout`, stopped by `cancel` (its future is dropped).
async fn bounded<T>(
    call: impl std::future::Future<Output = T>,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Bounded<T> {
    if cancel.is_cancelled() {
        return Bounded::Cancelled;
    }
    tokio::select! {
        result = tokio::time::timeout(timeout, call) => {
            result.map_or(Bounded::TimedOut, Bounded::Done)
        }
        () = cancel.cancelled() => Bounded::Cancelled,
    }
}

/// An `http` handler's run.
async fn post(
    event: HookEvent,
    http: &Http,
    port: Option<(Arc<dyn HttpPort>, Arc<HttpRules>)>,
    input: &[u8],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Remote {
    let started = Instant::now();
    let done = |status, code| Remote {
        status,
        detail: Detail::Http { status: code },
        duration: started.elapsed(),
    };
    let Some((port, rules)) = port else {
        return done(
            RunStatus::NotStarted("http hooks cannot run here".into()),
            None,
        );
    };
    if !rules.url_allowed(&http.url) {
        return done(
            RunStatus::Failed("its url is not in allowedHttpHookUrls; no request was sent".into()),
            None,
        );
    }
    match bounded(port.post(rules.call(http, input)), timeout, cancel).await {
        Bounded::Done(Ok(reply)) => {
            let status = match read_reply(event, &reply) {
                Ok(json) => RunStatus::Replied(json),
                Err(why) => RunStatus::Failed(why),
            };
            done(status, Some(reply.status))
        }
        Bounded::Done(Err(why)) => done(RunStatus::Failed(why), None),
        Bounded::TimedOut => done(RunStatus::TimedOut(timeout), None),
        Bounded::Cancelled => done(RunStatus::Cancelled, None),
    }
}

/// A `prompt` handler's run.
async fn ask(
    event: HookEvent,
    prompt: &Prompt,
    port: Option<Arc<dyn JudgePort>>,
    input: &[u8],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Remote {
    let started = Instant::now();
    let mut detail = Detail::Prompt {
        model: None,
        input_tokens: 0,
        output_tokens: 0,
    };
    let Some(port) = port else {
        return Remote {
            status: RunStatus::NotStarted("prompt hooks cannot run here".into()),
            detail,
            duration: started.elapsed(),
        };
    };
    let call = JudgeCall {
        prompt: crate::prompt::fill(&prompt.prompt, &String::from_utf8_lossy(input)),
        model: prompt.model.clone(),
        timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
    };
    let status = match bounded(port.judge(call), timeout, cancel).await {
        Bounded::Done(Ok(reply)) => {
            detail = Detail::Prompt {
                model: Some(reply.model.clone()),
                input_tokens: reply.input_tokens,
                output_tokens: reply.output_tokens,
            };
            match crate::prompt::verdict(event, prompt, &reply.text) {
                Ok(json) => RunStatus::Replied(json),
                Err(why) => RunStatus::Failed(why),
            }
        }
        Bounded::Done(Err(why)) => RunStatus::Failed(why),
        Bounded::TimedOut => RunStatus::TimedOut(timeout),
        Bounded::Cancelled => RunStatus::Cancelled,
    };
    Remote {
        status,
        detail,
        duration: started.elapsed(),
    }
}

struct One {
    handler: Arc<Handler>,
    spec: Result<SpawnSpec, Error>,
    spawner: Arc<dyn ProcessSpawner>,
    input: Arc<[u8]>,
    timeout: Duration,
    grace: Duration,
    limit: usize,
    cancel: CancellationToken,
}

enum Ended {
    Exited(std::io::Result<ExitStatus>),
    TimedOut,
    Cancelled,
}

impl One {
    async fn run(self) -> HandlerRun {
        let started = Instant::now();
        let not_started = |reason: String| HandlerRun {
            handler: Arc::clone(&self.handler),
            status: RunStatus::NotStarted(reason),
            stdout: String::new(),
            stderr: String::new(),
            duration: started.elapsed(),
            detail: Detail::Process,
        };
        if self.cancel.is_cancelled() {
            return not_started("cancelled before it started".into());
        }
        let spec = match &self.spec {
            Ok(spec) => spec.clone(),
            Err(reason) => return not_started(reason.to_string()),
        };
        let process = match self.spawner.spawn(spec) {
            Ok(p) => p,
            Err(e) => return not_started(format!("cannot start the hook: {e}")),
        };
        let mut stdin = process.stdin;
        let input = Arc::clone(&self.input);
        // A hook that exits without reading closes the pipe: that write error is expected.
        let writer = tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
        let stdout = reader(process.stdout, self.limit);
        let stderr = reader(process.stderr, self.limit);
        let mut control = process.control;
        let ended = {
            let wait = control.wait();
            tokio::select! {
                status = wait => Ended::Exited(status),
                () = tokio::time::sleep(self.timeout) => Ended::TimedOut,
                () = self.cancel.cancelled() => Ended::Cancelled,
            }
        };
        let status = match ended {
            Ended::Exited(Ok(status)) => RunStatus::Exited(status),
            Ended::Exited(Err(e)) => {
                RunStatus::NotStarted(format!("cannot wait for the hook: {e}"))
            }
            Ended::TimedOut => {
                stop(control.as_mut(), self.grace).await;
                RunStatus::TimedOut(self.timeout)
            }
            Ended::Cancelled => {
                stop(control.as_mut(), self.grace).await;
                RunStatus::Cancelled
            }
        };
        let duration = started.elapsed();
        // Ends what the hook left running, which also closes the pipes it inherited.
        drop(control);
        writer.abort();
        let stdout = finish(stdout).await;
        let stderr = finish(stderr).await;
        HandlerRun {
            handler: self.handler,
            status,
            stdout,
            stderr,
            duration,
            detail: Detail::Process,
        }
    }
}

/// `terminate`, then `kill` when the process is still there after `grace`.
async fn stop(control: &mut dyn ProcessControl, grace: Duration) {
    let _ = control.terminate();
    if tokio::time::timeout(grace, control.wait()).await.is_err() {
        let _ = control.kill();
        let _ = control.wait().await;
    }
}

/// What a reader kept so far: shared so that a pipe a stray process holds open still gives
/// up what it delivered.
type Kept = Arc<std::sync::Mutex<Vec<u8>>>;

/// Reads a pipe to its end, keeping the first `limit` bytes in `kept`.
async fn read_limited(mut pipe: Pin<Box<dyn AsyncRead + Send>>, limit: usize, kept: Kept) {
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut kept = kept
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let room = limit.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..n.min(room)]);
            }
        }
    }
}

/// Starts reading a pipe.
fn reader(
    pipe: Pin<Box<dyn AsyncRead + Send>>,
    limit: usize,
) -> (tokio::task::JoinHandle<()>, Kept) {
    let kept = Kept::default();
    (
        tokio::spawn(read_limited(pipe, limit, Arc::clone(&kept))),
        kept,
    )
}

/// The text a reader kept, once its pipe closed or stayed open past the grace.
async fn finish((task, kept): (tokio::task::JoinHandle<()>, Kept)) -> String {
    let mut task = task;
    if tokio::time::timeout(EXIT_GRACE, &mut task).await.is_err() {
        task.abort();
    }
    let bytes = std::mem::take(
        &mut *kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "runner_remote_tests.rs"]
mod remote_tests;
