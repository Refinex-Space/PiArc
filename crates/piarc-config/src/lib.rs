//! piarc-config: layered settings loading and merging (PiArc and Claude Code compatibility), project trust, configuration diagnostics.
//!
//! # Responsibilities
//!
//! - Loads and merges layered settings ([`layers`], [`merge`], [`settings`]): an ordered
//!   table of sources and precedences, schema checks with file, JSON Pointer and reason
//!   ([`schema`]), reload with the last valid content kept, writes to `.piarc/` and the user
//!   file ([`write`]). The Claude Code layers (`.claude/settings*.json`,
//!   `~/.claude/settings.json`) are in the same table, filtered by the key mapping table
//!   ([`claude`]); `.claude/rules/` files are parsed and matched by [`rules`].
//! - Project trust: the one query consumers of executable project configuration use
//!   ([`trust`]), the executable items a project would enable ([`executables`]), and
//!   leaving project hooks and allow rules out of the merge until the project is trusted.
//! - Configuration diagnostics ([`diagnostics`]): every file's load state, applied,
//!   overridden and ignored keys.
//! - Subagent definition files ([`agents`], T31): discovery from a directory upward and the
//!   user levels, frontmatter parsing ([`frontmatter`]) and the merge by name.
//! - Skills, slash command files, Pi prompt templates and output styles ([`skills`], T37):
//!   discovery, frontmatter, the merge by name and argument substitution.
//! - Extension packages ([`plugins`], T40): reading Claude Code plugins and Pi packages,
//!   which installed packages a workspace's settings turn on, and which of their executable
//!   items the user confirmed.
//! - The Bash sandbox's settings ([`sandbox`], T39): project files only tighten, allowed
//!   domains from the user and enterprise sources, `denyRead` paths resolved per file.
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

pub mod agents;
pub mod claude;
pub mod diagnostics;
pub mod executables;
pub mod frontmatter;
pub mod layers;
pub mod mcp;
pub mod merge;
pub mod plugins;
pub mod rules;
pub mod sandbox;
pub mod schema;
pub mod settings;
pub mod skills;
pub mod trust;
pub mod write;

pub use diagnostics::{
    FileReport, FileStatus, IgnoreReason, IgnoredKey, KeyReport, SourceKind, claude_state_report,
};
pub use executables::{Category, Inventory, Item, enumerate, new_items};
pub use layers::{Format, LayerSpec, LayerTable, PROJECT_DIR, Scope, Source, ids, precedence};
pub use settings::{Change, Issue, LayerStatus, PermissionLists, Settings};
pub use trust::{TrustLookup, TrustState, project_trust};
pub use write::{
    WriteError, append_local_permissions, append_unique, edit_permission_rule, write_value,
};

/// The built-in defaults layer.
#[must_use]
pub fn defaults() -> serde_json::Value {
    serde_json::json!({ "permissions": { "defaultMode": "default" } })
}
