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
//!
//! # Session requests (Core → Agent Host)
//!
//! - `session/create` opens a new session in a working directory; `session/resume` reopens
//!   one by id (Core uses it after an Agent Host restart, passing the last `seq` it received
//!   so numbering continues). Both answer with [`SessionOpened`].
//! - `session/prompt` starts a turn. The response ([`PromptAccepted`]) only acknowledges
//!   it: the turn's outcome arrives later as `turn/completed` with the same `turnId`. Its
//!   `requestId` is an idempotency key: the same key on the same session returns the turn
//!   it already started instead of starting another (ADR-0009 rule 5).
//! - `session/abort` interrupts the running turn and answers once the session is idle;
//!   `session/close` aborts, shuts the session down and forgets it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::jsonrpc::Version;
use crate::method::{Method, RequestMethod};
use crate::turn::TurnId;

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

/// Selects a model by provider id and model id, for example `anthropic` / `claude-opus-5-5`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    /// Provider id.
    pub provider: String,
    /// Model id within the provider.
    pub id: String,
}

/// Parameters of `session/create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    /// Absolute working directory of the session: tools resolve relative paths against it.
    pub cwd: String,
    /// Model to start with; the Agent Host's configured default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
}

/// Parameters of `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeParams {
    /// The session to reopen.
    pub session_id: SessionId,
    /// Its working directory, as given to `session/create`.
    pub cwd: String,
    /// The last `seq` Core received for this session; the session's notifications continue
    /// from the next number, so `seq` keeps increasing across Agent Host restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<u64>,
}

/// Result of `session/create` and `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpened {
    /// The session's id: new for `session/create`, the requested one for `session/resume`.
    pub session_id: SessionId,
    /// Number of conversation messages restored from the session file (0 for a new session).
    pub restored_messages: u64,
}

/// Parameters of `session/close` and `session/abort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    /// The session to act on.
    pub session_id: SessionId,
}

/// Result of `session/close` and `session/abort`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStopped {
    /// The session acted on.
    pub session_id: SessionId,
    /// The turn that was running and got interrupted, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted_turn_id: Option<TurnId>,
}

/// Parameters of `session/prompt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    /// The session to prompt.
    pub session_id: SessionId,
    /// Idempotency key chosen by Core; repeating it returns the turn already started.
    pub request_id: String,
    /// The user's input.
    pub text: String,
}

/// Result of `session/prompt`: the turn was accepted and will report `turn/started` and
/// `turn/completed` with this id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptAccepted {
    /// The turn running the prompt.
    pub turn_id: TurnId,
}

macro_rules! request {
    ($(#[$doc:meta])* $marker:ident, $name:literal, $params:ty, $result:ty) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy)]
        pub struct $marker;

        impl Method for $marker {
            const NAME: &'static str = $name;
            const TYPE_NAME: &'static str = stringify!($marker);
        }

        impl RequestMethod for $marker {
            type Params = $params;
            type Result = $result;
        }
    };
}

request!(
    /// Method marker for `session/create` (Core → Agent Host).
    SessionCreate, "session/create", SessionCreateParams, SessionOpened
);
request!(
    /// Method marker for `session/resume` (Core → Agent Host).
    SessionResume, "session/resume", SessionResumeParams, SessionOpened
);
request!(
    /// Method marker for `session/close` (Core → Agent Host).
    SessionClose, "session/close", SessionTarget, SessionStopped
);
request!(
    /// Method marker for `session/abort` (Core → Agent Host).
    SessionAbort, "session/abort", SessionTarget, SessionStopped
);
request!(
    /// Method marker for `session/prompt` (Core → Agent Host).
    SessionPrompt, "session/prompt", SessionPromptParams, PromptAccepted
);
