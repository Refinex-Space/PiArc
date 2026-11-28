//! Errors of the credential vault. No variant carries a credential value, and no message
//! includes one: credential keys (`provider/<id>`) are names, not secrets.

use std::io;
use std::path::{Path, PathBuf};

use piarc_ports::SecretStoreError;
use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};
use serde_json::json;

/// Why a vault operation failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The vault file exists but the system credential store has no master key for it. The
    /// vault is left untouched and no new key is created.
    #[error(
        "the credential vault {} exists but its master key is missing from the system credential store",
        vault.display()
    )]
    MasterKeyMissing {
        /// The vault file.
        vault: PathBuf,
    },
    /// The system credential store refused or failed; retry after the user grants access.
    #[error("{0}")]
    CredentialStore(#[from] SecretStoreError),
    /// The vault (or the master key item) failed authentication or is damaged. Nothing from
    /// it is returned.
    #[error("the credential vault failed its integrity check: {reason}")]
    Integrity {
        /// What failed; never contains vault content.
        reason: &'static str,
        /// Whether the header's key id matched the master key, when the header was readable.
        key_id_matches: Option<bool>,
    },
    /// The vault was written in a format version this build does not read.
    #[error("the credential vault has format version {version}, which this build does not read")]
    UnsupportedVersion {
        /// The version in the file.
        version: u16,
    },
    /// Reading or writing the vault file failed.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The file involved.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
    /// The credential key is not a valid name.
    #[error("invalid credential key {key:?}: {reason}")]
    InvalidKey {
        /// The rejected key (a name, not a secret).
        key: String,
        /// Why it was rejected.
        reason: &'static str,
    },
    /// The value cannot be stored.
    #[error("invalid value for credential {key:?}: {reason}")]
    InvalidValue {
        /// The credential key.
        key: String,
        /// Why it was rejected; never contains the value.
        reason: &'static str,
    },
    /// The operating system's random number generator failed.
    #[error("the system random number generator failed: {0}")]
    Random(String),
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub(crate) fn io(op: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Io {
            op,
            path: path.to_owned(),
            source,
        }
    }

    /// The AHP error category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::MasterKeyMissing { .. } => ErrorKind::MasterKeyMissing,
            Self::CredentialStore(_) => ErrorKind::CredentialStoreUnavailable,
            Self::Integrity { .. } => ErrorKind::VaultIntegrity,
            Self::UnsupportedVersion { .. } => ErrorKind::VaultVersion,
            Self::Io { .. } => ErrorKind::IoError,
            Self::InvalidKey { .. } | Self::InvalidValue { .. } => ErrorKind::InvalidParams,
            Self::Random(_) => ErrorKind::InternalError,
        }
    }

    /// Whether the same request can succeed later: only when the system credential store
    /// refused or was unavailable (the user can grant access or unlock it).
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::CredentialStore(_))
    }

    /// The structured error sent over AHP.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let details = match self {
            Self::CredentialStore(e) => Some(json!({ "reason": match e {
                SecretStoreError::AccessDenied(_) => "accessDenied",
                SecretStoreError::Unavailable(_) => "unavailable",
                SecretStoreError::Failed(_) => "failed",
            } })),
            Self::Integrity {
                key_id_matches: Some(matches),
                ..
            } => Some(json!({ "keyIdMatches": matches })),
            Self::UnsupportedVersion { version } => Some(json!({ "version": version })),
            Self::Io { path, source, .. } => Some(json!({
                "code": source.kind().to_string(),
                "path": path.to_string_lossy(),
            })),
            Self::MasterKeyMissing { vault } => Some(json!({ "path": vault.to_string_lossy() })),
            Self::Integrity { .. }
            | Self::InvalidKey { .. }
            | Self::InvalidValue { .. }
            | Self::Random(_) => None,
        };
        let kind = self.kind();
        ErrorObject {
            code: kind.code(),
            message: self.to_string(),
            data: ErrorData {
                kind,
                retryable: self.retryable(),
                details,
            },
        }
    }
}
