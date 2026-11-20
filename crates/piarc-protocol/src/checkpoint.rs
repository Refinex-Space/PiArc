//! Checkpoints, rewind, the Changes panel and session branches (architecture section 6.9, T28,
//! ADR-0044).
//!
//! AHP (capability `checkpoints`):
//!
//! - `session/rewind` (Core → Agent Host): moves the conversation back to before a turn, as a
//!   new branch (`branch`) or with the rest of the branch summarized (`summarize`); the original
//!   branch stays in the session file.
//! - `session/switchBranch` (Core → Agent Host): continues the conversation on another branch.
//! - `session/branches` (Agent Host → Core): the branch points on the current branch, sent when
//!   a user message lands where other branches exist.
//! - `fs/write`'s `turnId`, `session/fork`'s `beforeTurn` and `session/history`'s `branches`
//!   are in `fs.rs`, `session.rs` and `history.rs`.
//!
//! Core API (desktop clients): the rewind preview, request and report, the Changes panel's view
//! and discard request.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::diff::FileDiff;
use crate::method::{notification, request};
use crate::policy::PermissionMode;
use crate::session::{SessionEventHeader, SessionId};
use crate::turn::TurnId;

/// How `session/rewind` moves the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RewindMode {
    /// Continue from where the turn started; the turn and everything after it stay on the old
    /// branch.
    Branch,
    /// Like `branch`, with a summary of the turn and everything after it as the new branch's
    /// first entry.
    Summarize,
}

/// Parameters of `session/rewind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRewindParams {
    /// The session; it must be idle.
    pub session_id: SessionId,
    /// The turn to go back to before, on the current branch.
    pub turn_id: TurnId,
    /// How.
    pub mode: RewindMode,
}

/// Result of `session/rewind` and `session/switchBranch`: the session as reopened on its new
/// branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRewound {
    /// The session.
    pub session_id: SessionId,
    /// Conversation messages on the new branch.
    pub restored_messages: u64,
    /// Last mode explicitly selected on the new branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// What the user wrote in the turn's first message (`session/rewind` only), for the input
    /// box.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Parameters of `session/switchBranch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionSwitchBranchParams {
    /// The session; it must be idle.
    pub session_id: SessionId,
    /// The branch's last entry ([`BranchOption::entry_id`]).
    pub entry_id: String,
}

/// One branch at a branch point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchOption {
    /// The branch's last entry: what `session/switchBranch` continues from.
    pub entry_id: String,
    /// The turn that starts the branch, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// The start of the branch's first user message.
    pub preview: String,
}

/// A place on the current branch where other branches start: turns that begin at the same
/// entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BranchPoint {
    /// The current branch's turn at this place; absent when the current branch has no turn here
    /// yet (the conversation was rewound to this place and nothing was sent since).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// That turn's position among the options (0-based, in the order the branches were
    /// written).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
    /// Every branch that has a turn at this place, the current one included.
    pub options: Vec<BranchOption>,
}

/// Parameters of `session/branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionBranchesParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The branch points on the current branch, oldest first.
    pub branches: Vec<BranchPoint>,
}

request!(
    /// Method marker for `session/rewind` (Core → Agent Host).
    SessionRewind, "session/rewind", SessionRewindParams, SessionRewound
);
request!(
    /// Method marker for `session/switchBranch` (Core → Agent Host).
    SessionSwitchBranch, "session/switchBranch", SessionSwitchBranchParams, SessionRewound
);
notification!(
    /// Method marker for `session/branches` (Agent Host → Core).
    SessionBranches, "session/branches", SessionBranchesParams
);

/// What a rewind restores (Core API).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RewindScope {
    /// The files and the conversation, back to before the turn.
    CodeAndConversation,
    /// The conversation only.
    Conversation,
    /// The files only.
    Code,
    /// The conversation from the turn on becomes a summary; files stay.
    Summarize,
}

impl RewindScope {
    /// Whether the files go back.
    #[must_use]
    pub fn restores_code(self) -> bool {
        matches!(self, Self::CodeAndConversation | Self::Code)
    }

    /// How the conversation moves, if it does.
    #[must_use]
    pub fn conversation(self) -> Option<RewindMode> {
        match self {
            Self::CodeAndConversation | Self::Conversation => Some(RewindMode::Branch),
            Self::Summarize => Some(RewindMode::Summarize),
            Self::Code => None,
        }
    }
}

