//! piarc-hooks: hooks configuration parsing, matching, execution and decision merging.
//!
//! # Responsibilities
//!
//! - Parses hooks configuration, matches hooks to events, executes them and merges their decisions.
//!
//! # Not responsible for
//!
//! - Process tree management: hook commands run through the `ProcessSpawner` injected by `piarc-
//!   core`.
//! - Permission rules (`piarc-policy`).
//! - Loading and merging settings files (`piarc-config`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
