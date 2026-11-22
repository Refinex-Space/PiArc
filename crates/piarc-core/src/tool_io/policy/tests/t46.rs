//! T46 through the real Core preflight with a scripted reviewer in place of the Agent Host:
//! which calls are reviewed, how answers and failures end, pauses, availability and the audit.
use std::collections::VecDeque;
use std::sync::Mutex as StdMutex;

use piarc_protocol::policy::{
    PolicyReviewParams, PolicyReviewResult, ReviewAnswer, ReviewFailure, ReviewFallback,
    ReviewState, ReviewUsage,
};

use super::*;
use crate::tool_io::policy::review::{ReviewOutlet, ReviewTrouble};

type Reply = Result<PolicyReviewResult, ReviewTrouble>;

/// Answers reviews from a script and records what it was asked. A `None` step waits for
/// [`Reviewer::release`] before answering the next scripted reply.
#[derive(Default)]
struct Reviewer {
    script: StdMutex<VecDeque<Option<Reply>>>,
    asked: StdMutex<Vec<PolicyReviewParams>>,
    gate: Arc<tokio::sync::Notify>,
}

impl Reviewer {
    fn new(script: Vec<Option<Reply>>) -> Arc<Self> {
        Arc::new(Self {
            script: StdMutex::new(script.into()),
            ..Self::default()
        })
    }

    fn asked(&self) -> Vec<PolicyReviewParams> {
        self.asked.lock().expect("asked").clone()
    }

    fn release(&self) {
        self.gate.notify_one();
    }
}

impl ReviewOutlet for Reviewer {
    fn review(
        &self,
        root: String,
        params: PolicyReviewParams,
        _within: Duration,
    ) -> piarc_ports::BoxFuture<'static, Reply> {
        assert_eq!(root, SESSION);
        self.asked.lock().expect("asked").push(params);
        let mut next = self.script.lock().expect("script").pop_front();
        let wait = matches!(next, Some(None));
        if wait {
            next = self.script.lock().expect("script").pop_front();
        }
        let reply = next
            .flatten()
            .unwrap_or(Err(ReviewTrouble::Failed("no script".into())));
        let gate = wait.then(|| Arc::clone(&self.gate));
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            reply
        })
    }
}

fn answered(verdict: &str, reason: &str) -> Option<Reply> {
    Some(Ok(PolicyReviewResult {
        answer: Some(ReviewAnswer {
            verdict: verdict.into(),
            reason: reason.into(),
            category: Some("remoteCode".into()),
        }),
        failure: None,
        message: None,
        model: Some("rev/model".into()),
        usage: ReviewUsage {
            input: 1200,
            output: 40,
            cache_read: 900,
            cache_write: 0,
        },
        input_hash: "ab".repeat(32),
        input_chars: 4800,
        prompt_id: "0123456789ab".into(),
    }))
}

fn failed(failure: ReviewFailure) -> Option<Reply> {
    Some(Ok(PolicyReviewResult {
        answer: None,
        failure: Some(failure),
        message: Some("the provider said no".into()),
        model: Some("rev/model".into()),
        usage: ReviewUsage::default(),
        input_hash: String::new(),
        input_chars: 0,
        prompt_id: String::new(),
    }))
}

const ENABLED: &str = r#"{"permissions":{"enableAutoMode":true},"autoMode":{"model":"rev/model","environment":["github.com/acme"]}}"#;

impl Fixture {
    async fn auto(user: &str, reviewer: &Arc<Reviewer>) -> Self {
        let mut f = Self::fixed().await;
        // Every card sends `policy/pending` on the connection; nobody reads it here.
        let (_, idle) = tokio::sync::mpsc::channel(1);
        let mut frames = std::mem::replace(&mut f.frames, idle);
        tokio::spawn(async move { while frames.recv().await.is_some() {} });
        f.write_user_settings(user);
        f.io.set_review_outlet(reviewer.clone());
        f.io.check_mode(SESSION, PermissionMode::Auto)
            .await
            .expect("auto mode available");
        f.io.changed_mode(SESSION, PermissionMode::Auto)
            .await
            .expect("switch");
        f
    }

    fn rows(&self, kind: &str) -> Vec<Value> {
        self.storage
            .with(|s| s.session_audit_events(SESSION, 200))
            .expect("open")
            .expect("audit")
            .iter()
            .rev()
            .filter(|r| r.kind == kind)
            .map(|r| serde_json::from_str(&r.detail).expect("detail"))
            .collect()
    }

