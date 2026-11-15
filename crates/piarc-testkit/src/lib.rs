//! piarc-testkit: test support: strict mock provider, scenario runner and event assertions.
//!
//! # Responsibilities
//!
//! - Test-only support: the strict mock provider, the scenario runner and event assertions.
//!
//! # Not responsible for
//!
//! - Anything shipped in the app: production crates must never depend on it.
//!
//! # Allowed workspace dependencies
//!
//! `piarc-core` and the foundation crates `piarc-protocol` and `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
