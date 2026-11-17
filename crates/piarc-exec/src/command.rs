//! Running a command with streamed output: the work behind AHP's `exec/run`.
//!
//! [`CommandRunner::run`] starts the program of a [`CommandSpec`] (a shell with its arguments:
//! see [`crate::shells`]), closes its stdin, and sends each read from stdout and stderr to an
//! output channel as it arrives. A full channel pauses the reading (and so the command, once
//! its pipe fills); a closed channel or a cancelled token stops the command, and so does its
//! timeout.
//!
//! Stopping is two-step: [`ProcessControl::terminate`] (`SIGTERM` to the process group with
//! [`crate::ProcessTreeSpawner`]), then [`ProcessControl::kill`] once
//! [`CommandSpec::kill_grace`] has passed without an exit. When the shell is gone, the runner
//! drops its handle, which ends whatever the command left behind (the tree spawner kills the
//! group, Windows closes the job).
//!
//! After the shell exits, output is still read until both pipes close or stay quiet for
//! [`EXIT_GRACE`]: a background process the command started can keep a pipe open, and the
//! command's own last writes must not be lost (the same rule as Pi's `waitForChildProcess`).
//!
//! A [`Launcher`] runs the program through a wrapper, the way a sandbox does
//! (`/usr/bin/sandbox-exec … -- /bin/bash -c <command>`).

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use piarc_ports::{BoxFuture, Clock, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// How long output may stay quiet after the shell exited before the run completes.
pub const EXIT_GRACE: Duration = Duration::from_millis(100);

/// Size of one read from a pipe, and so the largest chunk sent.
const READ_CHUNK: usize = 64 * 1024;

/// Which pipe a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Stream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

/// One read from one of the command's pipes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputChunk {
    /// The pipe.
    pub stream: Stream,
    /// The bytes read.
    pub bytes: Vec<u8>,
}

/// What to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// The executable: the shell.
    pub program: PathBuf,
    /// Its arguments (`-c <command>`).
    pub args: Vec<OsString>,
    /// Working directory.
    pub cwd: PathBuf,
    /// The complete environment: nothing is inherited.
    pub env: Vec<(OsString, OsString)>,
    /// A wrapper that starts the program, or `None` to start it directly.
    pub launcher: Option<Launcher>,
    /// Stops the command once it has run this long; `None` lets it run.
    pub timeout: Option<Duration>,
    /// Between the polite request to stop and the kill.
    pub kill_grace: Duration,
}

/// A program that runs the command: `program args… <program of the spec> <its args>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launcher {
    /// The wrapper's executable.
    pub program: PathBuf,
    /// The wrapper's arguments before the wrapped program.
    pub args: Vec<OsString>,
}

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandExit {
    /// The process's exit status.
    pub status: ExitStatus,
    /// Whether it was stopped because the token was cancelled or the output channel closed.
    pub killed: bool,
    /// Whether it was stopped because its timeout passed.
    pub timed_out: bool,
}

/// Runs commands through an injected [`ProcessSpawner`]; timeouts are measured on an injected
/// [`Clock`] (tokio's timer by default).
#[derive(Clone)]
pub struct CommandRunner {
    spawner: Arc<dyn ProcessSpawner>,
    clock: Arc<dyn Clock>,
}

/// The default clock of timeouts: tokio's timer.
struct TokioClock;

impl Clock for TokioClock {
    fn now(&self) -> std::time::Instant {
        tokio::time::Instant::now().into_std()
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

impl std::fmt::Debug for CommandRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandRunner").finish_non_exhaustive()
    }
}

/// Why the watcher stopped the command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    TimedOut,
}

impl CommandRunner {
    /// A runner that starts processes with `spawner`.
    #[must_use]
    pub fn new(spawner: Arc<dyn ProcessSpawner>) -> Self {
        Self::with_clock(spawner, Arc::new(TokioClock))
    }

    /// A runner whose timeouts run on `clock` (tests pass one they advance themselves). The
    /// termination grace and [`EXIT_GRACE`] stay on tokio's timer: they wait for real processes.
    #[must_use]
    pub fn with_clock(spawner: Arc<dyn ProcessSpawner>, clock: Arc<dyn Clock>) -> Self {
        Self { spawner, clock }
    }

    /// Runs `spec`, sending its output to `output`, until it exits, `cancel` fires or its
    /// timeout passes.
    ///
    /// # Errors
    ///
    /// The program cannot be started, or its exit status cannot be read.
    pub async fn run(
        &self,
        spec: CommandSpec,
        output: mpsc::Sender<OutputChunk>,
        cancel: CancellationToken,
    ) -> io::Result<CommandExit> {
        let (program, args) = match spec.launcher {
            Some(launcher) => {
                let mut args = launcher.args;
                args.push(spec.program.into_os_string());
                args.extend(spec.args);
                (launcher.program, args)
            }
            None => (spec.program, spec.args),
        };
        let process = self.spawner.spawn(SpawnSpec {
            program,
            args,
            cwd: spec.cwd,
            env: spec.env,
        })?;
        // The command reads nothing: EOF on its stdin, as Pi's tool gives it.
        drop(process.stdin);
        // Stopping also covers a consumer that went away, and a caller that dropped this
        // future (its request ended): the guard stops the command then.
        let stop = cancel.child_token();
        let _stop_on_drop = stop.clone().drop_guard();
        let (exit_tx, exit_rx) = oneshot::channel();
        let limits = Stopping {
            deadline: spec.timeout.map(|timeout| self.clock.sleep(timeout)),
            grace: spec.kill_grace,
        };
        tokio::spawn(watch(process.control, stop.clone(), limits, exit_tx));
        let pump = Pump {
            output,
            stop: stop.clone(),
        };
        pump.run(process.stdout, process.stderr, exit_rx).await
    }
}

