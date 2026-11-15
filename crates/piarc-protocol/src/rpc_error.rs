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

    const ALL_KINDS: [ErrorKind; 7] = [
        ErrorKind::ParseError,
        ErrorKind::InvalidRequest,
        ErrorKind::MethodNotFound,
        ErrorKind::InvalidParams,
        ErrorKind::InternalError,
        ErrorKind::ProtocolVersionMismatch,
        ErrorKind::FrameTooLarge,
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
