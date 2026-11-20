//! piarc-policy: permission modes and rules, Bash command analysis (tree-sitter-bash), approval ledger.
//!
//! # Responsibilities
//!
//! - Permission modes and rules, and the permission decision.
//! - Bash command analysis (tree-sitter-bash).
//! - The approval ledger for pending approvals.
//!
//! # Not responsible for
//!
//! - Executing commands (`piarc-exec`) or hooks (`piarc-hooks`).
//! - Loading and merging settings files (`piarc-config`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod bash;
mod decision;
mod error;
mod ledger;
pub mod paths;
pub mod pattern;
pub mod rules;

pub use decision::{
    Boundary, HookVerdict, Input, MustAsk, NOT_IN_PLAN_MODE, Outcome, PLAN_MODE_REFUSAL, Ruling,
    after_permission_request, decide, starting_mode,
};
pub use error::Error;
pub use ledger::Ledger;
