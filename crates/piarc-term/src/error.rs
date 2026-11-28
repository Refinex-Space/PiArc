//! The crate error type.

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};

/// Errors of terminal sessions.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
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
    /// Too much input is waiting for the PTY (the program does not read it); try again later.
    #[error("the terminal's input queue is full")]
    Busy,
    /// The operation was cancelled before it finished.
    #[error("the terminal operation was cancelled")]
    Cancelled,
    /// Waiting for something in the terminal took longer than allowed.
    #[error("timed out waiting for {what}")]
    Timeout {
        /// What was awaited.
        what: &'static str,
    },
    /// A saved terminal could not be read or written.
    #[error("terminal snapshot {operation} failed: {reason}")]
    Snapshot {
        /// read, write, decode
        operation: &'static str,
        /// What went wrong.
        reason: String,
    },
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The stable, machine-readable category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Vt { .. } => ErrorKind::InternalError,
            Self::Spawn { .. } | Self::Pty { .. } | Self::Snapshot { .. } => ErrorKind::IoError,
            Self::InvalidArgument { .. } => ErrorKind::InvalidParams,
            Self::Closed => ErrorKind::NotFound,
            Self::Busy => ErrorKind::Busy,
            Self::Cancelled => ErrorKind::Cancelled,
            Self::Timeout { .. } => ErrorKind::Timeout,
        }
    }

    /// Whether the same request could succeed later: a full input queue drains, a wait can be
    /// repeated.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Busy | Self::Timeout { .. })
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
