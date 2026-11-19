//! T23 through the real Core preflight: rule sources and trust, modes, Bash analysis, tool
//! removal and multi-rule "always allow".
use super::*;

impl Fixture {
    /// Program lookups independent of the test process (cargo sets `DYLD_*` on macOS, which
    /// rightly turns automatic program approvals off).
    async fn fixed() -> Self {
        Self::with_env(super::super::super::CommandEnv::Fixed(vec![(
            "PATH".into(),
            "/usr/bin:/bin".into(),
        )]))
        .await
    }

    fn work(&self) -> PathBuf {
        self.work.clone()
    }

    fn write_settings(&self, file: &str, text: &str) {
        std::fs::write(self.work().join(".piarc").join(file), text).expect("settings");
    }

    /// The user's own settings file: its allow rules need no project trust.
    fn write_user_settings(&self, text: &str) {
        std::fs::write(self.root.join("data/settings.json"), text).expect("user settings");
    }

    async fn trust_again(&self) {
        let trust = &self.io.services().expect("policy").trust;
        let view = trust.view(&self.work()).await.expect("view");
        trust
            .decide(&self.work(), true, &view.version)
            .await
            .expect("trust the new items");
    }

    async fn answer_next(&self, decision: ApprovalDecision) -> ApprovalRequest {
        let card = self.pending().await;
        let mut reply = answer(&card, decision);
        if decision == ApprovalDecision::AllowAlways {
            reply.rules.clone_from(&card.rules);
        }
        assert_eq!(
            self.io.answer_approval(reply).await.expect("answer")["status"],
            "applied"
        );
        card
    }

    async fn asks(&self, tool: &str, input: Value) -> ApprovalRequest {
        let (result, card) = tokio::join!(
            self.evaluate("asked", tool, input),
            self.answer_next(ApprovalDecision::Deny)
        );
        assert_eq!(result["allowed"], false);
        card
    }

    fn audit(&self) -> Vec<Value> {
        self.storage
            .with(|s| s.session_audit_events(SESSION, 100))
            .expect("open")
            .expect("audit")
            .iter()
            .map(|r| serde_json::from_str(&r.detail).expect("detail"))
            .collect()
    }
}

