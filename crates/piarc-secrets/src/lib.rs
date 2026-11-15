//! piarc-secrets: credential vault: encrypted file plus master key in the system credential store (keyring-core).
//!
//! # Responsibilities
//!
//! - The credential vault ([`Vault`]): provider API keys, OAuth tokens and MCP tokens in one
//!   AES-256-GCM encrypted file (`<data dir>/secrets.vault`), keyed by names such as
//!   `provider/<id>`, `oauth/<id>` and `mcp/<server>` (ADR-0018 rule 5, architecture
//!   section 9.1). The file format is in [`format`]; the open/create rules in [`vault`].
//! - The master key ([`MasterKey`]): 32 random bytes in the system credential store, reached
//!   through the `SecretStore` port. [`SystemSecretStore`] implements the port over
//!   `keyring-core` (macOS login keychain, Windows Credential Manager);
//!   [`MemorySecretStore`] is the test double.
//! - Atomic file replacement ([`atomic::replace`]).
//!
//! Plaintext and the master key are held in buffers zeroed on drop. Errors and `Debug`
//! output never include credential values.
//!
//! # Not responsible for
//!
//! - Provider login flows, which the Agent Host drives through AHP.
//! - Serving the vault to Agent Hosts, locks and change notifications: `piarc-core`'s
//!   `secrets` module.
//! - Passing credentials through environment variables: credentials travel over AHP only.
//! - Choosing the application identifier: callers pass it to [`master_key_name`].
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod atomic;
mod document;
mod error;
pub mod format;
mod master_key;
mod memory;
mod random;
mod system_store;
pub mod vault;

pub use error::{Error, Result};
pub use master_key::{
    KEY_ID_LEN, KEY_LEN, MASTER_KEY_ACCOUNT, MasterKey, SERVICE_SUFFIX, TEST_SERVICE_PREFIX,
    master_key_name, test_master_key_name,
};
pub use memory::MemorySecretStore;
pub use system_store::SystemSecretStore;
pub use vault::{EntryView, OpenOutcome, Vault, VaultConfig, validate_key};
