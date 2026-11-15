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
//!
//! # Defined so far
//!
//! - [`ProcessSpawner`]: starts a process with piped stdio and a [`ProcessControl`] to kill it
//!   and wait for its exit (T06; `piarc-exec` implements it).
//! - [`Clock`]: monotonic time and sleeping, so restart windows and backoff can run on a test
//!   clock (T06).
//! - [`SecretStore`]: one secret per [`SecretName`] in the system credential store, used for
//!   the credential vault's master key (T08; `piarc-secrets` implements it over `keyring-core`).
//!
//! `FileSystem` and `AgentHostTransport` arrive with the tasks that need them.

mod clock;
mod process;
mod secret;

pub use clock::Clock;
pub use process::{
    BoxFuture, ExitStatus, ProcessControl, ProcessSpawner, SpawnSpec, SpawnedProcess,
};
pub use secret::{SecretName, SecretStore, SecretStoreError};