/// T23-A02: a deny rule without a specifier removes the tool; deny beats allow.
#[tokio::test]
async fn whole_tool_denials_and_deny_over_allow() {
    let f = Fixture::new().await;
    // Deny in one source wins over allow in another.
    f.write_settings(
        "settings.local.json",
        r#"{"permissions":{"deny":["WebFetch","mcp__slack","Bash(git push *)"]}}"#,
    );
    f.write_user_settings(r#"{"permissions":{"allow":["Bash(git *)"]}}"#);
    let params = json!({"sessionId":SESSION,"tools":["Read","Bash","WebFetch","mcp__slack__post","mcp__github__get"]});
    let result =
        f.io.dispatch(
            "policy/tools",
            params.as_object().expect("params").clone(),
            f.peer.clone(),
        )
        .await
        .expect("tools");
    assert_eq!(result["denied"], json!(["WebFetch", "mcp__slack__post"]));
    let denied = f
        .evaluate("push", "Bash", json!({"command":"git push origin main"}))
        .await;
    assert_eq!(denied["allowed"], false);
    assert!(
        denied["reason"]
            .as_str()
            .expect("reason")
            .contains("Bash(git push *)")
    );
    let allowed = f
        .evaluate("log", "Bash", json!({"command":"git log -1"}))
        .await;
    assert_eq!(allowed["allowed"], true);
    let audit = f.audit();
    assert_eq!(audit[1]["step"], "denyRule");
    assert_eq!(audit[1]["ruleSource"], "projectLocal");
    assert_eq!(audit[0]["step"], "allowRule");
    assert_eq!(audit[0]["ruleSource"], "user");
}

/// T23-A06: critical deletions ask in every mode, including bypass with a matching rule, and
/// cannot be saved.
#[tokio::test]
async fn critical_deletions_ask_even_in_bypass_with_an_allow_rule() {
    let f = Fixture::new().await;
    f.write_user_settings(r#"{"permissions":{"allow":["Bash(rm *)"]}}"#);
    for mode in [PermissionMode::Default, PermissionMode::BypassPermissions] {
        f.io.changed_mode(SESSION, mode).await.expect("mode");
        let card = f.asks("Bash", json!({"command":"rm -rf ~"})).await;
        assert!(card.rules.is_empty(), "{mode:?}");
    }
    assert_eq!(f.audit()[0]["step"], "criticalPath");
    f.io.changed_mode(SESSION, PermissionMode::Default)
        .await
        .expect("mode");
    assert_eq!(
        f.evaluate("rm", "Bash", json!({"command":"rm -rf build"}))
            .await["allowed"],
        true
    );
    assert_eq!(f.audit()[0]["step"], "allowRule");
}

/// T23-A07: a project allow rule applies only once the project trusts it; deny and ask
/// rules apply before that.
#[tokio::test]
async fn project_allow_rules_wait_for_trust() {
    let f = Fixture::new().await;
    f.write_settings(
        "settings.json",
        r#"{"permissions":{"allow":["Read(known)","Bash(make check *)"],"ask":["Bash(make release *)"]}}"#,
    );
    // The new allow rule is an unconfirmed executable item: the project is not trusted.
    f.asks("Bash", json!({"command":"make check"})).await;
    let asked = f.asks("Bash", json!({"command":"make release"})).await;
    assert_eq!(asked.tool, "Bash");
    f.trust_again().await;
    assert_eq!(
        f.evaluate("check", "Bash", json!({"command":"make check -j4"}))
            .await["allowed"],
        true
    );
    f.asks("Bash", json!({"command":"make release"})).await;
    assert_eq!(f.audit()[0]["step"], "askRule");
}

/// T23-A08: bypass needs the user's own setting; a project's bypass or auto never applies
/// and is audited.
#[tokio::test]
async fn bypass_needs_the_user_setting_and_project_modes_are_ignored() {
    let f = Fixture::new().await;
    assert!(
        f.io.check_mode(SESSION, PermissionMode::BypassPermissions)
            .await
            .is_err()
    );
    // A project file cannot enable it.
    f.write_settings(
        "settings.json",
        r#"{"permissions":{"enableBypassPermissions":true,"defaultMode":"bypassPermissions","allow":["Read(known)"]}}"#,
    );
    f.write_settings(
        "settings.local.json",
        r#"{"permissions":{"defaultMode":"auto"}}"#,
    );
    assert!(
        f.io.check_mode(SESSION, PermissionMode::BypassPermissions)
            .await
            .is_err()
    );
    f.io.set_initial_mode(SESSION, None).await.expect("start");
    let s = f.io.session(SESSION).expect("session");
    assert_eq!(lock(&s.policy).mode, PermissionMode::Default);
    let ignored: Vec<String> = f
        .audit()
        .iter()
        .filter(|d| d["step"] == "ignoredProjectMode")
        .map(|d| {
            format!(
                "{}={}",
                d["layer"].as_str().unwrap_or(""),
                d["mode"].as_str().unwrap_or("")
            )
        })
        .collect();
    assert_eq!(ignored.len(), 2, "{ignored:?}");
    f.write_user_settings(r#"{"permissions":{"enableBypassPermissions":true}}"#);
    f.io.check_mode(SESSION, PermissionMode::BypassPermissions)
        .await
        .expect("enabled by the user");
    f.io.changed_mode(SESSION, PermissionMode::BypassPermissions)
        .await
        .expect("switch");
    assert_eq!(
        f.evaluate("any", "Bash", json!({"command":"npm install left-pad"}))
            .await["allowed"],
        true
    );
    assert_eq!(f.audit()[0]["step"], "bypassPermissions");
}

/// T23-A09: plan mode refuses writes and commands that are not read-only, with the reason the
/// model needs.
#[tokio::test]
async fn plan_mode_refuses_writes_with_the_plan_reason() {
    let f = Fixture::new().await;
    f.io.changed_mode(SESSION, PermissionMode::Plan)
        .await
        .expect("plan");
    for (tool, input) in [
        ("Write", json!({"path":"a.txt","content":"x"})),
        (
            "Edit",
            json!({"path":"a.txt","edits":[{"oldText":"a","newText":"b"}]}),
        ),
        ("Bash", json!({"command":"npm test"})),
        ("Bash", json!({"command":"ls > listing.txt"})),
    ] {
        let result = f.evaluate("plan", tool, input).await;
        assert_eq!(result["allowed"], false, "{tool}");
        assert_eq!(result["reason"], piarc_policy::PLAN_MODE_REFUSAL);
    }
    for (tool, input) in [
        ("Read", json!({"path":"file.txt"})),
        ("Bash", json!({"command":"cd src && echo $(pwd)"})),
    ] {
        assert_eq!(
            f.evaluate("look", tool, input).await["allowed"],
            true,
            "{tool}"
        );
    }
    assert_eq!(f.audit()[2]["step"], "planMode");
}

/// T23-A10: the chosen mode is remembered for the workspace and restored for a new session.
#[tokio::test]
async fn the_chosen_mode_is_remembered_per_workspace() {
    let f = Fixture::new().await;
    let path = display(f.io.session(SESSION).expect("open").scope.root());
    f.storage
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
    f.io.changed_mode(SESSION, PermissionMode::Plan)
        .await
        .expect("plan");
    // A restarted Core opens the same database file; every session start reads the mode from
    // it (below), with no copy kept in memory.
    let reopened = Storage::open(
        DataDirs::new(f.root.join("data"), f.root.join("cache")).expect("directories"),
    )
    .expect("reopen the database");
    assert_eq!(
        reopened
            .with(|s| s.workspace_mode(&path))
            .expect("open")
            .expect("read")
            .as_deref(),
        Some("plan")
    );
    reopened.close();
    f.io.open_session("second", &f.work(), &f.work())
        .expect("second session");
    f.io.set_initial_mode("second", None).await.expect("start");
    assert_eq!(
        lock(&f.io.session("second").expect("open").policy).mode,
        PermissionMode::Plan
    );
    // The session's own choice (restored from its file) comes first.
    f.io.set_initial_mode("second", Some(PermissionMode::AcceptEdits))
        .await
        .expect("explicit");
    assert_eq!(
        lock(&f.io.session("second").expect("open").policy).mode,
        PermissionMode::AcceptEdits
    );
    f.io.close_session("second");
}

/// T23-A11: "always allow" offers one prefix rule per subcommand that still needs approval and
/// saves the confirmed list to `.piarc/settings.local.json`.
#[tokio::test]
async fn always_allow_saves_one_rule_per_subcommand() {
    let f = Fixture::fixed().await;
    let card = f
        .asks(
            "Bash",
            json!({"command":"ls && npm test && git commit -m 'msg'"}),
        )
        .await;
    assert_eq!(card.rules, ["Bash(npm test *)", "Bash(git commit *)"]);
    let (result, card) = tokio::join!(
        f.evaluate(
            "save",
            "Bash",
            json!({"command":"npm test && cargo build --release"})
        ),
        f.answer_next(ApprovalDecision::AllowAlways)
    );
    assert_eq!(result["allowed"], true);
    assert_eq!(card.rules, ["Bash(npm test *)", "Bash(cargo build *)"]);
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(f.work().join(".piarc/settings.local.json")).expect("saved"),
    )
    .expect("json");
    assert_eq!(
        saved["permissions"]["allow"],
        json!(["Bash(npm test *)", "Bash(cargo build *)"])
    );
    assert_eq!(
        f.evaluate(
            "again",
            "Bash",
            json!({"command":"cargo build && npm test -- -u"})
        )
        .await["allowed"],
        true
    );
    // An edited rule must still be a valid allow rule.
    let check = f.evaluate("bad", "Bash", json!({"command":"make docs"}));
    let reject = async {
        let card = f.pending().await;
        let mut reply = answer(&card, ApprovalDecision::AllowAlways);
        reply.rules = vec!["Bash(make docs".into()];
        assert!(f.io.answer_approval(reply).await.is_err());
        f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
            .await
            .expect("deny");
    };
    let (result, ()) = tokio::join!(check, reject);
    assert_eq!(result["allowed"], false);
}

/// T23-A12 (Core half): the settings page lists rules by source with their status, edits only
/// writable files, and filters the audit by session, tool and outcome.
#[tokio::test]
async fn settings_page_lists_edits_and_audits_rules() {
    let f = Fixture::fixed().await;
    // An invalid deny rule is listed with its error; it makes Read calls ask.
    f.write_user_settings(r#"{"permissions":{"deny":["Read([)"],"allow":["Bash(git *)"]}}"#);
    let view = f.io.permission_view(Some(f.work())).await.expect("view");
    let sources: Vec<&str> = view["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .map(|s| s["id"].as_str().expect("id"))
        .collect();
    // T24: Claude Code's project files are listed (read-only) between PiArc's; the fixture
    // has no home directory, so there is no user-level Claude Code file.
    assert_eq!(
        sources,
        [
            "projectLocal",
            "project",
            "claudeProjectLocal",
            "claudeProject",
            "user"
        ]
    );
    for claude in [2, 3] {
        assert_eq!(view["sources"][claude]["writable"], false);
    }
    let user = &view["sources"][4];
    assert_eq!(user["writable"], true);
    assert!(user["rules"][0]["error"].is_string(), "{user}");
    assert_eq!(user["rules"][1]["broad"], true);
    // The fixture's project allow rule is trusted, so it applies.
    assert_eq!(view["sources"][1]["rules"][0]["inactive"], false);
    let change =
        |old: Option<&str>, rule: Option<&str>, behavior: &str| -> settings_view::RuleChange {
            serde_json::from_value(json!({"workspace": f.work(), "layer": "projectLocal",
            "behavior": behavior, "old": old, "rule": rule}))
            .expect("change")
        };
    let after =
        f.io.update_permission_rule(change(None, Some("Bash(npm test *)"), "allow"))
            .await
            .expect("add");
    assert_eq!(after["sources"][0]["rules"][0]["rule"], "Bash(npm test *)");
    // Confirmed natively, it joins the trusted snapshot and applies at once.
    assert_eq!(after["sources"][0]["rules"][0]["inactive"], false);
    assert_eq!(
        f.evaluate("npm", "Bash", json!({"command":"npm test -- -u"}))
            .await["allowed"],
        true
    );
    assert!(
        f.io.update_permission_rule(change(None, Some("Bash(npm test *"), "deny"))
            .await
            .is_err()
    );
    let removed =
        f.io.update_permission_rule(change(Some("Bash(npm test *)"), None, "allow"))
            .await
            .expect("remove");
    assert!(
        removed["sources"][0]["rules"]
            .as_array()
            .expect("rules")
            .is_empty()
    );
    let query =
        |q: Value| -> settings_view::AuditQuery { serde_json::from_value(q).expect("query") };
    let events =
        f.io.audit_events(query(
            json!({"sessionId": SESSION, "tool": "Bash", "conclusion": "allow"}),
        ))
        .await
        .expect("audit");
    let events = events["events"].as_array().expect("events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["detail"]["ruleSource"], "projectLocal");
    let none =
        f.io.audit_events(query(json!({"tool": "Bash", "conclusion": "deny"})))
            .await
            .expect("audit");
    assert!(none["events"].as_array().expect("events").is_empty());
}
