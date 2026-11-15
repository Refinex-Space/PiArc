//! piarc-diff: diff computation (similar), hunk structure, large-diff degradation, UTF-16 offsets.
//!
//! # Responsibilities
//!
//! - Diff computation (`similar`) and hunk structure.
//! - Degradation for large diffs and UTF-16 offsets for the client.
//!
//! # Not responsible for
//!
//! - Reading files or repositories (`piarc-fs`, `piarc-git`).
//! - Rendering diffs.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
