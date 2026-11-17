//! piarc-exec: process management (process groups / Job Object, implements ProcessSpawner), shell commands (timeouts, output spooling, exit code meaning, environment, working directory).
//!
//! # Responsibilities
//!
//! - Process management with process groups on macOS and Job Objects on Windows; implements
//!   `ProcessSpawner`.
//! - Runs shell commands: finds the shells, builds their environment, applies timeouts, keeps
//!   output within budget and spools the rest to disk, reads exit codes, tracks the working
//!   directory. Moving timed-out commands to the background is T32's.
//!
//! # Not responsible for
//!
//! - Deciding whether a command may run (`piarc-policy`).
//! - Sandbox profile generation (`piarc-sandbox`).
//! - Interactive terminals and PTYs (`piarc-term`).
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
//!
//! The Windows `job` module is the crate's only unsafe code: a safe wrapper over the Job
//! Object calls (coding standards section 2.8).

pub mod capture;
mod command;
pub mod cwd;
pub mod env;
#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "safe wrapper over the Win32 Job Object API (coding standards section 2.8)"
)]
mod job;
pub mod limits;
pub mod semantic;
pub mod shells;
mod spawner;
#[cfg(test)]
mod termination_tests;
mod tree;

pub use capture::{CapturedOutput, OutputCapture, SpillTarget};
pub use command::{
    CommandExit, CommandRunner, CommandSpec, EXIT_GRACE, Launcher, OutputChunk, Stream,
};
pub use cwd::CwdProbe;
pub use limits::{ExecLimits, Timeout};
pub use semantic::{Interpretation, interpret};
pub use shells::{Shells, msys_to_windows};
pub use spawner::TokioProcessSpawner;
pub use tree::ProcessTreeSpawner;