struct Stopping {
    /// Completes when the timeout passes.
    deadline: Option<BoxFuture<'static, ()>>,
    grace: Duration,
}

/// Waits for the process to exit, stopping it first when `stop` fires or the timeout passes.
/// Dropping `control` at the end ends what the command left behind.
async fn watch(
    mut control: Box<dyn ProcessControl>,
    stop: CancellationToken,
    limits: Stopping,
    exit: oneshot::Sender<io::Result<CommandExit>>,
) {
    let deadline = async {
        match limits.deadline {
            Some(deadline) => deadline.await,
            None => std::future::pending().await,
        }
    };
    let exited = {
        let wait = control.wait();
        tokio::select! {
            status = wait => Ok(status),
            () = stop.cancelled() => Err(StopReason::Cancelled),
            () = deadline => Err(StopReason::TimedOut),
        }
    };
    let result = match exited {
        Ok(status) => status.map(|status| CommandExit {
            status,
            killed: false,
            timed_out: false,
        }),
        Err(reason) => stop_process(control.as_mut(), limits.grace)
            .await
            .map(|status| CommandExit {
                status,
                killed: reason == StopReason::Cancelled,
                timed_out: reason == StopReason::TimedOut,
            }),
    };
    drop(control);
    // The runner only stops listening when it was dropped itself.
    let _ = exit.send(result);
}

/// `terminate`, then `kill` when the process has not exited after `grace`.
async fn stop_process(control: &mut dyn ProcessControl, grace: Duration) -> io::Result<ExitStatus> {
    // An error means the process is already gone; its status follows from wait.
    let _ = control.terminate();
    if let Ok(status) = tokio::time::timeout(grace, control.wait()).await {
        return status;
    }
    let _ = control.kill();
    control.wait().await
}

struct Pump {
    output: mpsc::Sender<OutputChunk>,
    stop: CancellationToken,
}

impl Pump {
    async fn run(
        &self,
        mut stdout: std::pin::Pin<Box<dyn AsyncRead + Send>>,
        mut stderr: std::pin::Pin<Box<dyn AsyncRead + Send>>,
        mut exit_rx: oneshot::Receiver<io::Result<CommandExit>>,
    ) -> io::Result<CommandExit> {
        let mut out_buf = vec![0_u8; READ_CHUNK];
        let mut err_buf = vec![0_u8; READ_CHUNK];
        let (mut out_open, mut err_open) = (true, true);
        let mut exit: Option<io::Result<CommandExit>> = None;
        loop {
            if !out_open && !err_open && exit.is_some() {
                break;
            }
            tokio::select! {
                result = &mut exit_rx, if exit.is_none() => {
                    exit = Some(result.unwrap_or_else(|_| Err(io::Error::other("the process watcher stopped"))));
                }
                read = stdout.read(&mut out_buf), if out_open => {
                    out_open = self.forward(Stream::Stdout, read, &out_buf).await;
                }
                read = stderr.read(&mut err_buf), if err_open => {
                    err_open = self.forward(Stream::Stderr, read, &err_buf).await;
                }
                // Re-armed on every chunk: only quiet pipes end the wait after the exit.
                () = tokio::time::sleep(EXIT_GRACE), if exit.is_some() => break,
            }
        }
        exit.unwrap_or_else(|| Err(io::Error::other("the process watcher stopped")))
    }

