//! The input queue (T14-A03) and the timing of steering and follow-up messages (T14-A04).

use piarc_core::sessions::{Op, QueueOp};
use serde_json::Value;

use crate::support::{Env, answer, prompt_text, reply, shutdown, user_texts};
use crate::{open_session, prompt};

async fn op(core: &piarc_core::CoreRuntime, id: &str, op: Op) -> Value {
    let (done, rx) = reply();
    core.session_op(id.to_owned(), op, done).expect("queued");
    answer(rx).await.expect("the request succeeds")
}

fn texts(items: &Value) -> Vec<String> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            format!(
                "{}:{}",
                item["kind"].as_str().unwrap_or_default(),
                item["text"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

/// Waits until the turn's waiting command runs.
async fn waiting(events: &crate::support::Events, id: &str) {
    let route = format!("session/{id}");
    events
        .until("the waiting command", |r, v| {
            r == route
                && v["method"] == "item/started"
                && v["params"]["item"]["itemId"] == "toolu_wait"
        })
        .await;
}

/// T14-A03: queued inputs are edited, deleted and reordered while the turn runs;
/// `session/queueChanged` shows each new order, and after the turn the follow-ups run in the new
/// order, each exactly once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_inputs_are_edited_deleted_and_reordered_and_run_in_the_new_order() {
    let env = Env::new("queue").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Wait for the signal.", "queue")).await;
    waiting(&events, &id).await;

    edit_the_queue(&core, &events, &id).await;

    std::fs::write(env.ws.join("go"), "").expect("signal");
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    // Three follow-up turns run after the first one, then the queue is empty.
    events
        .wait("four turns completed", |e| {
            e.of(&id, "turn/completed").len() == 4
        })
        .await;
    let completed = events.of(&id, "turn/completed");
    assert_eq!(completed.len(), 4);
    assert!(completed.iter().all(|c| c["status"] == "completed"));

    check_follow_up_requests(&env);
    let last_queue = events.of(&id, "session/queueChanged");
    assert!(texts(&last_queue.last().expect("changes")["items"]).is_empty());
    shutdown(core).await;
}

/// Queues a steering message and three follow-ups, edits two, deletes one, adds one and
/// reorders; checks the answer and the reported queue.
async fn edit_the_queue(core: &piarc_core::CoreRuntime, events: &crate::support::Events, id: &str) {
    let item = |answer: Value| answer["itemId"].as_str().expect("queued").to_owned();
    let steer = item(op(core, id, Op::Steer("Steer S".into())).await);
    let a = item(op(core, id, Op::FollowUp("Follow-up A".into())).await);
    let b = item(op(core, id, Op::FollowUp("Follow-up B".into())).await);
    let c = item(op(core, id, Op::FollowUp("Follow-up C".into())).await);
    let edit = |item_id: &str, text: &str| {
        Op::Queue(QueueOp::Edit {
            item_id: item_id.into(),
            text: text.into(),
        })
    };
    op(core, id, edit(&steer, "Steer S2")).await;
    op(core, id, edit(&b, "Follow-up B2")).await;
    op(core, id, Op::Queue(QueueOp::Delete { item_id: a })).await;
    let d = item(op(core, id, Op::FollowUp("Follow-up D".into())).await);
    let reordered = op(
        core,
        id,
        Op::Queue(QueueOp::Reorder(vec![steer.clone(), d, c, b])),
    )
    .await;
    assert_eq!(
        texts(&reordered["items"]),
        [
            "steer:Steer S2",
            "followUp:Follow-up D",
            "followUp:Follow-up C",
            "followUp:Follow-up B2"
        ]
    );
    let expected = texts(&reordered["items"]);
    let changes = |e: &crate::support::Events| -> Vec<Vec<String>> {
        e.of(id, "session/queueChanged")
            .iter()
            .map(|p| texts(&p["items"]))
            .collect()
    };
    events
        .wait("the reordered queue reported", |e| {
            changes(e).last() == Some(&expected)
        })
        .await;
    println!(
        "queue changes:\n{}",
        changes(events)
            .iter()
            .map(|c| format!("  {c:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// The requests: steering inside the first turn, then the follow-ups in the new order, each once.
fn check_follow_up_requests(env: &Env) {
    let requests = env.requests("queue");
    let lasts: Vec<String> = requests
        .iter()
        .map(|r| user_texts(&r.body).last().cloned().unwrap_or_default())
        .collect();
    println!("last user text of each request: {lasts:?}");
    assert_eq!(
        lasts,
        [
            prompt_text("Wait for the signal.", "queue"),
            "Steer S2".into(),
            "Follow-up D".into(),
            "Follow-up C".into(),
            "Follow-up B2".into()
        ]
    );
    let history = user_texts(&requests.last().expect("requests").body);
    for (text, count) in [
        ("Steer S2", 1),
        ("Follow-up D", 1),
        ("Follow-up C", 1),
        ("Follow-up B2", 1),
        ("Steer S", 0),
        ("Follow-up A", 0),
        ("Follow-up B", 0),
    ] {
        assert_eq!(
            history.iter().filter(|t| t.as_str() == text).count(),
            count,
            "{text} in {history:?}"
        );
    }
}

/// T14-A04: a steering message sent while a tool runs reaches the model in the next request of
/// the same turn; a follow-up sent at the same time runs as a new turn after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steering_joins_the_running_turn_and_a_follow_up_waits_for_the_next() {
    let env = Env::new("steer").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Wait for the signal.", "steer")).await;
    waiting(&events, &id).await;
    op(&core, &id, Op::Steer("Also count the files.".into())).await;
    op(&core, &id, Op::FollowUp("Then summarize.".into())).await;
    std::fs::write(env.ws.join("go"), "").expect("signal");
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let route = format!("session/{id}");
    let next = events
        .until("the follow-up turn", |r, v| {
            r == route && v["method"] == "turn/started" && v["params"]["turnId"] != turn.as_str()
        })
        .await;
    let next_turn = next["params"]["turnId"].as_str().expect("id").to_owned();
    events.turn_completed(&id, &next_turn).await;

    let requests = env.requests("steer");
    assert_eq!(requests.len(), 3);
    // Request 2 continues the first turn: tool results, then the steering message.
    let second = user_texts(&requests[1].body);
    assert_eq!(
        second.last().map(String::as_str),
        Some("Also count the files.")
    );
    assert!(!requests[1].body.contains("Then summarize."));
    assert!(!requests[1].body.contains("Steered answer."));
    // Request 3 is the follow-up turn: after the first turn's final answer.
    let third = user_texts(&requests[2].body);
    assert_eq!(third.last().map(String::as_str), Some("Then summarize."));
    assert!(requests[2].body.contains("Steered answer."));

    // On the client: the steering message is an item of the first turn, the follow-up starts the
    // second, and the second turn starts only after the first completed.
    let order: Vec<String> = events
        .on(&route)
        .iter()
        .filter_map(|v| match v["method"].as_str() {
            Some("turn/started" | "turn/completed") => Some(format!(
                "{}:{}",
                v["method"].as_str().unwrap_or_default(),
                if v["params"]["turnId"] == turn.as_str() {
                    "1"
                } else {
                    "2"
                }
            )),
            Some("item/completed") if v["params"]["item"]["type"] == "userMessage" => {
                Some(format!(
                    "user:{}:{}",
                    if v["params"]["turnId"] == turn.as_str() {
                        "1"
                    } else {
                        "2"
                    },
                    v["params"]["item"]["text"].as_str().unwrap_or_default()
                ))
            }
            _ => None,
        })
        .collect();
    println!("client order: {order:?}");
    assert_eq!(
        order,
        [
            "turn/started:1",
            &format!("user:1:{}", prompt_text("Wait for the signal.", "steer")),
            "user:1:Also count the files.",
            "turn/completed:1",
            "turn/started:2",
            "user:2:Then summarize.",
            "turn/completed:2"
        ]
    );
    shutdown(core).await;
}
