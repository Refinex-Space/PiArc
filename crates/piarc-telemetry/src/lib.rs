//! piarc-telemetry: tracing, log rotation, local metrics and diagnostic bundle export.
//!
//! # Responsibilities
//!
//! - Tracing, log rotation, local metrics and diagnostic bundle export.
//! - T13: Core and Agent Host logs in `<data>/logs/`, one file per stream and UTC day, kept
//!   for [`RETENTION_DAYS`] days ([`rotation`], [`subscriber`]).
//! - T45: redaction ([`redact`]): every log line, and the diagnostic bundle, without the
//!   credentials Core loaded from the vault or common credential formats; the diagnostic bundle
//!   ([`bundle`]) assembled in memory for the client's preview and written as a ZIP ([`zip`]).
//!
//! # Not responsible for
//!
//! - Uploading anything by default: telemetry is off by default and never includes session content,
//!   file paths or command text (architecture section 10.5).
//! - Knowing which credentials exist: Core remembers the vault's values here as it loads them.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

pub mod bundle;
pub mod redact;
pub mod rotation;
pub mod subscriber;
pub mod zip;

pub use bundle::{Bundle, BundleFile, BundleInput, EXCLUDED, assemble};
pub use redact::{Kind, Redacted, redact, redact_home, remember_secret, remember_secrets_in};
pub use rotation::{Calendar, DailyLog, Day, RETENTION_DAYS, SystemCalendar};
pub use subscriber::{
    AGENT_HOST_PREFIX, AGENT_HOST_TARGET, CORE_PREFIX, Installed, detach, install, install_with,
};
