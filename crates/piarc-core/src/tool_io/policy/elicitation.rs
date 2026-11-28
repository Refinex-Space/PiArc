//! Nested MCP input requests (T48). Keep the approval in its originating session's ledger.
//! Hooks and the user see the configured server name; its form values only return to it.
use piarc_hooks::HookEvent;
use piarc_protocol::mcp::{
    Elicitation, ElicitationReply, McpCancelElicitationParams, McpElicitParams,
};
use serde_json::Map;
use sha2::{Digest, Sha256};

use super::*;
use crate::hooks::Request;

/// The Agent Host admits one question at a time on an invocation. Keep the current wait
/// and remember early cancellations, even if the cancellation dispatch runs before the ask.
#[derive(Default)]
pub(super) struct Interactions {
    latest: Option<(u64, tokio_util::sync::DropGuard)>,
    cancelled_through: u64,
}

impl Interactions {
    fn next(&self) -> Option<u64> {
        let started = self.latest.as_ref().map_or(0, |(number, _)| *number);
        started.max(self.cancelled_through).checked_add(1)
    }

    fn begin(&mut self, number: u64) -> Option<CancellationToken> {
        if self.next() != Some(number)
            || self
                .latest
                .as_ref()
                .is_some_and(|(_, wait)| !wait.token().is_cancelled())
        {
            return None;
        }
        let token = CancellationToken::new();
        self.latest = Some((number, token.clone().drop_guard()));
        Some(token)
    }

    fn cancel(&mut self, number: u64) {
        if let Some((active, wait)) = &self.latest
            && *active == number
        {
            wait.token().cancel();
        } else if self.next() == Some(number) {
            // Remember a cancellation that overtook its request without touching an earlier wait.
            self.cancelled_through = number;
        }
    }
}

fn bad(reason: &str) -> ErrorObject {
    ErrorObject::new(ErrorKind::InvalidRequest, reason, false)
}

/// Match pi-mcp's public tool naming contract, including a collision's shortened name.
fn owns_tool(grant: &Grant, server: &str, tool: &str, peer: &Peer) -> bool {
    let raw = format!("mcp__{server}__{tool}");
    let canonical: String = raw
        .encode_utf16()
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .filter(u8::is_ascii_alphanumeric)
                .map_or('_', char::from)
        })
        .collect();
    if canonical.len() <= 64 && grant.belongs(&canonical, peer) {
        return true;
    }
    let digest: String = Sha256::digest(format!("{server}\0{tool}"))
        .iter()
        .take(4)
        .map(|b| format!("{b:02x}"))
        .collect();
    let base = &canonical[..canonical.len().min(55)];
    grant.belongs(&format!("{base}_{}", &digest[..8]), peer)
}

fn mode(req: &Elicitation) -> &'static str {
    match req {
        Elicitation::Form { .. } => "form",
        Elicitation::Url { .. } => "url",
    }
}

/// Restrict untrusted schemas to the flat MCP vocabulary before invoking the validator.
/// No references or definitions can load content or make the validator traverse a graph.
fn schema_for(schema: &Map<String, Value>) -> Result<jsonschema::Validator, ErrorObject> {
    let invalid = || bad("Unsupported MCP elicitation form schema.");
    if schema.get("type").and_then(Value::as_str) != Some("object")
        || !schema.keys().all(|k| {
            matches!(
                k.as_str(),
                "type"
                    | "properties"
                    | "required"
                    | "description"
                    | "title"
                    | "$schema"
                    | "additionalProperties"
            )
        })
    {
        return Err(invalid());
    }
    let props = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if props.len() > 128 {
        return Err(invalid());
    }
    for field in props.values() {
        validate_field(field)?;
    }
    let mut restricted = schema.clone();
    restricted.remove("$schema");
    restricted.insert("additionalProperties".into(), Value::Bool(false));
    let doc = Value::Object(restricted);
    jsonschema::options()
        .should_validate_formats(true)
        .with_pattern_options(jsonschema::PatternOptions::regex())
        .build(&doc)
        .map_err(|_| invalid())
}

