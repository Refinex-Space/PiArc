//! `ui/ask` (T26, architecture section 6.5): `AskUserQuestion`'s form.
//!
//! The form is a `question` card in the session's approval ledger, so every window shows it
//! and only the first valid answer counts (the same `revision` and `connectionEpoch` rules as
//! the other cards). The tool itself asks in every mode; its permission preflight treats it
//! like a read-only tool. Core answers once:
//!
//! - the user answers: one result per question, `answered`;
//! - the user closes the form: every question `declined`, with their feedback;
//! - the settings' `askUserQuestion.timeoutSeconds` pass first (on [`ToolIoConfig::clock`]):
//!   each question's default options (`default`), or `unanswered` when it has none;
//! - the turn is interrupted or the connection ends: the card goes away and the request fails
//!   with `cancelled`.
use std::time::Duration;

use piarc_protocol::harness::{
    Question, QuestionOutcome, QuestionResult, UiAskParams, UiAskResult,
};

use super::*;

/// Questions in one form.
pub(super) const MAX_QUESTIONS: usize = 4;
/// Options of one question (the tool's schema asks for the same).
pub(super) const OPTIONS: std::ops::RangeInclusive<usize> = 2..=4;
/// Where the settings give the form's timeout, in seconds; absent waits for the user.
pub(super) const TIMEOUT_POINTER: &str = "/askUserQuestion/timeoutSeconds";

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::InvalidParams, message, false)
}

fn withdrawn() -> ErrorObject {
    ErrorObject::new(
        ErrorKind::Cancelled,
        "The question was withdrawn: the turn was interrupted or the connection ended.",
        false,
    )
}

/// The questions of one form: 1 to 4, each with a text and 2 to 4 distinct labelled options,
/// at most one default unless several may be picked.
fn check_questions(questions: &[Question]) -> Result<(), ErrorObject> {
    if questions.is_empty() || questions.len() > MAX_QUESTIONS {
        return Err(invalid(format!(
            "ui/ask takes 1 to {MAX_QUESTIONS} questions"
        )));
    }
    for (n, q) in questions.iter().enumerate() {
        if q.question.trim().is_empty() {
            return Err(invalid(format!("question {n} has no text")));
        }
        if !OPTIONS.contains(&q.options.len()) {
            return Err(invalid(format!(
                "question {n} needs {} to {} options",
                OPTIONS.start(),
                OPTIONS.end()
            )));
        }
        let mut labels = HashSet::new();
        if q.options
            .iter()
            .any(|o| o.label.trim().is_empty() || !labels.insert(&o.label))
        {
            return Err(invalid(format!(
                "question {n} has an empty or repeated option label"
            )));
        }
        let defaults = q.options.iter().filter(|o| o.default == Some(true)).count();
        if defaults > 1 && q.multi_select != Some(true) {
            return Err(invalid(format!(
                "question {n} allows one choice but has {defaults} defaults"
            )));
        }
    }
    Ok(())
}

/// An answer to a `question` card: closing it, or one answer per question that picks known
/// options (one at most unless several may be picked) or says something of its own.
pub(super) fn check_answer(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    match answer.decision {
        ApprovalDecision::Deny => return Ok(()),
        ApprovalDecision::AllowOnce => {}
        ApprovalDecision::AllowSession | ApprovalDecision::AllowAlways => {
            return Err(denied("Answer the questions once."));
        }
    }
    if answer.answers.len() != request.questions.len() {
        return Err(denied(format!(
            "Expected {} answers, got {}.",
            request.questions.len(),
            answer.answers.len()
        )));
    }
    for (q, a) in request.questions.iter().zip(&answer.answers) {
        let mut picked = HashSet::new();
        let known = a
            .selected
            .iter()
            .all(|s| q.options.iter().any(|o| &o.label == s) && picked.insert(s));
        let other = a.other.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let count = a.selected.len() + usize::from(other.is_some());
        let many = q.multi_select == Some(true);
        if !known || count == 0 || (!many && count > 1) {
            return Err(denied(format!(
                "The answer to {:?} is not one the question allows.",
                q.question
            )));
        }
    }
    Ok(())
}

/// The form's timeout from the merged settings.
fn timeout_of(settings: &Settings) -> Option<Duration> {
    settings
        .get(TIMEOUT_POINTER)
        .and_then(Value::as_f64)
        .filter(|seconds| *seconds > 0.0)
        .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
}

