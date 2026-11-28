//! Running one git command for the Git panel (ADR-0085): an output limit, stderr read as it
//! arrives (progress), cancellation that stops the process tree, and per-call timeouts.

use std::ffi::OsStr;
use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use piarc_ports::{ProcessControl, SpawnSpec};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use crate::git::{Git, GitError, joined, read_all, subcommand};

/// The most standard output a panel command keeps; more marks the output truncated.
pub const STDOUT_LIMIT: usize = 16 * 1024 * 1024;
/// The end of standard error a command keeps.
pub const STDERR_TAIL: usize = 8 * 1024;
/// Read-only queries.
pub const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Local writes (stage, commit with hooks, checkout).
pub const WRITE_TIMEOUT: Duration = Duration::from_mins(2);
/// Fetch, pull and push.
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(10);
/// How long a stopped process may take to exit before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(2);

/// Called with each line (or carriage-return segment) git writes to stderr.
pub type Progress = Arc<dyn Fn(&str) + Send + Sync>;

/// Cancels the commands that hold a clone of it. Cheap to clone.
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for Cancel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Cancel").field(&self.is_cancelled()).finish()
    }
}

impl Cancel {
    /// A token nobody has cancelled.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops the commands holding this token (and every later one).
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    /// Whether [`Cancel::cancel`] was called.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Completes once cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How [`Git::exec`] runs one command.
#[derive(Clone, Default)]
pub struct ExecOptions {
    /// The time limit; the runner's own when absent.
    pub timeout: Option<Duration>,
    /// Written to stdin, which is then closed.
    pub stdin: Vec<u8>,
    /// The most stdout kept; [`STDOUT_LIMIT`] when absent.
    pub stdout_limit: Option<usize>,
    /// Receives stderr as it arrives.
    pub progress: Option<Progress>,
    /// Stops the command.
    pub cancel: Option<Cancel>,
}

impl fmt::Debug for ExecOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecOptions")
            .field("timeout", &self.timeout)
            .field("stdin", &self.stdin.len())
            .field("stdout_limit", &self.stdout_limit)
            .field("progress", &self.progress.is_some())
            .field("cancel", &self.cancel)
            .finish()
    }
}

impl ExecOptions {
    /// Options with `timeout`.
    #[must_use]
    pub fn timeout(timeout: Duration) -> Self {
        Self {
            timeout: Some(timeout),
            ..Self::default()
        }
    }
}

/// What a command printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    /// The exit code; `None` when a signal ended the process.
    pub code: Option<i32>,
    /// Standard output up to the limit.
    pub stdout: Vec<u8>,
    /// Standard output went past the limit.
    pub truncated: bool,
    /// The end of standard error, trimmed.
    pub stderr: String,
}

impl ExecOutput {
    /// Whether git exited with 0.
    #[must_use]
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

impl Git {
    /// Runs `git <args>` in `cwd` with `options` and returns what it printed, whatever its
    /// exit code.
    ///
    /// # Errors
    ///
    /// [`GitError::Spawn`], [`GitError::Wait`], [`GitError::TimedOut`] or
    /// [`GitError::Cancelled`].
    pub async fn exec<S: AsRef<OsStr>>(
        &self,
        cwd: &Path,
        args: &[S],
        options: ExecOptions,
    ) -> Result<ExecOutput, GitError> {
        let command = subcommand(args);
        if options.cancel.as_ref().is_some_and(Cancel::is_cancelled) {
            return Err(GitError::Cancelled { command });
        }
        let spec = SpawnSpec {
            program: self.program.clone(),
            args: self
                .prefix()
                .iter()
                .map(std::ffi::OsString::from)
                .chain(args.iter().map(|a| a.as_ref().to_owned()))
                .collect(),
            cwd: cwd.to_owned(),
            env: self.env.clone(),
        };
        let mut process = self.spawner.spawn(spec).map_err(GitError::Spawn)?;
        let mut stdin = process.stdin;
        let input = options.stdin;
        let writer = tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
        let limit = options.stdout_limit.unwrap_or(STDOUT_LIMIT);
        let stdout = tokio::spawn(read_all(process.stdout, limit.saturating_add(1)));
        let stderr = tokio::spawn(read_stderr(process.stderr, options.progress));
        let timeout = options.timeout.unwrap_or(self.timeout);
        let ended = {
            let wait = tokio::time::timeout(timeout, process.control.wait());
            let cancel = options.cancel.clone();
            tokio::select! {
                result = wait => Some(result),
                () = async move {
                    match cancel {
                        Some(cancel) => cancel.cancelled().await,
                        None => std::future::pending().await,
                    }
                } => None,
            }
        };
        let status = match ended {
            Some(Ok(status)) => status.map_err(GitError::Wait)?,
            Some(Err(_)) => {
                stop(process.control.as_mut()).await;
                return Err(GitError::TimedOut { command });
            }
            None => {
                stop(process.control.as_mut()).await;
                return Err(GitError::Cancelled { command });
            }
        };
        let _ = writer.await;
        let mut stdout = joined(stdout).await?;
        let truncated = stdout.len() > limit;
        stdout.truncate(limit);
        let stderr = stderr
            .await
            .map_err(|e| GitError::Wait(std::io::Error::other(e)))?
            .map_err(GitError::Wait)?;
        Ok(ExecOutput {
            code: status.code,
            stdout,
            truncated,
            stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
        })
    }
}

/// Asks the process tree to exit, then kills it after the grace period.
async fn stop(control: &mut dyn ProcessControl) {
    let _ = control.terminate();
    if tokio::time::timeout(STOP_GRACE, control.wait())
        .await
        .is_err()
    {
        let _ = control.kill();
        let _ = control.wait().await;
    }
}

/// Reads stderr to the end: hands each line to `progress` and keeps the last
/// [`STDERR_TAIL`] bytes.
async fn read_stderr(
    mut pipe: std::pin::Pin<Box<dyn AsyncRead + Send>>,
    progress: Option<Progress>,
) -> std::io::Result<Vec<u8>> {
    let mut tail: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            if let Some(report) = &progress {
                emit(report, &line);
            }
            if tail.len() > STDERR_TAIL {
                tail.drain(..tail.len() - STDERR_TAIL);
            }
            return Ok(tail);
        }
        let chunk = &buffer[..n];
        tail.extend_from_slice(chunk);
        if tail.len() > STDERR_TAIL * 2 {
            tail.drain(..tail.len() - STDERR_TAIL);
        }
        if let Some(report) = &progress {
            for &byte in chunk {
                if byte == b'\r' || byte == b'\n' {
                    emit(report, &line);
                    line.clear();
                } else if line.len() < 1024 {
                    line.push(byte);
                }
            }
        }
    }
}

fn emit(report: &Progress, line: &[u8]) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if !text.is_empty() {
        report(text);
    }
}
