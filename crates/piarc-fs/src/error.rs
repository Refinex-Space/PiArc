//! Errors of file operations, mapped onto AHP's `notFound`, `outsideWorkspace`, `ioError` and
//! `invalidParams`.

use std::io;
use std::path::Path;

use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;

use crate::scope::display;

/// A failed file operation.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The path does not exist.
    #[error("{path}: no such file or directory")]
    NotFound {
        /// The path as resolved.
        path: String,
    },
    /// The path resolves outside the workspace root.
    #[error("{path} resolves to {resolved}, outside the workspace root {root}")]
    OutsideWorkspace {
        /// The path as requested.
        path: String,
        /// Where it resolves after normalization and symlink resolution.
        resolved: String,
        /// The workspace root.
        root: String,
    },
    /// Any other operating system error.
    #[error("{path}: {source}")]
    Io {
        /// The path the operation failed on.
        path: String,
        /// POSIX-style error code, for example `EACCES`.
        code: &'static str,
        /// The operating system's error.
        #[source]
        source: io::Error,
    },
    /// A glob or regular expression that does not compile.
    #[error("{message}")]
    InvalidPattern {
        /// The compiler's description.
        message: String,
    },
}

/// Result of a file operation.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The error of `source` while operating on `path`.
    pub(crate) fn io(path: &Path, source: io::Error) -> Self {
        let path = display(path);
        if source.kind() == io::ErrorKind::NotFound {
            Self::NotFound { path }
        } else {
            Self::Io {
                path,
                code: code_of(&source),
                source,
            }
        }
    }

    /// An error with an explicit code, for conditions the operating system does not report
    /// the same way on every platform (reading a directory).
    pub(crate) fn coded(path: &Path, code: &'static str, message: &str) -> Self {
        Self::Io {
            path: display(path),
            code,
            source: io::Error::other(message.to_owned()),
        }
    }

    /// Machine-readable category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::NotFound { .. } => ErrorKind::NotFound,
            Self::OutsideWorkspace { .. } => ErrorKind::OutsideWorkspace,
            Self::Io { .. } => ErrorKind::IoError,
            Self::InvalidPattern { .. } => ErrorKind::InvalidParams,
        }
    }

    /// Whether the same request could succeed later: never for these errors.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// The POSIX-style code (`ENOENT` for [`Error::NotFound`]), when there is one.
    #[must_use]
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::NotFound { .. } => Some("ENOENT"),
            Self::Io { code, .. } => Some(code),
            Self::OutsideWorkspace { .. } | Self::InvalidPattern { .. } => None,
        }
    }

    /// The wire error, with `details` per kind (see `piarc_protocol::fs`).
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let mut object = ErrorObject::new(self.kind(), self.to_string(), self.retryable());
        object.data.details = match self {
            Self::NotFound { path } => Some(json!({ "code": "ENOENT", "path": path })),
            Self::OutsideWorkspace {
                path,
                resolved,
                root,
            } => Some(json!({ "path": path, "resolved": resolved, "root": root })),
            Self::Io { path, code, .. } => Some(json!({ "code": code, "path": path })),
            Self::InvalidPattern { .. } => None,
        };
        object
    }
}

/// POSIX-style name of an I/O error, the same on every platform (as Node reports them).
fn code_of(error: &io::Error) -> &'static str {
    use io::ErrorKind as K;
    match error.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => "EACCES",
        K::AlreadyExists => "EEXIST",
        K::IsADirectory => "EISDIR",
        K::NotADirectory => "ENOTDIR",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::ReadOnlyFilesystem => "EROFS",
        K::StorageFull => "ENOSPC",
        K::FileTooLarge => "EFBIG",
        K::InvalidFilename => "ENAMETOOLONG",
        K::ResourceBusy => "EBUSY",
        K::InvalidInput => "EINVAL",
        // `FilesystemLoop` cannot be named on stable Rust yet (io_error_more).
        other if format!("{other:?}") == "FilesystemLoop" => "ELOOP",
        _ => "EIO",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_io_errors_to_kinds_and_codes() {
        let missing = Error::io(Path::new("a"), io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(missing.kind(), ErrorKind::NotFound);
        assert_eq!(missing.code(), Some("ENOENT"));
        let denied = Error::io(
            Path::new("a"),
            io::Error::from(io::ErrorKind::PermissionDenied),
        );
        let object = denied.to_error_object();
        assert_eq!(object.data.kind, ErrorKind::IoError);
        assert_eq!(object.code, -32011);
        assert_eq!(
            object.data.details,
            Some(json!({ "code": "EACCES", "path": "a" }))
        );
        assert!(!object.data.retryable);
    }
}
