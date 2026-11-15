//! piarc-git: Git status, diff, worktrees and branches.
//!
//! # Responsibilities
//!
//! - Git status, diff, worktrees and branches.
//!
//! # Not responsible for
//!
//! - Text diff computation (`piarc-diff`).
//! - Checkpoints and rewind (`piarc-checkpoint`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
