//! What the model reads when a call may not run, and what the audit records (moved out of
//! `policy.rs`, R4 I165).
use super::*;

/// A permanent answer must carry every value the card offered, each a valid allow rule.
pub(super) fn check_permanent(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    let refused = || denied("This permission cannot be saved.");
    if request.protected_path == Some(true)
        || (request.rules.is_empty() && request.directory.is_none())
        || answer.directory.is_some() != request.directory.is_some()
        || answer.rules.is_empty() != request.rules.is_empty()
        || answer.rules.len() > piarc_policy::bash::MAX_RULES
    {
        return Err(refused());
    }
    for rule in &answer.rules {
        piarc_policy::rules::parse(rule, piarc_policy::rules::Behavior::Allow)
            .map_err(|e| denied(format!("Invalid rule {rule:?}: {e}")))?;
    }
    Ok(())
}

/// A network-domain card (T39) takes every decision; its `allowAlways` must name the card's
/// host, which the native confirmation showed.
pub(super) fn check_network(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    if answer.decision == ApprovalDecision::AllowAlways
        && (answer.domain.is_none() || answer.domain != request.domain)
    {
        return Err(denied(
            "Adding a domain to the allowlist must name the domain of the card.",
        ));
    }
    Ok(())
}

/// A command outside the sandbox (T39) is allowed once or refused: no session or permanent
/// allowance carries it to later calls.
pub(super) fn check_unsandboxed(
    request: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    let outside = request.sandbox == Some(piarc_protocol::policy::CommandPlace::Unsandboxed);
    if outside
        && matches!(
            answer.decision,
            ApprovalDecision::AllowSession | ApprovalDecision::AllowAlways
        )
    {
        return Err(denied(
            "A command outside the sandbox can only be allowed once.",
        ));
    }
    Ok(())
}

pub(super) const LOST: &str = "Permission denied because the pending approval expired. Request a new approval before retrying.";

fn refusal(prepared: &Prepared, case_insensitive: bool, feedback: Option<&str>) -> String {
    let boundary = match prepared.boundary {
        Boundary::Outside => {
            "This operation needs the user's approval: it is outside the session's directories."
                .into()
        }
        Boundary::Protected => {
            let name = prepared
                .card
                .path
                .as_deref()
                .and_then(|p| piarc_fs::access::protected_component(Path::new(p), case_insensitive))
                .unwrap_or_else(|| "The target".into());
            format!("{name} is a protected path.")
        }
        Boundary::Inside => String::new(),
    };
    format!(
        "User denied {}. {boundary} {} Ask the user before trying again.",
        prepared.card.tool,
        feedback.unwrap_or("")
    )
}

/// Why the call may not run, or `None` when it may: the user's refusal (keep planning for a
/// plan), the ladder's, or a lost approval.
pub(super) fn refusal_of(
    answer: Option<&ApprovalAnswer>,
    ruling: &Ruling,
    prepared: &Prepared,
    case_insensitive: bool,
) -> Option<String> {
    match (answer, ruling.outcome) {
        (Some(a), _) if a.decision == ApprovalDecision::Deny => {
            Some(if prepared.card.kind == ApprovalKind::Plan {
                plan::keep_planning(a)
            } else {
                refusal(prepared, case_insensitive, a.feedback.as_deref())
            })
        }
        (Some(_), _) | (None, Outcome::Allow) => None,
        (None, Outcome::Deny) => Some(ruling_reason(ruling)),
        (None, Outcome::Ask) => Some(LOST.into()),
    }
}

/// What the model reads when the ladder refuses without asking.
fn ruling_reason(ruling: &Ruling) -> String {
    match ruling.step {
        "planMode" => piarc_policy::PLAN_MODE_REFUSAL.to_owned(),
        "notInPlanMode" => piarc_policy::NOT_IN_PLAN_MODE.to_owned(),
        "hookDeny" | "permissionRequestHook" | "autoReview" => ruling
            .reason
            .clone()
            .unwrap_or_else(|| "Permission denied by a hook.".to_owned()),
        _ => match ruling.hits.first() {
            Some(hit) => format!(
                "Permission denied by the rule {} in the {} settings. Do not retry this action; if it is needed, ask the user to change the rule.",
                hit.rule, hit.source
            ),
            None => "Permission denied.".to_owned(),
        },
    }
}

