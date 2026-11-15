//! Agent Host lifecycle requests sent by Core: `host/ping` and `host/shutdown`.
//!
//! `host/ping` is the heartbeat. Its result also reports the Agent Host's memory and the
//! state of its outbound frame queue, so Core can observe backpressure without a separate
//! channel. `host/shutdown` asks for an orderly exit: the Agent Host closes every session,
//! answers, flushes its output and exits with status 0.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{Method, RequestMethod};

/// Method marker for `host/ping` (Core → Agent Host).
#[derive(Debug, Clone, Copy)]
pub struct HostPing;

impl Method for HostPing {
    const NAME: &'static str = "host/ping";
    const TYPE_NAME: &'static str = "HostPing";
}

impl RequestMethod for HostPing {
    type Params = HostPingParams;
    type Result = HostStatus;
}

/// Parameters of `host/ping`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostPingParams {
    /// Core's send time in milliseconds since the Unix epoch, echoed in the result.
    pub sent_at: u64,
}

/// Result of `host/ping`: liveness plus resource counters of the Agent Host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// `sentAt` of the ping being answered.
    pub sent_at: u64,
    /// Resident set size of the Agent Host process, in bytes.
    pub rss_bytes: u64,
    /// Frames waiting to be written to stdout right now.
    pub outbound_queued_frames: u64,
    /// Bytes of those frames.
    pub outbound_queued_bytes: u64,
    /// Highest `outboundQueuedBytes` since the process started.
    pub outbound_peak_bytes: u64,
    /// Number of open sessions.
    pub sessions: u64,
}

/// Method marker for `host/shutdown` (Core → Agent Host).
#[derive(Debug, Clone, Copy)]
pub struct HostShutdown;

impl Method for HostShutdown {
    const NAME: &'static str = "host/shutdown";
    const TYPE_NAME: &'static str = "HostShutdown";
}

impl RequestMethod for HostShutdown {
    type Params = HostShutdownParams;
    type Result = HostShutdownResult;
}

/// Parameters of `host/shutdown`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostShutdownParams {
    /// Why Core asks the Agent Host to exit, for its log (for example `idle` or `appQuit`).
    pub reason: String,
}

/// Result of `host/shutdown`, sent once every session is closed and before the process
/// exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostShutdownResult {
    /// Number of sessions that were closed.
    pub closed_sessions: u64,
}
