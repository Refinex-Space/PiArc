//! `trust/get` (Agent Host → Core): whether a directory is a trusted project.
//!
//! Core owns project trust (architecture sections 5.5 and 10.2). The Agent Host asks before
//! it loads project-level Pi resources for a session and treats every failure (error,
//! timeout, lost connection) as "not trusted".

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{Method, RequestMethod};

/// Method marker for `trust/get` (Agent Host → Core).
#[derive(Debug, Clone, Copy)]
pub struct TrustGet;

impl Method for TrustGet {
    const NAME: &'static str = "trust/get";
    const TYPE_NAME: &'static str = "TrustGet";
}

impl RequestMethod for TrustGet {
    type Params = TrustGetParams;
    type Result = TrustStatus;
}

/// Parameters of `trust/get`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrustGetParams {
    /// Absolute path of the directory, normally a session's working directory.
    pub path: String,
}

/// Result of `trust/get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    /// Whether project-level resources in that directory may be loaded.
    pub trusted: bool,
}
