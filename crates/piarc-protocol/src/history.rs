//! Reading a session back: the replay buffer for `seq` gaps and the persisted history.
//!
//! - `session/getEntries` answers with the session's notifications after `since` (a `seq`),
//!   from a bounded buffer the Agent Host keeps per session. Core asks when it sees a gap in
//!   `seq` and forwards the missing notifications in order before the ones that followed the
//!   gap. `complete` is false when the buffer no longer holds all of them; Core then tells
//!   the client to reload the transcript.
//! - `session/history` projects the session file's current branch into items, by the same
//!   rules as the live notifications (architecture section 5.3), for Core's
//!   `transcript_window`. Live and historical items of a tool call share the tool call id;
//!   message items in the history are named after Pi's entry ids.
//! - `harness/entry` reports a custom session entry written by the Harness Kit (type prefix
//!   `piarc.`), for example a to-do list update.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::method::{notification, request};
use crate::session::{SessionEventHeader, SessionEventNotification, SessionId};
use crate::turn::{Item, TurnId};

/// Parameters of `session/getEntries`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetEntriesParams {
    /// The session.
    pub session_id: SessionId,
    /// The last `seq` Core received in order; the answer starts after it.
    pub since: u64,
}

/// Result of `session/getEntries`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntries {
    /// The notifications with `seq` greater than `since`, in `seq` order.
    pub entries: Vec<SessionEventNotification>,
    /// Whether `entries` starts right after `since`: false when the buffer dropped some of
    /// them.
    pub complete: bool,
}

/// Parameters of `session/history`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryParams {
    /// The session; it does not need to be open.
    pub session_id: SessionId,
    /// Its working directory (where its file is stored).
    pub cwd: String,
    /// Index of the first item; the last `limit` items when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u64>,
    /// The most items to return (1 to 1000).
    pub limit: u64,
}

/// One item of the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    /// The Pi entry the item comes from (for a tool call: the assistant message's entry).
    pub entry_id: String,
    /// The enclosing turn, or its first user entry in session files without PiArc turn IDs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// The item in its final state.
    pub item: Item,
}

/// Result of `session/history`: items `start .. start + items.len()` of `total`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWindow {
    /// Index of the first returned item.
    pub start: u64,
    /// How many items the history has.
    pub total: u64,
    /// The items, in conversation order.
    pub items: Vec<HistoryItem>,
    /// The plan and task list at the head of the branch (T26).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<crate::harness::HarnessState>,
    /// The branch points on the current branch (capability `checkpoints`, T28).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<crate::checkpoint::BranchPoint>>,
}

/// Parameters of `harness/entry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessEntryParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// Pi's id of the custom entry.
    pub entry_id: String,
    /// The entry's type, for example `piarc.todo`.
    pub custom_type: String,
    /// The entry's data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

request!(
    /// Method marker for `session/getEntries` (Core → Agent Host).
    SessionGetEntries, "session/getEntries", GetEntriesParams, SessionEntries
);
request!(
    /// Method marker for `session/history` (Core → Agent Host).
    SessionHistory, "session/history", HistoryParams, HistoryWindow
);
notification!(
    /// Method marker for `harness/entry` (Agent Host → Core).
    HarnessEntry, "harness/entry", HarnessEntryParams
);
