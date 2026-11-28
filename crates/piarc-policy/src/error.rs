//! Errors of the permission crate (coding standards 2.3, I128): a rule or a path pattern that
//! cannot be parsed. The message is written for the settings page and the audit.

use piarc_protocol::{ErrorKind, ErrorObject};

/// Why a rule or pattern was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// A permission rule (`Tool` or `Tool(specifier)`) that cannot be parsed.
    #[error("{0}")]
    InvalidRule(String),
    /// A `Read`/`Edit` path pattern that cannot be parsed.
    #[error("{0}")]
    InvalidPath(String),
}

impl Error {
    /// The error category across AHP and NAPI.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        ErrorKind::InvalidParams
    }

    /// Whether trying again could succeed: never, the text must change.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The structured error.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        ErrorObject::new(self.kind(), self.to_string(), self.retryable())
    }
}
