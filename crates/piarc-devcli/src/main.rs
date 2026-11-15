//! piarc-devcli: headless development driver running Core and the Agent Host without UI.
//!
//! # Responsibilities
//!
//! - Headless development driver: runs Core and the Agent Host without the UI.
//!
//! # Not responsible for
//!
//! - Shipping in the app: release artefacts must not contain it.
//!
//! # Allowed workspace dependencies
//!
//! `piarc-core`, `piarc-testkit` and the foundation crates `piarc-protocol` and `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

fn main() {}
