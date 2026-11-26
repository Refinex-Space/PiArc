//! Development server cards (ADR-0092 rule 3, design addendum
//! `docs/architecture/addenda/browser.md` B4.2): the agent's `Browser` script starts a launch
//! configuration whose fingerprint the session has not allowed.
//!
//! The card is a `command` card for tool [`BROWSER_SERVER_TOOL`] with the command line, its
//! directory and `sandbox: unsandboxed` (a server binds ports, so it never runs in the
//! sandbox); like every command outside the sandbox it offers only "Allow once" and "Deny"
//! (`protectedPath`). It belongs to the running `Browser` call: the run ending withdraws it.
//! Every mode asks (bypass and Auto too); no hook answers it. Allowing covers the fingerprint
//! for the rest of the session (ADR-0092 rule 3: asked once per session); "Deny", the run
//! ending or no answer within the timeout refuse. Each decision writes one `kind: "browser"`
//! audit row.
//!
//! Starting needs a trusted project whoever starts (ADR-0025): [`ToolIo::project_trusted`].

use std::time::Duration;

use piarc_protocol::ErrorObject;
use piarc_protocol::policy::{
    ApprovalDecision, ApprovalKind, ApprovalRequest, BROWSER_SERVER_TOOL, CommandPlace,
};
use serde_json::json;
use tokio::sync::oneshot;

use super::super::{SessionIo, ToolIo, lock};
use super::waits::{post_local_card, withdraw_local_card};
use super::{denied, session_settings};

/// What the user said about an agent's start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerDecision {
    /// Start it, and later starts of the same fingerprint in the session.
    Allowed,
    /// Do not start it.
    Refused,
}

/// The configuration an agent asks to start.
#[derive(Debug, Clone)]
pub(crate) struct ServerAsk<'a> {
    /// The `Browser` call's session (a subagent's own id).
    pub call_session: &'a str,
    pub tool_call_id: &'a str,
    pub name: &'a str,
    pub command: &'a str,
    pub cwd: &'a str,
    pub fingerprint: &'a str,
}

impl ToolIo {
    /// Whether the project of session `s` is trusted, through the one trust query with the
    /// session's settings (its executable inventory confirmed too, ADR-0029).
    pub(in crate::tool_io) async fn project_trusted(&self, s: &SessionIo) -> bool {
        let Ok(services) = self.services() else {
            return false;
        };
        session_settings(services, s)
            .await
            .is_ok_and(|settings| settings.trust().is_trusted())
    }

    /// Asks the user whether the agent's running `Browser` call may start a server.
    ///
    /// # Errors
    ///
    /// `sessionNotFound` for an unknown call session; the permission service is missing.
    pub(in crate::tool_io) async fn ask_dev_server(
        &self,
        ask: &ServerAsk<'_>,
        timeout: Duration,
    ) -> Result<ServerDecision, ErrorObject> {
        let s = self.session(ask.call_session)?;
        let key = format!("browser:{}", ask.tool_call_id);
        let Some(run) = lock(&s.running).get(&key).cloned() else {
            return Ok(ServerDecision::Refused);
        };
        let services = self.services()?;
        let card = server_card(ask);
        let (tx, rx) = oneshot::channel();
        if !post_local_card(&s, services, &card, tx) {
            return Ok(ServerDecision::Refused);
        }
        let answered = tokio::select! {
            answer = tokio::time::timeout(timeout, rx) => answer.ok().and_then(Result::ok),
            () = run.cancelled() => None,
        };
        let (decision, step) = match answered {
            None => {
                withdraw_local_card(&s, services, &card);
                (ServerDecision::Refused, "timeout")
            }
            Some((answer, ack)) => {
                let decision = match answer.decision {
                    ApprovalDecision::Deny => ServerDecision::Refused,
                    ApprovalDecision::AllowOnce
                    | ApprovalDecision::AllowSession
                    | ApprovalDecision::AllowAlways => ServerDecision::Allowed,
                };
                let _ = ack.send(Ok(()));
                (decision, "card")
            }
        };
        let detail = json!({
            "approval": "devServer",
            "tool": "Browser",
            "toolCallId": ask.tool_call_id,
            "server": ask.name,
            "fingerprint": ask.fingerprint,
            "step": step,
            "conclusion": if decision == ServerDecision::Refused { "deny" } else { "allow" },
        });
        services
            .record("browser", ask.call_session, s.project(), &detail)
            .await?;
        Ok(decision)
    }
}

/// The refusal an agent's start gets.
pub(crate) fn refused_start(name: &str) -> ErrorObject {
    denied(format!(
        "The user did not allow starting the development server \"{name}\"."
    ))
}

fn server_card(ask: &ServerAsk<'_>) -> ApprovalRequest {
    ApprovalRequest {
        elicitation: None,
        request_id: crate::sessions::new_session_id()
            .unwrap_or_else(|_| format!("server-{}-{}", ask.tool_call_id, ask.name.len())),
        session_id: ask.call_session.to_owned(),
        revision: 1,
        connection_epoch: 0,
        tool: BROWSER_SERVER_TOOL.to_owned(),
        kind: ApprovalKind::Command,
        command: Some(ask.command.to_owned()),
        cwd: Some(ask.cwd.to_owned()),
        path: None,
        diff: None,
        rules: Vec::new(),
        directory: None,
        // Outside the sandbox: only "Allow once" and "Deny" (T39); allowing covers the session.
        protected_path: Some(true),
        plan: None,
        questions: Vec::new(),
        subagent: None,
        sandbox: Some(CommandPlace::Unsandboxed),
        domain: None,
        site: None,
        notification_allow: false,
        review: None,
    }
}
