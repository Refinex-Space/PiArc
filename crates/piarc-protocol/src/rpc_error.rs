//! The structured error object carried by JSON-RPC error responses.
//!
//! The shape follows the JSON-RPC 2.0 error object (`code`, `message`, `data`). PiArc makes
//! `data` mandatory and requires `data.kind` (machine-readable category) and
//! `data.retryable`; `data.details` is optional. Callers branch on `kind`, never on
//! `message`. The NAPI boundary (ADR-0014) reuses the same shape.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Error codes.
///
/// Two ranges, defined separately:
///
/// - Standard codes from the JSON-RPC 2.0 specification (`-32700`, `-32600`..=`-32603`).
/// - The application range [`APPLICATION_MIN`]..=[`APPLICATION_MAX`] (`-32099..=-32000`,
///   which JSON-RPC reserves for implementation-defined errors). Every application
///   [`ErrorKind`] gets one fixed code from this range; new kinds take the next free code.
///
/// The code is coarse; `data.kind` carries the precise category.
pub mod code {
    /// Invalid JSON was received.
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON is not a valid request object (this includes batches, which AHP rejects).
    pub const INVALID_REQUEST: i64 = -32600;
    /// The method does not exist or is not available.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// Invalid method parameters.
    pub const INVALID_PARAMS: i64 = -32602;
    /// Internal error.
    pub const INTERNAL_ERROR: i64 = -32603;

    /// Lowest code of the application range.
    pub const APPLICATION_MIN: i64 = -32099;
    /// Highest code of the application range.
    pub const APPLICATION_MAX: i64 = -32000;

    /// The peers' major protocol versions differ.
    pub const PROTOCOL_VERSION_MISMATCH: i64 = -32000;
    /// A frame exceeded the receiver's size limit.
    pub const FRAME_TOO_LARGE: i64 = -32001;
    /// The receiver is shutting down and no longer accepts requests.
    pub const SHUTTING_DOWN: i64 = -32002;
    /// The receiver's queue is full; the same request can succeed later.
    pub const BUSY: i64 = -32003;
    /// No response arrived within the request's timeout.
    pub const TIMEOUT: i64 = -32004;
    /// The connection ended before the request reached a final state; it may or may not have
    /// taken effect.
    pub const UNCERTAIN: i64 = -32005;
    /// The Agent Host is not connected (starting, restarting or stopped).
    pub const HOST_UNAVAILABLE: i64 = -32006;
    /// No open session has the given id.
    pub const SESSION_NOT_FOUND: i64 = -32007;
    /// The session is running a turn and cannot start another.
    pub const SESSION_BUSY: i64 = -32008;
    /// The path named by a file operation does not exist.
    pub const NOT_FOUND: i64 = -32009;
    /// The path of a file or command operation lies outside the session's workspace.
    pub const OUTSIDE_WORKSPACE: i64 = -32010;
    /// The operating system refused a file or process operation.
    pub const IO_ERROR: i64 = -32011;
    /// The credential vault exists but its master key is gone from the system credential store.
    pub const MASTER_KEY_MISSING: i64 = -32012;
    /// The system credential store refused access, is locked or cannot be reached.
    pub const CREDENTIAL_STORE_UNAVAILABLE: i64 = -32013;
    /// The credential vault failed authentication: it was modified or damaged.
    pub const VAULT_INTEGRITY: i64 = -32014;
    /// The credential vault has a format version this build does not know.
    pub const VAULT_VERSION: i64 = -32015;
    /// A credential lock is no longer held: it expired or was released.
    pub const SECRET_LOCK_LOST: i64 = -32016;
    /// A release manifest or a downloaded artefact failed verification.
    pub const RELEASE_INTEGRITY: i64 = -32017;
    /// A queued input with the given id is no longer waiting: it was delivered or removed.
    pub const QUEUE_ITEM_NOT_FOUND: i64 = -32018;
}

/// JSON-RPC 2.0 error object with PiArc's mandatory structured `data`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorObject {
    /// Error code; see [`code`] for the standard and application ranges.
    pub code: i64,
    /// Human-readable description. Not meant for branching.
    pub message: String,
    /// Structured, machine-readable error data.
    pub data: ErrorData,
}

