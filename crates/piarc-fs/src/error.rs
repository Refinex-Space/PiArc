//! Errors of file operations, mapped onto AHP's `notFound`, `outsideWorkspace`,
//! `permissionDenied`, `fileNotRead`, `fileModified`, `unencodableText`, `ioError` and
//! `invalidParams`. Messages are written for the model: what happened, and what to do next.

use std::io;
use std::path::Path;

use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::json;

use crate::access::{Access, ApprovalReason};
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
    /// The request cannot be carried out as asked (for example a page range of a PDF).
    #[error("{message}")]
    InvalidRequest {
        /// What is wrong and what to ask instead.
        message: String,
    },
    /// The operation needs the user's approval; nothing was touched. The caller decides.
    #[error("{access} {path} needs the user's approval: {reason}")]
    NeedsApproval {
        /// The path as resolved.
        path: String,
        /// Reading or writing.
        access: Access,
        /// Why.
        reason: ApprovalReason,
    },
    /// The delegated operation does not match the approved change or canonical path.
    #[error("The operation on {path} no longer matches its approval. Request approval again.")]
    ApprovalMismatch {
        /// The resolved path.
        path: String,
    },
    /// An existing file was to be changed before the session read it.
    #[error(
        "{path} has not been read in this session. Read it with the Read tool first, then \
         make the change. The file is unchanged."
    )]
    NotRead {
        /// The path as resolved.
        path: String,
    },
    /// The file changed since the session last read or wrote it.
    #[error(
        "{path} has changed since this session last read it (another program or session \
         modified it). Read it again with the Read tool, then make the change against its \
         current content. The file is unchanged."
    )]
    Modified {
        /// The path as resolved.
        path: String,
    },
    /// The new text has a character the file's encoding cannot represent.
    #[error(
        "The new text for {path} has a character ({character:?} on line {line}) that the \
         file's encoding {encoding} cannot represent. The file is unchanged; use only \
         characters {encoding} can encode."
    )]
    Unencodable {
        /// The path as resolved.
        path: String,
        /// The file's encoding.
        encoding: &'static str,
        /// The character.
        character: char,
        /// 1-based line of the new text it is on.
        line: u64,
    },
}

/// Result of a file operation.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The error of `source` while operating on `path`: [`Error::NotFound`] for a missing
    /// path, [`Error::Io`] with the POSIX-style code otherwise.
    #[must_use]
    pub fn io(path: &Path, source: io::Error) -> Self {
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
            Self::InvalidPattern { .. } | Self::InvalidRequest { .. } => ErrorKind::InvalidParams,
            Self::NeedsApproval { .. } | Self::ApprovalMismatch { .. } => {
                ErrorKind::PermissionDenied
            }
            Self::NotRead { .. } => ErrorKind::FileNotRead,
            Self::Modified { .. } => ErrorKind::FileModified,
            Self::Unencodable { .. } => ErrorKind::UnencodableText,
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
            _ => None,
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
            Self::InvalidPattern { .. } | Self::InvalidRequest { .. } => None,
            Self::NeedsApproval {
                path,
                access,
                reason,
            } => Some(json!({
                "path": path,
                "reason": reason.name(),
                "operation": access.name(),
            })),
            Self::ApprovalMismatch { path } | Self::NotRead { path } | Self::Modified { path } => {
                Some(json!({ "path": path }))
            }
            Self::Unencodable {
                path,
                encoding,
                line,
                ..
            } => Some(json!({ "path": path, "encoding": encoding, "line": line })),
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
