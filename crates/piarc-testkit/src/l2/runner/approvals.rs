//! Answers to approval cards and question forms in the order a scenario declares them (T20,
//! T26, T30): the next visible card, its tool and call, and the answer Core receives.

use super::*;

impl Driver<'_> {
    pub(super) async fn answer_visible(&mut self) -> Result<(), String> {
        use piarc_protocol::policy::ApprovalRequest;

        let snapshots: Vec<Value> = {
            let all = self
                .events
                .all
                .lock()
                .map_err(|_| "event log unavailable")?;
            let new = all[self.approval_cursor..]
                .iter()
                .filter(|(route, _)| route == "core/sessions")
                .map(|(_, v)| v.clone())
                .collect();
            self.approval_cursor = all.len();
            new
        };
        for event in snapshots {
            for session in event["sessions"].as_array().into_iter().flatten() {
                let cards = session["approvals"]
                    .as_array()
                    .ok_or("session snapshot lacks approvals")?;
                if session["pendingApprovals"].as_u64() != Some(cards.len() as u64) {
                    return Err(format!(
                        "pendingApprovals disagrees with the {} cards in the snapshot",
                        cards.len()
                    ));
                }
                for raw in cards {
                    let card: ApprovalRequest =
                        serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
                    self.answer_card(card).await?;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn answer_card(
        &mut self,
        card: piarc_protocol::policy::ApprovalRequest,
    ) -> Result<(), String> {
        use crate::l2::format::ApprovalDecision as Choice;
        use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision as Decision};
        if self.answered.contains(&card.request_id) {
            return Ok(());
        }
        let pending = self.pending_call(&card.tool);
        let expected = if self.mode == Mode::L3 {
            // L3 answers the approval that names this card's call, whatever their order.
            self.spec
                .approvals
                .iter()
                .find(|a| a.call.is_some() && a.call == pending)
        } else {
            self.spec.approvals.get(self.answered.len())
        };
        let Some(expected) = expected else {
            if self.mode == Mode::L3 {
                return self.refuse_unscripted(card, pending).await;
            }
            return Err(format!("unexpected approval for {}", card.tool));
        };
        if self.mode == Mode::Strict && expected.call.is_some() && expected.call != pending {
            return Err(format!(
                "approval expected for call {:?}, got {pending:?}",
                expected.call
            ));
        }
        if self.mode == Mode::L3 {
            // L3 answers in order whatever the card is; the comparison reports the asks.
            self.asks.push(json!({
                "tool": card.tool,
                "call": pending,
                "decision": format!("{:?}", expected.decision).to_lowercase(),
                "scripted": true,
            }));
        } else if expected.tool.as_ref().is_some_and(|t| t != &card.tool) {
            return Err(format!(
                "approval expected {:?}, got {}",
                expected.tool, card.tool
            ));
        }
        if self.mode == Mode::Strict && expected.kind.is_some_and(|kind| kind != card.kind) {
            return Err(format!(
                "approval expected {:?}, got {:?}",
                expected.kind, card.kind
            ));
        }
        if expected.decision == Choice::Wait {
            // The form's timeout answers it; the result reaches the model as a tool result.
            self.answered.insert(card.request_id);
            return Ok(());
        }
        let comments = harness::plan_comments(&card, expected)?;
        let answer = ApprovalAnswer {
            request_id: card.request_id.clone(),
            session_id: card.session_id,
            revision: card.revision,
            connection_epoch: card.connection_epoch,
            feedback: expected.feedback.clone(),
            rules: card.rules,
            directory: card.directory,
            mode: expected.mode,
            comments,
            answers: harness::question_answers(expected),
            decision: match expected.decision {
                Choice::Allow => Decision::AllowOnce,
                Choice::Session => Decision::AllowSession,
                Choice::Always => Decision::AllowAlways,
                Choice::Deny | Choice::Wait => Decision::Deny,
            },
        };
        let result = call(
            |done| self.core.answer_approval(answer, done),
            "answering an approval",
        )
        .await?;
        if result["status"] != "applied" {
            return Err(format!("approval was not applied: {result}"));
        }
        self.answered.insert(card.request_id);
        Ok(())
    }
}
