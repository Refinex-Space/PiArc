//! T31 through the real Core preflight: a subagent's registration, its mode under the main
//! session's, "allow for this session" across the tree, the card's origin, the reach of an
//! interrupt, the definitions list with `Agent(<type>)` deny rules and scoped hooks.
use piarc_protocol::subagent::SubagentStartParams;

use super::*;

const CHILD: &str = "child-1";

impl Fixture {
    fn put(&self, relative: &str, text: &str) {
        let path = self.work.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }

    async fn start(&self, id: &str, parent: &str, kind: &str, background: bool) -> Value {
        let p = SubagentStartParams {
            session_id: id.into(),
            parent_session_id: parent.into(),
            tool_call_id: format!("agent-{id}"),
            agent_type: kind.into(),
            description: Some("Look around".into()),
            cwd: self.work.display().to_string(),
            session_file: None,
            model: None,
            background,
            isolation: None,
        };
        serde_json::to_value(self.io.start_subagent(p).await.expect("registered")).expect("json")
    }

    async fn evaluate_as(&self, session: &str, call: &str, tool: &str, input: Value) -> Value {
        let params =
            json!({"sessionId": session, "toolCallId": call, "tool": tool, "input": input});
        self.io
            .dispatch(
                "policy/evaluate",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
            .expect("preflight")
    }

    async fn pending_of(&self, session: &str) -> ApprovalRequest {
        let s = self.io.session(session).expect("registered");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(request) = lock(&s.policy).ledger.pending().next().cloned() {
                    return request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("approval arrived")
    }

    fn child_audit(&self, session: &str) -> Vec<Value> {
        self.storage
            .with(|s| s.session_audit_events(session, 100))
            .expect("open")
            .expect("audit")
            .iter()
            .map(|r| serde_json::from_str(&r.detail).expect("detail"))
            .collect()
    }
}

/// A command that is not read-only and not allowed by the fixture: Manual asks for it.
fn asked_command() -> Value {
    json!({"command": "printenv HOME"})
}

#[tokio::test]
async fn a_subagent_asks_in_its_main_session_and_session_rules_cover_the_tree() {
    let f = Fixture::new().await;
    let started = f.start(CHILD, SESSION, "general-purpose", false).await;
    assert_eq!(started["permissionMode"], "default");
    let answer_on_card = async {
        let card = f.pending_of(CHILD).await;
        let mut reply = answer(&card, ApprovalDecision::AllowSession);
        reply.rules.clone_from(&card.rules);
        assert_eq!(
            f.io.answer_approval(reply).await.expect("answer")["status"],
            "applied"
        );
        card
    };
    let (result, card) = tokio::join!(
        f.evaluate_as(CHILD, "c1", "Bash", asked_command()),
        answer_on_card
    );
    let origin = card.subagent.clone().expect("the card names its subagent");
    assert_eq!(origin.session_id, CHILD);
    assert_eq!(origin.parent_session_id, SESSION);
    assert_eq!(origin.agent_type, "general-purpose");
    assert_eq!(origin.description.as_deref(), Some("Look around"));
    assert_eq!(
        card.session_id, CHILD,
        "the answer goes to the subagent's ledger"
    );
    assert_eq!(result["allowed"], true);
    // "Allow for this session" on the subagent's card covers the main session and others.
    assert_eq!(
        f.evaluate("c2", "Bash", asked_command()).await["allowed"],
        true
    );
    f.start("child-2", SESSION, "Explore", false).await;
    assert_eq!(
        f.evaluate_as("child-2", "c3", "Bash", asked_command())
            .await["allowed"],
        true
    );
    let audit = f.child_audit(CHILD);
    assert_eq!(audit[0]["subagent"]["rootSessionId"], SESSION);
    assert_eq!(audit[0]["subagent"]["agentType"], "general-purpose");
    assert!(f.io.finish_subagent(CHILD));
    assert!(!f.io.finish_subagent(CHILD), "already finished");
    assert!(f.io.session(CHILD).is_err());
}

#[tokio::test]
async fn finishing_a_subagent_stops_its_monitors() {
    // R4 S4: a Monitor follows the session that started it; the subagent's ends with it.
    let f = Fixture::new().await;
    f.start(CHILD, SESSION, "general-purpose", false).await;
    let tasks = f.io.tasks();
    let dir = f.work.join("monitor-tasks");
    let reserved = tasks.reserve(&dir).expect("reserve");
    let log = std::sync::Arc::new(std::sync::Mutex::new(
        piarc_exec::TaskLog::create(&reserved.file).expect("log"),
    ));
    let cancel = tokio_util::sync::CancellationToken::new();
    tasks.register(
        &reserved,
        crate::tasks::NewTask {
            session_id: CHILD.into(),
            owner_session_id: SESSION.into(),
            workspace: f.work.display().to_string(),
            kind: piarc_protocol::tasks::TaskKind::Monitor,
            title: "watch".into(),
            command: "tail -f app.log".into(),
            cwd: f.work.display().to_string(),
            tool_call_id: Some("m1".into()),
            output_dir: dir.clone(),
            timeout: None,
        },
        log,
        cancel.clone(),
    );
    assert!(f.io.finish_subagent(CHILD));
    tokio::time::timeout(Duration::from_secs(10), cancel.cancelled())
        .await
        .expect("the subagent's Monitor was stopped");
}

#[tokio::test]
async fn the_mode_is_never_looser_than_the_main_sessions() {
    let f = Fixture::new().await;
    f.put(
        ".claude/agents/planner.md",
        "---\nname: planner\ndescription: d\npermissionMode: plan\n---\nPlan only.\n",
    );
    f.put(
        ".claude/agents/editor.md",
        "---\nname: editor\ndescription: d\npermissionMode: acceptEdits\n---\nEdit.\n",
    );
    f.put(
        ".claude/agents/escalate.md",
        "---\nname: escalate\ndescription: d\npermissionMode: bypassPermissions\n---\nAll.\n",
    );
    let planner = f.start("planner-1", SESSION, "planner", false).await;
    assert_eq!(planner["permissionMode"], "plan");
    let denied = f
        .evaluate_as(
            "planner-1",
            "w",
            "Write",
            json!({"path": "new.txt", "content": "x"}),
        )
        .await;
    assert_eq!(denied["allowed"], false, "plan refuses writes: {denied}");
    // acceptEdits is looser than the main session's Manual: Manual applies, with a warning.
    let editor = f.start("editor-1", SESSION, "editor", false).await;
    assert_eq!(editor["permissionMode"], "default");
    assert_eq!(editor["warnings"][0]["kind"], "modeClamped");
    assert_eq!(editor["warnings"][0]["value"], "acceptEdits");
    // A project file's bypass never applies (it became `default` when parsed).
    let escalate = f.start("escalate-1", SESSION, "escalate", false).await;
    assert_eq!(escalate["permissionMode"], "default");
    // The main session in acceptEdits: the editor follows it.
    f.io.changed_mode(SESSION, PermissionMode::AcceptEdits)
        .await
        .expect("mode");
    let edit = f
        .evaluate_as(
            "editor-1",
            "e",
            "Write",
            json!({"path": "made.txt", "content": "x"}),
        )
        .await;
    assert_eq!(edit["allowed"], true, "{edit}");
    let planned = f
        .evaluate_as(
            "planner-1",
            "w2",
            "Write",
            json!({"path": "new.txt", "content": "x"}),
        )
        .await;
    assert_eq!(planned["allowed"], false, "still plan: {planned}");
}

#[tokio::test]
async fn an_interrupt_reaches_foreground_subagents_only() {
    let f = Fixture::new().await;
    f.start("fg", SESSION, "general-purpose", false).await;
    f.start("bg", SESSION, "general-purpose", true).await;
    f.start("below-bg", "bg", "general-purpose", false).await;
    let fg = f.evaluate_as("fg", "c-fg", "Bash", asked_command());
    let bg = f.evaluate_as("bg", "c-bg", "Bash", asked_command());
    let below = f.evaluate_as("below-bg", "c-below", "Bash", asked_command());
    let check = async {
        f.pending_of("fg").await;
        f.pending_of("bg").await;
        f.pending_of("below-bg").await;
        f.io.clear_approvals(SESSION, Cleanup::Interrupted);
        let bg_left = lock(&f.io.session("bg").expect("bg").policy)
            .ledger
            .pending()
            .count();
        let below_left = lock(&f.io.session("below-bg").expect("below").policy)
            .ledger
            .pending()
            .count();
        assert_eq!((bg_left, below_left), (1, 1), "background runs go on");
        // The Agent Host stops a background run and the runs below it; each one's end
        // (`subagent/finish`) withdraws its cards.
        assert!(f.io.finish_subagent("below-bg"));
        assert!(f.io.finish_subagent("bg"));
    };
    let (fg, bg, below, ()) = tokio::join!(fg, bg, below, check);
    assert_eq!(fg["allowed"], false);
    assert_eq!(bg["allowed"], false);
    assert_eq!(
        below["allowed"], false,
        "a run below an interrupted one stops too"
    );
}

#[tokio::test]
async fn the_definitions_list_applies_agent_deny_rules_and_the_limits() {
    let f = Fixture::new().await;
    f.put(
        ".claude/agents/reviewer.md",
        "---\nname: reviewer\ndescription: Reviews.\nmemory: user\n---\nReview.\n",
    );
    f.put(".claude/agents/broken.md", "---\nname: [\n---\n");
    f.put(
        ".piarc/settings.local.json",
        r#"{"permissions":{"deny":["Agent(Explore)","Agent(revi*)"]},
            "subagents":{"maxConcurrent":2},
            "modelAliases":{"fast":"mock-child/mock-model","strong":""}}"#,
    );
    let params = json!({"cwd": f.work.display().to_string(),
        "builtIn": ["general-purpose", "Explore", "Plan"]});
    let list =
        f.io.agents_list(&f.work, serde_json::from_value(params).expect("params"))
            .await
            .expect("list");
    assert_eq!(list["deniedBuiltIn"], json!(["Explore"]));
    assert_eq!(list["agents"][0]["name"], "reviewer");
    assert_eq!(list["agents"][0]["denied"], true);
    assert_eq!(list["agents"][0]["warnings"][0]["kind"], "ignoredField");
    assert_eq!(list["issues"][0]["line"], 2);
    assert_eq!(list["limits"], json!({"maxDepth": 3, "maxConcurrent": 2}));
    assert_eq!(list["aliases"], json!({"fast": "mock-child/mock-model"}));
    let outside = json!({"cwd": f.root.display().to_string()});
    assert!(
        f.io.agents_list(&f.work, serde_json::from_value(outside).expect("params"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn definition_hooks_apply_to_their_run_only_and_need_trust_for_projects() {
    let f = Fixture::with_hooks(super::super::super::CommandEnv::Fixed(vec![(
        "PATH".into(),
        "/usr/bin:/bin".into(),
    )]))
    .await;
    f.put(
        ".claude/agents/guarded.md",
        "---\nname: guarded\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: echo blocked by the definition >&2; exit 2\n---\nBody\n",
    );
    f.put("known", "text");
    // A definition's hooks are executable project items: the user confirms them like others.
    let trust = &f.io.services().expect("policy").trust;
    let view = trust.view(&f.work).await.expect("view");
    trust
        .decide(&f.work, true, &view.version)
        .await
        .expect("trust the definition's hook");
    let started = f.start("guarded-1", SESSION, "guarded", false).await;
    assert!(
        started.get("warnings").is_none(),
        "trusted project: {started}"
    );
    let child = f
        .evaluate_as("guarded-1", "r1", "Read", json!({"path": "known"}))
        .await;
    assert_eq!(child["allowed"], false, "{child}");
    assert!(
        child["reason"]
            .as_str()
            .expect("reason")
            .contains("blocked by the definition")
    );
    let main = f.evaluate("r2", "Read", json!({"path": "known"})).await;
    assert_eq!(main["allowed"], true, "the main session has no such hook");
    f.io.finish_subagent("guarded-1");
    // Without trust, the project definition's hooks do not run.
    trust.revoke(&f.work).await.expect("revoke");
    let untrusted = f.start("guarded-2", SESSION, "guarded", false).await;
    assert_eq!(untrusted["warnings"][0]["kind"], "hooksUntrusted");
    let read = f
        .evaluate_as("guarded-2", "r3", "Read", json!({"path": "known"}))
        .await;
    assert_eq!(read["allowed"], true, "{read}");
}

/// R4 E1: a definition in a worktree's own `.claude/agents` (another branch's file) is not
/// covered by the main checkout's trust: its hooks do not run.
#[tokio::test]
async fn a_worktrees_own_definition_hooks_need_more_than_the_main_checkouts_trust() {
    let f = Fixture::new().await;
    f.put(
        ".piarc/worktrees/w/.claude/agents/guarded.md",
        "---\nname: guarded\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Read\n      hooks:\n        - type: command\n          command: exit 2\n---\nBody\n",
    );
    let trust = &f.io.services().expect("policy").trust;
    let view = trust.view(&f.work).await.expect("view");
    trust
        .decide(&f.work, true, &view.version)
        .await
        .expect("trust");
    let tree = f
        .work
        .join(".piarc/worktrees/w")
        .canonicalize()
        .expect("tree");
    f.io.open_session_in("wt", &f.work, &tree, &tree)
        .expect("worktree session");
    let p = SubagentStartParams {
        session_id: "guarded-w".into(),
        parent_session_id: "wt".into(),
        tool_call_id: "agent-w".into(),
        agent_type: "guarded".into(),
        description: None,
        cwd: tree.display().to_string(),
        session_file: None,
        model: None,
        background: false,
        isolation: None,
    };
    let started =
        serde_json::to_value(f.io.start_subagent(p).await.expect("registered")).expect("json");
    assert_eq!(
        started["warnings"][0]["kind"], "hooksUntrusted",
        "{started}"
    );
}

/// I82: parameter rules decide `Agent` calls by their arguments (deny and ask only).
#[tokio::test]
async fn parameter_rules_deny_and_ask_by_argument() {
    let f = Fixture::new().await;
    f.put(
        ".piarc/settings.local.json",
        r#"{"permissions":{"deny":["Agent(model:opus)"],"ask":["Agent(isolation:worktree)"]}}"#,
    );
    let denied = f
        .evaluate(
            "a1",
            "Agent",
            json!({"description":"d","prompt":"p","subagent_type":"Explore","model":"opus"}),
        )
        .await;
    assert_eq!(denied["allowed"], false);
    assert!(
        denied["reason"]
            .as_str()
            .expect("reason")
            .contains("Agent(model:opus)")
    );
    let fast = f
        .evaluate(
            "a2",
            "Agent",
            json!({"description":"d","prompt":"p","subagent_type":"Explore","model":"fast"}),
        )
        .await;
    assert_eq!(fast["allowed"], true, "{fast}");
    let (asked, card) = tokio::join!(
        f.evaluate(
            "a3",
            "Agent",
            json!({"description":"d","prompt":"p","isolation":"worktree"})
        ),
        async {
            let card = f.pending().await;
            f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
                .await
                .expect("answer");
            card
        }
    );
    assert_eq!(card.tool, "Agent");
    assert_eq!(asked["allowed"], false);
}