fn validate_field(field: &Value) -> Result<(), ErrorObject> {
    let invalid = || bad("Unsupported MCP elicitation field.");
    let spec = field.as_object().ok_or_else(invalid)?;
    if !matches!(
        spec.get("type").and_then(Value::as_str),
        Some("number" | "integer" | "string" | "boolean" | "array")
    ) || !spec.keys().all(|k| {
        matches!(
            k.as_str(),
            "type"
                | "description"
                | "title"
                | "default"
                | "format"
                | "pattern"
                | "enum"
                | "enumNames"
                | "oneOf"
                | "minimum"
                | "maximum"
                | "minLength"
                | "maxLength"
                | "minItems"
                | "maxItems"
                | "items"
        )
    }) {
        return Err(invalid());
    }
    let items = if spec.get("type") == Some(&json!("array")) {
        let item = spec
            .get("items")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if !item
            .keys()
            .all(|k| matches!(k.as_str(), "type" | "enum" | "anyOf"))
            || (!item.contains_key("enum") && !item.contains_key("anyOf"))
        {
            return Err(invalid());
        }
        Some(item)
    } else {
        if spec.contains_key("items") {
            return Err(invalid());
        }
        None
    };
    for variants in [spec.get("oneOf"), items.and_then(|i| i.get("anyOf"))]
        .into_iter()
        .flatten()
    {
        if !variants.as_array().is_some_and(|v| {
            !v.is_empty()
                && v.iter().all(|v| {
                    v.as_object().is_some_and(|o| {
                        o.keys().all(|k| k == "title" || k == "const")
                            && o.get("const").is_some_and(Value::is_string)
                    })
                })
        }) {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) fn check_answer(
    card: &ApprovalRequest,
    answer: &ApprovalAnswer,
) -> Result<(), ErrorObject> {
    let Some(request) = &card.elicitation else {
        return Err(bad("Missing elicitation request."));
    };
    let reply = answer.elicitation.as_ref();
    if answer.confirmed_url.is_some()
        && !matches!(
            (request, reply, answer.decision),
            (
                Elicitation::Url { .. },
                Some(ElicitationReply::Accept { content: None }),
                ApprovalDecision::AllowOnce
            )
        )
    {
        return Err(bad(
            "A confirmed URL applies only to acceptance of the displayed URL.",
        ));
    }
    match (answer.decision, reply, request) {
        (
            ApprovalDecision::Deny,
            None | Some(ElicitationReply::Cancel | ElicitationReply::Decline),
            _,
        ) => Ok(()),
        (
            ApprovalDecision::AllowOnce,
            Some(ElicitationReply::Accept { content: None }),
            Elicitation::Url { url, .. },
        ) if answer.confirmed_url.as_ref() == Some(url) => Ok(()),
        (
            ApprovalDecision::AllowOnce,
            Some(ElicitationReply::Accept {
                content: Some(data),
            }),
            Elicitation::Form {
                requested_schema, ..
            },
        ) if schema_for(requested_schema)?.is_valid(&Value::Object(data.clone())) => Ok(()),
        _ => Err(bad("The answer does not match the MCP elicitation.")),
    }
}

fn hook_fields(p: &McpElicitParams) -> Result<Map<String, Value>, ErrorObject> {
    let mut fields = Map::new();
    fields.insert("mcp_server_name".into(), json!(p.server));
    fields.insert("mode".into(), json!(mode(&p.request)));
    match &p.request {
        Elicitation::Form {
            message,
            requested_schema,
        } => {
            schema_for(requested_schema)?;
            fields.insert("message".into(), json!(message));
            fields.insert("requested_schema".into(), json!(requested_schema));
        }
        Elicitation::Url {
            message,
            url,
            elicitation_id,
        } => {
            if elicitation_id.is_empty() || url.len() > 8192 || piarc_web::rule_host(url).is_none()
            {
                return Err(bad("The MCP server sent an invalid elicitation URL."));
            }
            fields.insert("url".into(), json!(url));
            fields.insert("message".into(), json!(message));
        }
    }
    Ok(fields)
}

fn begin_interaction(
    s: &SessionIo,
    p: &McpElicitParams,
    peer: &Peer,
) -> Result<Option<CancellationToken>, ErrorObject> {
    let mut state = lock(&s.policy);
    state
        .grants
        .get_mut(&p.tool_call_id)
        .filter(|g| {
            piarc_config::mcp::valid_name(&p.server)
                && owns_tool(g, &p.server, &p.server_tool, peer)
        })
        .and_then(|g| g.elicitation.as_mut())
        .ok_or_else(|| denied("The server does not own this MCP tool call."))
        .map(|wait| wait.begin(p.interaction.get()))
}

impl ToolIo {
    pub(in crate::tool_io) fn cancel_elicitation(
        &self,
        p: McpCancelElicitationParams,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let session = self.session(&p.session_id)?;
        let mut state = lock(&session.policy);
        if let Some(wait) = state
            .grants
            .get_mut(&p.tool_call_id)
            .filter(|grant| grant.belongs(&grant.tool, peer))
            .and_then(|grant| grant.elicitation.as_mut())
        {
            wait.cancel(p.interaction.get());
        }
        Ok(json!({}))
    }

    pub(in crate::tool_io) async fn elicit(
        &self,
        p: McpElicitParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let services = self.services()?;
        let generation = begin_interaction(&s, &p, &peer)?;
        let Some(generation) = generation else {
            return to_value(&ElicitationReply::Cancel);
        };
        // Completing normally (or returning an error) also frees the slot for the next ask.
        let _until_done = generation.clone().drop_guard();
        let fields = hook_fields(&p)?;
        if generation.is_cancelled() {
            return to_value(&ElicitationReply::Cancel);
        }
        let facts = self.session_facts(&s, &p.session_id, generation.clone());
        if let Some(reply) = self
            .elicit_hook(&facts, &p.server, HookEvent::Elicitation, fields)
            .await
        {
            // A hook cannot open a URL for a user. A suggested URL acceptance still asks them.
            if !matches!(
                (&reply, &p.request),
                (ElicitationReply::Accept { .. }, Elicitation::Url { .. })
            ) {
                return if generation.is_cancelled() {
                    to_value(&ElicitationReply::Cancel)
                } else {
                    validated_reply(&p.request, &reply)
                };
            }
        }
        let mut card = new_request(&p.session_id, &p.server, &peer)?;
        card.kind = ApprovalKind::Elicitation;
        card.elicitation = Some(p.request.clone());
        let (tx, rx) = oneshot::channel();
        if !post_card(&s, services, &p.tool_call_id, &card, &peer, &generation, tx).await? {
            return to_value(&ElicitationReply::Cancel);
        }
        let answer = tokio::select! {
            biased;
            () = generation.cancelled() => None,
            () = peer.closed() => None,
            got = rx => got.ok(),
        };
        let Some((answer, ack)) = answer else {
            withdraw_card(&s, services, &p.tool_call_id, &card, &peer);
            return to_value(&ElicitationReply::Cancel);
        };
        let original = answer.elicitation.unwrap_or(ElicitationReply::Decline);
        let _ = ack.send(Ok(()));
        let mut fields = to_value(&original)?
            .as_object()
            .cloned()
            .unwrap_or_default();
        fields.insert("mode".into(), json!(mode(&p.request)));
        fields.insert("mcp_server_name".into(), json!(p.server));
        let changed = self
            .elicit_hook(&facts, &p.server, HookEvent::ElicitationResult, fields)
            .await;
        if generation.is_cancelled() {
            return to_value(&ElicitationReply::Cancel);
        }
        // A result hook cannot report that a URL was opened after the user declined navigation.
        if matches!(
            (&p.request, &original, &changed),
            (
                Elicitation::Url { .. },
                ElicitationReply::Cancel | ElicitationReply::Decline,
                Some(ElicitationReply::Accept { .. })
            )
        ) {
            return to_value(&original);
        }
        validated_reply(&p.request, changed.as_ref().unwrap_or(&original))
    }

    async fn elicit_hook(
        &self,
        facts: &crate::hooks::Facts,
        server: &str,
        event: HookEvent,
        fields: Map<String, Value>,
    ) -> Option<ElicitationReply> {
        let hooks = self.hook_service()?;
        let answer = self
            .run_hooks(
                hooks,
                facts,
                &Request {
                    event,
                    subject: Some(server.to_owned()),
                    fields,
                    tool: None,
                },
            )
            .await;
        if answer.decision.block.is_some() || answer.decision.stop.is_some() {
            Some(ElicitationReply::Decline)
        } else {
            answer.decision.elicitation
        }
    }
}

fn validated_reply(request: &Elicitation, reply: &ElicitationReply) -> Result<Value, ErrorObject> {
    match (request, reply) {
        (Elicitation::Url { .. }, ElicitationReply::Accept { content: Some(_) }) => {
            Err(bad("URL elicitation cannot return content."))
        }
        (
            Elicitation::Form {
                requested_schema, ..
            },
            ElicitationReply::Accept { content },
        ) => {
            if schema_for(requested_schema)?
                .is_valid(&Value::Object(content.clone().unwrap_or_default()))
            {
                to_value(reply)
            } else {
                Err(bad(
                    "The hook response did not match the elicitation schema.",
                ))
            }
        }
        _ => to_value(reply),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_current_or_immediately_upcoming_interaction_can_be_cancelled() {
        let mut state = Interactions::default();
        let first = state.begin(1).expect("first");
        state.cancel(99);
        assert!(!first.is_cancelled());
        state.cancel(1);
        assert!(first.is_cancelled());
        let next = state
            .begin(2)
            .expect("out-of-order cancellation must not poison the invocation");
        state.cancel(1);
        assert!(!next.is_cancelled());
        next.cancel();
        // Inbound frames can be scheduled before the matching ask.
        state.cancel(3);
        assert!(state.begin(3).is_none());
        assert!(state.begin(4).is_some());
    }
}
