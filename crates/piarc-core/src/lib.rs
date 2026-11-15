//! piarc-core: runtime facade: workspace and session orchestration, event bus, incremental merging, background task registry.
//!
//! # Responsibilities
//!
//! - Runtime facade of PiArc Core: workspace and session orchestration, the event bus, incremental
//!   event merging and the background task registry.
//! - Owns the tokio runtime and the workspace and session actors.
//! - Composes the feature crates: it is the only place where they collaborate, and it injects the
//!   `ProcessSpawner` from `piarc-exec` into `piarc-host`, `piarc-hooks` and sandboxed command
//!   execution.
//!
//! # Not responsible for
//!
//! - The JavaScript binding surface (`piarc-napi`).
//! - Feature logic that belongs to a feature crate, such as permission decisions, hook execution or
//!   snapshot storage.
//!
//! # Allowed workspace dependencies
//!
//! The feature crates `piarc-host`, `piarc-policy`, `piarc-hooks`, `piarc-config`, `piarc-fs`,
//! `piarc-checkpoint`, `piarc-exec`, `piarc-term`, `piarc-sandbox`, `piarc-store`, `piarc-diff`,
//! `piarc-git`, `piarc-secrets`, `piarc-telemetry`, and the foundation crates `piarc-protocol` and
//! `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
