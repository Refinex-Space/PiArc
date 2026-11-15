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