/// Structured part of an [`ErrorObject`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorData {
    /// Machine-readable error category.
    pub kind: ErrorKind,
    /// Whether repeating the same request could succeed.
    pub retryable: bool,
    /// Optional kind-specific details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// Machine-readable error categories.
///
/// Adding a variant is not backward compatible for receivers on an older minor version;
/// see the crate documentation on compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// Invalid JSON or invalid UTF-8 was received.
    ParseError,
    /// The message is not a valid AHP JSON-RPC message (including batches).
    InvalidRequest,
    /// The method does not exist or is not available.
    MethodNotFound,
    /// The method parameters are invalid.
    InvalidParams,
    /// An unexpected internal failure.
    InternalError,
    /// The peers' major protocol versions differ.
    ProtocolVersionMismatch,
    /// A frame exceeded the receiver's size limit.
    FrameTooLarge,
    /// The receiver is shutting down and no longer accepts requests. Core API only: not
    /// sent over AHP until a capability introduces it.
    ShuttingDown,
    /// The receiver's queue is full; retrying later can succeed. Core API only: not sent
    /// over AHP until a capability introduces it.
    Busy,
    /// No response arrived within the request's timeout; whether the request took effect is
    /// unknown.
    Timeout,
    /// The connection to the Agent Host ended before the request reached a final state; it
    /// may or may not have taken effect, and it is not replayed. Core API only.
    Uncertain,
    /// The Agent Host is not connected: it is starting, restarting or stopped. Core API only.
    HostUnavailable,
    /// No open session has the given id.
    SessionNotFound,
    /// The session is running a turn and cannot start another one yet.
    SessionBusy,
    /// The path named by a file operation does not exist. `details`: `{ code: "ENOENT",
    /// path }`.
    NotFound,
    /// The path of a file or command operation resolves, after normalization and symlink
    /// resolution, to a location outside the session's workspace root. `details`:
    /// `{ path, resolved, root }`.
    OutsideWorkspace,
    /// The operating system refused a file or process operation. `details`: `{ code, path }`
    /// with a POSIX-style error code such as `EACCES`, `EISDIR` or `ENOTDIR`.
    IoError,
    /// The credential vault exists but its master key is gone from the system credential
    /// store. Nothing is created or overwritten; the user decides how to recover.
    MasterKeyMissing,
    /// The system credential store refused access to the master key, is locked or cannot be
    /// reached. Retryable once the user grants access. `details`: `{ reason }` with
    /// `accessDenied`, `unavailable` or `failed`.
    CredentialStoreUnavailable,
    /// The credential vault failed authentication (modified or damaged); no entry is returned.
    VaultIntegrity,
    /// The credential vault has a format version this build does not know. `details`:
    /// `{ version }`.
    VaultVersion,
    /// A `secrets/*` request named a lock that is no longer held (expired or released).
    SecretLockLost,
    /// A release manifest's signature or a downloaded artefact's size or SHA-256 did not
    /// verify; the update must be refused (ADR-0018 rule 4). `details`: `{ reason, file? }`
    /// with `reason` one of `noTrustedKey`, `malformedSignature`, `unknownKey`,
    /// `badSignature`, `malformedManifest`, `notListed`, `sizeMismatch`, `hashMismatch`.
    ReleaseIntegrity,
    /// A `session/queue/*` request named a queued input that is no longer waiting: it was
    /// delivered to the model or removed meanwhile. `details`: `{ sessionId, itemId }`.
    QueueItemNotFound,
}

