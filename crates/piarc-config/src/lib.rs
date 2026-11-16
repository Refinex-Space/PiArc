//! piarc-config: layered settings loading and merging (PiArc and Claude Code compatibility), project trust, configuration diagnostics.
//!
//! # Responsibilities
//!
//! - Loads and merges layered settings ([`layers`], [`merge`], [`settings`]): an ordered
//!   table of sources and precedences, schema checks with file, JSON Pointer and reason
//!   ([`schema`]), reload with the last valid content kept, writes to `.piarc/` and the user
//!   file ([`write`]). The Claude Code compatibility layers are added to the same table (T24).
//! - Project trust: the one query consumers of executable project configuration use
//!   ([`trust`]), the executable items a project would enable ([`executables`]), and
//!   leaving project hooks and allow rules out of the merge until the project is trusted.
//! - Configuration diagnostics.
//!
//! # Not responsible for
//!
//! - Interpreting permission rules or hooks (`piarc-policy`, `piarc-hooks`).
//! - Writing to `.claude/`: Claude Code configuration is read-only for PiArc.
//! - Watching files (`piarc-fs`; `piarc-core` forwards change events) and storing trust
//!   decisions (`piarc-store`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod executables;
pub mod layers;
pub mod merge;
pub mod schema;
pub mod settings;
pub mod trust;
pub mod write;

pub use executables::{Category, Inventory, Item, enumerate, new_items};
pub use layers::{LayerSpec, LayerTable, PROJECT_DIR, Scope, Source, ids, precedence};
pub use settings::{Change, Issue, LayerStatus, Settings};
pub use trust::{TrustLookup, TrustState, project_trust};
pub use write::{WriteError, write_value};

/// The built-in defaults layer.
#[must_use]
pub fn defaults() -> serde_json::Value {
    serde_json::json!({ "permissions": { "defaultMode": "default" } })
}
