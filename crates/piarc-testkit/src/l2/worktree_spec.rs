//! Scenario format for T35: sessions in worktrees, their cleanup, and git checks. The schema is
//! in `tests/scenarios/schema.json`.

use serde::Deserialize;
use serde_json::Value;

/// A session created in a worktree of its own (the new-session form's choice).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeSpec {
    /// Its name; Core's default (the session id's start) when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// The branch or commit it starts from; the workspace's HEAD when absent.
    #[serde(default)]
    pub base: Option<String>,
}

/// Runs one worktree cleanup now and checks which sessions' worktrees it removed and which
/// wait for the user (session labels, compared as sets).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SweepWorktreesSpec {
    /// Sessions whose worktree was removed.
    #[serde(default)]
    pub removed: Vec<String>,
    /// Sessions whose worktree has changes and waits.
    #[serde(default)]
    pub waiting: Vec<String>,
}

/// Checks a session's worktree: a field subset of `{ path, branch, exists, removed,
/// cleanupDue, confirm }` (`path` relative to the workspace, `/`-separated).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckWorktreeSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// Required fields; `null` for "no worktree".
    pub fields: Value,
}

/// Removes a closed session's worktree as the archive dialog or the cleanup question does.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveWorktreeSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// Throw its uncommitted changes away.
    #[serde(default)]
    pub discard: bool,
    /// Whether Core removes it (false: it refuses).
    #[serde(default = "yes")]
    pub succeeds: bool,
}

fn yes() -> bool {
    true
}

/// Keeps a session's worktree for another retention period (the cleanup question's "keep").
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeepWorktreeSpec {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
}

/// Runs git in the workspace and checks what it printed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckGitSpec {
    /// Arguments after `git`.
    pub args: Vec<String>,
    /// Texts its standard output contains.
    #[serde(default)]
    pub contains: Vec<String>,
    /// Texts it does not contain.
    #[serde(default)]
    pub not_contains: Vec<String>,
    /// How many non-empty lines it printed.
    #[serde(default)]
    pub lines: Option<usize>,
}

/// Searches the sessions' messages through Core and checks which sessions match (labels,
/// compared as sets) and the texts of their snippets.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchSpec {
    /// The query.
    pub query: String,
    /// The matching sessions.
    pub sessions: Vec<String>,
    /// Texts some snippet contains.
    #[serde(default)]
    pub snippets: Vec<String>,
}