impl ErrorKind {
    /// The JSON-RPC error code used for this kind.
    #[must_use]
    pub const fn code(self) -> i64 {
        match self {
            Self::ParseError => code::PARSE_ERROR,
            Self::InvalidRequest => code::INVALID_REQUEST,
            Self::MethodNotFound => code::METHOD_NOT_FOUND,
            Self::InvalidParams => code::INVALID_PARAMS,
            Self::InternalError => code::INTERNAL_ERROR,
            Self::ProtocolVersionMismatch => code::PROTOCOL_VERSION_MISMATCH,
            Self::FrameTooLarge => code::FRAME_TOO_LARGE,
            Self::ShuttingDown => code::SHUTTING_DOWN,
            Self::Busy => code::BUSY,
            Self::Timeout => code::TIMEOUT,
            Self::Uncertain => code::UNCERTAIN,
            Self::HostUnavailable => code::HOST_UNAVAILABLE,
            Self::SessionNotFound => code::SESSION_NOT_FOUND,
            Self::SessionBusy => code::SESSION_BUSY,
            Self::NotFound => code::NOT_FOUND,
            Self::OutsideWorkspace => code::OUTSIDE_WORKSPACE,
            Self::IoError => code::IO_ERROR,
            Self::MasterKeyMissing => code::MASTER_KEY_MISSING,
            Self::CredentialStoreUnavailable => code::CREDENTIAL_STORE_UNAVAILABLE,
            Self::VaultIntegrity => code::VAULT_INTEGRITY,
            Self::VaultVersion => code::VAULT_VERSION,
            Self::SecretLockLost => code::SECRET_LOCK_LOST,
            Self::ReleaseIntegrity => code::RELEASE_INTEGRITY,
            Self::QueueItemNotFound => code::QUEUE_ITEM_NOT_FOUND,
        }
    }
}

impl ErrorObject {
    /// Builds an error object whose code is derived from `kind`.
    #[must_use]
    pub fn new(kind: ErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: kind.code(),
            message: message.into(),
            data: ErrorData {
                kind,
                retryable,
                details: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_KINDS: [ErrorKind; 24] = [
        ErrorKind::ParseError,
        ErrorKind::InvalidRequest,
        ErrorKind::MethodNotFound,
        ErrorKind::InvalidParams,
        ErrorKind::InternalError,
        ErrorKind::ProtocolVersionMismatch,
        ErrorKind::FrameTooLarge,
        ErrorKind::ShuttingDown,
        ErrorKind::Busy,
        ErrorKind::Timeout,
        ErrorKind::Uncertain,
        ErrorKind::HostUnavailable,
        ErrorKind::SessionNotFound,
        ErrorKind::SessionBusy,
        ErrorKind::NotFound,
        ErrorKind::OutsideWorkspace,
        ErrorKind::IoError,
        ErrorKind::MasterKeyMissing,
        ErrorKind::CredentialStoreUnavailable,
        ErrorKind::VaultIntegrity,
        ErrorKind::VaultVersion,
        ErrorKind::SecretLockLost,
        ErrorKind::ReleaseIntegrity,
        ErrorKind::QueueItemNotFound,
    ];

    #[test]
    fn application_kinds_use_codes_from_the_application_range() {
        let standard = [
            code::PARSE_ERROR,
            code::INVALID_REQUEST,
            code::METHOD_NOT_FOUND,
            code::INVALID_PARAMS,
            code::INTERNAL_ERROR,
        ];
        for kind in ALL_KINDS {
            let c = kind.code();
            assert!(
                standard.contains(&c)
                    || (code::APPLICATION_MIN..=code::APPLICATION_MAX).contains(&c),
                "{kind:?} uses code {c} outside both ranges"
            );
        }
    }

    #[test]
    fn every_kind_has_a_distinct_code() {
        let mut codes: Vec<i64> = ALL_KINDS.iter().map(|k| k.code()).collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), ALL_KINDS.len());
    }

    #[test]
    fn serializes_as_a_json_rpc_error_object() {
        let error = ErrorObject::new(ErrorKind::MethodNotFound, "no such method", false);
        let value = serde_json::to_value(&error).expect("error object serializes");
        assert_eq!(
            value,
            serde_json::json!({
                "code": -32601,
                "message": "no such method",
                "data": { "kind": "methodNotFound", "retryable": false }
            })
        );
    }

    #[test]
    fn rejects_error_data_without_kind_or_retryable() {
        let missing_kind = serde_json::json!({
            "code": -32603, "message": "x", "data": { "retryable": false }
        });
        let missing_retryable = serde_json::json!({
            "code": -32603, "message": "x", "data": { "kind": "internalError" }
        });
        let missing_data = serde_json::json!({ "code": -32603, "message": "x" });
        for value in [missing_kind, missing_retryable, missing_data] {
            assert!(
                serde_json::from_value::<ErrorObject>(value.clone()).is_err(),
                "{value}"
            );
        }
    }
}
