//! piarc-napi: thin NAPI-RS export layer producing the per-platform .node modules (ADR-0014).
//!
//! # Responsibilities
//!
//! - Thin NAPI-RS export layer over `piarc-core`; produces the per-platform `.node` modules loaded
//!   by the Electron main process (ADR-0014).
//! - Catches panics at the boundary and maps errors to structured objects with `kind` and
//!   `retryable`.
//! - One of the two places where `unsafe` is allowed (the other is `piarc-ghostty-sys`).
//!
//! # Not responsible for
//!
//! - Business logic of any kind: it only converts and forwards.
//! - Being loaded by renderer processes: only the main process loads Core.
//!
//! # Allowed workspace dependencies
//!
//! `piarc-core`, plus the foundation crates `piarc-protocol` and `piarc-ports` for the types it
//! converts.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
