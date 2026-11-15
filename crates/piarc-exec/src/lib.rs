//! piarc-exec: process management (process groups / Job Object, implements ProcessSpawner), output spooling, timeout to background.
//!
//! # Responsibilities
//!
//! - Process management with process groups on macOS and Job Objects on Windows; implements
//!   `ProcessSpawner`.
//! - Spools command output to disk and moves timed-out commands to the background.
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
//! # Implemented so far (T06)
//!
//! [`TokioProcessSpawner`] starts a process with tokio, with exactly the environment given
//! and piped stdio, and kills it when its handle is dropped. It terminates only the direct
//! child: process-group (macOS) and Job Object (Windows) termination of the whole process
//! tree is still to come (`docs/plan/PLAN.md`, I17).

mod spawner;

pub use spawner::TokioProcessSpawner;
