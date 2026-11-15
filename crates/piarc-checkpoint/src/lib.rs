//! piarc-checkpoint: content-addressed snapshot store, checkpoint index, rewind and conflict detection.
//!
//! # Responsibilities
//!
//! - Content-addressed, deduplicated snapshot storage and the checkpoint index.
//! - Rewind, including detection of conflicts with files changed outside PiArc.
//!
//! # Not responsible for
//!
//! - Performing file edits (`piarc-fs`).
//! - Git operations (`piarc-git`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
