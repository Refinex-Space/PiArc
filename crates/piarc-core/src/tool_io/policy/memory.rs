//! An import permits one resolved document as model context. It never grants the tools I/O.
use super::*;

/// Returns the decision for this snapshot, using the same ledger, native confirmation and
/// interruption semantics as the file tools. Permanent grants live outside the project.
pub(in crate::tool_io) async fn approve(
    services: &Services,
    session: &SessionIo,
    id: &str,
    call: &str,
    target: &Path,
    peer: &Peer,
    generation: &CancellationToken,
) -> Result<ApprovalDecision, ErrorObject> {
    let workspace = session.scope.key(session.scope.root());
    let key = display(target);
    let lookup = (workspace.clone(), key.clone());
    if services
        .storage
        .run(move |db| db.allows_memory_import(&lookup.0, &lookup.1))
        .await
        .map_err(|e| e.to_error_object())?
        .map_err(|e| e.to_error_object())?
    {
        return Ok(ApprovalDecision::AllowAlways);
    }
    let p = PolicyEvaluateParams {
        session_id: id.to_owned(),
        tool_call_id: call.to_owned(),
        tool: "MemoryImport".to_owned(),
        input: Default::default(),
        staged_input_bytes: None,
    };
    let mut card = new_request(&p, peer)?;
    card.kind = ApprovalKind::PermissionExpansion;
    card.path = Some(display(target));
    card.rule = Some(piarc_policy::exact_rule(&p.tool, &display(target)));
    let Some((answer, ack)) = wait_for_user(session, services, &p, &card, peer, generation).await?
    else {
        return Err(denied(LOST));
    };
    let decision = answer.decision;
    let commit = async {
        if peer.is_closed() || generation.is_cancelled() {
            return Err(denied(LOST));
        }
        if decision == ApprovalDecision::AllowAlways && answer.rule != card.rule {
            return Err(denied("Permanent memory consent must name the requested file exactly."));
        }
        services.audit(id, session.scope.root(), &json!({
            "tool":p.tool, "toolCallId":call, "path":card.path, "decision":decision,
            "source":"user", "conclusion": if decision == ApprovalDecision::Deny {"deny"} else {"allow"}
        })).await?;
        if decision == ApprovalDecision::AllowAlways {
            services.storage.run(move |db| db.allow_memory_import(&workspace,&key))
                .await.map_err(|e| e.to_error_object())?.map_err(|e| e.to_error_object())?;
        }
        Ok(())
    }.await;
    let _ = ack.send(commit.clone());
    commit?;
    Ok(decision)
}

pub(in crate::tool_io) fn generation(s: &SessionIo) -> CancellationToken {
    lock(&s.policy).generation.clone()
}
