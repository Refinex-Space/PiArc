//! piarc-checkpoint: content-addressed snapshot store, checkpoint index, rewind and conflict detection.
//!
//! # Responsibilities
//!
//! - Content-addressed, deduplicated snapshot storage ([`ObjectStore`]): objects named by their
//!   SHA-256 under `<data dir>/checkpoints/objects/<2 hex>/<64 hex>`, pinned while in use,
//!   collected when no index record refers to them.
//! - The rules of a rewind, an undo and the Changes panel's base over the index records
//!   ([`plan`]): which content each file goes back to, and which files conflict because they
//!   changed outside the session.
//! - The retention policy ([`RetentionPolicy`]).
//!
//! # Not responsible for
//!
//! - Performing file edits (`piarc-fs`): it stores the old bytes here before each write and
//!   writes the planned content back.
//! - Storing the index (`piarc-store`, tables `checkpoints` and `checkpoint_files`) and running
//!   rewinds and retention (`piarc-core::checkpoints`).
//! - Git operations (`piarc-git`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`; `piarc-fs` depends on this crate (registered one-way
//! exception), never the reverse.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

mod error;
pub mod plan;
mod retention;
mod store;
#[cfg(test)]
mod testing;

pub use error::{Error, Result};
pub use plan::{Baseline, FileRecord, Operation, PlannedFile, Step};
pub use retention::{DEFAULT_IDLE, DEFAULT_MAX_CHECKPOINTS, RetentionPolicy};
pub use store::{Collected, Collection, Hash, ObjectStore, Pin, from_hex, hash_of, to_hex};
