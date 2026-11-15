//! Running a shell command with streamed output: the work behind AHP's `exec/run`.
//!
//! [`CommandRunner::run`] starts the command with bash (`bash -c <command>`, the shell Pi's
//! `bash` tool uses: `/bin/bash` on Unix, Git Bash on Windows), closes its stdin, and sends each
//! read from stdout and stderr to an output channel as it arrives. A full channel pauses the
//! reading (and so the command, once its pipe fills); a closed channel or a cancelled token
//! terminates the command.
//!
//! After the shell exits, output is still read until both pipes close or stay quiet for
//! [`EXIT_GRACE`]: a background process the command started can keep a pipe open, and the
//! command's own last writes must not be lost (the same rule as Pi's `waitForChildProcess`).
//!
//! Only the direct child is terminated so far; process groups and Job Objects, timeouts and
//! moving long commands to the background arrive with T17 (`docs/plan/PLAN.md`, I17).

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use piarc_ports::{ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// How long output may stay quiet after the shell exited before the run completes.
pub const EXIT_GRACE: Duration = Duration::from_millis(100);

/// Size of one read from a pipe, and so the largest chunk sent.
const READ_CHUNK: usize = 64 * 1024;

/// Which pipe a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    /// The command line, passed to `bash -c`.
    pub command: String,
    /// Working directory.
    pub cwd: PathBuf,
    /// The complete environment: nothing is inherited.
    pub env: Vec<(OsString, OsString)>,
}

/// How a command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandExit {
    /// The process's exit status.
    pub status: ExitStatus,
    /// Whether it was terminated because the token was cancelled or the output channel closed.
    pub killed: bool,
}

/// Runs shell commands through an injected [`ProcessSpawner`] (the sandbox wraps it later).
#[derive(Clone)]
pub struct CommandRunner {
    spawner: Arc<dyn ProcessSpawner>,
    shell: PathBuf,
}

impl std::fmt::Debug for CommandRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandRunner")
            .field("shell", &self.shell)
            .finish_non_exhaustive()
    }
}

impl CommandRunner {
    /// A runner that starts processes with `spawner` and the default bash.
    #[must_use]
    pub fn new(spawner: Arc<dyn ProcessSpawner>) -> Self {
        Self {
            spawner,
            shell: default_bash(),
        }
    }

    /// The shell commands run with.
    #[must_use]
    pub fn shell(&self) -> &std::path::Path {
        &self.shell
    }

    /// Runs `spec`, sending its output to `output`, until it exits or `cancel` fires.
    ///
    /// # Errors
    ///
    /// The shell cannot be started, or its exit status cannot be read.
    pub async fn run(
        &self,
        spec: CommandSpec,
        output: mpsc::Sender<OutputChunk>,
        cancel: CancellationToken,
    ) -> io::Result<CommandExit> {
        let process = self.spawner.spawn(SpawnSpec {
            program: self.shell.clone(),
            args: vec![OsString::from("-c"), OsString::from(spec.command)],
            cwd: spec.cwd,
            env: spec.env,
        })?;
        // The command reads nothing: EOF on its stdin, as Pi's tool gives it.
        drop(process.stdin);
        // Stopping also covers a consumer that went away.
        let stop = cancel.child_token();
        let (exit_tx, exit_rx) = oneshot::channel();
        tokio::spawn(watch(process.control, stop.clone(), exit_tx));
        let pump = Pump {
            output,
            stop: stop.clone(),
        };
        pump.run(process.stdout, process.stderr, exit_rx).await
    }
}

/// Waits for the process to exit, killing it first when `stop` fires.
async fn watch(
    mut control: Box<dyn ProcessControl>,
    stop: CancellationToken,
    exit: oneshot::Sender<io::Result<CommandExit>>,
) {
    let exited = {
        let wait = control.wait();
        tokio::select! {
            status = wait => Some(status),
            () = stop.cancelled() => None,
        }
    };
    let result = match exited {
        Some(status) => status.map(|status| CommandExit {
            status,
            killed: false,
        }),
        None => {
            // An error means the process is already gone; its status follows from wait.
            let _ = control.kill();
            control.wait().await.map(|status| CommandExit {
                status,
                killed: true,
            })
        }
    };
    // The runner only stops listening when it was dropped itself.
    let _ = exit.send(result);
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

/// bash as Pi finds it: `/bin/bash`, then `bash` on PATH (Unix); Git Bash under Program Files,
/// then `bash.exe` on PATH (Windows). Telling the user that Git Bash is missing is T17's.
fn default_bash() -> PathBuf {
    if cfg!(windows) {
        for base in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(base) {
                let bash = PathBuf::from(dir).join("Git").join("bin").join("bash.exe");
                if bash.is_file() {
                    return bash;
                }
            }
        }
        PathBuf::from("bash.exe")
    } else if std::path::Path::new("/bin/bash").is_file() {
        PathBuf::from("/bin/bash")
    } else {
        PathBuf::from("bash")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::TokioProcessSpawner;

    fn spec(command: &str) -> CommandSpec {
        CommandSpec {
            command: command.to_owned(),
            cwd: std::env::temp_dir(),
            env: std::env::vars_os()
                .filter(|(k, _)| k == "PATH" || k == "SystemRoot")
                .collect(),
        }
    }

    fn runner() -> CommandRunner {
        CommandRunner::new(Arc::new(TokioProcessSpawner))
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
        assert!(!exit.killed);
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
        let (tx, rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let reader = tokio::spawn(collect(rx));
        let canceller = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            canceller.cancel();
        });
        let started = Instant::now();
        let exit = runner()
            .run(spec("echo started; exec sleep 30"), tx, cancel)
            .await
            .expect("runs");
        assert!(exit.killed);
        assert!(!exit.status.success());
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(reader.await.expect("reader").0, "started\n");
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
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
