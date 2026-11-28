//! Errors of the snapshot store. Messages name objects by hash and files by path, never their
//! content.

use std::io;
use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};
use serde_json::json;

/// Why a store operation failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Reading or writing the object directory failed.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The file or directory involved.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
    /// No object has this hash: it was never stored or was collected.
    #[error("the snapshot {hash} is missing")]
    Missing {
        /// The object's hex SHA-256.
        hash: String,
    },
    /// The object's bytes no longer hash to its name.
    #[error("the snapshot {hash} is damaged: its content no longer matches its hash")]
    Corrupt {
        /// The object's hex SHA-256.
        hash: String,
    },
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub(crate) fn io(op: &'static str, path: &Path) -> impl FnOnce(io::Error) -> Self {
        let path = path.to_owned();
        move |source| Self::Io { op, path, source }
    }

    /// The AHP / Core API error category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Io { .. } => ErrorKind::IoError,
            Self::Missing { .. } => ErrorKind::NotFound,
            Self::Corrupt { .. } => ErrorKind::InternalError,
        }
    }

    /// Whether the same call can succeed later: never; a missing or damaged snapshot stays so,
    /// and an I/O failure of the data directory needs the user.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The structured error for AHP and NAPI.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let details = match self {
            Self::Io { path, source, .. } => Some(json!({
                "code": source.kind().to_string(),
                "path": path.to_string_lossy(),
            })),
            Self::Missing { hash } | Self::Corrupt { hash } => Some(json!({ "hash": hash })),
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