/// The results when the time ran out: each question's defaults, or none.
fn timed_out(questions: &[Question]) -> UiAskResult {
    let results = questions
        .iter()
        .map(|q| {
            let selected: Vec<String> = q
                .options
                .iter()
                .filter(|o| o.default == Some(true))
                .map(|o| o.label.clone())
                .collect();
            QuestionResult {
                question: q.question.clone(),
                outcome: if selected.is_empty() {
                    QuestionOutcome::Unanswered
                } else {
                    QuestionOutcome::Default
                },
                selected,
                other: None,
            }
        })
        .collect();
    UiAskResult {
        results,
        feedback: None,
    }
}

/// The results of the user's answer (checked by [`check_answer`]).
fn answered(questions: &[Question], answer: &ApprovalAnswer) -> UiAskResult {
    let declined = answer.decision == ApprovalDecision::Deny;
    let results = questions
        .iter()
        .enumerate()
        .map(|(n, q)| {
            let given = answer.answers.get(n).filter(|_| !declined);
            QuestionResult {
                question: q.question.clone(),
                outcome: if declined {
                    QuestionOutcome::Declined
                } else {
                    QuestionOutcome::Answered
                },
                selected: given.map(|a| a.selected.clone()).unwrap_or_default(),
                other: given
                    .and_then(|a| a.other.as_deref())
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned),
            }
        })
        .collect();
    UiAskResult {
        results,
        feedback: answer
            .feedback
            .as_deref()
            .map(str::trim)
            .filter(|f| declined && !f.is_empty())
            .map(str::to_owned),
    }
}

impl ToolIo {
    /// `ui/ask`: shows the form and waits for its answer, the timeout or the end of the turn.
    pub(in crate::tool_io) async fn ask(
        &self,
        p: UiAskParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let services = self.services()?;
        check_questions(&p.questions)?;
        let settings = services.settings(s.scope.root()).await?;
        let timeout = timeout_of(&settings);
        let generation = lock(&s.policy).generation.clone();
        let card = ApprovalRequest {
            request_id: crate::sessions::new_session_id().map_err(|e| e.to_error_object())?,
            session_id: p.session_id.clone(),
            revision: 1,
            connection_epoch: peer.epoch(),
            tool: "AskUserQuestion".into(),
            kind: ApprovalKind::Question,
            command: None,
            cwd: None,
            path: None,
            diff: None,
            rules: Vec::new(),
            directory: None,
            protected_path: None,
            plan: None,
            questions: p.questions.clone(),
            subagent: None,
            sandbox: None,
            domain: None,
            notification_allow: false,
            review: None,
        };
        let (tx, mut rx) = oneshot::channel();
        if !post_card(&s, services, &p.tool_call_id, &card, &peer, &generation, tx).await? {
            return Err(withdrawn());
        }
        let clock = Arc::clone(&self.config.clock);
        let expiry = async move {
            match timeout {
                Some(after) => clock.sleep(after).await,
                None => std::future::pending().await,
            }
        };
        let settled = tokio::select! {
            biased;
            () = peer.closed() => None,
            () = generation.cancelled() => None,
            reply = &mut rx => reply.ok().map(Some),
            () = expiry => {
                if withdraw_card(&s, services, &p.tool_call_id, &card, &peer) {
                    Some(None)
                } else {
                    // An answer claimed the card first: it is on its way.
                    rx.await.ok().map(Some)
                }
            }
        };
        let result = match settled {
            None => {
                withdraw_card(&s, services, &p.tool_call_id, &card, &peer);
                return Err(withdrawn());
            }
            Some(None) => timed_out(&p.questions),
            Some(Some((answer, ack))) => {
                let result = answered(&p.questions, &answer);
                // The answering window may have closed; the answer is taken either way.
                let _ = ack.send(Ok(()));
                result
            }
        };
        to_value(&result)
    }
}

#[cfg(test)]
mod tests {
    use piarc_protocol::harness::{QuestionAnswer, QuestionOption};

    use super::*;

    fn option(label: &str, default: bool) -> QuestionOption {
        QuestionOption {
            label: label.into(),
            description: None,
            default: default.then_some(true),
        }
    }

    fn question(text: &str, multi: bool, options: Vec<QuestionOption>) -> Question {
        Question {
            question: text.into(),
            header: None,
            options,
            multi_select: multi.then_some(true),
        }
    }

    fn forms() -> Vec<Question> {
        vec![
            question(
                "Single?",
                false,
                vec![option("A", true), option("B", false)],
            ),
            question("Many?", true, vec![option("X", false), option("Y", false)]),
        ]
    }

