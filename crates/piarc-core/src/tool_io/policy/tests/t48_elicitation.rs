//! MCP elicitation through real tool grants and the approval ledger.
use super::*;

#[tokio::test]
async fn elicitation_requires_a_live_grant_and_validates_the_form_before_claiming_the_card() {
    use piarc_protocol::mcp::ElicitationReply;

    let f = Fixture::new().await;
    std::fs::write(
        f.root.join("data/settings.json"),
        r#"{"permissions":{"allow":["mcp__alpha__*"]}}"#,
    )
    .expect("settings");
    let request = json!({"sessionId":SESSION,"toolCallId":"called","interaction":1,"server":"alpha","serverTool":"elicit","request":{
        "mode":"form","message":"Choose a release.","requestedSchema":{"type":"object","properties":{"release":{"type":"string","minLength":2}},"required":["release"]}}});
    let elicit = || {
        f.io.dispatch(
            "mcp/elicit",
            request.as_object().expect("params").clone(),
            f.peer.clone(),
        )
    };
    assert_eq!(
        elicit().await.expect_err("missing grant").data.kind,
        ErrorKind::PermissionDenied
    );
    assert_eq!(
        f.evaluate("called", "mcp__alpha__elicit", json!({})).await["allowed"],
        true
    );
    let input = async {
        let card = f.pending().await;
        assert_eq!(card.kind, ApprovalKind::Elicitation);
        assert_eq!(card.tool, "alpha");
        let mut reply = answer(&card, ApprovalDecision::AllowOnce);
        for value in ["x", "Ready"] {
            reply.elicitation = Some(ElicitationReply::Accept {
                content: Some(serde_json::Map::from_iter([(
                    "release".into(),
                    json!(value),
                )])),
            });
            if value == "Ready" {
                let mut unexpected_url = reply.clone();
                unexpected_url.confirmed_url = Some("https://example.invalid/".into());
                assert_eq!(
                    f.io.answer_approval(unexpected_url)
                        .await
                        .expect_err("form has no URL")
                        .data
                        .kind,
                    ErrorKind::InvalidRequest
                );
                assert_eq!(f.pending().await.request_id, card.request_id);
            }
            let status = f.io.answer_approval(reply.clone()).await;
            if value == "x" {
                assert_eq!(
                    status.expect_err("invalid form").data.kind,
                    ErrorKind::InvalidRequest
                );
            } else {
                assert_eq!(status.expect("answered")["status"], "applied");
            }
        }
    };
    let (result, ()) = tokio::join!(elicit(), input);
    assert_eq!(
        result.expect("server reply"),
        json!({"action":"accept","content":{"release":"Ready"}})
    );
    f.io.finish_tool(SESSION, "called");
    assert!(elicit().await.is_err());
}

#[tokio::test]
async fn elicitation_url_is_bound_to_native_confirmation_and_ends_with_its_tool() {
    use piarc_protocol::mcp::ElicitationReply;
    let f = Fixture::new().await;
    std::fs::write(
        f.root.join("data/settings.json"),
        r#"{"permissions":{"allow":["mcp__alpha__*"]}}"#,
    )
    .expect("settings");
    let url = "https://example.invalid/confirm";
    for (id, result) in [
        ("confirm", "accept"),
        ("dismiss", "cancel"),
        ("refuse", "decline"),
        ("end", "cancel"),
    ] {
        let request = json!({"sessionId":SESSION,"toolCallId":id,"interaction":1,"server":"alpha","serverTool":"choose","request":{"mode":"url","url":url,"elicitationId":id,"message":"Open the site?"}});
        assert_eq!(
            f.evaluate(id, "mcp__alpha__choose", json!({})).await["allowed"],
            true
        );
        let pending = f.io.dispatch(
            "mcp/elicit",
            request.as_object().expect("params").clone(),
            f.peer.clone(),
        );
        let send = async {
            let card = f.pending().await;
            if id == "end" {
                f.io.finish_tool(SESSION, id);
                return;
            }
            let mut a = answer(&card, ApprovalDecision::Deny);
            a.elicitation = Some(match result {
                "accept" => {
                    a.decision = ApprovalDecision::AllowOnce;
                    a.confirmed_url = Some("https://elsewhere.invalid/".into());
                    a.elicitation = Some(ElicitationReply::Accept { content: None });
                    assert_eq!(
                        f.io.answer_approval(a.clone())
                            .await
                            .expect_err("wrong URL")
                            .data
                            .kind,
                        ErrorKind::InvalidRequest
                    );
                    a.confirmed_url = Some(url.into());
                    ElicitationReply::Accept { content: None }
                }
                "cancel" => ElicitationReply::Cancel,
                _ => ElicitationReply::Decline,
            });
            assert_eq!(
                f.io.answer_approval(a).await.expect("answered")["status"],
                "applied"
            );
        };
        let (replied, ()) = tokio::join!(pending, send);
        assert_eq!(replied.expect("result"), json!({"action":result}));
        f.io.finish_tool(SESSION, id);
    }
}

