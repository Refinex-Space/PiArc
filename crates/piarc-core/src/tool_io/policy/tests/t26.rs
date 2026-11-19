//! T26 through the real Core preflight: plan mode's host tools, the plan card and the question
//! form (`ui/ask`) with an injected clock.
use std::sync::Arc;

use piarc_protocol::harness::PlanComment;

use super::*;
use crate::clock::ManualClock;

impl Fixture {
    async fn with_clock(clock: Arc<ManualClock>) -> Self {
        Self::build(
            super::super::super::CommandEnv::process(),
            Path::to_path_buf,
            false,
            clock,
        )
        .await
    }

    /// The workspace as Core stores it (`workspaces.default_mode`), with its row.
    fn root_name(&self) -> String {
        display(self.io.session(SESSION).expect("session").scope.root())
    }

    fn add_workspace_row(&self) {
        let path = self.root_name();
        self.storage
            .with(|s| {
                s.upsert_workspace(&piarc_store::WorkspaceRecord {
                    path: path.clone(),
                    display_name: "workspace".into(),
                    main_checkout: path.clone(),
                    last_opened_at: 1,
                    default_mode: None,
                    default_model: None,
                })
            })
            .expect("open")
            .expect("workspace row");
    }

    fn mode(&self) -> PermissionMode {
        lock(&self.io.session(SESSION).expect("session").policy).mode()
    }

    fn pending_count(&self) -> usize {
        lock(&self.io.session(SESSION).expect("session").policy)
            .ledger
            .pending()
            .count()
    }

