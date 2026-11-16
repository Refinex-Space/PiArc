//! The crate error type and its mapping to the structured error object.

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};

/// Errors returned by the Core runtime.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// An argument failed validation at the API boundary.
    #[error("invalid {field}: {reason}")]
    InvalidArgument {
        /// The name of the argument as the caller sees it.
        field: &'static str,
        /// What is wrong with it.
        reason: String,
    },
    /// The runtime is shutting down or has shut down and no longer accepts requests.
    #[error("Core is shutting down and no longer accepts requests")]
    ShuttingDown,
    /// The event queue is full: the client is behind. The same request can succeed once
    /// the client has caught up.
    #[error("the Core event queue is full; retry after the client has caught up")]
    QueueFull,
    /// No demo event source has this id.
    #[error("no demo event source has id {id}")]
    UnknownDemoSource {
        /// The id the caller passed.
        id: u32,
    },
    /// No terminal has this id (it was never created or is closed).
    #[error("no terminal has id {id}")]
    UnknownTerminal {
        /// The id the caller passed.
        id: u32,
    },
    /// A terminal session failed.
    #[error(transparent)]
    Terminal(#[from] piarc_term::Error),
    /// The Agent Host runtime of a packaged app is incomplete or cannot be prepared
    /// (`agent_host::BundledRuntime`): a broken installation, not a caller error.
    #[error("the bundled Agent Host runtime is unusable: {reason}")]
    BundledRuntime {
        /// What is missing or failed.
        reason: String,
    },
    /// The tokio runtime could not be started.
    #[error("failed to start the Core runtime: {reason}")]
    RuntimeStart {
        /// The underlying I/O error.
        reason: String,
    },
    /// An unexpected internal failure, including a caught panic.
    #[error("internal error: {reason}")]
    Internal {
        /// Description of the failure, for logs. Callers branch on the kind, not on this.
        reason: String,
    },
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The stable, machine-readable category of the error.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::InvalidArgument { .. } | Self::UnknownDemoSource { .. } => {
                ErrorKind::InvalidParams
            }
            Self::ShuttingDown => ErrorKind::ShuttingDown,
            Self::QueueFull => ErrorKind::Busy,
            Self::UnknownTerminal { .. } => ErrorKind::NotFound,
            Self::Terminal(error) => error.kind(),
            Self::BundledRuntime { .. } | Self::RuntimeStart { .. } | Self::Internal { .. } => {
                ErrorKind::InternalError
            }
        }
    }

    /// Whether repeating the same request could succeed. Only a full queue clears by
    /// itself.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::QueueFull)
    }

    /// Converts the error into the structured error object shared by AHP and the NAPI
    /// boundary.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let details = match self {
            Self::InvalidArgument { field, .. } => Some(serde_json::json!({ "field": field })),
            Self::UnknownDemoSource { id } | Self::UnknownTerminal { id } => {
                Some(serde_json::json!({ "id": id }))
            }
            Self::Terminal(_)
            | Self::ShuttingDown
            | Self::QueueFull
            | Self::BundledRuntime { .. }
            | Self::RuntimeStart { .. }
            | Self::Internal { .. } => None,
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

    /// The error for a caught panic. `payload` is the value `catch_unwind` or a tokio
    /// `JoinError` returned; `location` says where it was caught.
    #[must_use]
    pub fn from_panic(location: &str, payload: &(dyn std::any::Any + Send)) -> Self {
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_owned());
        Self::Internal {
            reason: format!("panic in {location}: {message}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_each_error_to_a_kind_and_retryability() {
        let cases = [
            (
                Error::InvalidArgument {
                    field: "route",
                    reason: "empty".into(),
                },
                ErrorKind::InvalidParams,
                false,
            ),
            (Error::ShuttingDown, ErrorKind::ShuttingDown, false),
            (Error::QueueFull, ErrorKind::Busy, true),
            (
                Error::UnknownDemoSource { id: 3 },
                ErrorKind::InvalidParams,
                false,
            ),
            (
                Error::Internal {
                    reason: "boom".into(),
                },
                ErrorKind::InternalError,
                false,
            ),
        ];
        for (error, kind, retryable) in cases {
            let object = error.to_error_object();
            assert_eq!(object.data.kind, kind, "{error}");
            assert_eq!(object.data.retryable, retryable, "{error}");
            assert_eq!(object.code, kind.code(), "{error}");
            assert_eq!(object.message, error.to_string());
        }
    }

    #[test]
    fn panic_payloads_become_internal_errors_with_their_message() {
        let from_str = Error::from_panic("echo", &"static message");
        let from_string = Error::from_panic("task", &String::from("owned message"));
        let from_other = Error::from_panic("task", &42_u32);
        assert_eq!(
            from_str.to_string(),
            "internal error: panic in echo: static message"
        );
        assert_eq!(
            from_string.to_string(),
            "internal error: panic in task: owned message"
        );
        assert!(from_other.to_string().ends_with("non-string panic payload"));
        assert_eq!(from_str.kind(), ErrorKind::InternalError);
    }
}
