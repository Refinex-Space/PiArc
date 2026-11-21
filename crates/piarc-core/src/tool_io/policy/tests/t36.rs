//! T36-A09 on Core's side: `mcp__server__tool` and `mcp__server__*` rules apply to MCP calls,
//! and a tool marked `requiresUserInteraction` asks in every mode, offers nothing to save, and
//! no allow rule or session answer skips it.
use super::*;

const TOOL: &str = "mcp__deploy__release";

impl Fixture {
    fn user_settings(&self, text: &str) {
        std::fs::write(self.root.join("data/settings.json"), text).expect("user settings");
    }

    async fn mcp_call(&self, call: &str, interactive: bool) -> Value {
        let params = json!({
            "sessionId": SESSION, "toolCallId": call, "tool": TOOL,
            "input": { "service": "api" }, "requiresUserInteraction": interactive,
        });
        self.io
            .dispatch(
                "policy/evaluate",
                params.as_object().expect("params").clone(),
                self.peer.clone(),
            )
            .await
            .expect("preflight")
    }

    /// Runs `call` and answers its card with `decision`; returns the result and the card.
    async fn mcp_answered(
        &self,
        call: &str,
        decision: ApprovalDecision,
    ) -> (Value, ApprovalRequest) {
        let ask = async {
            let card = self.pending().await;
            assert_eq!(
                self.io
                    .answer_approval(answer(&card, decision))
                    .await
                    .expect("answer")["status"],
                "applied"
            );
            card
        };
        tokio::join!(self.mcp_call(call, true), ask)
    }

    fn last_step(&self) -> Value {
        let rows = self
            .storage
            .with(|s| s.session_audit_events(SESSION, 1))
            .expect("open")
            .expect("audit");
        let detail: Value = serde_json::from_str(&rows[0].detail).expect("detail");
        detail["step"].clone()
    }
}

#[tokio::test]
async fn server_and_tool_rules_apply_to_mcp_calls() {
    let f = Fixture::new().await;
    f.user_settings(r#"{"permissions":{"allow":["mcp__deploy__*"]}}"#);
    assert_eq!(f.mcp_call("wildcard", false).await["allowed"], true);
    assert_eq!(f.last_step(), "allowRule");
    f.user_settings(
        r#"{"permissions":{"allow":["mcp__deploy__*"],"deny":["mcp__deploy__release"]}}"#,
    );
    let denied = f.mcp_call("denied", false).await;
    assert_eq!(denied["allowed"], false);
    assert_eq!(f.last_step(), "denyRule");
}

#[tokio::test]
async fn a_tool_that_requires_user_interaction_asks_in_every_mode() {
    let f = Fixture::new().await;
    f.user_settings(
        r#"{"permissions":{"allow":["mcp__deploy__release"],"enableBypassPermissions":true}}"#,
    );
    for mode in [
        PermissionMode::Default,
        PermissionMode::AcceptEdits,
        PermissionMode::BypassPermissions,
    ] {
        f.io.changed_mode(SESSION, mode).await.expect("mode");
        let (result, card) = f
            .mcp_answered(&format!("ask-{mode:?}"), ApprovalDecision::AllowSession)
            .await;
        assert_eq!(result["allowed"], true, "{mode:?}");
        assert!(card.rules.is_empty(), "nothing to save ({mode:?})");
        assert_eq!(
            card.protected_path,
            Some(true),
            "no session allow ({mode:?})"
        );
        assert_eq!(f.last_step(), "requiresUserInteraction");
    }
    // The session answers above saved nothing: the next call asks again.
    f.io.changed_mode(SESSION, PermissionMode::Default)
        .await
        .expect("mode");
    let (again, _) = f.mcp_answered("again", ApprovalDecision::Deny).await;
    assert_eq!(again["allowed"], false);
    // A deny rule still refuses without asking.
    f.user_settings(r#"{"permissions":{"deny":["mcp__deploy"]}}"#);
    assert_eq!(f.mcp_call("deny", true).await["allowed"], false);
    assert_eq!(f.last_step(), "denyRule");
}
