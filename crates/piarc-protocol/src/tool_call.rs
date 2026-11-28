//! What ties a delegated I/O request to the tool call that made it.
//!
//! The Agent Host's tools delegate their file and command I/O to Core (`fs/*`, `exec/*`,
//! ADR-0004). Every such request may name the tool call it serves, by canonical tool name
//! (`Read`, `Bash`, ...; architecture section 6.1.1) and Pi's tool call id. Core uses it for
//! logs today; permission checks, snapshots and audit records attach to it later.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The tool call a delegated request serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolOrigin {
    /// Canonical tool name, for example `Read`; never the model-visible name of a Tool Profile.
    pub tool: String,
    /// Pi's id of the tool call.
    pub tool_call_id: String,
}
