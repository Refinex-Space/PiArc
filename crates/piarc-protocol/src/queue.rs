//! The input queue of a session: steering and follow-up messages waiting for a running turn
//! (architecture section 5.3).
//!
//! Pi keeps queued messages as bare strings. The Agent Host gives every queued input an id and
//! keeps the queue table itself, so Core can edit, delete and reorder single items
//! (`session/queue/*`); every change, including a delivery to the model, is reported as
//! `session/queueChanged` with the whole queue in order.
//!
//! Delivery: steering items reach the model after the current step, in their queue order;
//! follow-up items each start a new turn after the running turn completes, in their queue
//! order. Reordering is a permutation of all items; it changes the relative order within each
//! kind.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{notification, request};
use crate::session::{SessionEventHeader, SessionId};

/// How a queued input is delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueueKind {
    /// Reaches the model after the current step of the running turn.
    Steer,
    /// Starts a new turn after the running turn completes.
    FollowUp,
}

/// One queued input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// The item's id, unique within the session.
    pub item_id: String,
    /// How it is delivered.
    pub kind: QueueKind,
    /// The text.
    pub text: String,
}

/// The whole queue, in order: the result of `session/queue/*` and the payload of
/// `session/queueChanged`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    /// The queued items, in queue order.
    pub items: Vec<QueueItem>,
}

/// Parameters of `session/queue/edit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueEditParams {
    /// The session.
    pub session_id: SessionId,
    /// The item to change.
    pub item_id: String,
    /// Its new text.
    pub text: String,
}

/// Parameters of `session/queue/delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueDeleteParams {
    /// The session.
    pub session_id: SessionId,
    /// The item to remove.
    pub item_id: String,
}

/// Parameters of `session/queue/reorder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueReorderParams {
    /// The session.
    pub session_id: SessionId,
    /// Every queued item's id, each once, in the new order.
    pub item_ids: Vec<String>,
}

/// Parameters of `session/queueChanged`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueChangedParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The queued items, in queue order.
    pub items: Vec<QueueItem>,
}

request!(
    /// Method marker for `session/queue/edit` (Core → Agent Host).
    QueueEdit, "session/queue/edit", QueueEditParams, QueueState
);
request!(
    /// Method marker for `session/queue/delete` (Core → Agent Host).
    QueueDelete, "session/queue/delete", QueueDeleteParams, QueueState
);
request!(
    /// Method marker for `session/queue/reorder` (Core → Agent Host).
    QueueReorder, "session/queue/reorder", QueueReorderParams, QueueState
);

notification!(
    /// Method marker for `session/queueChanged` (Agent Host → Core).
    QueueChanged, "session/queueChanged", QueueChangedParams
);
