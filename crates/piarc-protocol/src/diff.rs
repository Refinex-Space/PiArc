//! Structured diff of one file change (architecture section 7.7): the unified diff text and
//! the same change as hunks, computed by Core (`piarc-diff`) and carried by `fs/write` results
//! and `fileChange` items.
//!
//! Line numbers are 1-based. A hunk with no old (new) lines has `oldStart` (`newStart`) at the
//! line before which it applies, as in unified diff (`@@ -0,0 +1,3 @@` for a new file).
//! Large changes degrade: past a line limit the hunks are left out (`degraded`) and the unified
//! text is cut, while the line counts stay exact.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One file change as a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// The file as the diff names it: relative to the workspace root with `/` separators, or
    /// absolute outside it.
    pub path: String,
    /// Whether the file did not exist before the change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
    /// Lines added.
    pub added: u64,
    /// Lines removed.
    pub removed: u64,
    /// The change as unified diff text (`---`/`+++` headers, three lines of context).
    pub unified: String,
    /// The change as hunks, in file order; empty when `degraded`.
    pub hunks: Vec<DiffHunk>,
    /// Set when the change was too large for hunks: `hunks` is empty and `unified` may be cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<bool>,
}

/// A run of changed lines with their context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// First line of the hunk in the old file.
    pub old_start: u64,
    /// Lines of the old file the hunk covers.
    pub old_lines: u64,
    /// First line of the hunk in the new file.
    pub new_start: u64,
    /// Lines of the new file the hunk covers.
    pub new_lines: u64,
    /// The hunk's lines in order.
    pub lines: Vec<DiffLine>,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// Whether the line is kept, added or removed.
    pub kind: DiffLineKind,
    /// The line without its line break.
    pub text: String,
    /// Set on a last line that has no line break at the end of its file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_newline: Option<bool>,
}

/// What happened to a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    /// In both files.
    Context,
    /// Only in the new file.
    Added,
    /// Only in the old file.
    Removed,
}
