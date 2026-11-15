//! Session event envelope.
//!
//! ADR-0009 describes every session event as `{sessionId, seq, ts, type, payload}`. On the
//! wire this is a JSON-RPC notification:
//!
//! - `type` is the JSON-RPC `method` (for example `turn/started`);
//! - `sessionId`, `seq` and `ts` are members of `params` ([`SessionEventHeader`]);
//! - `payload` is the rest of `params` (the method-specific fields).
//!
//! `seq` increases monotonically per session; Core detects gaps by it and backfills with
//! `session/getEntries(since)`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::jsonrpc::Version;

/// Session identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct SessionId(pub String);

/// Members every session notification carries in `params`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventHeader {
    /// The session the event belongs to.
    pub session_id: SessionId,
    /// Sequence number, monotonically increasing within the session.
    pub seq: u64,
    /// Time the event was produced, in milliseconds since the Unix epoch (UTC).
    pub ts: u64,
}

/// Any session notification, read without interpreting its method: header plus payload.
/// Core uses it to track `seq` for every session event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventNotification {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// The event type, for example `item/completed`.
    pub method: String,
    /// Header and payload.
    pub params: SessionEventParams,
}

/// `params` of a session notification: the header plus the method-specific payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEventParams {
    /// `sessionId`, `seq` and `ts`.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// Every other member of `params`.
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}
