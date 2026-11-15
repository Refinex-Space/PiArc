//! The crate error type and its mapping to the structured error object.

use piarc_protocol::{ErrorData, ErrorKind, ErrorObject};

/// Errors of calls to the Agent Host and of the supervisor.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Error {
    /// The Agent Host is not connected: starting, restarting or stopped.
    #[error("the Agent Host is not connected ({state})")]
    HostUnavailable {
        /// The supervisor state at the time of the call.
        state: String,
    },
    /// The write queue to the Agent Host is full; the request was not sent.
    #[error("the write queue to the Agent Host is full; {method} was not sent")]
    Busy {
        /// The method of the refused request.
        method: String,
    },
    /// No response arrived in time. The request may still take effect.
    #[error("{method} got no response within {timeout_ms} ms")]
    Timeout {
        /// The method of the request.
        method: String,
        /// The timeout that expired.
        timeout_ms: u64,
    },
    /// The connection ended before the request reached a final state. It is not replayed.
    #[error("the Agent Host connection ended before {method} completed; its outcome is unknown")]
    Uncertain {
        /// The method of the request.
        method: String,
    },
    /// The Agent Host answered with an error.
    #[error("{method} failed: {}", error.message)]
    Remote {
        /// The method of the request.
        method: String,
        /// The error response.
        error: ErrorObject,
    },
    /// The Agent Host's result does not match the method's result type.
    #[error("{method} returned a malformed result: {reason}")]
    MalformedResult {
        /// The method of the request.
        method: String,
        /// What did not match.
        reason: String,
    },
    /// The request could not be serialized.
    #[error("{method} could not be encoded: {reason}")]
    Encode {
        /// The method of the request.
        method: String,
        /// The serializer's message.
        reason: String,
    },
    /// The supervisor is shutting down or stopped and accepts no calls.
    #[error("the Agent Host supervisor is shutting down")]
    ShuttingDown,
}

/// Result type of this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// The stable, machine-readable category of the error.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::HostUnavailable { .. } => ErrorKind::HostUnavailable,
            Self::Busy { .. } => ErrorKind::Busy,
            Self::Timeout { .. } => ErrorKind::Timeout,
            Self::Uncertain { .. } => ErrorKind::Uncertain,
            Self::Remote { error, .. } => error.data.kind,
            Self::MalformedResult { .. } | Self::Encode { .. } => ErrorKind::InternalError,
            Self::ShuttingDown => ErrorKind::ShuttingDown,
        }
    }

    /// Whether repeating the call could succeed. An uncertain call is not retryable: whether it
    /// took effect is unknown, and the session layer decides (ADR-0009 rule 5).
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::HostUnavailable { .. } | Self::Busy { .. } | Self::Timeout { .. } => true,
            Self::Remote { error, .. } => error.data.retryable,
            Self::Uncertain { .. }
            | Self::MalformedResult { .. }
            | Self::Encode { .. }
            | Self::ShuttingDown => false,
        }
    }

    /// The structured error object shared by AHP and the NAPI boundary.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        if let Self::Remote { error, .. } = self {
            return error.clone();
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_errors_to_kinds_and_retryability() {
        let remote = ErrorObject::new(ErrorKind::SessionBusy, "busy", true);
        let cases = [
            (
                Error::HostUnavailable {
                    state: "restarting".into(),
                },
                ErrorKind::HostUnavailable,
                true,
            ),
            (Error::Busy { method: "m".into() }, ErrorKind::Busy, true),
            (
                Error::Timeout {
                    method: "m".into(),
                    timeout_ms: 5,
                },
                ErrorKind::Timeout,
                true,
            ),
            (
                Error::Uncertain { method: "m".into() },
                ErrorKind::Uncertain,
                false,
            ),
            (
                Error::Remote {
                    method: "m".into(),
                    error: remote.clone(),
                },
                ErrorKind::SessionBusy,
                true,
            ),
            (Error::ShuttingDown, ErrorKind::ShuttingDown, false),
        ];
        for (error, kind, retryable) in cases {
            let object = error.to_error_object();
            assert_eq!(
                (object.data.kind, object.data.retryable),
                (kind, retryable),
                "{error}"
            );
        }
        let passthrough = Error::Remote {
            method: "m".into(),
            error: remote.clone(),
        };
        assert_eq!(passthrough.to_error_object(), remote);
    }
}