    /// The first card in the ledger, the reviewer's included.
    async fn card(&self) -> ApprovalRequest {
        let session = self.io.session(SESSION).expect("registered");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(card) = lock(&session.policy).ledger.pending().next().cloned() {
                    return card;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("card")
    }

    /// A command that is neither read-only nor allowed: the general question.
    async fn command(&self, call: &str) -> Value {
        self.evaluate(call, "Bash", json!({"command": "printenv HOME"}))
            .await
    }
}

/// A-02: allow runs the call once, deny refuses it with the reason for the model; each review
/// is audited with its fields and the decision is the reviewer's.
#[tokio::test]
async fn the_reviewer_allows_and_denies_general_questions() {
    let reviewer = Reviewer::new(vec![
        answered("allow", "Reads one variable the user asked about."),
        answered(
            "deny",
            "Prints the environment, which the task does not need.",
        ),
    ]);
    let f = Fixture::auto(ENABLED, &reviewer).await;
    let allowed = f.command("c1").await;
    assert_eq!(allowed["allowed"], true, "{allowed}");
    assert_eq!(allowed["review"]["verdict"], "allow");
    assert_eq!(allowed["review"]["model"], "rev/model");
    let denied = f.command("c2").await;
    assert_eq!(denied["allowed"], false);
    assert_eq!(denied["review"]["verdict"], "deny");
    let reason = denied["reason"].as_str().expect("reason");
    assert!(reason.contains("which the task does not need."), "{reason}");
    assert!(
        reason.contains(piarc_policy::review::DENIAL_NOTE),
        "{reason}"
    );
    // Nothing waited for the user.
    assert!(
        lock(&f.io.session(SESSION).expect("s").policy)
            .first_pending()
            .is_none()
    );

    let asked = reviewer.asked();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[0].tool, "Bash");
    assert_eq!(asked[0].input["command"], "printenv HOME");
    assert_eq!(asked[0].model.provider, "rev");
    assert_eq!(asked[0].policy.environment, ["github.com/acme"]);
    assert!(!asked[0].why.is_empty());
    assert_eq!(asked[0].timeout_ms, 30_000);

    let reviews = f.rows("autoReview");
    assert_eq!(reviews.len(), 2);
    assert_eq!(reviews[0]["outcome"], "allow");
    assert_eq!(reviews[0]["conclusion"], "allow");
    assert_eq!(reviews[0]["model"], "rev/model");
    assert_eq!(reviews[0]["tokens"]["cacheRead"], 900);
    assert_eq!(reviews[0]["inputHash"], "ab".repeat(32));
    assert_eq!(reviews[0]["promptId"], "0123456789ab");
    assert_eq!(reviews[0]["category"], "remoteCode");
    assert!(reviews[0]["durationMs"].is_u64());
    assert_eq!(reviews[1]["denials"]["consecutive"], 1);
    // The command text is not stored, only its length.
    assert!(!reviews[0].to_string().contains("printenv"));
    let decisions = f.rows("permission");
    let by_reviewer: Vec<_> = decisions
        .iter()
        .filter(|d| d["source"] == "reviewer")
        .map(|d| (d["step"].clone(), d["conclusion"].clone()))
        .collect();
    assert_eq!(
        by_reviewer,
        [
            (json!("autoReview"), json!("allow")),
            (json!("autoReview"), json!("deny"))
        ]
    );
}

