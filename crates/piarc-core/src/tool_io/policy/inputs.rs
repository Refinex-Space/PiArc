//! Large preflight parameters, in bounded session memory. Only a matching call on the same
//! connection can consume them. No caller-supplied file is ever opened or removed.
use std::collections::HashMap;

use piarc_host::Peer;
use piarc_protocol::ErrorObject;
use piarc_protocol::fs::MAX_UPLOAD_BYTES;
use piarc_protocol::policy::{PolicyEvaluateParams, PolicyInputChunkParams};
use serde_json::{Value, json};

use super::{ToolIo, denied, lock};

struct Transfer {
    peer: Peer,
    tool: String,
    text: String,
}

#[derive(Default)]
pub(super) struct Inputs {
    calls: HashMap<String, Transfer>,
}

impl Inputs {
    pub fn clear(&mut self) {
        self.calls.clear();
    }

    pub fn cancel(&mut self, call: &str, peer: &Peer) {
        if self
            .calls
            .get(call)
            .is_some_and(|t| t.peer.same_connection(peer))
        {
            self.calls.remove(call);
        }
    }

    fn append(&mut self, p: PolicyInputChunkParams, peer: &Peer) -> Result<(), ErrorObject> {
        if p.text.is_empty() || peer.is_closed() {
            return Err(denied("Empty or disconnected permission input transfer."));
        }
        // Pi serializes preflights. Bound concurrent subtool transfers and their metadata too.
        if self.calls.len() >= 8 && !self.calls.contains_key(&p.tool_call_id) {
            return Err(denied(
                "Too many permission input transfers in this session.",
            ));
        }
        let total: u64 = self.calls.values().map(|t| t.text.len() as u64).sum();
        if total + p.text.len() as u64 > MAX_UPLOAD_BYTES {
            self.cancel(&p.tool_call_id, peer);
            return Err(denied(
                "Permission input exceeds the session upload budget.",
            ));
        }
        match self.calls.entry(p.tool_call_id) {
            std::collections::hash_map::Entry::Vacant(entry) if p.offset == 0 => {
                entry.insert(Transfer {
                    peer: peer.clone(),
                    tool: p.tool,
                    text: p.text,
                });
            }
            std::collections::hash_map::Entry::Occupied(mut entry)
                if entry.get().peer.same_connection(peer)
                    && entry.get().tool == p.tool
                    && entry.get().text.len() as u64 == p.offset =>
            {
                entry.get_mut().text.push_str(&p.text);
            }
            _ => {
                return Err(denied(
                    "Permission input chunks must arrive in order for the same tool call.",
                ));
            }
        }
        Ok(())
    }

    pub fn take(
        &mut self,
        p: &PolicyEvaluateParams,
        peer: &Peer,
    ) -> Result<Option<String>, ErrorObject> {
        let Some(bytes) = p.staged_input_bytes else {
            return Ok(None);
        };
        let Some(t) = self.calls.get(&p.tool_call_id) else {
            return Err(denied("No permission input was staged for this call."));
        };
        if !t.peer.same_connection(peer)
            || t.tool != p.tool
            || t.text.len() as u64 != bytes
            || peer.is_closed()
        {
            return Err(denied("Incomplete or mismatched staged permission input."));
        }
        Ok(self.calls.remove(&p.tool_call_id).map(|t| t.text))
    }
}

/// Consume the staged data and capture the cancellation token under the same lock.
pub(super) async fn begin(
    session: &super::SessionIo,
    p: &mut PolicyEvaluateParams,
    peer: &Peer,
) -> Result<super::CancellationToken, ErrorObject> {
    let (staged, generation) = {
        let mut state = lock(&session.policy);
        (state.inputs.take(p, peer)?, state.generation.clone())
    };
    if let Some(text) = staged {
        restore(p, text).await?;
    }
    Ok(generation)
}

async fn restore(p: &mut PolicyEvaluateParams, text: String) -> Result<(), ErrorObject> {
    if p.tool == "Write" && !p.input.contains_key("content") {
        p.input.insert("content".into(), Value::String(text));
    } else if p.tool != "Write" && p.input.is_empty() {
        p.input = tokio::task::spawn_blocking(move || serde_json::from_str(&text))
            .await
            .map_err(|error| denied(format!("Decoding staged permission input failed: {error}")))?
            .map_err(|_| denied("Invalid staged tool input JSON."))?;
    } else {
        return Err(denied("Ambiguous staged and inline tool input."));
    }
    Ok(())
}

impl ToolIo {
    pub(in crate::tool_io) fn stage_input(
        &self,
        p: PolicyInputChunkParams,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id)?;
        lock(&session.policy).inputs.append(p, peer)?;
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(offset: u64, text: &str) -> PolicyInputChunkParams {
        PolicyInputChunkParams {
            session_id: "session-a".into(),
            tool: "Write".into(),
            tool_call_id: "call-a".into(),
            offset,
            text: text.into(),
        }
    }

    #[tokio::test]
    async fn chunks_and_their_consumer_are_bound_to_the_peer_tool_call_and_byte_offset() {
        let mut inputs = Inputs::default();
        let (peer, _receiver) = Peer::channel(1);
        let (other, _other_receiver) = Peer::channel(1);
        let mut request = PolicyEvaluateParams {
            session_id: "session-a".into(),
            tool_call_id: "call-a".into(),
            tool: "Write".into(),
            input: Default::default(),
            staged_input_bytes: Some(4),
        };
        inputs.append(chunk(0, "文"), &peer).expect("first chunk");
        assert!(inputs.append(chunk(1, "!"), &peer).is_err());
        assert!(inputs.append(chunk(3, "!"), &other).is_err());
        assert!(inputs.take(&request, &peer).is_err(), "missing last byte");
        inputs.cancel("call-a", &other);
        inputs
            .append(chunk(3, "!"), &peer)
            .expect("same connection");
        assert!(inputs.take(&request, &other).is_err());
        request.tool = "Edit".into();
        assert!(inputs.take(&request, &peer).is_err());
        request.tool = "Write".into();
        let text = inputs
            .take(&request, &peer)
            .expect("valid")
            .expect("staged text");
        restore(&mut request, text).await.expect("complete content");
        assert_eq!(request.input["content"], "文!");
        assert!(inputs.take(&request, &peer).is_err(), "one use");
    }
}