    async fn ask(&self, questions: Value) -> Result<Value, ErrorObject> {
        let params = json!({"sessionId": SESSION, "toolCallId": "ask", "questions": questions});
        self.io
            .dispatch(
                "ui/ask",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
    }

    async fn reply(&self, card: &ApprovalRequest, change: impl FnOnce(&mut ApprovalAnswer)) {
        let mut reply = answer(card, ApprovalDecision::AllowOnce);
        change(&mut reply);
        assert_eq!(
            self.io.answer_approval(reply).await.expect("answer")["status"],
            "applied"
        );
    }
}

const PLAN: &str = "# 计划\n\n1. Read the parser\n2. Fix the bug";

fn questions() -> Value {
    json!([
        {"question": "Which database?", "header": "DB",
         "options": [{"label": "SQLite", "default": true}, {"label": "Postgres"}]},
        {"question": "Which platforms?", "multiSelect": true,
         "options": [{"label": "macOS"}, {"label": "Windows"}]},
        {"question": "Name?", "options": [{"label": "piarc"}, {"label": "arc"}]}
    ])
}

#[tokio::test]
async fn enter_plan_mode_switches_without_asking() {
    let f = Fixture::new().await;
    f.add_workspace_row();
    f.io.set_initial_mode(SESSION, None).await.expect("start");
    let result = f.evaluate("enter", "EnterPlanMode", json!({})).await;
    assert_eq!(result["allowed"], true, "{result}");
    assert_eq!(result["mode"], "plan");
    assert_eq!(f.mode(), PermissionMode::Plan);
    assert_eq!(f.pending_count(), 0);
    // Already in plan mode: allowed, nothing to switch.
    let again = f.evaluate("again", "EnterPlanMode", json!({})).await;
    assert_eq!(again["allowed"], true);
    assert!(again.get("mode").is_none(), "{again}");
    // The model chose it: the workspace keeps the user's own choice.
    let root = f.root_name();
    let remembered = f
        .storage
        .run(move |db| db.workspace_mode(&root))
        .await
        .expect("storage")
        .expect("query");
    assert_eq!(remembered, None);
}

#[tokio::test]
async fn host_tools_run_in_plan_mode_and_writes_point_at_exit_plan_mode() {
    let f = Fixture::new().await;
    f.io.changed_mode(SESSION, PermissionMode::Plan)
        .await
        .expect("mode");
    for (tool, input) in [
        ("TodoWrite", json!({"todos": []})),
        ("SuggestNextSteps", json!({"suggestions": []})),
        ("AskUserQuestion", json!({"questions": []})),
    ] {
        let result = f.evaluate(tool, tool, input).await;
        assert_eq!(result["allowed"], true, "{tool}: {result}");
    }
    let write = f
        .evaluate("write", "Write", json!({"path": "a.txt", "content": "x"}))
        .await;
    assert_eq!(write["allowed"], false);
    let reason = write["reason"].as_str().expect("reason");
    assert!(
        reason.contains("plan mode is on") && reason.contains("ExitPlanMode"),
        "{reason}"
    );
}

#[tokio::test]
async fn exit_plan_mode_outside_plan_mode_is_refused() {
    let f = Fixture::new().await;
    f.io.changed_mode(SESSION, PermissionMode::BypassPermissions)
        .await
        .expect("mode");
    let result = f
        .evaluate("exit", "ExitPlanMode", json!({"plan": PLAN}))
        .await;
    assert_eq!(result["allowed"], false);
    assert_eq!(result["reason"], piarc_policy::NOT_IN_PLAN_MODE);
    assert_eq!(f.pending_count(), 0);
}

#[tokio::test]
async fn an_approved_plan_continues_in_the_chosen_mode() {
    for mode in [PermissionMode::AcceptEdits, PermissionMode::Default] {
        let f = Fixture::new().await;
        f.add_workspace_row();
        f.io.changed_mode(SESSION, PermissionMode::Plan)
            .await
            .expect("mode");
        let (result, ()) = tokio::join!(
            f.evaluate("exit", "ExitPlanMode", json!({"plan": PLAN})),
            async {
                let card = f.pending().await;
                assert_eq!(card.kind, ApprovalKind::Plan);
                assert_eq!(card.plan.as_deref(), Some(PLAN));
                // Without a follow-up mode the answer is refused and the card stays.
                let mut bare = answer(&card, ApprovalDecision::AllowOnce);
                bare.mode = None;
                assert!(f.io.answer_approval(bare).await.is_err());
                f.reply(&card, |a| a.mode = Some(mode)).await;
            }
        );
        assert_eq!(result["allowed"], true, "{result}");
        assert_eq!(result["mode"], json!(mode));
        assert_eq!(f.mode(), mode);
        let root = f.root_name();
        let remembered = f
            .storage
            .run(move |db| db.workspace_mode(&root))
            .await
            .expect("storage")
            .expect("query");
        assert_eq!(
            remembered.as_deref(),
            Some(json!(mode).as_str().expect("name"))
        );
    }
}

#[tokio::test]
async fn keeping_on_planning_returns_feedback_and_comments_and_stays_in_plan_mode() {
    let f = Fixture::new().await;
    f.io.changed_mode(SESSION, PermissionMode::Plan)
        .await
        .expect("mode");
    // "Fix the bug" starts after "# 计划\n\n1. Read the parser\n2. ".
    let start = "# 计划\n\n1. Read the parser\n2. ".encode_utf16().count() as u64;
    let (result, ()) = tokio::join!(
        f.evaluate("exit", "ExitPlanMode", json!({"plan": PLAN})),
        async {
            let card = f.pending().await;
            let mut reply = answer(&card, ApprovalDecision::Deny);
            reply.feedback = Some("Add a test first.".into());
            reply.comments = vec![PlanComment {
                start,
                end: start + 11,
                quote: "Fix the bug".into(),
                text: "Which bug?".into(),
            }];
            // A quote that does not match its range is refused.
            let mut wrong = reply.clone();
            wrong.comments[0].end += 1;
            assert!(f.io.answer_approval(wrong).await.is_err());
            assert_eq!(
                f.io.answer_approval(reply).await.expect("answer")["status"],
                "applied"
            );
        }
    );
    assert_eq!(result["allowed"], false);
    let reason = result["reason"].as_str().expect("reason");
    assert!(reason.contains("Plan mode stays on"), "{reason}");
    assert!(reason.contains("Add a test first."), "{reason}");
    assert!(
        reason.contains(&format!(
            "1. On \"Fix the bug\" (offsets {start}-{}): Which bug?",
            start + 11
        )),
        "{reason}"
    );
    assert!(result.get("mode").is_none());
    assert_eq!(f.mode(), PermissionMode::Plan);
}

#[tokio::test]
async fn the_question_form_returns_structured_answers() {
    let f = Fixture::new().await;
    let (result, ()) = tokio::join!(f.ask(questions()), async {
        let card = f.pending().await;
        assert_eq!(card.kind, ApprovalKind::Question);
        assert_eq!(card.tool, "AskUserQuestion");
        assert_eq!(card.questions.len(), 3);
        f.reply(&card, |a| {
            a.answers = vec![
                piarc_protocol::harness::QuestionAnswer {
                    selected: vec!["Postgres".into()],
                    other: None,
                },
                piarc_protocol::harness::QuestionAnswer {
                    selected: vec!["macOS".into(), "Windows".into()],
                    other: None,
                },
                piarc_protocol::harness::QuestionAnswer {
                    selected: Vec::new(),
                    other: Some("PiArc Desktop".into()),
                },
            ];
        })
        .await;
    });
    let result = result.expect("answered");
    assert_eq!(
        result["results"],
        json!([
            {"question": "Which database?", "outcome": "answered", "selected": ["Postgres"]},
            {"question": "Which platforms?", "outcome": "answered", "selected": ["macOS", "Windows"]},
            {"question": "Name?", "outcome": "answered", "other": "PiArc Desktop"}
        ])
    );
    assert_eq!(f.pending_count(), 0);
}

#[tokio::test]
async fn the_question_form_times_out_on_the_injected_clock() {
    let clock = ManualClock::new();
    let f = Fixture::with_clock(Arc::clone(&clock)).await;
    std::fs::write(
        f.work.join(".piarc/settings.local.json"),
        r#"{"askUserQuestion":{"timeoutSeconds":30}}"#,
    )
    .expect("settings");
    let (result, ()) = tokio::join!(f.ask(questions()), async {
        f.pending().await;
        while clock.sleepers() == 0 {
            tokio::task::yield_now().await;
        }
        clock.advance(Duration::from_secs(29));
        tokio::task::yield_now().await;
        assert_eq!(f.pending_count(), 1, "still waiting before the timeout");
        clock.advance(Duration::from_secs(1));
    });
    let result = result.expect("timed out");
    assert_eq!(
        result["results"],
        json!([
            {"question": "Which database?", "outcome": "default", "selected": ["SQLite"]},
            {"question": "Which platforms?", "outcome": "unanswered"},
            {"question": "Name?", "outcome": "unanswered"}
        ])
    );
    assert_eq!(f.pending_count(), 0, "the card is withdrawn");
}

#[tokio::test]
async fn without_a_timeout_the_form_waits_and_closing_it_declines() {
    let clock = ManualClock::new();
    let f = Fixture::with_clock(Arc::clone(&clock)).await;
    let (result, ()) = tokio::join!(f.ask(questions()), async {
        let card = f.pending().await;
        clock.advance(Duration::from_secs(24 * 3600));
        assert_eq!(clock.sleepers(), 0);
        let mut reply = answer(&card, ApprovalDecision::Deny);
        reply.feedback = Some("Ask me after lunch".into());
        assert_eq!(
            f.io.answer_approval(reply).await.expect("answer")["status"],
            "applied"
        );
    });
    let result = result.expect("declined");
    assert_eq!(result["feedback"], "Ask me after lunch");
    assert!(
        result["results"]
            .as_array()
            .expect("results")
            .iter()
            .all(|r| r["outcome"] == "declined"),
        "{result}"
    );
}

#[tokio::test]
async fn an_interrupted_turn_withdraws_the_form() {
    let f = Fixture::new().await;
    let (result, ()) = tokio::join!(f.ask(questions()), async {
        f.pending().await;
        f.io.clear_approvals(SESSION, super::super::Cleanup::Interrupted);
    });
    let error = result.expect_err("withdrawn");
    assert_eq!(error.data.kind, ErrorKind::Cancelled);
    assert_eq!(f.pending_count(), 0);
}

#[tokio::test]
async fn invalid_forms_are_refused_before_showing() {
    let f = Fixture::new().await;
    let one_option = json!([{"question": "Q?", "options": [{"label": "only"}]}]);
    let error = f.ask(one_option).await.expect_err("invalid");
    assert_eq!(error.data.kind, ErrorKind::InvalidParams);
    assert_eq!(f.pending_count(), 0);
}
