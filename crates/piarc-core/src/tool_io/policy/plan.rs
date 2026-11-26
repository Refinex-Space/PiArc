//! Plan mode's host tools (T26, architecture section 6.5).
//!
//! - `EnterPlanMode` is allowed like a read-only tool; allowing it switches the session to
//!   plan mode (not remembered for the workspace: the model chose it).
//! - `ExitPlanMode` in plan mode asks with a `plan` card. The user approves it with the mode
//!   to continue in (`acceptEdits` or `default`, remembered for the workspace like a choice in
//!   the mode menu), or declines it to keep planning: the feedback and the inline comments go
//!   back to the model as the refusal ([`keep_planning`]) and the mode stays plan.
//! - The Agent Host records every switch on the branch (`policy/evaluate` result `mode`).
use piarc_protocol::harness::PlanComment;

use super::*;

/// Comments one answer may carry.
const MAX_COMMENTS: usize = 200;

/// A mode change that allowing a call brings.
#[derive(Debug, Clone, Copy)]
pub(super) struct ModeSwitch {
    pub mode: PermissionMode,
    /// The user chose it: remember it for the workspace.
    pub remember: bool,
}

/// The switch an allowed call of `tool` brings, decided in `mode`.
pub(super) fn mode_switch(
    tool: &str,
    mode: PermissionMode,
    answer: Option<&ApprovalAnswer>,
) -> Option<ModeSwitch> {
    match tool {
        "EnterPlanMode" if mode != PermissionMode::Plan => Some(ModeSwitch {
            mode: PermissionMode::Plan,
            remember: false,
        }),
        "ExitPlanMode" => answer.and_then(|a| a.mode).map(|mode| ModeSwitch {
            mode,
            remember: true,
        }),
        _ => None,
    }
}

/// An answer to a `plan` card: approved once with the mode to continue in, or declined with
/// comments that quote the plan exactly.
pub(super) fn check_answer(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    match answer.decision {
        ApprovalDecision::AllowOnce => match answer.mode {
            Some(PermissionMode::AcceptEdits | PermissionMode::Default) => Ok(()),
            _ => Err(denied(
                "Approve a plan with the mode to continue in: acceptEdits or default.",
            )),
        },
        ApprovalDecision::Deny => check_comments(
            request.plan.as_deref().unwrap_or_default(),
            &answer.comments,
        ),
        ApprovalDecision::AllowSession | ApprovalDecision::AllowAlways => Err(denied(
            "A plan is approved once, with the mode to continue in.",
        )),
    }
}

fn check_comments(plan: &str, comments: &[PlanComment]) -> Result<(), ErrorObject> {
    if comments.len() > MAX_COMMENTS {
        return Err(denied(format!(
            "At most {MAX_COMMENTS} comments can go with a plan."
        )));
    }
    let units: Vec<u16> = plan.encode_utf16().collect();
    for comment in comments {
        let range = usize::try_from(comment.start)
            .ok()
            .zip(usize::try_from(comment.end).ok())
            .filter(|(start, end)| start < end && *end <= units.len());
        let quoted = range.and_then(|(start, end)| String::from_utf16(&units[start..end]).ok());
        if quoted.as_deref() != Some(comment.quote.as_str()) {
            return Err(denied(format!(
                "A comment's range {}..{} does not match its quote in the plan.",
                comment.start, comment.end
            )));
        }
        if comment.text.trim().is_empty() {
            return Err(denied("A comment on the plan is empty."));
        }
    }
    Ok(())
}

/// What the model reads when the user keeps planning: the feedback, then each comment with
/// the passage it is about (as a JSON string) and the passage's UTF-16 offsets in the plan.
pub(super) fn keep_planning(answer: &ApprovalAnswer) -> String {
    let mut text = String::from(
        "The user did not approve the plan. Plan mode stays on: keep investigating with \
         read-only tools as needed, revise the plan and submit it again with ExitPlanMode.",
    );
    if let Some(feedback) = answer
        .feedback
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        text.push_str("\n\nFeedback from the user:\n");
        text.push_str(feedback);
    }
    if !answer.comments.is_empty() {
        text.push_str(
            "\n\nComments from the user on passages of the plan (offsets count UTF-16 code \
             units of the submitted plan):",
        );
        for (n, comment) in answer.comments.iter().enumerate() {
            let quote = serde_json::to_string(&comment.quote).unwrap_or_default();
            text.push_str(&format!(
                "\n{}. On {quote} (offsets {}-{}): {}",
                n + 1,
                comment.start,
                comment.end,
                comment.text.trim()
            ));
        }
    }
    text
}

