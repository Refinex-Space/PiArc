//! Errors of the import (coding standards 2.3). No message carries a cookie value, a key or a
//! keychain password: they name paths, profiles and reasons only.

use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;

/// Why the decryption key could not be had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyProblem {
    /// The user refused the keychain prompt (macOS).
    Denied,
    /// There is no key: no "Chrome Safe Storage" item, no `os_crypt.encrypted_key`.
    Missing,
    /// The system store could not answer now (locked keychain, DPAPI failure).
    Unavailable,
    /// The stored key has the wrong form.
    Invalid,
}

impl KeyProblem {
    fn reason(self) -> &'static str {
        match self {
            Self::Denied => "keychainDenied",
            Self::Missing => "keyMissing",
            Self::Unavailable => "keyUnavailable",
            Self::Invalid => "keyInvalid",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Chrome's data folder was not found ({0})")]
    NoChrome(String),
    #[error("There is no Chrome profile {0:?}")]
    NoProfile(String),
    #[error("The Chrome profile {0:?} has no cookies database")]
    NoCookies(String),
    #[error("Chrome holds its cookies database open; quit Chrome and try again")]
    Locked,
    #[error("Cannot {action}: {reason}")]
    Io {
        action: &'static str,
        reason: String,
    },
    #[error("Cannot read Chrome's cookies database: {0}")]
    Database(String),
    #[error("Chrome's cookies database has a form PiArc cannot read: {0}")]
    Format(String),
    #[error("{message}")]
    Key {
        problem: KeyProblem,
        message: String,
    },
    #[error("Importing Chrome sign-ins is not available on this platform")]
    Unsupported,
    #[error("{0}")]
    Invalid(String),
}

impl Error {
    pub(crate) fn io(action: &'static str, error: &std::io::Error) -> Self {
        Self::Io {
            action,
            reason: error.to_string(),
        }
    }

    pub(crate) fn database(error: &rusqlite::Error) -> Self {
        // SQLite's messages name tables, columns and codes, never row values.
        Self::Database(error.to_string())
    }

    pub(crate) fn key(problem: KeyProblem, message: impl Into<String>) -> Self {
        Self::Key {
            problem,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::NoChrome(_) | Self::NoProfile(_) | Self::NoCookies(_) => ErrorKind::NotFound,
            Self::Locked => ErrorKind::Busy,
            Self::Io { .. } | Self::Database(_) | Self::Format(_) => ErrorKind::IoError,
            Self::Key { problem, .. } => match problem {
                KeyProblem::Denied => ErrorKind::PermissionDenied,
                KeyProblem::Missing => ErrorKind::NotFound,
                KeyProblem::Unavailable => ErrorKind::CredentialStoreUnavailable,
                KeyProblem::Invalid => ErrorKind::IoError,
            },
            Self::Unsupported => ErrorKind::InvalidRequest,
            Self::Invalid(_) => ErrorKind::InvalidParams,
        }
    }

    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Locked
                | Self::Key {
                    problem: KeyProblem::Denied | KeyProblem::Unavailable,
                    ..
                }
        )
    }

    /// A stable name of the cause for `details.reason`.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NoChrome(_) => "noChrome",
            Self::NoProfile(_) => "noProfile",
            Self::NoCookies(_) => "noCookies",
            Self::Locked => "locked",
            Self::Io { .. } => "io",
            Self::Database(_) => "database",
            Self::Format(_) => "format",
            Self::Key { problem, .. } => problem.reason(),
            Self::Unsupported => "unsupported",
            Self::Invalid(_) => "invalid",
        }
    }

    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let mut error = ErrorObject::new(self.kind(), self.to_string(), self.retryable());
        error.data.details = Some(json!({ "reason": self.reason() }));
        error
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_reasons_are_structured() {
        let denied = Error::key(KeyProblem::Denied, "denied");
        assert_eq!(denied.kind(), ErrorKind::PermissionDenied);
        assert!(denied.retryable());
        let object = Error::Locked.to_error_object();
        assert_eq!(object.data.kind, ErrorKind::Busy);
        assert!(object.data.retryable);
        assert_eq!(object.data.details, Some(json!({ "reason": "locked" })));
        assert_eq!(
            Error::NoProfile("Profile 9".into()).kind(),
            ErrorKind::NotFound
        );
    }
}