/// The rule as stored in the audit. Exact command rules can embed credentials: a digest
/// identifies the setting without copying its arguments into the database.
fn audit_rule(hit: &Hit) -> String {
    let command = hit.rule.starts_with("Bash(") || hit.rule.starts_with("PowerShell(");
    if !command || hit.rule.contains('*') {
        return hit.rule.clone();
    }
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(hit.rule.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let tool = hit.rule.split('(').next().unwrap_or_default();
    format!("{tool}:sha256:{digest}")
}

pub(super) fn audit_detail(
    p: &PolicyEvaluateParams,
    mode: PermissionMode,
    ruling: &Ruling,
    card: &ApprovalRequest,
    allowed: bool,
    source: &str,
) -> Value {
    let hits: Vec<Value> = ruling
        .hits
        .iter()
        .map(|h| json!({"rule": audit_rule(h), "source": h.source, "behavior": h.behavior}))
        .collect();
    let first = ruling.hits.first();
    json!({"tool":p.tool,"toolCallId":p.tool_call_id,"arguments":argument_summary(p),"mode":mode,
        "step":ruling.step,"rule":first.map(audit_rule),"ruleSource":first.map(|h| &h.source),
        "rules":hits,"offered":card.rules.len(),
        "conclusion": if allowed {"allow"} else {"deny"}, "source":source})
}

pub(super) fn argument_summary(p: &PolicyEvaluateParams) -> Value {
    // Do not store model-supplied text or shell arguments, which can contain secrets.
    json!({"keys":p.input.keys().collect::<Vec<_>>(), "path":p.input.get("path").and_then(Value::as_str),
        "commandBytes":p.input.get("command").and_then(Value::as_str).map(str::len),
        "contentBytes":p.input.get("content").and_then(Value::as_str).map(str::len),
        "editCount":p.input.get("edits").and_then(Value::as_array).map(Vec::len)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use piarc_protocol::policy::CommandPlace;
    use serde_json::json;

    fn card(place: Option<CommandPlace>) -> ApprovalRequest {
        let mut request: ApprovalRequest = serde_json::from_value(json!({
            "requestId": "r1", "sessionId": "s1", "revision": 1, "connectionEpoch": 1,
            "tool": "Bash", "kind": "command", "protectedPath": true,
        }))
        .expect("request");
        request.sandbox = place;
        request
    }

    fn reply(decision: ApprovalDecision) -> ApprovalAnswer {
        serde_json::from_value(json!({
            "requestId": "r1", "sessionId": "s1", "revision": 1, "connectionEpoch": 1,
            "decision": decision,
        }))
        .expect("answer")
    }

    /// T39-A04: a command outside the sandbox is allowed once or refused, whatever the client
    /// sends; a sandboxed command's card is not restricted here.
    #[test]
    fn an_unsandboxed_command_is_allowed_once_or_refused() {
        let outside = card(Some(CommandPlace::Unsandboxed));
        for decision in [ApprovalDecision::AllowOnce, ApprovalDecision::Deny] {
            assert!(
                check_unsandboxed(&outside, &reply(decision)).is_ok(),
                "{decision:?}"
            );
        }
        for decision in [
            ApprovalDecision::AllowSession,
            ApprovalDecision::AllowAlways,
        ] {
            let refused = check_unsandboxed(&outside, &reply(decision)).expect_err("refused");
            assert_eq!(
                refused.data.kind,
                piarc_protocol::ErrorKind::PermissionDenied
            );
            assert!(
                refused.message.contains("only be allowed once"),
                "{}",
                refused.message
            );
        }
        for place in [Some(CommandPlace::Sandbox), None] {
            let session = reply(ApprovalDecision::AllowSession);
            assert!(check_unsandboxed(&card(place), &session).is_ok());
        }
    }
}
