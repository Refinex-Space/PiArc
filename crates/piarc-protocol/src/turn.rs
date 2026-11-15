//! Turns and items: the minimal `turn/*` and `item/*` notifications.
//!
//! A session runs turns; a turn produces items (agent messages, tool calls, ...). Each item
//! goes `item/started` → optional deltas → `item/completed`, identified by
//! `sessionId / turnId / itemId`. This module defines the skeleton; item types beyond
//! `agentMessage` are added by the tasks that need them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{Method, NotificationMethod};
use crate::session::SessionEventHeader;

/// Turn identifier, unique within a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct TurnId(pub String);

/// Item identifier, unique within a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct ItemId(pub String);

/// Lifecycle state of an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    /// Started and not finished yet.
    InProgress,
    /// Finished successfully.
    Completed,
    /// Finished with an error.
    Failed,
    /// Rejected by the user or by policy before it ran.
    Declined,
    /// Stopped because the turn was aborted.
    Interrupted,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    /// The turn ran to completion.
    Completed,
    /// The turn ended with an error.
    Failed,
    /// The turn was aborted.
    Interrupted,
}

/// An item in its current state, discriminated by the `type` member. Every variant
/// carries `itemId` and `status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    /// Text produced by the agent.
    AgentMessage {
        /// The item's identifier.
        item_id: ItemId,
        /// Lifecycle state.
        status: ItemStatus,
        /// The message text accumulated so far (complete in `item/completed`).
        text: String,
    },
}

impl Item {
    /// The item's identifier.
    #[must_use]
    pub fn item_id(&self) -> &ItemId {
        match self {
            Self::AgentMessage { item_id, .. } => item_id,
        }
    }

    /// The item's lifecycle state.
    #[must_use]
    pub fn status(&self) -> ItemStatus {
        match self {
            Self::AgentMessage { status, .. } => *status,
        }
    }
}

/// Parameters of `turn/started`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn that started.
    pub turn_id: TurnId,
}

/// Parameters of `turn/completed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn that ended.
    pub turn_id: TurnId,
    /// How it ended.
    pub status: TurnStatus,
}

/// Parameters of `item/started` and `item/completed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemEventParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn the item belongs to.
    pub turn_id: TurnId,
    /// The item's state: `inProgress` when started, final when completed.
    pub item: Item,
}

/// Parameters of `item/agentMessage/delta`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageDeltaParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The turn the item belongs to.
    pub turn_id: TurnId,
    /// The `agentMessage` item being extended.
    pub item_id: ItemId,
    /// Text to append.
    pub delta: String,
}

macro_rules! notification {
    ($(#[$doc:meta])* $marker:ident, $name:literal, $params:ty) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy)]
        pub struct $marker;

        impl Method for $marker {
            const NAME: &'static str = $name;
            const TYPE_NAME: &'static str = stringify!($marker);
        }

        impl NotificationMethod for $marker {
            type Params = $params;
        }
    };
}

notification!(
    /// Method marker for `turn/started` (Agent Host → Core).
    TurnStarted, "turn/started", TurnStartedParams
);
notification!(
    /// Method marker for `turn/completed` (Agent Host → Core).
    TurnCompleted, "turn/completed", TurnCompletedParams
);
notification!(
    /// Method marker for `item/started` (Agent Host → Core).
    ItemStarted, "item/started", ItemEventParams
);
notification!(
    /// Method marker for `item/completed` (Agent Host → Core).
    ItemCompleted, "item/completed", ItemEventParams
);
notification!(
    /// Method marker for `item/agentMessage/delta` (Agent Host → Core).
    ItemAgentMessageDelta, "item/agentMessage/delta", AgentMessageDeltaParams
);
