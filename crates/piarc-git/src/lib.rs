//! piarc-git: Git status, diff, worktrees and branches.
//!
//! # Responsibilities
//!
//! - Git status, diff, worktrees and branches.
//! - T13: the main checkout of a directory, the key of project trust ([`checkout`]).
//! - T35: PiArc's worktrees ([`worktree`]), with git run through the injected process spawner
//!   ([`git`]).
//! - T40: clones of extension packages pinned to a commit, and their explicit update
//!   ([`package`]).
//! - T46: the remotes a working tree's repository configures ([`remotes`]).
//!
//! # Not responsible for
//!
//! - Text diff computation (`piarc-diff`).
//! - Checkpoints and rewind (`piarc-checkpoint`).
//! - Storing trust decisions (`piarc-store`) or deciding trust (`piarc-config`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod checkout;
pub mod git;
pub mod package;
pub mod remotes;
pub mod worktree;

pub use checkout::{Checkout, CheckoutKind, Error, Result, canonical, resolve, strip_verbatim};
pub use git::{Git, GitError};
pub use worktree::WorktreeError;
