//! Errors of sandbox preparation and the proxy.

use std::path::PathBuf;

use piarc_protocol::ErrorKind;

/// A `Result` with [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Why a sandbox could not be prepared.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// This platform has no command sandbox (Windows in the first release, requirement D7).
    #[error("commands cannot be sandboxed on this platform")]
    Unsupported,
    /// A policy path is not absolute.
    #[error("sandbox path {path} is not absolute")]
    NotAbsolute {
        /// The path as given.
        path: PathBuf,
    },
    /// A directory the sandbox must make writable does not exist or cannot be resolved.
    #[error("cannot resolve sandbox directory {path}: {source}")]
    Resolve {
        /// The path as given.
        path: PathBuf,
        /// The file system's error.
        source: std::io::Error,
    },
    /// A path is not valid UTF-8, so it cannot be written into a Seatbelt regex.
    #[error("sandbox path {path} is not valid UTF-8")]
    NotUtf8 {
        /// The path.
        path: PathBuf,
    },
    /// The network proxy could not start.
    #[error("the sandbox network proxy cannot start: {0}")]
    Proxy(#[source] std::io::Error),
}

impl Error {
    /// The machine-readable category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Unsupported | Self::Proxy(_) => ErrorKind::InternalError,
            Self::NotAbsolute { .. } | Self::NotUtf8 { .. } => ErrorKind::InvalidParams,
            Self::Resolve { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
                ErrorKind::NotFound
            }
            Self::Resolve { .. } => ErrorKind::IoError,
        }
    }

    /// Whether trying again could succeed: only starting the proxy can fail transiently.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Proxy(_))
    }
}
