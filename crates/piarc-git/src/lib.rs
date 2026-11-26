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
//! - Git panel (ADR-0084, ADR-0085): read-only queries with program-running configuration
//!   overridden and the user's write operations ([`repo`], [`exec`], [`env`], [`args`]), status
//!   ([`status`]), scope diffs ([`diff`]), commits and file texts ([`log`]), branches
//!   ([`refs`]); the index and hunks ([`index`]), commits ([`commit`]), branch operations
//!   ([`branches`]), fetch, pull, push and the operation in progress ([`remote`]). G3: history
//!   pages, commit details and commit operations ([`history`]), stashes ([`stash`]).
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

pub mod args;
pub mod branches;
pub mod checkout;
pub mod commit;
pub mod diff;
pub mod env;
pub mod exec;
pub mod git;
pub mod history;
pub mod index;
pub mod log;
pub mod package;
pub mod refs;
pub mod remote;
pub mod remotes;
pub mod repo;
pub mod stash;
pub mod status;
pub mod worktree;

pub use checkout::{Checkout, CheckoutKind, Error, Result, canonical, resolve, strip_verbatim};
pub use exec::{Cancel, ExecOptions, ExecOutput, Progress};
pub use git::{Git, GitError};
pub use repo::{Reader, Repo, Writer};
pub use worktree::WorktreeError;
