//! piarc-secrets: credential vault: encrypted file plus master key in the system credential store (keyring-core).
//!
//! # Responsibilities
//!
//! - Credential vault: an encrypted vault file whose master key lives in the system credential
//!   store (`keyring-core`: macOS Keychain, Windows Credential Manager).
//!
//! # Not responsible for
//!
//! - Provider login flows, which the Agent Host drives through AHP.
//! - Passing credentials through environment variables: credentials travel over AHP only.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
