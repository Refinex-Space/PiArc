//! Turn invariants (architecture section 6.15) and the event path: interruption (T14-A05),
//! tool batches (A06), retries (A07) and a lost notification (A08).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_core::sessions::Op;
use piarc_core::tool_io::ToolIoObserver;
use piarc_ports::BoxFuture;
use serde_json::Value;
use tokio::sync::watch;

use crate::support::{Env, answer, prompt_text, reply, roles, shutdown, user_texts};
use crate::{open_session, prompt};

/// T14-A05: aborting while tools run completes every call of the response as interrupted; the
/// next request pairs every tool call with a result and keeps user and assistant alternating
/// (every validation rule on).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_abort_completes_every_tool_call_as_interrupted_and_the_next_request_is_valid() {
    let env = Env::new("abort").await;
    std::fs::create_dir_all(env.ws.join("notes")).expect("notes");
    std::fs::write(env.ws.join("notes").join("a.txt"), "alpha\n").expect("note");
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(
        &core,
        &id,
        &prompt_text("Run the three tools.", "abort-tools"),
    )
    .await;
    let route = format!("session/{id}");
    events
        .until("the hanging command", |r, v| {
            r == route
                && v["method"] == "item/started"
                && v["params"]["item"]["itemId"] == "toolu_hang"
        })
        .await;
    let (done, rx) = reply();
    core.session_op(id.clone(), Op::Abort, done)
        .expect("queued");
    let stopped = answer(rx).await.expect("aborted");
    assert_eq!(stopped["interruptedTurnId"].as_str(), Some(turn.as_str()));
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "interrupted"
    );

    let finals: BTreeSet<String> = events
        .of(&id, "item/completed")
        .iter()
        .filter(|p| p["item"]["tool"].is_string())
        .map(|p| {
            format!(
                "{}:{}",
                p["item"]["itemId"].as_str().unwrap_or_default(),
                p["item"]["status"].as_str().unwrap_or_default()
            )
        })
        .collect();
    println!("tool items: {finals:?}");
    assert_eq!(
        finals,
        BTreeSet::from([
            "toolu_grep:interrupted".to_owned(),
            "toolu_hang:interrupted".to_owned(),
            "toolu_read:interrupted".to_owned()
        ])
    );

    let next = prompt(&core, &id, "Go on.").await;
    let resumed = events.turn_completed(&id, &next).await;
    let requests = env.requests("abort-tools");
    assert_eq!(
        resumed["status"],
        "completed",
        "turn {resumed}; mock requests: {:?}",
        requests
            .iter()
            .map(|r| (&r.violations, roles(&r.body)))
            .collect::<Vec<_>>()
    );
    check_request_after_abort(&env);
    shutdown(core).await;
}

