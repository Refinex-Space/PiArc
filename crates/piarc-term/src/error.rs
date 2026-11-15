//! The crate error type.

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};

/// Errors of terminal sessions.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A libghostty-vt call returned an error result.
    #[error("libghostty-vt {call} failed with result {code}")]
    Vt {
        /// The C function that failed.
        call: &'static str,
        /// Its `GhosttyResult` (negative).
        code: i32,
    },
    /// The PTY or the program in it could not be started.
    #[error("cannot start the terminal program: {reason}")]
    Spawn {
        /// What failed.
        reason: String,
    },
    /// A PTY operation (resize, read, write) failed.
    #[error("PTY {operation} failed: {reason}")]
    Pty {
        /// The operation.
        operation: &'static str,
        /// The underlying error.
        reason: String,
    },
    /// An argument failed validation.
    #[error("invalid {field}: {reason}")]
    InvalidArgument {
        /// Argument name as the caller sees it.
        field: &'static str,
        /// What is wrong with it.
        reason: String,
    },
    /// The session was closed: it accepts no more input and produces no more frames.
    #[error("the terminal session is closed")]
    Closed,
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The stable, machine-readable category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Vt { .. } => ErrorKind::InternalError,
            Self::Spawn { .. } | Self::Pty { .. } => ErrorKind::IoError,
            Self::InvalidArgument { .. } => ErrorKind::InvalidParams,
            Self::Closed => ErrorKind::NotFound,
        }
    }

    /// Whether the same request could succeed later. None of these can.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The wire error object (AHP and NAPI shape).
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let kind = self.kind();
        ErrorObject {
            code: kind.code(),
            message: self.to_string(),
            data: ErrorData {
                kind,
                retryable: self.retryable(),
                details: None,
            },
        }
    }
}
