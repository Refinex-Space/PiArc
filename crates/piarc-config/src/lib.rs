//! piarc-config: layered settings loading and merging (PiArc and Claude Code compatibility), project trust, configuration diagnostics.
//!
//! # Responsibilities
//!
//! - Loads and merges layered settings: PiArc settings plus the Claude Code compatibility layer.
//! - Project trust.
//! - Configuration diagnostics.
//!
//! # Not responsible for
//!
//! - Interpreting permission rules or hooks (`piarc-policy`, `piarc-hooks`).
//! - Writing to `.claude/`: Claude Code configuration is read-only for PiArc.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
