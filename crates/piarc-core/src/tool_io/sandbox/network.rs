//! The network-domain card (T39, architecture sections 6.10 and 8.2): a sandboxed command
//! reaches for a host outside the allowlist, the proxy holds the connection and the user
//! answers in the session's approval ledger.
//!
//! - "Allow once" lets this connection through; the next one asks again.
//! - "Allow for this session" lets the host through until the session closes.
//! - "Add to allowlist" writes the host into the user's `sandbox.network.allowedDomains`
//!   (after the main process's native confirmation) and lets it through from now on.
//! - "Deny", or no answer within the timeout (60 s by default), refuses the connection; the
//!   command gets the proxy's 403 and its result names the host.
//!
//! Every mode asks, `bypassPermissions` included, and no hook answers: the card never passes
//! through the decision ladder. Each answer is written to the audit (`kind: "sandbox"`).

use std::sync::Mutex;
use std::time::Duration;

use piarc_protocol::policy::{
    ApprovalDecision, ApprovalKind, ApprovalRequest, CommandPlace, NETWORK_TOOL,
};
use serde_json::json;
use tokio::sync::oneshot;

use super::super::policy::{Services, post_local_card, withdraw_local_card};
use super::super::{SessionIo, lock};
use super::audit;

/// One question to the user about a host.
pub(super) struct Ask<'a> {
    pub s: &'a SessionIo,
    pub services: &'a Services,
    pub session_id: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub timeout: Duration,
    /// The session's allowed hosts.
    pub hosts: &'a Mutex<Vec<String>>,
}

/// Asks the user whether one connection to `host:port` may go ahead.
pub(super) async fn ask(a: &Ask<'_>) -> bool {
    let Ok(request_id) = crate::sessions::new_session_id() else {
        return false;
    };
    let card = ApprovalRequest {
        elicitation: None,
        request_id,
        session_id: a.session_id.to_owned(),
        revision: 1,
        connection_epoch: 0,
        tool: NETWORK_TOOL.to_owned(),
        kind: ApprovalKind::PermissionExpansion,
        command: None,
        cwd: None,
        path: None,
        diff: None,
        rules: Vec::new(),
        directory: None,
        protected_path: None,
        plan: None,
        questions: Vec::new(),
        subagent: None,
        sandbox: Some(CommandPlace::Sandbox),
        domain: Some(a.host.to_owned()),
        notification_allow: false,
        review: None,
    };
    let (tx, rx) = oneshot::channel();
    if !post_local_card(a.s, a.services, &card, tx) {
        return false;
    }
    let answered = tokio::time::timeout(a.timeout, rx).await;
    let (allowed, decision) = match answered {
        Ok(Ok((answer, ack))) => {
            let applied = apply(a, answer.decision).await;
            let allowed = answer.decision != ApprovalDecision::Deny;
            // The answering window hears whether saving worked; the connection goes ahead
            // either way once allowed.
            let _ = ack.send(applied);
            (allowed, decision_name(answer.decision))
        }
        // No answer in time, or the session closed with the card.
        _ => {
            withdraw_local_card(a.s, a.services, &card);
            (false, "timeout")
        }
    };
    let detail = json!({"approval":"network","host":a.host,"port":a.port,"decision":decision,
        "conclusion": if allowed {"allow"} else {"deny"}});
    audit(a.services, a.session_id, a.s.project(), detail).await;
    allowed
}

/// What an allowing answer keeps: the host for the session, or in the user's allowlist.
async fn apply(a: &Ask<'_>, decision: ApprovalDecision) -> Result<(), piarc_protocol::ErrorObject> {
    match decision {
        ApprovalDecision::AllowSession => remember(a.hosts, a.host),
        ApprovalDecision::AllowAlways => {
            remember(a.hosts, a.host);
            let table = a.services.storage.dirs().layers(a.s.project());
            let host = a.host.to_owned();
            let saved = tokio::task::spawn_blocking(move || {
                piarc_config::append_unique(
                    &table,
                    piarc_config::ids::USER,
                    piarc_config::sandbox::ALLOWED_DOMAINS,
                    &host,
                )
            })
            .await;
            match saved {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(super::super::policy::denied(e.to_string())),
                Err(e) => return Err(super::super::policy::denied(e.to_string())),
            }
        }
        ApprovalDecision::AllowOnce | ApprovalDecision::Deny => {}
    }
    Ok(())
}

fn decision_name(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::AllowOnce => "allowOnce",
        ApprovalDecision::AllowSession => "allowSession",
        ApprovalDecision::AllowAlways => "allowAlways",
        ApprovalDecision::Deny => "deny",
    }
}

fn remember(hosts: &Mutex<Vec<String>>, host: &str) {
    let mut hosts = lock(hosts);
    if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
        hosts.push(host.to_owned());
    }
}