impl ToolIo {
    /// Applies the mode an allowed call switched to.
    pub(super) async fn switch_mode(
        &self,
        id: &str,
        switch: ModeSwitch,
    ) -> Result<(), ErrorObject> {
        if switch.remember {
            return self.changed_mode(id, switch.mode).await;
        }
        let s = self.session(id)?;
        let services = self.services()?;
        let mut state = lock(&s.policy);
        state.project_auto = false;
        state.mode = switch.mode;
        state.publish(id, services);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(decision: ApprovalDecision) -> ApprovalAnswer {
        ApprovalAnswer {
            elicitation: None,
            confirmed_url: None,
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
            answers: Vec::new(),
            via: None,
        }
    }

    fn card(plan: &str) -> ApprovalRequest {
        ApprovalRequest {
            elicitation: None,
            request_id: "r".into(),
            session_id: "s".into(),
            revision: 1,
            connection_epoch: 1,
            tool: "ExitPlanMode".into(),
            kind: ApprovalKind::Plan,
            command: None,
            cwd: None,
            path: None,
            diff: None,
            rules: Vec::new(),
            directory: None,
            protected_path: None,
            plan: Some(plan.into()),
            questions: Vec::new(),
            subagent: None,
            sandbox: None,
            domain: None,
            site: None,
            notification_allow: false,
            review: None,
        }
    }

    fn comment(start: u64, end: u64, quote: &str) -> PlanComment {
        PlanComment {
            start,
            end,
            quote: quote.into(),
            text: "Why?".into(),
        }
    }

    #[test]
    fn approval_needs_one_of_the_two_follow_up_modes() {
        let plan = card("1. Fix it");
        let mut a = answer(ApprovalDecision::AllowOnce);
        assert!(check_answer(&plan, &a).is_err());
        for mode in [PermissionMode::AcceptEdits, PermissionMode::Default] {
            a.mode = Some(mode);
            assert!(check_answer(&plan, &a).is_ok(), "{mode:?}");
        }
        for mode in [PermissionMode::Plan, PermissionMode::BypassPermissions] {
            a.mode = Some(mode);
            assert!(check_answer(&plan, &a).is_err(), "{mode:?}");
        }
        let mut session = answer(ApprovalDecision::AllowSession);
        session.mode = Some(PermissionMode::Default);
        assert!(check_answer(&plan, &session).is_err());
    }

    #[test]
    fn comments_must_quote_the_plan_at_utf16_offsets() {
        // "计划" is two UTF-16 units, the emoji two more.
        let plan = card("计划 😀 step");
        let mut a = answer(ApprovalDecision::Deny);
        a.comments = vec![
            comment(0, 2, "计划"),
            comment(3, 5, "😀"),
            comment(6, 10, "step"),
        ];
        assert!(check_answer(&plan, &a).is_ok());
        for wrong in [
            comment(0, 1, "计划"),
            comment(3, 4, "😀"),
            comment(6, 11, "step"),
            comment(2, 2, ""),
        ] {
            a.comments = vec![wrong.clone()];
            assert!(check_answer(&plan, &a).is_err(), "{wrong:?}");
        }
        a.comments = vec![PlanComment {
            text: "  ".into(),
            ..comment(0, 2, "计划")
        }];
        assert!(check_answer(&plan, &a).is_err());
    }

    #[test]
    fn keep_planning_carries_feedback_and_anchored_comments() {
        let mut a = answer(ApprovalDecision::Deny);
        a.feedback = Some(" Split step 2. ".into());
        a.comments = vec![PlanComment {
            text: " Use the cache ".into(),
            ..comment(3, 10, "line\n\"two\"")
        }];
        let text = keep_planning(&a);
        assert!(text.contains("Plan mode stays on"), "{text}");
        assert!(text.contains("ExitPlanMode"), "{text}");
        assert!(
            text.contains("Feedback from the user:\nSplit step 2."),
            "{text}"
        );
        assert!(
            text.contains(r#"1. On "line\n\"two\"" (offsets 3-10): Use the cache"#),
            "{text}"
        );
    }

    #[test]
    fn only_enter_and_an_approved_exit_switch_modes() {
        let none = mode_switch("EnterPlanMode", PermissionMode::Plan, None);
        assert!(none.is_none());
        let enter = mode_switch("EnterPlanMode", PermissionMode::Default, None)
            .map(|s| (s.mode, s.remember));
        assert_eq!(enter, Some((PermissionMode::Plan, false)));
        let mut a = answer(ApprovalDecision::AllowOnce);
        a.mode = Some(PermissionMode::AcceptEdits);
        let exit = mode_switch("ExitPlanMode", PermissionMode::Plan, Some(&a))
            .map(|s| (s.mode, s.remember));
        assert_eq!(exit, Some((PermissionMode::AcceptEdits, true)));
        assert!(mode_switch("TodoWrite", PermissionMode::Plan, Some(&a)).is_none());
    }
}
