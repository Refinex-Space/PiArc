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
//! - Snapshot storage and rewind (`piarc-checkpoint`), planned before writes in M2.
//! - Diff computation (`piarc-diff`).
//! - Permission decisions (`piarc-policy`).
//!
//! # Allowed workspace dependencies
//!
//! The foundation crates `piarc-protocol` and `piarc-ports`, plus the registered one-way exception
//! `piarc-checkpoint`: in M2 every write must save the original file content to a checkpoint first
//! (architecture section 6.9). `piarc-checkpoint` never depends on `piarc-fs`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Implemented so far (T07, T16)
//!
//! The file operations behind AHP's `fs/*` (architecture sections 6.1.2 and 6.1.3), as
//! blocking functions over a session [`Scope`]; `piarc-core` runs them on its blocking pool:
//!
//! - path boundary: every path is checked by [`Scope::check`] (normalized, symlinks resolved,
//!   inside the session's directories, not protected for writes) before anything touches it;
//!   what needs approval is [`Error::NeedsApproval`], decided by the caller ([`access`]);
//! - [`read_text`] by range in the file's encoding without splitting characters
//!   ([`encoding`]), [`read_blob`] by reference (streamed, capped), [`mkdir`], [`stat`] (with
//!   image sniffing), [`list`], [`read_pdf`];
//! - the file state table ([`FileStates`]) and path locks ([`PathLocks`]): [`stat_for_read`]
//!   records reads, [`check_fresh`] and [`write()`] refuse stale changes, [`write()`] keeps
//!   encoding, byte order mark and line endings and replaces files atomically;
//! - [`spill()`] keeps long tool results in the session's temporary directory;
//! - [`glob()`] with fd's matching rules and [`grep()`] with ripgrep's libraries, both honoring
//!   ignore files; [`fuzzy`] lists and ranks files for the composer's `@` mentions (T19).
//!
//! Scoped file tools operate relative to directory objects ([`DirectoryBinding`], ADR-0036).
//!
//! [`watch::Watcher`] (T13) watches directories for `piarc-core`, which forwards the changes
//! of settings files to `piarc-config`; T35 builds workspace watching on it.

pub mod access;
mod atomic;
mod bound;
mod content;
pub mod encoding;
mod entry;
mod error;
pub mod fuzzy;
mod glob;
mod grep;
mod image;
mod pdf;
mod scope;
mod spill;
mod state;
#[cfg(test)]
mod testing;
mod walk;
pub mod watch;
mod write;

pub use access::{Access, ApprovalReason};
pub use bound::DirectoryBinding;
pub use content::{DETECT_BYTES, EncodingCache, mkdir, read_blob, read_text};
pub use entry::{MAX_LIST_ENTRIES, list, stat};
pub use error::{Error, Result};
pub use glob::{MAX_GLOB_MATCHES, glob};
pub use grep::{DEFAULT_MATCH_LIMIT, GrepQuery, MAX_LINE_CHARS, MAX_OUTPUT_BYTES, grep};
pub use pdf::{
    MAX_PAGES_PER_READ, MAX_PAGES_WITHOUT_RANGE, pdf_page_count, pdf_page_count_bytes, read_pdf,
};
pub use scope::{Scope, display};
/// Streaming spill files (`spill::create`).
pub use spill::create as create_spill;
pub use spill::{SPILL_DIR, Spilled, model_path, spill};
pub use state::{FileStates, Freshness, Metadata, PathGuard, PathLocks, Snapshot};
pub use write::{
    WriteSpec, Written, check_fresh, reported_encoding, stat_for_read, write, write_checked,
};