/// The request after the abort passes every rule: each tool call has its (error) result and the
/// roles alternate.
fn check_request_after_abort(env: &Env) {
    let requests = env.requests("abort-tools");
    let after = requests.last().expect("the request after the abort");
    assert!(after.violations.is_empty(), "{:#?}", after.violations);
    let body: Value = serde_json::from_str(&after.body).expect("JSON");
    let results: Vec<(String, bool)> = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .filter(|b| b["type"] == "tool_result")
        .map(|b| {
            (
                b["tool_use_id"].as_str().unwrap_or_default().to_owned(),
                b["is_error"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    println!("roles after the abort: {:?}", roles(&after.body));
    assert_eq!(
        results,
        [
            ("toolu_hang".to_owned(), true),
            ("toolu_read".to_owned(), true),
            ("toolu_grep".to_owned(), true)
        ]
    );
    assert_eq!(
        roles(&after.body),
        ["user", "assistant", "user", "assistant", "user"]
    );
}

/// Holds every delegated request until no new one arrived for a quiet period, then lets them
/// all go together; records which tool calls were held at once.
#[derive(Default)]
struct Rounds {
    state: Mutex<RoundState>,
}

#[derive(Default)]
struct RoundState {
    held: Vec<(String, watch::Sender<bool>)>,
    arrivals: u64,
    rounds: Vec<BTreeSet<String>>,
}

impl Rounds {
    /// Releases the held requests once `quiet` passed without a new arrival.
    fn release_when_quiet(self: Arc<Self>, quiet: Duration) {
        tokio::spawn(async move {
            let mut seen = u64::MAX;
            loop {
                tokio::time::sleep(quiet).await;
                let mut state = self.state.lock().expect("lock");
                if state.arrivals == seen && !state.held.is_empty() {
                    let held = std::mem::take(&mut state.held);
                    state
                        .rounds
                        .push(held.iter().map(|(call, _)| call.clone()).collect());
                    for (_, release) in held {
                        release.send_replace(true);
                    }
                }
                seen = state.arrivals;
            }
        });
    }
}

impl ToolIoObserver for Rounds {
    fn before(
        &self,
        _session_id: &str,
        _method: &str,
        tool_call_id: Option<&str>,
    ) -> BoxFuture<'static, ()> {
        // Requests made for no tool call (`exec/shells` while the session's tools are set up,
        // T17) are not part of a batch.
        let Some(tool_call_id) = tool_call_id else {
            return Box::pin(async {});
        };
        let (tx, mut rx) = watch::channel(false);
        {
            let mut state = self.state.lock().expect("lock");
            state.arrivals += 1;
            state.held.push((tool_call_id.to_owned(), tx));
        }
        Box::pin(async move {
            // The sender lives until it releases this request.
            let _ = rx.wait_for(|open| *open).await;
        })
    }
}

/// T14-A06: a response with 12 read-only calls, a write and 2 read-only calls runs in batches
/// of 10, 2, the write alone, 2; at no time do more than 10 calls run (counted on Core's side,
/// where the delegated requests arrive).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_calls_run_in_batches_of_ten_read_only_calls_and_writes_alone() {
    let env = Env::new("batches").await;
    std::fs::create_dir_all(env.ws.join("files")).expect("files");
    for n in 1..=14 {
        std::fs::write(
            env.ws.join("files").join(format!("{n:02}.txt")),
            format!("file {n}\n"),
        )
        .expect("file");
    }
    let rounds = Arc::new(Rounds::default());
    Arc::clone(&rounds).release_when_quiet(Duration::from_millis(150));
    let mut config = env.config(&[]);
    config.tool_observer = Some(Arc::clone(&rounds) as _);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Read, write, read.", "batches")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );

    let rounds = rounds.state.lock().expect("lock").rounds.clone();
    // A tool makes several requests one after another (stat, then read): consecutive rounds of
    // the same calls are one batch.
    let mut batches: Vec<BTreeSet<String>> = Vec::new();
    for round in rounds {
        if batches.last() != Some(&round) {
            batches.push(round);
        }
    }
    println!("batches seen by Core: {batches:?}");
    let sizes: Vec<usize> = batches.iter().map(BTreeSet::len).collect();
    assert_eq!(sizes, [10, 2, 1, 2]);
    assert!(batches[2].contains("w13"), "the write runs alone");
    let reads = |range: std::ops::RangeInclusive<u32>| -> BTreeSet<String> {
        range.map(|n| format!("r{n:02}")).collect()
    };
    assert_eq!(batches[0], reads(1..=10));
    assert_eq!(batches[1], reads(11..=12));
    assert_eq!(batches[3], reads(14..=15));
    assert!(sizes.iter().all(|size| *size <= 10));
    shutdown(core).await;
}

/// T14-A07: an overloaded (529) and a rate-limited (429) answer are retried by Pi: the client
/// sees `turn/retrying` with attempt, maxAttempts and delayMs, and the successful request carries
/// none of the failed attempts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_are_reported_to_the_client_and_kept_from_the_model() {
    let env = Env::new("retry").await;
    let (core, events) = env.start(env.config(&[]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Answer despite errors.", "retry")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let retries = events.of(&id, "turn/retrying");
    println!("turn/retrying: {retries:#?}");
    assert_eq!(retries.len(), 2);
    for (n, retry) in retries.iter().enumerate() {
        assert_eq!(retry["turnId"].as_str(), Some(turn.as_str()));
        assert_eq!(retry["attempt"], n + 1);
        assert!(retry["maxAttempts"].as_u64().is_some_and(|max| max >= 2));
        assert!(retry["delayMs"].is_u64());
    }
    assert!(
        retries[0]["errorMessage"]
            .as_str()
            .is_some_and(|m| m.contains("overloaded"))
    );
    let requests = env.requests("retry");
    assert_eq!(requests.len(), 3);
    let last = &requests[2];
    assert_eq!(
        roles(&last.body),
        ["user"],
        "only the prompt reaches the model"
    );
    assert!(!last.body.contains("overloaded") && !last.body.contains("rate limited"));
    assert_eq!(
        user_texts(&last.body),
        [prompt_text("Answer despite errors.", "retry")]
    );
    shutdown(core).await;
}

/// T14-A08: the Agent Host leaves notification 3 out of stdout (test hook); Core sees the gap,
/// fetches it with `session/getEntries`, and the client gets every notification once, in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_notification_is_backfilled_and_the_client_sees_every_one_in_order() {
    let env = Env::new("gap").await;
    let (core, events) = env.start(env.config(&["--test-drop-seq", "3"]));
    let id = open_session(&core, &env).await;
    let turn = prompt(&core, &id, &prompt_text("Say something.", "chat")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let delivered = events.on(&format!("session/{id}"));
    let seqs: Vec<u64> = delivered
        .iter()
        .filter_map(|v| v["params"]["seq"].as_u64())
        .collect();
    println!(
        "delivered: {:?}",
        delivered
            .iter()
            .map(|v| format!(
                "{}#{}",
                v["method"].as_str().unwrap_or_default(),
                v["params"]["seq"]
            ))
            .collect::<Vec<_>>()
    );
    let expected: Vec<u64> = (1..=u64::try_from(seqs.len()).expect("small")).collect();
    assert!(seqs.len() > 3);
    assert_eq!(seqs, expected, "every seq once, in order, 3 included");
    assert!(
        !delivered.iter().any(|v| v["method"] == "session/resync"),
        "the gap was filled, not skipped"
    );
    shutdown(core).await;
}

/// I19: measure a real delegated read following a burst on the same AHP connection.
/// Report the stat-to-next-read interval (including the stat round trip); scheduling and
/// host speed vary, so the assertion is completion and data delivery, not a fixed latency.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_completes_after_a_notification_burst() {
    use std::time::Instant;
    #[derive(Default)]
    struct Arrivals(Mutex<Vec<(String, Instant)>>);
    impl ToolIoObserver for Arrivals {
        fn before(&self, _: &str, method: &str, call: Option<&str>) -> BoxFuture<'static, ()> {
            if call == Some("read") && method.starts_with("fs/") {
                self.0
                    .lock()
                    .expect("timestamps")
                    .push((method.to_owned(), Instant::now()));
            }
            Box::pin(async {})
        }
    }
    let scenario = serde_json::json!({"id":"notify-burst","steps":[
        {"text":"a".repeat(2048),"chunk_chars":1,"tool_calls":[{"id":"read","name":"Read","input":{"path":"note.txt"}}]},
        {"text":"Done."}
    ]});
    let scenario = piarc_testkit::Scenario::from_json_str("notify-burst", &scenario.to_string())
        .expect("scenario");
    let env = Env::with_scenario("notify burst", Some(scenario)).await;
    std::fs::write(env.ws.join("note.txt"), "R2 burst fixture").expect("fixture");
    let arrivals = Arc::new(Arrivals::default());
    let mut config = env.config(&[]);
    config.tool_observer = Some(Arc::clone(&arrivals) as _);
    let (core, events) = env.start(config);
    let id = open_session(&core, &env).await;
    let started = Instant::now();
    let turn = prompt(&core, &id, &prompt_text("Read the note.", "notify-burst")).await;
    assert_eq!(
        events.turn_completed(&id, &turn).await["status"],
        "completed"
    );
    let deltas = events.of(&id, "item/agentMessage/delta").len();
    assert!(deltas > 0);
    assert!(
        env.requests("notify-burst")[1]
            .body
            .contains("R2 burst fixture")
    );
    {
        let times = arrivals.0.lock().expect("timestamps");
        let stat = times.iter().find(|(m, _)| m == "fs/stat").expect("stat").1;
        let read = times.iter().find(|(m, _)| m == "fs/read").expect("read").1;
        println!(
            "I19 wire deltas=2048 delivered deltas={deltas} prompt-to-stat={:?} stat-to-read={:?}",
            stat - started,
            read - stat
        );
    }
    shutdown(core).await;
}
