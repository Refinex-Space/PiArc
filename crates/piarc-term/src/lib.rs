//! piarc-term: terminal sessions: PTY (portable-pty) plus libghostty-vt terminal state, screen snapshots (ADR-0017).
//!
//! # Responsibilities
//!
//! - Terminal sessions: PTY (`portable-pty`) plus libghostty-vt terminal state, and screen
//!   snapshots (ADR-0017).
//!
//! # Not responsible for
//!
//! - Raw libghostty-vt bindings and prebuilt artefact handling (`piarc-ghostty-sys`).
//! - Rendering, which happens in the desktop client.
//!
//! # Allowed workspace dependencies
//!
//! The foundation crates `piarc-protocol` and `piarc-ports`, plus the registered one-way exception
//! `piarc-ghostty-sys`: it is the `-sys` layer whose only consumer is this crate.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

mod error;
pub mod frame;
pub mod keymap;
pub mod session;
#[allow(
    unsafe_code,
    reason = "the safe wrapper over the libghostty-vt bindings (ADR-0017); unsafe stays inside it"
)]
pub mod vt;

pub use error::{Error, Result};
pub use session::{Event, EventHandler, Program, Session, SessionConfig, SessionStats};
