//! Scenario format for T28: rewinds and their undo, the Changes panel and branches. The schema
//! is in `tests/scenarios/schema.json`.

use std::collections::BTreeMap;

use piarc_protocol::checkpoint::{FileOutcome, RewindAction, RewindScope};
use serde::Deserialize;
use serde_json::Value;

fn yes() -> bool {
    true
}

/// Rewinds a session to before one of its labeled turns: checks the preview, answers conflicts,
/// checks the report.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RewindSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The label of the turn (`prompt`'s `turn`).
    pub turn: String,
    /// What goes back.
    pub scope: RewindScope,
    /// Every file the preview lists, by its workspace-relative label, with its action. Checked
    /// exactly when given.
    #[serde(default)]
    pub preview: Option<BTreeMap<String, RewindAction>>,
    /// For each conflicting file (label): overwrite with the snapshot (`true`) or keep.
    #[serde(default)]
    pub choices: BTreeMap<String, bool>,
    /// Stop after the preview, as when the user cancels.
    #[serde(default)]
    pub cancel: bool,
    /// The outcome of each file in the report (label → outcome), checked exactly when given.
    #[serde(default)]
    pub outcomes: Option<BTreeMap<String, FileOutcome>>,
    /// Whether every step ran.
    #[serde(default = "yes")]
    pub completed: bool,
    /// The text the rewind gives back for the input box.
    #[serde(default)]
    pub text: Option<String>,
}

/// Undoes the session's latest rewind.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoRewindSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The outcome of each file (label → outcome), checked exactly when given.
    #[serde(default)]
    pub outcomes: Option<BTreeMap<String, FileOutcome>>,
}

/// Checks a field subset of the session's Changes view.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckChangesSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// A field subset of `ChangesView` (files by their order).
    pub fields: Value,
}

/// Discards a file's change, or one hunk, in the Changes panel.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscardSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The file's workspace-relative label.
    pub path: String,
    /// The hunk's index in the file's diff; the whole file when absent.
    #[serde(default)]
    pub hunk: Option<u64>,
    /// Send an outdated version: the discard must be refused (`fileModified`).
    #[serde(default)]
    pub stale: bool,
}

/// Continues on the branch whose first user message starts with `to`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SwitchBranchSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The branch's preview (the start of its first user message).
    pub to: String,
}

/// Checks the conversation of the session's current branch.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckBranchSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The user and agent message texts on the branch, in order.
    pub texts: Vec<String>,
    /// A field subset of the branch points (`session/history`'s `branches`), `null` for none.
    #[serde(default)]
    pub branches: Option<Value>,
}

/// Checks workspace files in the middle of a scenario: content, or `null` for absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckFilesSpec {
    /// Relative path → content or `null`.
    pub files: BTreeMap<String, Option<String>>,
}
