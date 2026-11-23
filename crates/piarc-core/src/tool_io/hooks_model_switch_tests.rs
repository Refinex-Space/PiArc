//! Model-switch decisions and their session-bound confirmation.
use super::*;
use piarc_hooks::HookEvent;
use piarc_protocol::{models::ModelSwitchPreviewResult, session::ModelRef};

fn model(id: &str) -> ModelRef {
    ModelRef {
        provider: "fixture".into(),
        id: id.into(),
    }
}
fn preview() -> ModelSwitchPreviewResult {
    ModelSwitchPreviewResult {
        from_model: Some(model("current")),
        context_tokens: Some(1024),
        cache_invalidated: true,
        cache_write_usd: Some(0.015),
        drops_thinking: false,
        prompt_cache_warm: true,
        cache_ttl: Some(300),
    }
}

#[tokio::test]
async fn pre_model_switch_denial_and_post_context_use_the_model_matcher_and_cost_fields() {
    let f=Fixture::new(Setup{user:json!({
        "PreModelSwitch":group("other",&[command(&records("pre")),prints(&json!({"decision":"block","reason":"pinned"}))]),
        "PostModelSwitch":group("other",&[command("printf 'Use the glossary.'")]),
    }), ..Setup::default()}).await;
    let p = preview();
    let token = CancellationToken::new();
    assert!(
        f.io.model_switch_hook(
            SESSION,
            HookEvent::PreModelSwitch,
            &model("matched-nothing"),
            &p,
            &token
        )
        .await
        .is_ok()
    );
    let reason =
        f.io.model_switch_hook(
            SESSION,
            HookEvent::PreModelSwitch,
            &model("other"),
            &p,
            &token,
        )
        .await
        .expect_err("denied");
    assert_eq!(reason.message, "pinned");
    let rows = f.log("pre");
    assert_eq!(rows.len(), 1);
    let fields = &rows[0];
    for (key, value) in [
        ("from_model", json!("current")),
        ("to_model", json!("other")),
        ("requested_model", json!("other")),
        ("source", json!("picker")),
        ("context_tokens", json!(1024)),
        ("prompt_cache_warm", json!(true)),
        ("cache_ttl", json!("5m")),
        ("estimated_cache_write_usd", json!(0.015)),
        ("pricing", json!("catalog")),
    ] {
        assert_eq!(fields[key], value, "{key}");
    }
    assert_eq!(
        f.io.model_switch_hook(
            SESSION,
            HookEvent::PostModelSwitch,
            &model("other"),
            &p,
            &token
        )
        .await
        .expect("post")
        .as_deref(),
        Some("Use the glossary.")
    );
}

#[tokio::test]
async fn a_pre_model_switch_ask_accepts_only_the_target_chosen_in_the_question_card() {
    let f=Fixture::new(Setup{user:json!({
        "PreModelSwitch":group("other",&[prints(&json!({"hookSpecificOutput":{"hookEventName":"PreModelSwitch","permissionDecision":"ask","permissionDecisionReason":"Review target"}}))])
    }),..Setup::default()}).await;
    let token = CancellationToken::new();
    let p = preview();
    let target = model("other");
    for (choice, ok) in [("fixture/current", false), ("fixture/other", true)] {
        let change =
            f.io.model_switch_hook(SESSION, HookEvent::PreModelSwitch, &target, &p, &token);
        let confirm = async {
            let card = f.pending().await;
            assert_eq!(card.tool, "PreModelSwitch");
            assert_eq!(card.questions[0].question, "Review target");
            let answer=serde_json::from_value(json!({"requestId":card.request_id,"sessionId":SESSION,"connectionEpoch":card.connection_epoch,"revision":card.revision,
                "decision":"allowOnce","answers":[{"selected":[choice]}]})).expect("answer");
            f.io.answer_approval(answer).await.expect("applied");
        };
        let (result, ()) = tokio::join!(change, confirm);
        assert_eq!(result.is_ok(), ok);
    }
}
