//! piarc-sandbox: macOS Seatbelt profile generation, local network proxy; Windows isolation (evaluated in M4).
//!
//! # Responsibilities
//!
//! - Generates macOS Seatbelt profiles per command.
//! - Runs the local network proxy that applies the domain allowlist.
//! - Windows isolation, to be evaluated in M4 (architecture section 6.10).
//!
//! # Not responsible for
//!
//! - Spawning processes (`piarc-exec`, through `ProcessSpawner`).
//! - Permission rules (`piarc-policy`).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
