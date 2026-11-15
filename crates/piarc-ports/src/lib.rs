//! piarc-ports: narrow traits shared across crates: ProcessSpawner, FileSystem, Clock, SecretStore, AgentHostTransport.
//!
//! # Responsibilities
//!
//! - Defines the narrow traits that isolate I/O boundaries and are shared across crates:
//!   `ProcessSpawner`, `FileSystem`, `Clock`, `SecretStore` and `AgentHostTransport`.
//! - Lets crates be driven by in-memory implementations in tests.
//!
//! # Not responsible for
//!
//! - Implementations of any kind: this crate contains definitions only. For example, `piarc-exec`
//!   implements `ProcessSpawner`.
//!
//! # Allowed workspace dependencies
//!
//! None. This is a foundation crate: it must not depend on any other workspace crate.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
