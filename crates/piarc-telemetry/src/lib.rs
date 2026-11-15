//! piarc-telemetry: tracing, log rotation, local metrics and diagnostic bundle export.
//!
//! # Responsibilities
//!
//! - Tracing, log rotation, local metrics and diagnostic bundle export.
//!
//! # Not responsible for
//!
//! - Uploading anything by default: telemetry is off by default and never includes session content,
//!   file paths or command text (architecture section 10.5).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
