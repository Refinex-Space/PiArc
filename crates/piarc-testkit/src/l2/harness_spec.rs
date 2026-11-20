//! Scenario format for T26's host tools: plan and question answers, forks and the branch's
//! harness state. The schema is in `tests/scenarios/schema.json`.

use serde::Deserialize;
use serde_json::Value;

/// An inline comment on a plan card, anchored at the first occurrence of `quote` in the plan.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanCommentSpec {
    /// The commented passage, copied from the plan.
    pub quote: String,
    /// The comment.
    pub text: String,
}

/// The answer to one question of a question card.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionAnswerSpec {
    /// Labels of the picked options.
    #[serde(default)]
    pub selected: Vec<String>,
    /// An answer of the user's own.
    #[serde(default)]
    pub other: Option<String>,
}

/// Forks a session at the entry of one of its agent messages; the new session takes a label
/// declared in `sessions` (deferred, so it is not created otherwise).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForkAction {
    /// The session to fork; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// The text of the agent message whose entry is the fork point.
    #[serde(default)]
    pub at_text: Option<String>,
    /// Instead of `at_text`: fork before this labeled turn ("branch from here", T28).
    #[serde(default)]
    pub before_turn: Option<String>,
    /// The label of the new session.
    #[serde(rename = "as")]
    pub label: String,
}

/// Checks a session's plan and task list (`session/history`'s `harness`), or their absence
/// when `fields` is null.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckHarnessAction {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// A field subset of the harness state.
    pub fields: Value,
}
