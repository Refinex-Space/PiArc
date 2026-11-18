//! T19 (ADR-0030): the composer's input end to end — mentions and attachments reach the model
//! as image content and PDF text and come back as the user wrote them (live and from the
//! history), the client's idempotency key, `/compact` as a turn, and the kind of a failed turn.

use std::path::{Path, PathBuf};

use piarc_core::composer::UserInput;
use piarc_core::sessions::Op;
use piarc_protocol::input::InputMention;
use serde_json::{Value, json};

use crate::support::{Env, answer, prompt_text, reply, shutdown};
use crate::{open_session, window};

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/scenarios/fixtures")
        .join(name);
    std::fs::read(path).expect("fixture")
}

/// Pi's models with image input (the model must accept images to receive them).
fn vision_models(env: &Env) {
    let models = json!({ "providers": { "piarc-mock": {
        "baseUrl": env.mock.anthropic_base_url(), "api": "anthropic-messages",
        "apiKey": "piarc-mock-test-key",
        "models": [{ "id": "mock-large", "name": "mock-large", "reasoning": false,
            "input": ["text", "image"], "contextWindow": 200_000, "maxTokens": 4096,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }]
    }}});
    std::fs::write(
        env.data.join("pi").join("models.json"),
        serde_json::to_vec(&models).expect("JSON"),
    )
    .expect("models written");
}

async fn store(core: &piarc_core::CoreRuntime, id: &str, name: &str, mime: &str) -> Value {
    let (done, rx) = reply();
    core.store_attachment(
        id.to_owned(),
        name.to_owned(),
        mime.to_owned(),
        fixture(name),
        done,
    )
    .expect("queued");
    answer(rx).await.expect("stored")
}

async fn run(core: &piarc_core::CoreRuntime, id: &str, op: Op) -> piarc_core::Result<Value> {
    let (done, rx) = reply();
    core.session_op(id.to_owned(), op, done).expect("queued");
    answer(rx).await
}

