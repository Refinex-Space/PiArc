//! The Harness Kit's host tools (architecture section 6.5, T26): the task list (`TodoWrite`),
//! the plan (`EnterPlanMode`, `ExitPlanMode`), structured questions (`AskUserQuestion`) and
//! next-step suggestions (`SuggestNextSteps`).
//!
//! - `harness/todo` (Agent Host → Core, capability `todo`): the session's task list after a
//!   `TodoWrite` result, sent right after that call's `item/completed`. The list lives in the
//!   result's `details`, so the list of a branch is its last `TodoWrite` result.
//! - `harness/plan` (Agent Host → Core, capability `planMode`): a plan the user approved,
//!   recorded as the custom entry `piarc.plan` on the session's branch.
//! - `ui/ask` (Agent Host → Core, capability `ask`): `AskUserQuestion` shows its form; Core
//!   keeps it in the session's approval ledger and answers with one result per question, when
//!   the user answers or the configured timeout passes.
//! - [`HarnessState`] is the plan and task list at the head of a branch, returned with
//!   `session/history` so a client that reloads the transcript gets them too.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::{notification, request};
use crate::policy::PermissionMode;
use crate::session::SessionEventHeader;
use crate::turn::ItemId;

/// Where a task stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TodoStatus {
    /// Not started.
    Pending,
    /// Being worked on.
    InProgress,
    /// Done.
    Completed,
}

/// One task of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// What the task is, in the imperative ("Run the tests").
    pub content: String,
    /// Where it stands.
    pub status: TodoStatus,
    /// The same task as it reads while in progress ("Running the tests").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// Parameters of `harness/todo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTodoParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The `TodoWrite` call whose result holds the list.
    pub item_id: ItemId,
    /// The whole list, in order.
    pub todos: Vec<TodoItem>,
}

notification!(
    /// Method marker for `harness/todo` (Agent Host → Core).
    HarnessTodo, "harness/todo", HarnessTodoParams
);

/// A plan the user approved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    /// The plan as the model wrote it (Markdown).
    pub plan: String,
    /// The `ExitPlanMode` call that submitted it.
    pub tool_call_id: String,
    /// Pi's id of the `piarc.plan` custom entry.
    pub entry_id: String,
    /// The mode the user chose to continue in.
    pub mode: PermissionMode,
}

/// Parameters of `harness/plan`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPlanParams {
    /// Session event header.
    #[serde(flatten)]
    pub header: SessionEventHeader,
    /// The approved plan.
    #[serde(flatten)]
    pub record: PlanRecord,
}

notification!(
    /// Method marker for `harness/plan` (Agent Host → Core).
    HarnessPlan, "harness/plan", HarnessPlanParams
);

/// The plan and task list at the head of a branch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HarnessState {
    /// The last plan the user approved on the branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanRecord>,
    /// The task list of the branch's last `TodoWrite` result.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<TodoItem>,
}

/// One choice of a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    /// What the user picks (short).
    pub label: String,
    /// What picking it means.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Chosen when the question times out without an answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

/// One question of `AskUserQuestion`. The user may always write an answer of their own
/// besides the options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The question.
    pub question: String,
    /// A short label for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// The choices.
    pub options: Vec<QuestionOption>,
    /// Whether several options may be picked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
}

/// The user's answer to one question, in the order of the questions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    /// Labels of the picked options.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected: Vec<String>,
    /// An answer in the user's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
}

/// How a question was settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QuestionOutcome {
    /// The user answered.
    Answered,
    /// The time ran out; the question's default options stand.
    Default,
    /// The time ran out and the question has no default.
    Unanswered,
    /// The user closed the form without answering.
    Declined,
}

/// The result of one question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResult {
    /// The question it answers.
    pub question: String,
    /// How it was settled.
    pub outcome: QuestionOutcome,
    /// Labels of the picked options (the defaults for `default`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected: Vec<String>,
    /// The user's own answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other: Option<String>,
}

/// Parameters of `ui/ask`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiAskParams {
    /// The asking session.
    pub session_id: String,
    /// The `AskUserQuestion` call.
    pub tool_call_id: String,
    /// The questions, 1 to 4.
    pub questions: Vec<Question>,
}

/// Result of `ui/ask`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UiAskResult {
    /// One result per question, in order.
    pub results: Vec<QuestionResult>,
    /// What the user wrote when closing the form without answering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

request!(
    /// Show `AskUserQuestion`'s form and wait for the answers (Agent Host → Core).
    UiAsk, "ui/ask", UiAskParams, UiAskResult
);

/// An inline comment on a plan: a range of the plan text and what the user wrote about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanComment {
    /// Start of the commented range, in UTF-16 code units of the plan (architecture 7.7).
    pub start: u64,
    /// End of the range (exclusive).
    pub end: u64,
    /// The commented text, `plan[start..end]`.
    pub quote: String,
    /// The comment.
    pub text: String,
}
