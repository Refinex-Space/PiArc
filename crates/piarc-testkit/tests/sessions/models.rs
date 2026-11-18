//! T21: a confirmed switch and an effort change reach the wire and survive a Core restart.

use piarc_core::sessions::{ModelOp, Op};
use piarc_protocol::models::EffortLevel;
use piarc_protocol::session::ModelRef;
use serde_json::{Value, json};

use crate::support::{Env, answer, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

async fn model_op(core: &piarc_core::CoreRuntime, id: &str, op: ModelOp) -> Value {
    let (done, rx) = reply();
    core.session_op(id.to_owned(), Op::Model(op), done)
        .expect("queued");
    answer(rx).await.expect("model operation")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirmed_model_and_effort_reach_the_wire_after_resume() {
    let env = Env::new("model-switch").await;
    let path = env.data.join("pi").join("models.json");
    let mut config: Value =
        serde_json::from_slice(&std::fs::read(&path).expect("model file")).expect("JSON");
    config["providers"]["second"] = json!({
        "api":"openai-completions","baseUrl":env.mock.openai_base_url(),"apiKey":"mock",
        "models":[{"id":"reasoner","reasoning":true,"compat":{"supportsReasoningEffort":true}}]
    });
    std::fs::write(path, serde_json::to_vec(&config).expect("JSON")).expect("write models");
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("First", "chat")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );

    let target = ModelRef {
        provider: "second".into(),
        id: "reasoner".into(),
    };
    let preview = model_op(&core, &id, ModelOp::Preview(target.clone())).await;
    assert_eq!(preview["cacheInvalidated"], true);
    let selected = model_op(&core, &id, ModelOp::Set(target, Some(EffortLevel::Low))).await;
    assert_eq!(selected["effort"], "low");
    model_op(&core, &id, ModelOp::Effort(EffortLevel::High)).await;
    let turn = prompt(&core, &id, "Second").await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    shutdown(core).await;

    let (core, events) = env.start(env.config(&[]));
    let (done, rx) = reply();
    core.resume_session(id.clone(), done).expect("queued");
    answer(rx).await.expect("resumed");
    let turn = prompt(&core, &id, "Third").await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let records = env.requests("chat");
    assert_eq!(records.len(), 3);
    for record in &records[1..] {
        assert!(record.path.starts_with("/v1/chat/completions"));
        let body = record.body_json().expect("request JSON");
        assert_eq!(body["model"], "reasoner");
        assert_eq!(body["reasoning_effort"], "high");
    }
    shutdown(core).await;
}