#[tokio::test]
async fn ordinary_approval_rejects_elicitation_fields_without_claiming_the_card() {
    use piarc_protocol::mcp::ElicitationReply;

    async fn check_fields(f: &Fixture, card: &ApprovalRequest) {
        let valid = answer(card, ApprovalDecision::AllowOnce);
        for (with_reply, with_url) in [(true, false), (false, true), (true, true)] {
            let mut wrong = valid.clone();
            wrong.elicitation = with_reply.then_some(ElicitationReply::Accept { content: None });
            wrong.confirmed_url = with_url.then(|| "https://example.invalid/".into());
            assert_eq!(
                f.io.answer_approval(wrong)
                    .await
                    .expect_err("field belongs to another card")
                    .data
                    .kind,
                ErrorKind::InvalidRequest
            );
            assert_eq!(f.pending().await.request_id, card.request_id);
        }
    }

    let f = Fixture::new().await;
    let pending = f.evaluate("ordinary", "Bash", json!({"command":"npm test"}));
    let user = async {
        let card = f.pending().await;
        assert_eq!(card.kind, ApprovalKind::Command);
        let valid = answer(&card, ApprovalDecision::AllowOnce);
        check_fields(&f, &card).await;
        assert_eq!(
            f.io.answer_approval(valid).await.expect("original card")["status"],
            "applied"
        );
    };
    let (result, ()) = tokio::join!(pending, user);
    assert_eq!(result["allowed"], true);

    let session = f.io.session(SESSION).expect("session");
    let services = f.io.services().expect("services");
    for kind in [
        ApprovalKind::FileChange,
        ApprovalKind::PermissionExpansion,
        ApprovalKind::Question,
        ApprovalKind::Plan,
    ] {
        let mut card = new_request(SESSION, "test", &f.peer).expect("card");
        card.kind = kind;
        let (tx, _reply) = oneshot::channel();
        assert!(post_local_card(&session, services, &card, tx));
        check_fields(&f, &card).await;
        withdraw_local_card(&session, services, &card);
    }
}

#[tokio::test]
async fn cancelling_an_elicitation_leaves_later_questions_of_the_same_tool_answerable() {
    let f = Fixture::new().await;
    std::fs::write(
        f.root.join("data/settings.json"),
        r#"{"permissions":{"allow":["mcp__alpha__*"]}}"#,
    )
    .expect("settings");
    let request = |number: u64| {
        json!({"sessionId":SESSION,"toolCallId":"parent","interaction":number,
        "server":"alpha","serverTool":"choose","request":{"mode":"form","message":"Continue?","requestedSchema":{"type":"object","properties":{}}}})
    };
    let cancel = |number: u64| {
        f.io.dispatch(
            "mcp/cancelElicitation",
            json!({"sessionId":SESSION,"toolCallId":"parent","interaction":number})
                .as_object()
                .expect("cancel")
                .clone(),
            f.peer.clone(),
        )
    };
    assert_eq!(
        f.evaluate("parent", "mcp__alpha__choose", json!({})).await["allowed"],
        true
    );
    for (number, expected) in [(1, "cancel"), (2, "decline")] {
        let wait = f.io.dispatch(
            "mcp/elicit",
            request(number).as_object().expect("request").clone(),
            f.peer.clone(),
        );
        let user = async {
            let card = f.pending().await;
            // A delayed cancellation from the first interaction must not withdraw the second.
            cancel(1).await.expect("cancel first question");
            if number == 2 {
                assert_eq!(f.pending().await.request_id, card.request_id);
                f.io.answer_approval(answer(&card, ApprovalDecision::Deny))
                    .await
                    .expect("second reply");
            }
        };
        let (reply, ()) = tokio::join!(wait, user);
        assert_eq!(reply.expect("resolved")["action"], expected);
    }
}
