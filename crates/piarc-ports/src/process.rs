//! Starting processes with piped stdio.

use std::ffi::OsString;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;

use tokio::io::{AsyncRead, AsyncWrite};

/// A boxed, sendable future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    /// The executable.
    pub program: PathBuf,
    /// Arguments after the program name.
    pub args: Vec<OsString>,
    /// Working directory.
    pub cwd: PathBuf,
    /// The complete environment of the new process: nothing is inherited from the caller.
    pub env: Vec<(OsString, OsString)>,
}

/// How a process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitStatus {
    /// The exit code, when the process exited normally.
    pub code: Option<i32>,
    /// The terminating signal on Unix, when a signal ended the process.
    pub signal: Option<i32>,
}

impl ExitStatus {
    /// Whether the process exited with code 0.
    #[must_use]
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

/// A started process: its three stdio pipes and its control handle.
pub struct SpawnedProcess {
    /// The process's stdin.
    pub stdin: Pin<Box<dyn AsyncWrite + Send>>,
    /// The process's stdout.
    pub stdout: Pin<Box<dyn AsyncRead + Send>>,
    /// The process's stderr.
    pub stderr: Pin<Box<dyn AsyncRead + Send>>,
    /// Kills the process and reports its exit.
    pub control: Box<dyn ProcessControl>,
}

/// Controls a started process.
pub trait ProcessControl: Send {
    /// The operating system's process id, while the process runs.
    fn pid(&self) -> Option<u32>;

    /// Starts terminating the process forcibly; [`ProcessControl::wait`] reports the exit.
    ///
    /// # Errors
    ///
    /// The operating system's error when the signal cannot be sent.
    fn kill(&mut self) -> io::Result<()>;

    /// Completes when the process has exited.
    fn wait(&mut self) -> BoxFuture<'_, io::Result<ExitStatus>>;
}

/// Starts processes. `piarc-exec` provides the implementation; `piarc-core` injects it.
pub trait ProcessSpawner: Send + Sync {
    /// Starts `spec` with piped stdin, stdout and stderr.
    ///
    /// # Errors
    ///
    /// The operating system's error when the process cannot be started.
    fn spawn(&self, spec: SpawnSpec) -> io::Result<SpawnedProcess>;
}
