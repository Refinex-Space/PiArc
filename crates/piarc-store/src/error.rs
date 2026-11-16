//! Errors of the store. Messages name tables, files and versions, never row content.

use std::io;
use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};
use serde_json::json;

/// Why a store operation failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// SQLite reported an error.
    #[error("{context}: {source}")]
    Sqlite {
        /// What was being done.
        context: &'static str,
        /// SQLite's error.
        source: rusqlite::Error,
    },
    /// A migration failed; its transaction was rolled back and the schema stays at the
    /// previous version.
    #[error("migration {version} ({name}) failed: {source}")]
    Migration {
        /// The version that failed.
        version: u32,
        /// Its name.
        name: &'static str,
        /// SQLite's error.
        source: rusqlite::Error,
    },
    /// The database was written by a newer build: it records a migration this build does not
    /// know.
    #[error("the database is at schema version {found}, newer than this build's {known}")]
    SchemaTooNew {
        /// The highest recorded version.
        found: u32,
        /// The highest version this build knows.
        known: u32,
    },
    /// Reading a file failed.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The file involved.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
    /// A path that is not valid UTF-8 cannot be stored as a key.
    #[error("the path {} is not valid UTF-8", path.display())]
    NonUtf8Path {
        /// The rejected path.
        path: PathBuf,
    },
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub(crate) fn sqlite(context: &'static str) -> impl FnOnce(rusqlite::Error) -> Self {
        move |source| Self::Sqlite { context, source }
    }

    pub(crate) fn io(op: &'static str, path: &Path) -> impl FnOnce(io::Error) -> Self {
        let path = path.to_owned();
        move |source| Self::Io { op, path, source }
    }

    /// The AHP / Core API error category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Io { .. } => ErrorKind::IoError,
            Self::NonUtf8Path { .. } => ErrorKind::InvalidParams,
            Self::Sqlite { .. } | Self::Migration { .. } | Self::SchemaTooNew { .. } => {
                ErrorKind::InternalError
            }
        }
    }

    /// Whether the same call can succeed later: only when SQLite reported the database as
    /// busy or locked by another connection.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Sqlite { source: rusqlite::Error::SqliteFailure(e, _), .. }
                if matches!(e.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        )
    }

    /// The structured error for AHP and NAPI.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let details = match self {
            Self::Io { path, source, .. } => Some(json!({
                "code": source.kind().to_string(),
                "path": path.to_string_lossy(),
            })),
            Self::Migration { version, .. } => Some(json!({ "version": version })),
            Self::SchemaTooNew { found, known } => Some(json!({ "found": found, "known": known })),
            Self::Sqlite { .. } | Self::NonUtf8Path { .. } => None,
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

/// The path as a UTF-8 string for a key column.
pub(crate) fn path_text(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| Error::NonUtf8Path {
        path: path.to_owned(),
    })
}
