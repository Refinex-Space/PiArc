//! piarc-host: agent Host supervision: launch, handshake, framing, backpressure, restart and call reconciliation.
//!
//! # Responsibilities
//!
//! - Supervises the Agent Host process: launch, AHP handshake, framing, backpressure, restart and
//!   reconciliation of in-flight calls.
//!
//! # Not responsible for
//!
//! - Process tree management: it launches the Agent Host through the `ProcessSpawner` injected by
//!   `piarc-core`.
//! - Sandbox profile generation (`piarc-sandbox`).
//! - Pi integration logic, which lives in the TypeScript Agent Host (`agent-host/`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
