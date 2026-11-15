//! piarc-protocol: AHP and Core API data types, protocol versions and JSON Schema export.
//!
//! # Responsibilities
//!
//! - Defines the data types of the Agent Host Protocol (AHP) and of the Core API, and their version
//!   numbers.
//! - Exports JSON Schema (via `schemars`); `packages/protocol` generates its TypeScript types from
//!   it, so this crate is the single source of those types.
//!
//! # Not responsible for
//!
//! - Transport, framing and backpressure (`piarc-host`).
//! - Any I/O or business logic: it holds plain data types only.
//!
//! # Allowed workspace dependencies
//!
//! None. This is a foundation crate: it must not depend on any other workspace crate.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