    /// Sends one read on; returns whether the pipe stays open.
    async fn forward(&self, stream: Stream, read: io::Result<usize>, buffer: &[u8]) -> bool {
        match read {
            Ok(0) | Err(_) => false,
            Ok(n) => {
                let chunk = OutputChunk {
                    stream,
                    bytes: buffer[..n].to_vec(),
                };
                if self.output.send(chunk).await.is_err() {
                    // Nobody reads the output any more: stop the command.
                    self.stop.cancel();
                }
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::{ProcessTreeSpawner, TokioProcessSpawner};

    fn bash() -> PathBuf {
        crate::shells::detect(&crate::shells::Probe::system(&env()), None)
            .bash
            .expect("bash")
    }

    fn env() -> Vec<(OsString, OsString)> {
        std::env::vars_os()
            .filter(|(k, _)| {
                [
                    "PATH",
                    "SystemRoot",
                    "ProgramFiles",
                    "ProgramFiles(x86)",
                    "LOCALAPPDATA",
                ]
                .iter()
                .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
            })
            .collect()
    }

    pub(crate) fn spec(command: &str) -> CommandSpec {
        CommandSpec {
            program: bash(),
            args: crate::shells::bash_args(command),
            cwd: std::env::temp_dir(),
            env: env(),
            launcher: None,
            timeout: None,
            kill_grace: Duration::from_secs(2),
        }
    }

    fn runner() -> CommandRunner {
        CommandRunner::new(Arc::new(ProcessTreeSpawner))
    }

    async fn collect(mut rx: mpsc::Receiver<OutputChunk>) -> (String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        while let Some(chunk) = rx.recv().await {
            match chunk.stream {
                Stream::Stdout => out.extend(chunk.bytes),
                Stream::Stderr => err.extend(chunk.bytes),
            }
        }
        (
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
        )
    }

    #[tokio::test]
    async fn reports_output_and_exit_codes() {
        let (tx, rx) = mpsc::channel(16);
        let reader = tokio::spawn(collect(rx));
        let exit = runner()
            .run(
                spec("printf '中文\\n'; echo oops >&2; exit 3"),
                tx,
                CancellationToken::new(),
            )
            .await
            .expect("runs");
        assert_eq!(exit.status.code, Some(3));
        assert!(!exit.killed && !exit.timed_out);
        assert_eq!(
            reader.await.expect("reader"),
            ("中文\n".to_owned(), "oops\n".to_owned())
        );
    }

    #[tokio::test]
    async fn streams_output_before_the_command_ends() {
        let (tx, mut rx) = mpsc::channel(16);
        let run = tokio::spawn(async move {
            runner()
                .run(
                    spec("echo first; sleep 2; echo second"),
                    tx,
                    CancellationToken::new(),
                )
                .await
        });
        let started = Instant::now();
        let first = rx.recv().await.expect("first chunk");
        assert_eq!(first.bytes, b"first\n");
        assert!(started.elapsed() < Duration::from_millis(1500));
        assert!(!run.is_finished(), "the command is still running");
        let _ = collect(rx).await;
        assert_eq!(
            run.await.expect("joins").expect("runs").status.code,
            Some(0)
        );
    }

    #[tokio::test]
    async fn cancelling_kills_the_command() {
        let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
        let cancel = CancellationToken::new();
        let canceller = cancel.clone();
        // Cancel once the command has started, not after a fixed delay: Git Bash on a busy
        // Windows machine can take longer than that to print anything.
        let reader = tokio::spawn(async move {
            let mut out = Vec::new();
            while let Some(chunk) = rx.recv().await {
                if chunk.stream == Stream::Stdout {
                    out.extend(chunk.bytes);
                    canceller.cancel();
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        });
        let started = Instant::now();
        let exit = runner()
            .run(spec("echo started; sleep 30"), tx, cancel)
            .await
            .expect("runs");
        assert!(exit.killed && !exit.timed_out);
        assert!(!exit.status.success());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(reader.await.expect("reader"), "started\n");
    }

    #[tokio::test]
    async fn the_direct_child_spawner_still_works() {
        let (tx, rx) = mpsc::channel(16);
        let reader = tokio::spawn(collect(rx));
        let exit = CommandRunner::new(Arc::new(TokioProcessSpawner))
            .run(spec("echo plain"), tx, CancellationToken::new())
            .await
            .expect("runs");
        assert_eq!(exit.status.code, Some(0));
        assert_eq!(reader.await.expect("reader").0, "plain\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_launcher_wraps_the_program() {
        let (tx, rx) = mpsc::channel(16);
        let reader = tokio::spawn(collect(rx));
        let mut wrapped = spec("echo \"$PIARC_LAUNCHED $0\"");
        // `env X=1 /bin/bash -c …`: the launcher's arguments come before the program.
        wrapped.launcher = Some(Launcher {
            program: "/usr/bin/env".into(),
            args: vec![OsString::from("PIARC_LAUNCHED=1")],
        });
        let exit = runner()
            .run(wrapped, tx, CancellationToken::new())
            .await
            .expect("runs");
        assert_eq!(exit.status.code, Some(0));
        assert_eq!(
            reader.await.expect("reader").0,
            format!("1 {}\n", bash().display())
        );
    }

    #[tokio::test]
    async fn a_missing_working_directory_fails_to_start() {
        let (tx, _rx) = mpsc::channel(1);
        let mut missing = spec("true");
        missing.cwd = std::env::temp_dir().join("piarc-exec-no-such-dir");
        let error = runner()
            .run(missing, tx, CancellationToken::new())
            .await
            .expect_err("no cwd");
        // Windows reports a missing working directory as ERROR_DIRECTORY ("the directory name
        // is invalid"), which std maps to `NotADirectory`.
        let expected = if cfg!(windows) {
            io::ErrorKind::NotADirectory
        } else {
            io::ErrorKind::NotFound
        };
        assert_eq!(error.kind(), expected);
    }
}