fn input(text: String, mentions: Vec<InputMention>, attachments: Value) -> UserInput {
    UserInput {
        request_id: Some("client-1".into()),
        text,
        mentions,
        attachments: serde_json::from_value(attachments).expect("attachments"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_input_reaches_the_model_with_its_attachments_and_shows_as_written() {
    let env = Env::new("input").await;
    vision_models(&env);
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let image = store(&core, &id, "pixel.png", "image/png").await;
    let pdf = store(&core, &id, "report.pdf", "application/pdf").await;
    assert_eq!(pdf["pageCount"], 12, "{pdf}");
    let blob = PathBuf::from(pdf["blob"]["path"].as_str().expect("path"));
    assert_eq!(
        blob.parent().expect("dir"),
        env.data.join("sessions").join(&id).join("attachments")
    );

    let text = prompt_text("Compare @src/a b.ts with the report", "input");
    let mention = InputMention {
        path: "src/a b.ts".into(),
        start: 8,
        end: 19,
    };
    let sent = input(text.clone(), vec![mention.clone()], json!([image, pdf]));
    let first = run(&core, &id, Op::Prompt(sent.clone()))
        .await
        .expect("accepted");
    // The same key again: the same turn, not a second message.
    let again = run(&core, &id, Op::Prompt(sent)).await.expect("accepted");
    assert_eq!(first["turnId"], again["turnId"]);
    let turn = first["turnId"].as_str().expect("turn");
    let completed = events.turn_completed(&id, turn).await;
    assert_eq!(completed["status"], "completed", "{completed}");

    let requests = env.requests("input");
    assert_eq!(requests.len(), 1, "one request for one turn");
    let body: Value = serde_json::from_str(&requests[0].body).expect("JSON");
    let user = body["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "user"))
        .expect("a user message");
    let blocks = user["content"].as_array().expect("blocks");
    let texts: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
    let joined = texts.join("\n");
    assert!(joined.starts_with(&text), "{joined}");
    assert!(
        joined.contains("<attachment name=\"report.pdf\" type=\"application/pdf\" pages=\"12\""),
        "{joined}"
    );
    assert!(joined.contains("[Page 12]\nReport page 12"), "{joined}");
    let images: Vec<&Value> = blocks.iter().filter(|b| b["type"] == "image").collect();
    assert_eq!(images.len(), 1, "{user}");
    assert_eq!(images[0]["source"]["media_type"], "image/png");

    // Live: the user message as written, with its chips' data.
    let live = events
        .of(&id, "item/completed")
        .into_iter()
        .find(|n| n["item"]["type"] == "userMessage")
        .expect("a user message item");
    let item = &live["item"];
    assert_eq!(item["text"], text.as_str());
    assert_eq!(item["mentions"], json!([mention]));
    assert_eq!(item["attachments"].as_array().map(Vec::len), Some(2));
    // History: the same.
    let history = window(&core, &id, None).await;
    let stored = history["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["item"]["type"] == "userMessage"))
        .expect("the user message in the history");
    assert_eq!(stored["item"]["text"], item["text"]);
    assert_eq!(stored["item"]["mentions"], item["mentions"]);
    assert_eq!(stored["item"]["attachments"], item["attachments"]);
    verify_attachment_lifetime(&env, &core, &id, &blob).await;
    shutdown(core).await;
}

async fn verify_attachment_lifetime(
    env: &Env,
    core: &piarc_core::CoreRuntime,
    id: &str,
    blob: &Path,
) {
    // Archiving clears generated output but keeps the attachment referenced by the JSONL.
    let scratch = env
        .data
        .join("sessions")
        .join(id)
        .join("scratch-output.txt");
    std::fs::write(&scratch, b"temporary output").expect("write output");
    for archived in [true, false] {
        run(
            core,
            id,
            Op::Prefs(piarc_core::sessions::SessionPrefsChange {
                archived: Some(archived),
                ..Default::default()
            }),
        )
        .await
        .expect("change archive state");
        assert_eq!(
            std::fs::read(blob).expect("archived attachment"),
            fixture("report.pdf")
        );
        assert!(!scratch.exists());
    }
    let (done, rx) = reply();
    core.delete_session(id.to_owned(), done).expect("queued");
    answer(rx).await.expect("deleted");
    assert!(!blob.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachments_must_be_this_sessions_and_of_an_accepted_type() {
    let env = Env::new("input-refused").await;
    let (core, _events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let (done, rx) = reply();
    core.store_attachment(
        id.clone(),
        "notes.txt".into(),
        "text/plain".into(),
        b"hello".to_vec(),
        done,
    )
    .expect("queued");
    let refused = answer(rx).await.expect_err("not an accepted type");
    assert_eq!(refused.kind(), piarc_protocol::ErrorKind::InvalidParams);
    let image = store(&core, &id, "pixel.png", "image/png").await;
    let mut foreign = image.clone();
    foreign["blob"]["path"] = json!(
        env.root.join("elsewhere").join(
            Path::new(image["blob"]["path"].as_str().expect("path"))
                .file_name()
                .expect("name")
        )
    );
    let error = run(
        &core,
        &id,
        Op::Prompt(input("x".into(), Vec::new(), json!([foreign]))),
    )
    .await
    .expect_err("another directory");
    assert_eq!(error.kind(), piarc_protocol::ErrorKind::InvalidParams);
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_runs_as_a_turn_of_its_own() {
    let env = Env::new("compact").await;
    std::fs::write(
        env.data.join("pi").join("settings.json"),
        r#"{ "compaction": { "keepRecentTokens": 1 }, "retry": { "baseDelayMs": 5 } }"#,
    )
    .expect("settings");
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = crate::prompt(
        &core,
        &id,
        &prompt_text("Something to remember.", "compact"),
    )
    .await;
    events.turn_completed(&id, &turn).await;
    let accepted = run(&core, &id, Op::Compact).await.expect("accepted");
    let turn = accepted["turnId"].as_str().expect("turn").to_owned();
    let completed = events.turn_completed(&id, &turn).await;
    assert_eq!(completed["status"], "completed", "{completed}");
    let compaction = events
        .of(&id, "item/completed")
        .into_iter()
        .find(|n| n["item"]["type"] == "contextCompaction")
        .expect("a compaction item");
    assert_eq!(compaction["turnId"], turn.as_str());
    assert_eq!(compaction["item"]["status"], "completed");
    assert_eq!(compaction["item"]["reason"], "manual");
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_turn_reports_its_kind_and_whether_to_retry() {
    let env = Env::new("errors").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = crate::prompt(&core, &id, &prompt_text("Hello.", "auth")).await;
    let failed = events.turn_completed(&id, &turn).await;
    assert_eq!(failed["status"], "failed", "{failed}");
    assert_eq!(failed["errorKind"], "auth", "{failed}");
    assert_eq!(failed["retryable"], false);

    // A failed turn leaves its user message without a reply (I67), which the strict mock
    // refuses before the next message: the second failure runs in its own session.
    let id = open_session(&core, &env).await;
    let turn = crate::prompt(&core, &id, &prompt_text("Again.", "limit")).await;
    let failed = events.turn_completed(&id, &turn).await;
    assert_eq!(failed["errorKind"], "rateLimit", "{failed}");
    assert_eq!(failed["retryable"], true);
    let retries: Vec<Value> = events
        .of(&id, "turn/retrying")
        .into_iter()
        .filter(|n| n["turnId"] == turn.as_str())
        .collect();
    assert_eq!(retries.len(), 3, "Pi's three automatic retries");
    assert_eq!(retries[2]["attempt"], 3);
    assert_eq!(retries[2]["maxAttempts"], 3);
    let usage = events.of(&id, "turn/usage");
    assert!(
        usage.iter().any(|n| n["turnId"] == turn.as_str()),
        "turn/usage after each response"
    );
    shutdown(core).await;
}
