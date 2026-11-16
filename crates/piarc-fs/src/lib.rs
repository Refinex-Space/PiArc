//! piarc-fs: file read/write, file state table, glob and grep, file watching.
//!
//! # Responsibilities
//!
//! - File reading and writing, and the file state table.
//! - Glob and grep (`ignore`, `grep-searcher`).
//! - File watching (`notify`).
//!
//! # Not responsible for
//!
//! - Snapshot storage and rewind (`piarc-checkpoint`), which it calls before writing.
//! - Diff computation (`piarc-diff`).
//! - Permission decisions (`piarc-policy`).
//!
//! # Allowed workspace dependencies
//!
//! The foundation crates `piarc-protocol` and `piarc-ports`, plus the registered one-way exception
//! `piarc-checkpoint`: every write must save the original file content to a checkpoint first
//! (architecture section 6.9). `piarc-checkpoint` never depends on `piarc-fs`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Implemented so far (T07)
//!
//! The minimal, correct file operations behind AHP's `fs/*` (architecture section 6.1.3), as
//! blocking functions over a session [`Scope`]; `piarc-core` runs them on its blocking pool:
//!
//! - path boundary: every path is resolved by [`Scope::resolve`] (normalized, symlinks
//!   resolved, inside the workspace root) before anything touches it;
//! - [`read_text`] by range without splitting UTF-8, [`read_blob`] by reference, [`write`],
//!   [`mkdir`], [`stat`] (with image sniffing), [`list`];
//! - [`glob()`] with fd's matching rules and [`grep()`] with ripgrep's libraries, both honoring
//!   ignore files.
//!
//! This crate implements file I/O, so it uses `std::fs` directly. The editing invariants of
//! architecture section 6.1.2 (read before edit, faithful atomic writes, the file state table,
//! asking instead of refusing outside the root) arrive with T16.
//!
//! [`watch::Watcher`] (T13) watches directories for `piarc-core`, which forwards the changes
//! of settings files to `piarc-config`; T35 builds workspace watching on it.

mod content;
mod entry;
mod error;
mod glob;
mod grep;
mod image;
mod scope;
#[cfg(test)]
mod testing;
pub mod watch;

pub use content::{mkdir, read_blob, read_text, write};
pub use entry::{MAX_LIST_ENTRIES, list, stat};
pub use error::{Error, Result};
pub use glob::{MAX_GLOB_MATCHES, glob};
pub use grep::{DEFAULT_MATCH_LIMIT, GrepQuery, MAX_LINE_CHARS, MAX_OUTPUT_BYTES, grep};
pub use scope::{Scope, display};
