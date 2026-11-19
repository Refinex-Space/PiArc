//! Waiting for the user's answer to a card of the session's approval ledger: the card goes in,
//! the Agent Host hears `policy/pending` (which stops its transport deadline), and the wait
//! ends with the answer, the end of the connection or the interruption of the turn.
use super::*;

pub(super) type Answered = (ApprovalAnswer, oneshot::Sender<Result<(), ErrorObject>>);

pub(super) async fn wait_for_user(
    s: &SessionIo,
    services: &Services,
    p: &PolicyEvaluateParams,
    card: &ApprovalRequest,
    peer: &Peer,
    generation: &CancellationToken,
) -> Result<Option<Answered>, ErrorObject> {
    let (tx, rx) = oneshot::channel();
    if !post_card(s, services, &p.tool_call_id, card, peer, generation, tx).await? {
        return Ok(None);
    }
    let result = tokio::select! {
        biased;
        ()=peer.closed()=>None,
        ()=generation.cancelled()=>None,
        reply=rx=>reply.ok(),
    };
    if result.is_none() {
        withdraw_card(s, services, &p.tool_call_id, card, peer);
    }
    Ok(result)
}

/// Puts `card` in the session's ledger and tells the Agent Host that the call waits for the
/// user (`policy/pending`). False when the connection is gone.
pub(super) async fn post_card(
    s: &SessionIo,
    services: &Services,
    call: &str,
    card: &ApprovalRequest,
    peer: &Peer,
    generation: &CancellationToken,
    tx: oneshot::Sender<Answered>,
) -> Result<bool, ErrorObject> {
    use piarc_protocol::policy::{PolicyPending, PolicyPendingParams};
    {
        let mut state = lock(&s.policy);
        if generation.is_cancelled() || peer.is_closed() {
            return Err(denied(LOST));
        }
        if !state.ledger.insert(
            card.clone(),
            Pending {
                call: call.to_owned(),
                reply: tx,
                peer: peer.clone(),
            },
        ) {
            return Err(denied("Duplicate approval request."));
        }
        state.publish(&card.session_id, services);
    }
    let pending = PolicyPendingParams {
        session_id: card.session_id.clone(),
        tool_call_id: call.to_owned(),
    };
    if peer.notify::<PolicyPending>(pending).await.is_ok() {
        Ok(true)
    } else {
        withdraw_card(s, services, call, card, peer);
        Ok(false)
    }
}

/// Takes an unanswered card back out of the ledger (the wait ended without an answer).
pub(super) fn withdraw_card(
    s: &SessionIo,
    services: &Services,
    call: &str,
    card: &ApprovalRequest,
    peer: &Peer,
) -> bool {
    let mut state = lock(&s.policy);
    if peer.is_closed() {
        state.expired.insert(call.to_owned());
    }
    let taken = state
        .ledger
        .take_if(|r, _| r.request_id == card.request_id)
        .is_some();
    state.publish(&card.session_id, services);
    taken
}
