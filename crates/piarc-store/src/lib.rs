//! piarc-store: SQLite storage (rusqlite): index, FTS5, audit; streaming read-only parsing of Pi JSONL.
//!
//! # Responsibilities
//!
//! - SQLite storage via `rusqlite`: metadata index, FTS5 full-text search and the audit log.
//! - Streaming, read-only parsing of Pi session JSONL.
//!
//! # Not responsible for
//!
//! - Writing conversation content: Pi owns the JSONL and Core only reads it.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