/// A-02, A-03: unsure and every failure put the same card back to the user; while the
/// reviewer works the card takes no answer.
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one table of cases and the loop over it"
)]
async fn unsure_and_failures_go_back_to_the_user() {
    let cases: Vec<(Option<Reply>, ReviewFallback, &str)> = vec![
        (
            answered("unsure", "Cannot tell what the script does."),
            ReviewFallback::Unsure,
            "unsure",
        ),
        (
            Some(Err(ReviewTrouble::Timeout)),
            ReviewFallback::Timeout,
            "timeout",
        ),
        (
            failed(ReviewFailure::Timeout),
            ReviewFallback::Timeout,
            "timeout",
        ),
        (
            failed(ReviewFailure::ProviderError),
            ReviewFallback::ProviderError,
            "providerError",
        ),
        (
            failed(ReviewFailure::Unparsable),
            ReviewFallback::Unparsable,
            "unparsable",
        ),
        (
            answered("Allow", "x"),
            ReviewFallback::InvalidVerdict,
            "invalidVerdict",
        ),
        (
            answered("allow", " \n "),
            ReviewFallback::Unparsable,
            "unparsable",
        ),
        (
            failed(ReviewFailure::BelowBar),
            ReviewFallback::Unavailable,
            "unavailable",
        ),
        (
            Some(Err(ReviewTrouble::HostDown("not running".into()))),
            ReviewFallback::Unavailable,
            "unavailable",
        ),
    ];
    let mut script = vec![None];
    script.extend(cases.iter().map(|(reply, ..)| reply.clone()));
    let reviewer = Reviewer::new(script);
    let f = Fixture::auto(ENABLED, &reviewer).await;
    for (n, (_, fallback, outcome)) in cases.iter().enumerate() {
        let call = format!("f{n}");
        let (result, card) = tokio::join!(f.command(&call), async {
            let reviewing = f.card().await;
            if n == 0 {
                let review = reviewing.review.clone().expect("review");
                assert_eq!(review.state, ReviewState::Reviewing);
                // No answer while the reviewer works.
                let stale =
                    f.io.answer_approval(answer(&reviewing, ApprovalDecision::AllowOnce))
                        .await
                        .expect("answer");
                assert_eq!(stale["status"], "stale");
                reviewer.release();
            }
            let card = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let card = f.pending().await;
                    if card
                        .review
                        .as_ref()
                        .is_some_and(|r| r.state == ReviewState::Fallback)
                    {
                        return card;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("handed back");
            assert_eq!(card.revision, reviewing.revision + 1);
            assert_eq!(
                f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
                    .await
                    .expect("answer")["status"],
                "applied"
            );
            card
        });
        assert_eq!(result["allowed"], false, "{outcome}");
        assert!(result.get("review").is_none(), "{outcome}: {result}");
        let review = card.review.expect("review");
        assert_eq!(review.fallback, Some(*fallback), "{outcome}");
        let row = f.rows("autoReview").pop().expect("row");
        assert_eq!(row["outcome"], *outcome, "{row}");
        assert_eq!(row["conclusion"], "ask");
    }
    assert_eq!(
        f.rows("autoReview")
            .first()
            .and_then(|r| r["reason"].as_str().map(str::to_owned))
            .as_deref(),
        Some("Cannot tell what the script does.")
    );
}

/// A-07: three refusals in a row pause review; the user's allow lifts the pause.
#[tokio::test]
async fn three_refusals_pause_until_the_user_allows() {
    let deny = || answered("deny", "Not part of the task.");
    let reviewer = Reviewer::new(vec![deny(), deny(), deny(), answered("allow", "Fine now.")]);
    let f = Fixture::auto(ENABLED, &reviewer).await;
    for n in 0..3 {
        let result = f.command(&format!("d{n}")).await;
        assert_eq!(result["allowed"], false);
        let paused = result["reason"]
            .as_str()
            .is_some_and(|r| r.contains(piarc_policy::review::PAUSE_NOTE));
        assert_eq!(paused, n == 2, "{result}");
    }
    let rows = f.rows("autoReview");
    assert_eq!(rows[2]["denials"]["paused"], "consecutive");
    // Paused: the next call goes straight to the user, without a review.
    let (result, card) = tokio::join!(f.command("p1"), f.answer_next(ApprovalDecision::AllowOnce));
    assert_eq!(result["allowed"], true);
    let review = card.review.expect("review");
    assert_eq!(review.state, ReviewState::Fallback);
    assert_eq!(review.fallback, Some(ReviewFallback::PausedConsecutive));
    assert_eq!(reviewer.asked().len(), 3);
    // The user's allow resumed review.
    assert_eq!(f.command("r1").await["allowed"], true);
    assert_eq!(reviewer.asked().len(), 4);
}

/// A-04: deny and ask rules, critical deletions, protected paths, outside paths and unresolved
/// commands never reach the reviewer; workspace edits are Accept edits' defaults.
#[tokio::test]
async fn other_questions_and_rules_never_reach_the_reviewer() {
    let reviewer = Reviewer::new(Vec::new());
    let f = Fixture::auto(ENABLED, &reviewer).await;
    f.write_settings(
        "settings.local.json",
        r#"{"permissions":{"deny":["Bash(printenv PATH)"],"ask":["Bash(printenv USER)"]}}"#,
    );
    f.trust_again().await;
    let denied = f
        .evaluate("deny", "Bash", json!({"command": "printenv PATH"}))
        .await;
    assert_eq!(denied["allowed"], false);
    let outside = f.root.join("outside 外");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(outside.join("f.txt"), "x").expect("outside file");
    for (tool, input) in [
        ("Read", json!({"path": outside.join("f.txt")})),
        ("Bash", json!({"command": "printenv USER"})),
        ("Bash", json!({"command": "rm -rf /"})),
        ("Bash", json!({"command": "eval \"$X\""})),
        (
            "Write",
            json!({"path": f.work().join(".git/config"), "content": "x"}),
        ),
        ("Read", json!({"path": outside.join("f.txt")})),
    ] {
        let card = f.asks(tool, input.clone()).await;
        assert!(card.review.is_none(), "{input}");
    }
    let edit = f
        .evaluate(
            "edit",
            "Write",
            json!({"path": f.work().join("new.txt"), "content": "x"}),
        )
        .await;
    assert_eq!(edit["allowed"], true);
    assert!(reviewer.asked().is_empty());
    assert!(f.rows("autoReview").is_empty());
}

/// A-05 with section 7: only the user's own file enables Auto mode; `disableAutoMode` from any
/// layer turns it off, and a session in it continues in Manual mode with an audit row.
#[tokio::test]
async fn availability_comes_from_the_user_and_any_layer_turns_it_off() {
    let f = Fixture::fixed().await;
    f.write_settings(
        "settings.json",
        r#"{"permissions":{"enableAutoMode":true},"autoMode":{"model":"lax/any"}}"#,
    );
    f.trust_again().await;
    assert!(
        f.io.check_mode(SESSION, PermissionMode::Auto)
            .await
            .is_err(),
        "a project file cannot enable Auto mode"
    );
    let reviewer = Reviewer::new(Vec::new());
    f.write_user_settings(ENABLED);
    f.io.set_review_outlet(reviewer.clone());
    f.io.check_mode(SESSION, PermissionMode::Auto)
        .await
        .expect("enabled");
    f.io.changed_mode(SESSION, PermissionMode::Auto)
        .await
        .expect("switch");
    f.write_settings("settings.local.json", r#"{"disableAutoMode":"disable"}"#);
    let card = f.asks("Bash", json!({"command": "printenv HOME"})).await;
    assert!(card.review.is_none());
    assert!(reviewer.asked().is_empty());
    let s = f.io.session(SESSION).expect("s");
    assert_eq!(lock(&s.policy).mode(), PermissionMode::Default);
    let status = lock(&s.policy)
        .auto
        .status(PermissionMode::Default)
        .expect("status");
    assert_eq!(
        status.reason,
        Some(piarc_protocol::policy::AutoReviewReason::Disabled)
    );
    assert!(
        f.rows("permission")
            .iter()
            .any(|r| r["step"] == "autoModeOff")
    );
    assert!(
        f.io.check_mode(SESSION, PermissionMode::Auto)
            .await
            .is_err()
    );
}

/// Section 2.4: no reviewer model means no review; the card says why and the status shows it.
#[tokio::test]
async fn without_a_reviewer_model_cards_go_to_the_user() {
    let reviewer = Reviewer::new(Vec::new());
    let f = Fixture::auto(r#"{"permissions":{"enableAutoMode":true}}"#, &reviewer).await;
    let card = f.asks("Bash", json!({"command": "printenv HOME"})).await;
    let review = card.review.expect("review");
    assert_eq!(review.fallback, Some(ReviewFallback::Unavailable));
    assert!(reviewer.asked().is_empty());
    let row = f.rows("autoReview").pop().expect("row");
    assert_eq!(row["outcome"], "unavailable");
    let s = f.io.session(SESSION).expect("s");
    let status = lock(&s.policy)
        .auto
        .status(PermissionMode::Auto)
        .expect("status");
    assert_eq!(
        status.reason,
        Some(piarc_protocol::policy::AutoReviewReason::NoModel)
    );
}

/// A-10: a subagent's call is reviewed in its main session's Auto mode, through the main
/// session's workspace; the request names the subagent type, the audit row its origin, and its
/// refusals count on the main session.
#[tokio::test]
async fn a_subagents_review_names_it_and_counts_on_the_main_session() {
    const CHILD: &str = "child-46";
    let deny = || answered("deny", "Not needed for the delegated task.");
    let reviewer = Reviewer::new(vec![deny(), deny(), deny()]);
    let f = Fixture::auto(ENABLED, &reviewer).await;
    let started = f.start(CHILD, SESSION, "general-purpose", false).await;
    assert_eq!(started["permissionMode"], "auto");
    for n in 0..3 {
        let result = f
            .evaluate_as(
                CHILD,
                &format!("c{n}"),
                "Bash",
                json!({"command": "printenv HOME"}),
            )
            .await;
        assert_eq!(result["allowed"], false);
        assert_eq!(result["review"]["verdict"], "deny");
    }
    let asked = reviewer.asked();
    assert_eq!(asked.len(), 3);
    assert_eq!(asked[0].session_id, CHILD);
    assert_eq!(
        asked[0].environment.agent_type.as_deref(),
        Some("general-purpose")
    );
    let rows: Vec<Value> = f
        .child_audit(CHILD)
        .into_iter()
        .filter(|r| r["source"] == "reviewer" && r["outcome"].is_string())
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["subagent"]["agentType"], "general-purpose");
    assert_eq!(rows[0]["subagent"]["rootSessionId"], SESSION);
    // The third refusal paused review for the whole tree: the main session shows it.
    let main = f.io.session(SESSION).expect("main");
    let status = lock(&main.policy)
        .auto
        .status(PermissionMode::Auto)
        .expect("status");
    assert_eq!(
        status.state,
        piarc_protocol::policy::AutoReviewState::Paused
    );
}
