//! Session-scoped memory discovery. Core chooses source files and checks external imports.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::request;

/// Start a snapshot or continue transferring its immutable UTF-8 representation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMemoryParams {
    /// Session whose working directory and workspace govern discovery.
    pub session_id: String,
    /// Correlates approval waits and pages on this connection.
    pub tool_call_id: String,
    /// Additional visited directories below the session cwd.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directories: Option<Vec<String>>,
    /// Include the git status captured when Core opened the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_git: Option<bool>,
    /// Byte offset returned by the preceding page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
}

/// One memory document with expanded imports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryFile {
    /// Source path.
    pub path: String,
    /// Visible Markdown, with source labels on expanded imports.
    pub content: String,
}

/// The JSON document transferred by fs/memory.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    /// Documents in precedence order.
    pub files: Vec<MemoryFile>,
    /// Updated documents if memory changed between opening and first delivery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_files: Option<Vec<MemoryFile>>,
    /// Session opening status when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<String>,
}

/// A frame-sized UTF-8 slice of the encoded snapshot.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FsMemoryResult {
    /// A slice ending at a character boundary.
    pub chunk: String,
    /// Absent after the last byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

request! {
    /// Read memory documents for one session.
    FsMemory, "fs/memory", FsMemoryParams, FsMemoryResult
}