    fn card(questions: Vec<Question>) -> ApprovalRequest {
        ApprovalRequest {
            request_id: "r".into(),
            session_id: "s".into(),
            revision: 1,
            connection_epoch: 1,
            tool: "AskUserQuestion".into(),
            kind: ApprovalKind::Question,
            command: None,
            cwd: None,
            path: None,
            diff: None,
            rules: Vec::new(),
            directory: None,
            protected_path: None,
            plan: None,
            questions,
            subagent: None,
            sandbox: None,
            domain: None,
            notification_allow: false,
            review: None,
        }
    }

    fn reply(decision: ApprovalDecision, answers: Vec<QuestionAnswer>) -> ApprovalAnswer {
        ApprovalAnswer {
            request_id: "r".into(),
            session_id: "s".into(),
            revision: 1,
            connection_epoch: 1,
            decision,
            feedback: None,
            rules: Vec::new(),
            directory: None,
            domain: None,
            mode: None,
            comments: Vec::new(),
            answers,
            via: None,
        }
    }

    fn pick(selected: &[&str], other: Option<&str>) -> QuestionAnswer {
        QuestionAnswer {
            selected: selected.iter().map(|s| (*s).to_owned()).collect(),
            other: other.map(str::to_owned),
        }
    }

    #[test]
    fn forms_have_bounded_distinct_options_and_one_default_per_single_choice() {
        assert!(check_questions(&forms()).is_ok());
        assert!(check_questions(&[]).is_err());
        assert!(check_questions(&vec![forms()[0].clone(); 5]).is_err());
        let one = question("One?", false, vec![option("A", false)]);
        assert!(check_questions(&[one]).is_err());
        let same = question("Same?", false, vec![option("A", false), option("A", false)]);
        assert!(check_questions(&[same]).is_err());
        let two = question("Two?", false, vec![option("A", true), option("B", true)]);
        assert!(check_questions(&[two]).is_err());
        let many = question("Two?", true, vec![option("A", true), option("B", true)]);
        assert!(check_questions(&[many]).is_ok());
    }

    #[test]
    fn answers_pick_known_options_or_say_something_else() {
        let request = card(forms());
        let ok = [
            vec![pick(&["A"], None), pick(&["X", "Y"], None)],
            vec![pick(&[], Some("C")), pick(&["X"], Some("Z"))],
        ];
        for answers in ok {
            let a = reply(ApprovalDecision::AllowOnce, answers.clone());
            assert!(check_answer(&request, &a).is_ok(), "{answers:?}");
        }
        let wrong = [
            vec![pick(&["A"], None)],
            vec![pick(&["A", "B"], None), pick(&["X"], None)],
            vec![pick(&["A"], Some("C")), pick(&["X"], None)],
            vec![pick(&["Q"], None), pick(&["X"], None)],
            vec![pick(&[], Some("  ")), pick(&["X"], None)],
            vec![pick(&["A"], None), pick(&["X", "X"], None)],
        ];
        for answers in wrong {
            let a = reply(ApprovalDecision::AllowOnce, answers.clone());
            assert!(check_answer(&request, &a).is_err(), "{answers:?}");
        }
        assert!(check_answer(&request, &reply(ApprovalDecision::Deny, Vec::new())).is_ok());
        let session = reply(ApprovalDecision::AllowSession, Vec::new());
        assert!(check_answer(&request, &session).is_err());
    }

    #[test]
    fn results_are_structured_for_every_outcome() {
        let questions = forms();
        let late = timed_out(&questions);
        assert_eq!(late.results[0].outcome, QuestionOutcome::Default);
        assert_eq!(late.results[0].selected, ["A"]);
        assert_eq!(late.results[1].outcome, QuestionOutcome::Unanswered);
        assert!(late.results[1].selected.is_empty());
        let a = reply(
            ApprovalDecision::AllowOnce,
            vec![pick(&[], Some(" C ")), pick(&["X", "Y"], None)],
        );
        let given = answered(&questions, &a);
        assert_eq!(given.results[0].other.as_deref(), Some("C"));
        assert_eq!(given.results[1].selected, ["X", "Y"]);
        assert!(
            given
                .results
                .iter()
                .all(|r| r.outcome == QuestionOutcome::Answered)
        );
        let mut closed = reply(ApprovalDecision::Deny, Vec::new());
        closed.feedback = Some("Later".into());
        let declined = answered(&questions, &closed);
        assert_eq!(declined.feedback.as_deref(), Some("Later"));
        assert!(
            declined
                .results
                .iter()
                .all(|r| r.outcome == QuestionOutcome::Declined)
        );
    }
}
