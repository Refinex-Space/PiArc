//! The crate error type.

use std::path::PathBuf;

/// Errors produced while loading scenarios or running the mock provider.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A scenario file or script could not be parsed, or breaks a script rule.
    #[error("invalid scenario {source_name}: {reason}")]
    Scenario {
        /// The file path or caller-supplied name of the script.
        source_name: String,
        /// What is wrong.
        reason: String,
    },
    /// Two loaded scenarios use the same `id`.
    #[error("duplicate scenario id {id:?}")]
    DuplicateScenario {
        /// The repeated id.
        id: String,
    },
    /// A scenario file or directory could not be read.
    #[error("cannot read {path}: {source}")]
    Read {
        /// The path that failed.
        path: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
    /// The listening socket could not be bound or queried.
    #[error("cannot listen on 127.0.0.1:{port}: {source}")]
    Bind {
        /// The requested port (0 means any free port).
        port: u16,
        /// The underlying I/O error.
        source: std::io::Error,
    },
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Stable, machine-readable error category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The scenario input is invalid ([`Error::Scenario`], [`Error::DuplicateScenario`]).
    InvalidScenario,
    /// File-system access failed ([`Error::Read`]).
    Io,
    /// The listening socket could not be set up ([`Error::Bind`]).
    Bind,
}

impl Error {
    /// The stable category of the error; branch on it, not on the message.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Scenario { .. } | Self::DuplicateScenario { .. } => ErrorKind::InvalidScenario,
            Self::Read { .. } => ErrorKind::Io,
            Self::Bind { .. } => ErrorKind::Bind,
        }
    }

    /// Whether repeating the same call could succeed: only a port that is busy right now
    /// may become free.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Bind { source, .. } if source.kind() == std::io::ErrorKind::AddrInUse)
    }

    pub(crate) fn scenario(source_name: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Scenario {
            source_name: source_name.into(),
            reason: reason.into(),
        }
    }
}
