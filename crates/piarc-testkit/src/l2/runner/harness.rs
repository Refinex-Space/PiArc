//! T26's actions and answers: forking at an agent message, checking a branch's plan and task
//! list, and the parts of a plan or question answer a scenario declares.
use piarc_protocol::harness::{PlanComment, QuestionAnswer};
use piarc_protocol::policy::ApprovalRequest;
use serde_json::Value;

use piarc_core::sessions::{ForkPoint, Op};

use super::{Driver, call};
use crate::l2::context_spec::CheckUsageAction;
use crate::l2::format::Approval;
use crate::l2::harness_spec::{CheckHarnessAction, ForkAction};
use crate::l2::matcher::subset_mismatch;

/// The most history items the actions read (Core's `session/history` limit).
const WINDOW: u64 = 1000;

impl Driver<'_> {
    async fn history(&self, session: Option<&str>) -> Result<Value, String> {
        let id = self.session_id(session)?;
        call(
            |done| self.core.transcript_window(id, Some(0), WINDOW, done),
            "reading the session's history",
        )
        .await
    }

    pub(super) async fn fork(&mut self, fork: &ForkAction) -> Result<(), String> {
        let at = match (&fork.before_turn, &fork.at_text) {
            (Some(label), _) => ForkPoint::BeforeTurn(
                self.turns
                    .get(label)
                    .ok_or_else(|| format!("fork: no turn labeled {label}"))?
                    .clone(),
            ),
            (None, Some(text)) => {
                let history = self.history(fork.session.as_deref()).await?;
                let entry = history["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|i| i["item"]["type"] == "agentMessage" && i["item"]["text"] == *text)
                    .and_then(|i| i["entryId"].as_str())
                    .ok_or_else(|| format!("fork: no agent message {text:?}"))?
                    .to_owned();
                ForkPoint::Entry(Some(entry))
            }
            (None, None) => return Err("fork needs at_text or before_turn".to_owned()),
        };
        let id = self.session_id(fork.session.as_deref())?;
        let opened = call(
            |done| self.core.fork_session(id, at, done),
            "forking the session",
        )
        .await?;
        let forked = opened["sessionId"]
            .as_str()
            .ok_or_else(|| format!("fork: no session id in {opened}"))?;
        self.sessions.insert(fork.label.clone(), forked.to_owned());
        Ok(())
    }

    /// T27: the session's context usage from Core. The categories always add up to `tokens`.
    pub(super) async fn check_usage(&self, check: &CheckUsageAction) -> Result<(), String> {
        let id = self.session_id(check.session.as_deref())?;
        let usage = call(
            |done| self.core.session_op(id, Op::ContextUsage, done),
            "reading the context usage",
        )
        .await?;
        let categories = usage["categories"]
            .as_object()
            .ok_or_else(|| format!("context usage without categories: {usage}"))?;
        let sum: u64 = categories.values().filter_map(Value::as_u64).sum();
        if Some(sum) != usage["tokens"].as_u64() {
            return Err(format!(
                "the categories add up to {sum}, the usage says {}: {usage}",
                usage["tokens"]
            ));
        }
        for name in &check.positive {
            if categories.get(name).and_then(Value::as_u64).unwrap_or(0) == 0 {
                return Err(format!("category {name} is not above zero: {usage}"));
            }
        }
        match &check.fields {
            Some(fields) => subset_mismatch(fields, &usage, "context usage").map_or(Ok(()), Err),
            None => Ok(()),
        }
    }

    pub(super) async fn check_harness(&self, check: &CheckHarnessAction) -> Result<(), String> {
        let history = self.history(check.session.as_deref()).await?;
        let actual = history.get("harness").cloned().unwrap_or(Value::Null);
        subset_mismatch(&check.fields, &actual, "harness state").map_or(Ok(()), Err)
    }
}

/// The comments of a declined plan, anchored at the first occurrence of each quote (UTF-16
/// offsets, as the client sends them).
pub(super) fn plan_comments(
    card: &ApprovalRequest,
    expected: &Approval,
) -> Result<Vec<PlanComment>, String> {
    let plan = card.plan.as_deref().unwrap_or_default();
    expected
        .comments
        .iter()
        .map(|c| {
            let at = plan
                .find(&c.quote)
                .ok_or_else(|| format!("the plan does not contain {:?}", c.quote))?;
            let start = plan[..at].encode_utf16().count() as u64;
            Ok(PlanComment {
                start,
                end: start + c.quote.encode_utf16().count() as u64,
                quote: c.quote.clone(),
                text: c.text.clone(),
            })
        })
        .collect()
}

/// The answers of a question card.
pub(super) fn question_answers(expected: &Approval) -> Vec<QuestionAnswer> {
    expected
        .answers
        .iter()
        .map(|a| QuestionAnswer {
            selected: a.selected.clone(),
            other: a.other.clone(),
        })
        .collect()
}
