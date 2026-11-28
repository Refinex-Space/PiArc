//! Errors of the crate's public functions (coding standards 2.3, I128).

use piarc_protocol::{ErrorKind, ErrorObject};

/// Why a part of the hooks configuration cannot be used, or a handler cannot start.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// A matcher PiArc's regular expressions cannot express, or invalid syntax.
    #[error("{0}")]
    InvalidMatcher(String),
    /// A handler cannot start here (no shell of the requested kind, no transport).
    #[error("{0}")]
    CannotStart(String),
}

impl Error {
    /// The protocol's error kind.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::InvalidMatcher(_) => ErrorKind::InvalidParams,
            Self::CannotStart(_) => ErrorKind::InternalError,
        }
    }

    /// Whether trying again can succeed: a missing shell or transport stays missing.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The AHP error.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        ErrorObject::new(self.kind(), self.to_string(), self.retryable())
    }
}