/// What a rewind does to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RewindAction {
    /// The file gets its content from before the turn.
    Restore,
    /// The file was created from the turn on and is removed.
    Delete,
    /// The file already has that content.
    Unchanged,
    /// The file changed outside the session (or by a command) since the session last wrote
    /// it: the user chooses.
    Conflict,
}

/// One file of a rewind preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewindFile {
    /// The file.
    pub path: String,
    /// The file as diffs name it: relative to the workspace, absolute outside it.
    pub label: String,
    /// What happens to it.
    pub action: RewindAction,
    /// For a conflict: overwriting removes the file (it did not exist before the turn).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletes: Option<bool>,
    /// The content now: hex SHA-256, or `absent`. A request names it for a conflict.
    pub version: String,
    /// Outside the workspace or a protected path: confirming the rewind approves the write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<bool>,
}

/// What a rewind would do (Core API `rewindPreview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    /// The turn.
    pub turn_id: TurnId,
    /// Whether the files can go back: the turn has a checkpoint (it was not pruned, the
    /// session made it).
    pub code_available: bool,
    /// The files written from the turn on.
    pub files: Vec<RewindFile>,
}

/// The user's choice for a conflicting file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConflictChoice {
    /// The file ([`RewindFile::path`]).
    pub path: String,
    /// The version the user saw ([`RewindFile::version`]).
    pub version: String,
    /// Overwrite with the snapshot; otherwise keep the current content.
    pub overwrite: bool,
}

/// A rewind (Core API `rewind`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewindRequest {
    /// The turn to go back to before.
    pub turn_id: TurnId,
    /// What goes back.
    pub scope: RewindScope,
    /// A choice for every conflicting file of the preview.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<ConflictChoice>,
}

/// What happened to one file of a rewind or an undo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FileOutcome {
    /// It got the recorded content.
    Restored,
    /// It was removed.
    Deleted,
    /// It already had the content.
    Unchanged,
    /// The user chose to keep it (or it changed again since the rewind, for an undo).
    Kept,
    /// It could not be changed; the rewind stopped here.
    Failed,
    /// Not reached: an earlier file failed.
    Skipped,
}

/// One file of a rewind or undo report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    /// The file.
    pub path: String,
    /// The file as diffs name it.
    pub label: String,
    /// What happened.
    pub outcome: FileOutcome,
    /// Why it failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a rewind or an undo did (Core API `rewind`, `undoRewind`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewindReport {
    /// Every file, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<FileResult>,
    /// Undoes the files this rewind changed (`undoRewind`); absent when it changed none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_id: Option<String>,
    /// Whether every step ran: false when a file failed (the conversation did not move then) or
    /// the conversation could not move.
    pub completed: bool,
    /// The conversation moved: what the user wrote in the turn's first message, for the input
    /// box (absent for a summary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<RewoundConversation>,
    /// Why the rewind stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The conversation part of a rewind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewoundConversation {
    /// What the user wrote in the turn's first message, for the input box.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// How a file differs from its base in the Changes panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// It did not exist before the session wrote it.
    Created,
    /// It exists with other content.
    Modified,
    /// It existed and is gone.
    Deleted,
}

/// One file of the Changes panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// The file.
    pub path: String,
    /// The file as diffs name it.
    pub label: String,
    /// How it differs.
    pub kind: ChangeKind,
    /// The content now: hex SHA-256, or `absent`. A discard names it.
    pub version: String,
    /// Lines added since the base.
    pub added: u64,
    /// Lines removed since the base.
    pub removed: u64,
    /// The base or the current content is binary: only the whole file can be discarded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// The diff; absent for binary files and when the panel degraded (fetch the file alone).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<FileDiff>,
}

/// The session's changes (Core API `sessionChanges`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangesView {
    /// The changed files, in the order the session first wrote them.
    pub files: Vec<ChangedFile>,
    /// Lines added across the files.
    pub added: u64,
    /// Lines removed across the files.
    pub removed: u64,
    /// Too many files or lines: the diffs are left out and shown as plain text when a file is
    /// fetched alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<bool>,
}

/// Discarding a file's change, or one hunk of it (Core API `discardChange`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRequest {
    /// The file ([`ChangedFile::path`]).
    pub path: String,
    /// The version the diff was shown for ([`ChangedFile::version`]).
    pub version: String,
    /// The hunk's index in the shown diff; the whole file when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hunk: Option<u64>,
}

/// The version string of a content hash: hex SHA-256, or `absent` for no file.
pub const ABSENT_VERSION: &str = "absent";
