//! piarc-sandbox: macOS Seatbelt profile generation, local network proxy; Windows isolation (evaluated in M4).
//!
//! # Responsibilities
//!
//! - Generates macOS Seatbelt profiles per command.
//! - Runs the local network proxy that applies the domain allowlist.
//! - Windows isolation, to be evaluated in M4 (architecture section 6.10).
//!
//! # Not responsible for
//!
//! - Spawning processes (`piarc-exec`, through `ProcessSpawner`).
//! - Permission rules (`piarc-policy`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Implemented so far (T11, T39)
//!
//! - [`SandboxPolicy`] → [`ResolvedPolicy`]: writable directories, `denyRead`, the protected
//!   paths ([`PROTECTED_PATHS`]), canonical and with symlinks resolved.
//! - [`CommandSandbox`] and [`platform_sandbox`]: Seatbelt on macOS (`seatbelt` module: one
//!   profile per command, paths passed as `sandbox-exec -D` parameters), none elsewhere.
//! - [`sandbox_env`]: proxy variables, `TMPDIR` and package caches in the session's
//!   temporary directory.
//! - [`SessionSandbox`]: one session's proxy; `launch(policy)` resolves the policy as it stands
//!   and gives the wrapper and environment of one command (T39: no profile outlives its
//!   command).
//! - [`proxy`]: the local HTTP/`CONNECT` proxy with the domain allowlist, refusing loopback and
//!   cloud metadata destinations; hosts outside the allowlist are put to its owner's hooks,
//!   refusals reported (T39).
//!
//! - [`agent_host_launch`] (T12, finalized in T39, macOS): the `sandbox-exec` wrapper of the
//!   Agent Host's profile (writes limited to the workspace without its protected paths and to
//!   the Agent Host's places in PiArc's data directory).
//! - [`denials`] (T39): the paths a failed sandboxed command was refused, read from its
//!   output and checked against its policy.
//!
//! `piarc-core` hands the wrapper to `piarc-exec`, which runs it with its process-tree spawner;
//! this crate starts no processes.

pub mod denials;
mod env;
mod error;
mod platform;
mod policy;
pub mod proxy;
#[cfg(target_os = "macos")]
pub mod seatbelt;
mod session;

pub use env::sandbox_env;
pub use error::{Error, Result};
pub use platform::{CommandSandbox, SandboxedLaunch, launch_failed, platform_sandbox};
#[cfg(target_os = "macos")]
pub use platform::{Seatbelt, agent_host_launch};
pub use policy::{PROTECTED_PATHS, ResolvedPolicy, SandboxPolicy};
pub use session::SessionSandbox;
