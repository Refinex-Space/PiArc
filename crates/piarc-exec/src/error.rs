//! Errors of the crate's public file and process functions (coding standards 2.3, I173):
//! [`crate::TaskLog`], [`crate::task_log::read_chunk`], [`crate::terminal_tree::TerminalTree::attach`] and
//! [`crate::CwdProbe`]. Running a command ([`crate::CommandRunner::run`]) keeps `io::Result`:
//! its failures are the spawner's (`piarc_ports::ProcessSpawner`).

use std::io;
use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorKind, ErrorObject};

/// Why a file or process operation of this crate failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A file the crate writes or reads for a command: a background task's output file, the
    /// bash startup file or the working-directory answer, or their directory.
    #[error("{}: {source}", path.display())]
    File {
        /// The file or directory involved.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
    /// The processes a terminal's shell starts cannot be followed (Windows: the Job Object
    /// cannot be created or the shell cannot join it).
    #[error("cannot follow the processes of {pid}: {source}")]
    Process {
        /// The shell's process id.
        pid: u32,
        /// The operating system's error.
        source: io::Error,
    },
    /// [`crate::CwdProbe::pin_program`] was given a name that is not a plain program name.
    #[error("{0:?} is not a plain program name")]
    InvalidProgram(String),
    /// The listening TCP sockets cannot be listed ([`crate::listeners::listening`]).
    #[error("cannot list the listening TCP ports: {source}")]
    Listeners {
        /// The operating system's error, or `lsof`'s failure.
        source: io::Error,
    },
}

/// Result type of this crate's file and process functions.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub(crate) fn file(path: &Path) -> impl FnOnce(io::Error) -> Self {
        let path = path.to_owned();
        move |source| Self::File { path, source }
    }

    /// The AHP / Core API error category.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::File { source, .. } if source.kind() == io::ErrorKind::NotFound => {
                ErrorKind::NotFound
            }
            Self::File { .. } | Self::Process { .. } | Self::Listeners { .. } => ErrorKind::IoError,
            Self::InvalidProgram(_) => ErrorKind::InvalidParams,
        }
    }

    /// Whether the same call can succeed later: a file the data directory cannot hold or a
    /// process that cannot be followed needs the user, and a bad name stays bad; listing the
    /// listening ports is asked again on the next scan.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Listeners { .. })
    }

    /// The file involved, for callers that report file errors in their own shape.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::File { path, .. } => Some(path),
            Self::Process { .. } | Self::InvalidProgram(_) | Self::Listeners { .. } => None,
        }
    }

    /// The AHP error.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        ErrorObject::new(self.kind(), self.to_string(), self.retryable())
    }

    /// The operating system's error, when there is one; consumes the error so callers that
    /// classify I/O failures (`piarc_fs::Error::io`) keep their codes.
    #[must_use]
    pub fn into_io(self) -> Option<io::Error> {
        match self {
            Self::File { source, .. }
            | Self::Process { source, .. }
            | Self::Listeners { source } => Some(source),
            Self::InvalidProgram(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_follow_the_cause() {
        let missing = Error::file(Path::new("a b/中文.log"))(io::ErrorKind::NotFound.into());
        assert_eq!(missing.kind(), ErrorKind::NotFound);
        assert_eq!(missing.path(), Some(Path::new("a b/中文.log")));
        assert!(missing.to_string().starts_with("a b/中文.log: "));
        let denied = Error::file(Path::new("x"))(io::ErrorKind::PermissionDenied.into());
        assert_eq!(denied.kind(), ErrorKind::IoError);
        let process = Error::Process {
            pid: 7,
            source: io::Error::other("no job"),
        };
        assert_eq!(process.kind(), ErrorKind::IoError);
        assert!(process.path().is_none());
        let name = Error::InvalidProgram("-x".into());
        assert_eq!(name.kind(), ErrorKind::InvalidParams);
        assert!(name.into_io().is_none());
        for error in [missing, denied, process] {
            assert!(!error.retryable());
            assert!(!error.to_error_object().data.retryable);
            assert!(error.into_io().is_some());
        }
    }
}
