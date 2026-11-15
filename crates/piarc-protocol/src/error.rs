//! The crate error type and its mapping to the wire error object.

use crate::rpc_error::{ErrorData, ErrorKind, ErrorObject};
use crate::version::ProtocolVersion;

/// Errors produced by this crate: handshake negotiation, frame decoding and message
/// classification.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The peers speak different major protocol versions.
    #[error(
        "protocol major version mismatch: local speaks {local}, remote speaks {remote}; \
         update the older side so both use the same major version"
    )]
    VersionMismatch {
        /// The version of this side.
        local: ProtocolVersion,
        /// The version announced by the peer.
        remote: ProtocolVersion,
    },
    /// A frame exceeded the configured size limit; it was discarded up to the next LF.
    #[error("frame exceeds the limit of {limit} bytes and was discarded")]
    FrameTooLarge {
        /// The configured limit in bytes.
        limit: usize,
    },
    /// A frame is not valid UTF-8.
    #[error("frame is not valid UTF-8: {reason}")]
    InvalidUtf8 {
        /// Description of the first invalid byte sequence.
        reason: String,
    },
    /// A frame is valid UTF-8 but not valid JSON.
    #[error("frame is not valid JSON: {reason}")]
    InvalidJson {
        /// The parser's description of the problem.
        reason: String,
    },
    /// The payload is JSON but not a valid JSON-RPC 2.0 message for AHP. A batch (JSON
    /// array) is reported here too, because AHP does not support batches.
    #[error("invalid request: {reason}")]
    InvalidRequest {
        /// What is wrong with the message.
        reason: String,
    },
    /// A value could not be serialized into a frame.
    #[error("failed to encode frame: {reason}")]
    Encode {
        /// The serializer's description of the problem.
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
            Self::VersionMismatch { .. } => ErrorKind::ProtocolVersionMismatch,
            Self::FrameTooLarge { .. } => ErrorKind::FrameTooLarge,
            Self::InvalidUtf8 { .. } | Self::InvalidJson { .. } => ErrorKind::ParseError,
            Self::InvalidRequest { .. } => ErrorKind::InvalidRequest,
            Self::Encode { .. } => ErrorKind::InternalError,
        }
    }

    /// Whether repeating the same input could succeed. None of these errors are: they are
    /// caused by the input itself or by incompatible peers.
    #[must_use]
    pub fn retryable(&self) -> bool {
        false
    }

    /// Converts the error into the JSON-RPC error object sent on the wire.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        let details = match self {
            Self::VersionMismatch { local, remote } => Some(serde_json::json!({
                "local": local.to_string(),
                "remote": remote.to_string(),
            })),
            Self::FrameTooLarge { limit } => Some(serde_json::json!({ "limit": limit })),
            Self::InvalidUtf8 { .. }
            | Self::InvalidJson { .. }
            | Self::InvalidRequest { .. }
            | Self::Encode { .. } => None,
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
