//! piarc-browser-import: Chrome sign-in import for the built-in browser (ADR-0090, design
//! addendum `docs/architecture/addenda/browser.md` B5.1–B5.4).
//!
//! # Responsibilities
//!
//! - Chrome's profiles under its user data folder ([`profiles`]).
//! - The `Cookies` database read from a private copy, the database and its `-wal` ([`cookies`]):
//!   sites with their cookie counts (no value, no key), and the rows of chosen sites.
//! - Decryption ([`crypto`]): macOS `v10` (PBKDF2-SHA1 + AES-128-CBC), Windows `v10`
//!   (AES-256-GCM), the domain hash of database version 24 and later; Windows `v20` (App-Bound)
//!   reported per cookie as unsupported.
//! - The key ([`keys`]): the macOS keychain's "Chrome Safe Storage" password or the Windows
//!   DPAPI-protected key in `Local State`, read once per import; a fixed key for tests.
//! - The cookies of chosen sites in the shape of Electron's `cookies.set` ([`import`]).
//!
//! Keys, passwords and values are held in `Zeroizing` buffers; `Debug` output and error
//! messages never contain them.
//!
//! # Not responsible for
//!
//! - Asking the user, writing cookies into the browser partition, the import records, the
//!   audit and registering values with the log redactor (`piarc-core`'s `browser::import` and
//!   the main process).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other
//! feature crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod cookies;
pub mod crypto;
#[cfg(windows)]
#[allow(
    unsafe_code,
    reason = "safe wrapper over DPAPI's CryptUnprotectData (coding standards section 2.8)"
)]
mod dpapi;
mod error;
pub mod import;
pub mod keys;
pub mod profiles;

pub use cookies::SiteCount;
pub use crypto::{ChromeKey, Skip};
pub use error::{Error, KeyProblem, Result};
pub use import::{Cookie, Imported, Importer, SiteReport, Skipped, covered, related, root_for};
pub use keys::{FixedKey, KeySource, SystemKey, test_key};
pub use profiles::Profile;
