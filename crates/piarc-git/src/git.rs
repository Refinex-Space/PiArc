//! Running the `git` program (T35): every worktree operation goes through [`Git`], which starts
//! the process with the injected [`ProcessSpawner`] and the caller's environment.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_ports::{ProcessSpawner, SpawnSpec};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// The most stderr a failed command reports.
const STDERR_LIMIT: usize = 4 * 1024;

/// How long one git command may run before it is killed.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

/// Why a git command failed.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// The program could not be started.
    #[error("cannot start git: {0}")]
    Spawn(#[source] std::io::Error),
    /// Reading its output or waiting for it failed.
    #[error("git did not complete: {0}")]
    Wait(#[source] std::io::Error),
    /// It ran longer than the timeout and was killed.
    #[error("git {command} timed out")]
    TimedOut {
        /// The git subcommand.
        command: String,
    },
    /// The caller cancelled it and it was stopped.
    #[error("git {command} was cancelled")]
    Cancelled {
        /// The git subcommand.
        command: String,
    },
    /// It exited with a failure.
    #[error("git {command} failed: {stderr}")]
    Failed {
        /// The git subcommand.
        command: String,
        /// Its exit code (none when a signal ended it).
        code: Option<i32>,
        /// The start of its standard error, trimmed.
        stderr: String,
    },
}

/// What a finished command printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// The exit code; `None` when a signal ended the process.
    pub code: Option<i32>,
    /// Standard output, complete.
    pub stdout: Vec<u8>,
    /// The start of standard error.
    pub stderr: String,
}

/// Runs `git` with a fixed program, environment and timeout. Cheap to clone.
#[derive(Clone)]
pub struct Git {
    pub(crate) spawner: Arc<dyn ProcessSpawner>,
    pub(crate) program: PathBuf,
    pub(crate) env: Vec<(OsString, OsString)>,
    pub(crate) timeout: Duration,
}

impl std::fmt::Debug for Git {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Git")
            .field("program", &self.program)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl Git {
    /// `program` started by `spawner` with exactly `env`, plus `GIT_TERMINAL_PROMPT=0` (git
    /// never waits for a password nobody can type).
    #[must_use]
    pub fn new(
        spawner: Arc<dyn ProcessSpawner>,
        program: PathBuf,
        mut env: Vec<(OsString, OsString)>,
    ) -> Self {
        env.retain(|(name, _)| name != "GIT_TERMINAL_PROMPT");
        env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
        Self {
            spawner,
            program,
            env,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// The git program this runner starts.
    #[must_use]
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// The same runner with another timeout (tests).
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The same runner with `name` set to `value` (replacing an inherited value), e.g.
    /// `GCM_INTERACTIVE=never` for an automatic fetch nobody is watching.
    #[must_use]
    pub fn with_env(mut self, name: &str, value: &str) -> Self {
        self.env.retain(|(n, _)| n != name);
        self.env.push((name.into(), value.into()));
        self
    }

    /// Runs `git <args>` in `cwd` and returns what it printed, whatever its exit code.
    ///
    /// # Errors
    ///
    /// [`GitError::Spawn`], [`GitError::Wait`] or [`GitError::TimedOut`].
    pub async fn run<S: AsRef<OsStr>>(&self, cwd: &Path, args: &[S]) -> Result<Output, GitError> {
        self.run_with_input(cwd, args, Vec::new()).await
    }

    /// Like [`Git::run`], writing `input` to git's standard input first.
    ///
    /// # Errors
    ///
    /// The errors of [`Git::run`].
    pub async fn run_with_input<S: AsRef<OsStr>>(
        &self,
        cwd: &Path,
        args: &[S],
        input: Vec<u8>,
    ) -> Result<Output, GitError> {
        let command = subcommand(args);
        // Git for Windows refuses paths longer than 260 characters (a deep worktree, a clone
        // under the data directory) unless `core.longpaths` is on; other platforms' git
        // ignores the key (W3).
        let spec = SpawnSpec {
            program: self.program.clone(),
            args: [OsStr::new("-c"), OsStr::new("core.longpaths=true")]
                .into_iter()
                .map(OsStr::to_owned)
                .chain(args.iter().map(|a| a.as_ref().to_owned()))
                .collect(),
            cwd: cwd.to_owned(),
            env: self.env.clone(),
        };
        let mut process = self.spawner.spawn(spec).map_err(GitError::Spawn)?;
        // Closing stdin after the input lets a read end at once.
        let mut stdin = process.stdin;
        let writer = tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
        let stdout = tokio::spawn(read_all(process.stdout, usize::MAX));
        let stderr = tokio::spawn(read_all(process.stderr, STDERR_LIMIT));
        let status = match tokio::time::timeout(self.timeout, process.control.wait()).await {
            Ok(status) => status.map_err(GitError::Wait)?,
            Err(_) => {
                let _ = process.control.kill();
                let _ = process.control.wait().await;
                return Err(GitError::TimedOut { command });
            }
        };
        let _ = writer.await;
        let stdout = joined(stdout).await?;
        let stderr = joined(stderr).await?;
        Ok(Output {
            code: status.code,
            stdout,
            stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
        })
    }

    /// Runs `git <args>` in `cwd` and returns its standard output when it exits with 0.
    ///
    /// # Errors
    ///
    /// The errors of [`Git::run`], and [`GitError::Failed`] for another exit.
    pub async fn ok<S: AsRef<OsStr>>(&self, cwd: &Path, args: &[S]) -> Result<Vec<u8>, GitError> {
        let output = self.run(cwd, args).await?;
        if output.code == Some(0) {
            Ok(output.stdout)
        } else {
            Err(GitError::Failed {
                command: subcommand(args),
                code: output.code,
                stderr: output.stderr,
            })
        }
    }
}

/// The first argument that is not an option: what error messages name.
pub(crate) fn subcommand<S: AsRef<OsStr>>(args: &[S]) -> String {
    let mut iter = args.iter().map(|a| a.as_ref().to_string_lossy());
    while let Some(arg) = iter.next() {
        if arg == "-c" || arg == "-C" {
            iter.next();
        } else if !arg.starts_with('-') {
            return arg.into_owned();
        }
    }
    "git".into()
}

pub(crate) async fn read_all(
    mut pipe: std::pin::Pin<Box<dyn AsyncRead + Send>>,
    limit: usize,
) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let n = pipe.read(&mut buffer).await?;
        if n == 0 {
            return Ok(kept);
        }
        let room = limit.saturating_sub(kept.len()).min(n);
        kept.extend_from_slice(&buffer[..room]);
    }
}

pub(crate) async fn joined(
    task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, GitError> {
    task.await
        .map_err(|e| GitError::Wait(std::io::Error::other(e)))?
        .map_err(GitError::Wait)
}

/// The `git` program on `path` (a `PATH` value): the first absolute entry holding it, never
/// one inside `exclude` (a workspace must not supply the git PiArc runs for it).
#[must_use]
pub fn find_program(path: &OsStr, exclude: Option<&Path>) -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .filter_map(|dir| crate::canonical(&dir.join(name)).ok())
        .find(|p| p.is_file() && exclude.is_none_or(|root| !p.starts_with(root)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subcommands_skip_options_and_config() {
        assert_eq!(subcommand(&["-c", "a=b", "worktree", "add"]), "worktree");
        assert_eq!(subcommand(&["--no-pager", "status"]), "status");
        assert_eq!(subcommand::<&str>(&[]), "git");
    }
}
