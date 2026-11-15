//! Call reconciliation (ADR-0009 rule 5): the state of every request Core sent to the Agent
//! Host.
//!
//! - `sent`: written to the Agent Host, no response yet;
//! - `acknowledged`: a `session/prompt` the Agent Host accepted; it stays open until the
//!   `turn/completed` notification of its turn arrives;
//! - `terminal`: answered (success or error), or its turn completed. Terminal calls leave the
//!   ledger at once, so it holds only calls in flight;
//! - `uncertain`: the connection ended while the call was `sent` or `acknowledged`. Whether it
//!   took effect is unknown; it is reported once and never replayed.
//!
//! Transitions happen on the connection's reader task in frame order, so a prompt's response
//! is always recorded before its `turn/completed`.

use std::collections::BTreeMap;

use piarc_protocol::method::Method;
use piarc_protocol::session::SessionPrompt;
use serde::Serialize;

/// The state of one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallState {
    /// Written, not answered yet.
    Sent,
    /// A prompt accepted by the Agent Host whose turn has not completed.
    Acknowledged,
    /// Answered, or its turn completed.
    Terminal,
    /// The connection ended first; the outcome is unknown.
    Uncertain,
}

/// One call to the Agent Host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    /// JSON-RPC id of the request.
    pub call_id: i64,
    /// Connection the call was sent on.
    pub epoch: u64,
    /// The method.
    pub method: String,
    /// The session the call targets, if any.
    pub session_id: Option<String>,
    /// The idempotency key of a `session/prompt`.
    pub request_key: Option<String>,
    /// The turn a prompt started, once acknowledged.
    pub turn_id: Option<String>,
    /// Where the call stands.
    pub state: CallState,
}

/// Calls in flight, by call id.
#[derive(Debug, Default)]
pub struct Ledger {
    calls: BTreeMap<i64, CallRecord>,
}

impl Ledger {
    /// Records a call that was just queued for writing.
    pub fn sent(&mut self, record: CallRecord) {
        self.calls.insert(record.call_id, record);
    }

    /// Forgets a call that was never written (the write queue refused it).
    pub fn withdraw(&mut self, call_id: i64) {
        self.calls.remove(&call_id);
    }

    /// Records the response to `call_id`. A successful `session/prompt` with a `turnId`
    /// becomes `acknowledged`; anything else is terminal.
    pub fn answered(&mut self, call_id: i64, turn_id: Option<String>) {
        let acknowledged = match self.calls.get_mut(&call_id) {
            Some(record) if record.method == SessionPrompt::NAME && turn_id.is_some() => {
                record.turn_id = turn_id;
                record.state = CallState::Acknowledged;
                true
            }
            _ => false,
        };
        if !acknowledged {
            self.calls.remove(&call_id);
        }
    }

    /// A turn completed: the prompt that started it is terminal.
    pub fn turn_completed(&mut self, epoch: u64, session_id: &str, turn_id: &str) {
        self.calls.retain(|_, record| {
            !(record.epoch == epoch
                && record.state == CallState::Acknowledged
                && record.session_id.as_deref() == Some(session_id)
                && record.turn_id.as_deref() == Some(turn_id))
        });
    }

    /// The connection `epoch` ended: its open calls become uncertain and leave the ledger.
    pub fn connection_lost(&mut self, epoch: u64) -> Vec<CallRecord> {
        let lost: Vec<i64> = self
            .calls
            .values()
            .filter(|record| record.epoch == epoch)
            .map(|record| record.call_id)
            .collect();
        lost.into_iter()
            .filter_map(|id| self.calls.remove(&id))
            .map(|mut record| {
                record.state = CallState::Uncertain;
                record
            })
            .collect()
    }

    /// The calls in flight.
    #[must_use]
    pub fn snapshot(&self) -> Vec<CallRecord> {
        self.calls.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(call_id: i64, epoch: u64, method: &str, session: Option<&str>) -> CallRecord {
        CallRecord {
            call_id,
            epoch,
            method: method.to_owned(),
            session_id: session.map(str::to_owned),
            request_key: None,
            turn_id: None,
            state: CallState::Sent,
        }
    }

    #[test]
    fn keeps_a_prompt_open_until_its_turn_completes() {
        let mut ledger = Ledger::default();
        ledger.sent(call(1, 1, "session/prompt", Some("s")));
        ledger.answered(1, Some("t1".into()));
        assert_eq!(ledger.snapshot()[0].state, CallState::Acknowledged);
        ledger.turn_completed(1, "other", "t1");
        ledger.turn_completed(1, "s", "t2");
        assert_eq!(ledger.snapshot().len(), 1);
        ledger.turn_completed(1, "s", "t1");
        assert!(ledger.snapshot().is_empty());
    }

    #[test]
    fn answered_requests_and_rejected_prompts_are_terminal() {
        let mut ledger = Ledger::default();
        ledger.sent(call(1, 1, "session/create", None));
        ledger.sent(call(2, 1, "session/prompt", Some("s")));
        ledger.answered(1, None);
        ledger.answered(2, None);
        assert!(ledger.snapshot().is_empty());
    }

    #[test]
    fn marks_the_open_calls_of_a_lost_connection_uncertain() {
        let mut ledger = Ledger::default();
        ledger.sent(call(1, 1, "session/create", None));
        ledger.sent(call(2, 1, "session/prompt", Some("s")));
        ledger.answered(2, Some("t".into()));
        ledger.sent(call(3, 2, "session/close", Some("s")));
        let lost = ledger.connection_lost(1);
        assert_eq!(
            lost.iter()
                .map(|r| (r.call_id, r.state))
                .collect::<Vec<_>>(),
            [(1, CallState::Uncertain), (2, CallState::Uncertain)]
        );
        assert_eq!(lost[1].turn_id.as_deref(), Some("t"));
        assert_eq!(
            ledger
                .snapshot()
                .iter()
                .map(|r| r.call_id)
                .collect::<Vec<_>>(),
            [3]
        );
    }
}
