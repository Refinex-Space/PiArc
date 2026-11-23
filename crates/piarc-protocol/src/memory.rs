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
    /// Owning turn, so delayed completion of its predecessor cannot cancel this scan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Additional visited directories below the session cwd.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directories: Option<Vec<String>>,
    /// Include the git status captured when Core opened the session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_git: Option<bool>,
    /// Files the agent just read or wrote: conditional rules whose `paths:` match one of
    /// them are loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    /// Conditional rules already delivered in this session (their `MemoryFile.path`); they
    /// stay loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// Byte offset returned by the preceding page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
}

/// What a memory document is besides an ordinary memory file (T47).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MemoryKind {
    /// A `CLAUDE.md` an organization placed with its managed settings: always first, the user
    /// cannot leave it out.
    Managed,
    /// The index of the agent's auto memory for this repository: last.
    AutoMemory,
}

/// One memory document with expanded imports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MemoryFile {
    /// Source path.
    pub path: String,
    /// Visible Markdown, with source labels on expanded imports.
    pub content: String,
    /// For a rule with `paths:` frontmatter, its globs: the rule was loaded because the agent
    /// read or wrote a matching file (or did so earlier in the session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    /// A managed `CLAUDE.md` or the auto memory index (T47); absent for ordinary files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MemoryKind>,
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
    /// Some conditional rule is not loaded yet: reading or writing a matching file would
    /// load it. Absent when every rule is loaded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inactive_rules: Option<bool>,
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

/// `memory/status` (T47): what auto memory offers a session.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusParams {
    /// The session.
    pub session_id: String,
}

/// The answer of `memory/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusResult {
    /// Auto memory is on: the index joins the session's memory snapshot.
    pub enabled: bool,
    /// The session offers the `Memory` tool: auto memory is on, the project is trusted and the
    /// session is not a subagent.
    pub tool: bool,
}

request! {
    /// What auto memory offers a session (T47); asked when the session opens.
    MemoryStatus, "memory/status", MemoryStatusParams, MemoryStatusResult
}

/// What a `Memory` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MemoryAction {
    /// The whole index, or one memory by name.
    Read,
    /// Creates or replaces one memory.
    Save,
    /// Deletes one memory.
    Delete,
}

/// `memory/apply` (T47): one `Memory` tool call, run by Core after the call was allowed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryApplyParams {
    /// The session.
    pub session_id: String,
    /// The `Memory` call whose permission this consumes.
    pub tool_call_id: String,
    /// What to do.
    pub action: MemoryAction,
    /// The memory's name (`read` without it returns the whole index).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `user`, `feedback`, `project` or `reference` (`save`).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// One line for the index (`save`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The memory's Markdown body (`save`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// A `read` that restores context after a compaction: no tool call, read only, the
    /// session's own repository only.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub restore: bool,
}

/// The answer of `memory/apply`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryApplyResult {
    /// The tool result for the model.
    pub text: String,
    /// A `save` or `delete` changed the memory: the index as a new session would get it now
    /// (absent when no memory is left), so the session knows its own change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<MemoryFile>,
    /// Whether the memory changed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
}

request! {
    /// Runs one `Memory` tool call (T47).
    MemoryApply, "memory/apply", MemoryApplyParams, MemoryApplyResult
}
