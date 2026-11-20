//! piarc-store: SQLite storage (rusqlite): index, FTS5, audit; streaming read-only parsing of Pi JSONL.
//!
//! # Responsibilities
//!
//! - The Core database `core.sqlite` via `rusqlite`: numbered migrations ([`migrate`]), the
//!   tables of architecture section 9.2 plus `project_trust` and the sync state
//!   `session_files`.
//! - Streaming, read-only parsing of Pi session JSONL ([`jsonl`], [`pi_session`]) and the
//!   session index kept current incrementally or rebuilt from the files ([`index`]).
//! - Rows of workspaces, trust decisions and audit events ([`records`]).
//! - The checkpoint index of file snapshots (`checkpoints`, `checkpoint_files`,
//!   `checkpoint_sessions`; schema v5, ADR-0044); the snapshot objects and the rewind rules are
//!   `piarc-checkpoint`'s.
//!
//! # Not responsible for
//!
//! - Writing conversation content: Pi owns the JSONL and Core only reads it.
//! - Deciding trust or resolving checkouts (`piarc-config`, `piarc-git`, composed by
//!   `piarc-core`): this crate only stores the decision under the key it is given.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

mod background_tasks;
mod checkpoints;
mod error;
pub mod index;
pub mod jsonl;
mod memory_imports;
pub mod migrate;
pub mod pi_session;
pub mod records;
mod store;
pub mod time;

pub use background_tasks::TaskRow;
pub use checkpoints::{CheckpointFileRow, CheckpointRow, NewCheckpointFile};
pub use error::{Error, Result};
pub use index::{
    FileOutcome, IndexStatus, SessionPrefsChange, SessionRecord, SkippedLine, SyncReport,
};
pub use migrate::{MIGRATIONS, Migration};
pub use pi_session::{SessionMeta, Usage};
pub use records::{AuditEvent, AuditFilter, TrustDecision, TrustRecord, WorkspaceRecord};
pub use store::{BUSY_TIMEOUT, CACHE_KIB, Store};
