//! Session titles (ADR-0106): the first message of a new session asks the auxiliary model for a
//! short title on the side; the list shows it while the first turn runs, keeps it after the
//! session closes, and never asks again. Short messages are their own title, a renamed session
//! keeps the user's name, and Core asks nothing unless titles are on.

use piarc_core::sessions::{Op, SessionPrefsChange};
use serde_json::Value;

use crate::support::{Env, Events, answer, prompt_text, reply, shutdown};
use crate::{open_session, prompt};

const TITLE: &str = "Spring Boot 入门学习计划";
const LONG: &str = "我想系统地学习 Spring Boot，请帮我规划一个从零开始、四周完成的入门学习计划，\
                    每周列出主题、要读的文档和一个小练习";

/// Waits for a `core/sessions` snapshot in which session `id` satisfies `pred`.
async fn listed(events: &Events, id: &str, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let snapshot = events
        .until(what, |route, v| {
            route == "core/sessions"
                && v["sessions"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["id"] == id && pred(s)))
        })
        .await;
    snapshot["sessions"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == id))
        .cloned()
        .expect("listed")
}

/// Whether a recorded request body declares tools (the title request has none).
fn has_tools(body: &str) -> bool {
    let request: Value = serde_json::from_str(body).expect("JSON request");
    request["tools"].as_array().is_some_and(|t| !t.is_empty())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_session_is_titled_from_its_first_message_while_the_turn_runs() {
    let env = Env::new("titles").await;
    let (core, events) = env.start(config_on(&env));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text(LONG, "title")).await;
    listed(&events, &id, "the generated title", |s| s["title"] == TITLE).await;
    events.turn_completed(&id, &turn).await;

    // One turn request with tools, one title request without tools or the conversation.
    let requests = env.requests("title");
    assert_eq!(requests.len(), 2, "{requests:#?}");
    let side: Vec<_> = requests.iter().filter(|r| !has_tools(&r.body)).collect();
    assert_eq!(side.len(), 1, "one tool-free title request");
    assert!(
        side[0].body.contains("Spring Boot"),
        "it carries the first message"
    );

    // A second message does not ask again.
    let turn = prompt(&core, &id, "And the fifth week?").await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(env.requests("title").len(), 3, "only the turn's request");

    // Closed, the list comes from the index: the title was stored.
    let (done, rx) = reply();
    core.close_session(id.clone(), done).expect("queued");
    answer(rx).await.expect("closed");
    listed(&events, &id, "the stored title", |s| {
        s["open"] == false && s["title"] == TITLE
    })
    .await;
    shutdown(core).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn short_messages_and_disabled_titles_ask_nothing() {
    let env = Env::new("titles-off").await;
    let (core, events) = env.start(config_on(&env));
    // A short first message is already a good title.
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("你好", "chat")).await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(env.requests("chat").len(), 1, "no title request");
    shutdown(core).await;

    // Renamed before its first message: the user's name stays and nothing is asked.
    let (core, events) = env.start(config_on(&env));
    let id = open_session(&core, &env).await;
    let (done, rx) = reply();
    let rename = Op::Prefs(SessionPrefsChange {
        custom_title: Some(Some("我的计划".into())),
        ..SessionPrefsChange::default()
    });
    core.session_op(id.clone(), rename, done).expect("queued");
    answer(rx).await.expect("renamed");
    let turn = prompt(&core, &id, &prompt_text(LONG, "chat")).await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(
        env.requests("chat").len(),
        2,
        "one more turn, no title request"
    );
    listed(&events, &id, "the user's title", |s| {
        s["title"] == "我的计划"
    })
    .await;
    shutdown(core).await;

    // Off (the default, as in every other test): a long message asks nothing either.
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text(LONG, "chat")).await;
    events.turn_completed(&id, &turn).await;
    assert_eq!(
        env.requests("chat").len(),
        3,
        "one more turn, no title request"
    );
    shutdown(core).await;
}

fn config_on(env: &Env) -> piarc_core::CoreConfig {
    let mut config = env.config(&[]);
    config.sessions.session_titles = true;
    config
}
