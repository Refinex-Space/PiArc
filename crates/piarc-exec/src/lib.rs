//! piarc-exec: process management (process groups / Job Object, implements ProcessSpawner), shell commands (timeouts, output spooling, exit code meaning, environment, working directory).
//!
//! # Responsibilities
//!
//! - Process management with process groups on macOS and Job Objects on Windows; implements
//!   `ProcessSpawner`.
//! - Runs shell commands: finds the shells, builds their environment, applies timeouts, keeps
//!   output within budget and spools the rest to disk, reads exit codes, tracks the working
//!   directory; writes background tasks' output files (T32).
//!
//! # Not responsible for
//!
//! - Deciding whether a command may run (`piarc-policy`).
//! - Sandbox profile generation (`piarc-sandbox`).
//! - Interactive terminals and PTYs (`piarc-term`); it only ends their process trees.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Implemented so far
//!
//! - [`TokioProcessSpawner`] (T06) starts a process with tokio, with exactly the environment
//!   given and piped stdio, and kills only the direct child.
//! - [`ProcessTreeSpawner`] (T11) ends the whole process tree: a process group on Unix
//!   (`SIGTERM`, then `SIGKILL`), a Job Object with `KILL_ON_JOB_CLOSE` on Windows (the child
//!   joins it before running). Core runs every command with it (T17).
//! - [`CommandRunner`] (T07, T17) runs a program with streamed stdout and stderr, a timeout and
//!   a two-step stop (terminate, grace, kill): the work behind AHP's `exec/run`.
//! - T17, the shell command behavior of architecture section 6.11:
//!   [`limits`] (timeouts and output budgets in one place), [`capture`] (inline output, preview,
//!   head and tail, the full text spooled to a file), [`semantic`] (exit codes that are answers,
//!   such as `grep`'s 1), [`env`] (the login shell's environment without PiArc's own variables),
//!   [`shells`] (finding bash, Git Bash and PowerShell, and how they are invoked) and [`cwd`]
//!   (the directory a bash command ended in).
//! - T32: [`task_log`] (a background task's output file: bytes in read order, lines per pipe,
//!   the last lines kept, byte ranges read back as text) and [`OutputCapture::hand_over`]
//!   (what a foreground command printed before its timeout moved it to the background).
//!
//! - T33: [`terminal_tree`] ends what a terminal's shell started (every process attached to
//!   the PTY on macOS, a Job Object on Windows).
//! - T39: [`Error`], with `kind()` and `retryable()`, for the file and process functions
//!   ([`TaskLog`], [`task_log::read_chunk`], [`terminal_tree::TerminalTree::attach`], [`CwdProbe`]).
//!
//! - ADR-0092: [`listeners`] (the TCP ports a process tree listens on: `lsof` on macOS,
//!   `GetExtendedTcpTable` and parent links on Windows).
//!
//! The Windows `job` module (a safe wrapper over the Job Object calls and the process
//! snapshot), the Windows `tcp_table` module (one `GetExtendedTcpTable` call per address
//! family), the macOS `tty_processes` module (one `proc_listpids` call) and the Unix `session`
//! module (one `setsid` hook between `fork` and `exec`, for the login shell probe) are the
//! crate's only unsafe code (coding standards section 2.8).

pub mod capture;
mod command;
pub mod cwd;
pub mod env;
mod error;
#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "safe wrapper over the Win32 Job Object API (coding standards section 2.8)"
)]
mod job;
pub mod limits;
pub mod listeners;
pub mod semantic;
#[cfg(unix)]
#[allow(
    unsafe_code,
    reason = "safe wrapper over one pre_exec setsid hook (coding standards section 2.8)"
)]
mod session;
pub mod shells;
mod spawner;
pub mod task_log;
#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "safe wrapper over GetExtendedTcpTable (coding standards section 2.8)"
)]
mod tcp_table;
pub mod terminal_tree;
#[cfg(test)]
mod termination_tests;
mod tree;
#[cfg(target_os = "macos")]
#[allow(
    unsafe_code,
    reason = "safe wrapper over one libproc call (coding standards section 2.8)"
)]
mod tty_processes;

pub use capture::{CapturedOutput, Handover, OutputCapture, SpillTarget};
pub use command::{
    CommandExit, CommandRunner, CommandSpec, EXIT_GRACE, Launcher, OutputChunk, Stream,
};
pub use cwd::CwdProbe;
pub use error::{Error, Result};
pub use limits::{ExecLimits, Timeout};
pub use semantic::{Interpretation, interpret};
pub use shells::{Shells, msys_to_windows};
pub use spawner::TokioProcessSpawner;
pub use task_log::TaskLog;
pub use tree::ProcessTreeSpawner;
