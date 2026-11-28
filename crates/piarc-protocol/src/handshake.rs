//! Connection handshake: `host/hello` and its `core/welcome` result.
//!
//! The Agent Host sends `host/hello` first; Core answers with a successful response whose
//! result is [`CoreWelcome`] (the `core/welcome` contract), or with a
//! `protocolVersionMismatch` error response when [`crate::negotiate`] fails.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{Method, RequestMethod};
use crate::version::{Capability, ProtocolVersion};

/// Method marker for `host/hello` (Agent Host → Core).
#[derive(Debug, Clone, Copy)]
pub struct HostHello;

impl Method for HostHello {
    const NAME: &'static str = "host/hello";
    const TYPE_NAME: &'static str = "HostHello";
}

impl RequestMethod for HostHello {
    type Params = HostHelloParams;
    type Result = CoreWelcome;
}

/// Parameters of `host/hello`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostHelloParams {
    /// Protocol version spoken by the Agent Host.
    pub protocol: ProtocolVersion,
    /// Version of the Pi SDK the Agent Host runs.
    pub pi: String,
    /// Capabilities the Agent Host supports.
    pub capabilities: Vec<Capability>,
}

/// Result of `host/hello` (`core/welcome`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoreWelcome {
    /// Protocol version spoken by Core.
    pub protocol: ProtocolVersion,
    /// Capabilities enabled for this connection: the intersection of both sides.
    pub enabled: Vec<Capability>,
    /// Absolute path of the workspace this Agent Host serves.
    pub workspace: String,
    /// Incremented every time Core (re)starts an Agent Host for the workspace; lets both
    /// sides tell connections apart after a restart.
    pub connection_epoch: u64,
    /// Whether Pi may refresh catalogs from the network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_model_network: Option<bool>,
    /// Per-model settings and the auxiliary model (T29).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_preferences: Option<crate::models::ModelPreferences>,
}
