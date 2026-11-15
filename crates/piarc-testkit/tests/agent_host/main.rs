//! S3 and the process half of S9, end to end: the real bundled Agent Host (Pi SDK sessions)
//! under Core's supervisor, the strict mock provider as the model service. Run with
//! `--nocapture` to print the observations recorded in `docs/spikes/S03-multi-session.md`
//! and `docs/spikes/S09-ahp-resilience.md`.

mod harness;

use harness::{Env, assert_contiguous_seq, notification, open, payload, ping, prompt_text};
use piarc_core::agent_host::{CallState, ExitReason, HostEvent};
use piarc_protocol::session::SessionId;
use piarc_protocol::turn::TurnId;
use piarc_testkit::Outcome;
use serde_json::json;

const FILES_A: &str = r#"
id: files-a
steps:
  - text: "Writing the note."
    tool_calls: [{ name: write, input: { path: "notes/note.txt", content: "written by session A" } }]
  - tool_calls: [{ name: edit, input: { path: "notes/note.txt", edits: [{ oldText: "session A", newText: "session A, edited" }] } }]
  - tool_calls: [{ name: read, input: { path: "notes/note.txt" } }]
  - text: "Done in A."
"#;

const FILES_B: &str = r#"
id: files-b
steps:
  - text: "Writing the note."
    tool_calls: [{ name: write, input: { path: "notes/note.txt", content: "written by session B" } }]
  - tool_calls: [{ name: edit, input: { path: "notes/note.txt", edits: [{ oldText: "session B", newText: "session B, edited" }] } }]
  - tool_calls: [{ name: read, input: { path: "notes/note.txt" } }]
  - text: "Done in B."
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_sessions_run_tool_calls_concurrently_and_only_touch_their_own_workspace() {
    let env = Env::new("files", &[FILES_A, FILES_B], json!({})).await;
    let (supervisor, mut events, trust) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-large").await;
    let rss_one = ping(&supervisor).await.rss_bytes;
    let b = open(&supervisor, &env.cwd(1), "mock-large").await;
    let rss_two = ping(&supervisor).await.rss_bytes;

    let (text_a, text_b) = (
        prompt_text("Write a note.", "files-a"),
        prompt_text("Write a note.", "files-b"),
    );
    let (ta, tb) = tokio::join!(
        supervisor.prompt(&a, "req-a", &text_a),
        supervisor.prompt(&b, "req-b", &text_b)
    );
    let (ta, tb) = (
        ta.expect("A accepted").turn_id,
        tb.expect("B accepted").turn_id,
    );
    let done_a = events.turn_completed(&ta.0).await;
    let done_b = events.turn_completed(&tb.0).await;
    assert_eq!(
        (done_a["status"].as_str(), done_b["status"].as_str()),
        (Some("completed"), Some("completed"))
    );

    check_own_notes(&env, &events, &a, &b);
    check_overlap(&events, &a);
    let (na, nb) = (
        assert_contiguous_seq(&events, &a.0),
        assert_contiguous_seq(&events, &b.0),
    );
    println!(
        "seq 1..={na} for A, 1..={nb} for B; RSS with one session {rss_one} bytes, with two {rss_two} bytes"
    );
    assert_eq!(*trust.asked.lock().expect("lock"), [env.cwd(0), env.cwd(1)]);
    supervisor.shutdown().await;
}

/// (tool, status, output) of every tool call of a session.
fn harness_tools(events: &harness::Recorder, session: &str) -> Vec<(String, String, String)> {
    events
        .tool_results(session)
        .into_iter()
        .map(|item| {
            let field = |name: &str| item[name].as_str().unwrap_or_default().to_owned();
            (field("tool"), field("status"), field("output"))
        })
        .collect()
}

const STALL_A: &str = r#"
id: stall-a
# Pi 1.5.2 drops the interrupted assistant message from the next request, which then holds two
# consecutive user messages. The Anthropic API merges them; the mock's strict alternation rule
# would reject the request (PLAN.md I18).
validation:
  rules: { role_order: false }
steps:
  - text: "Still thinking about the answer"
    stall_after_events: 4
  - text: "Answered after the interruption."
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupting_one_session_leaves_the_other_running_to_completion() {
    let env = Env::new("abort", &[STALL_A, FILES_B], json!({})).await;
    let (supervisor, mut events, _) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-large").await;
    let b = open(&supervisor, &env.cwd(1), "mock-large").await;
    let ta = supervisor
        .prompt(&a, "req-a", &prompt_text("Think.", "stall-a"))
        .await
        .expect("A accepted")
        .turn_id;
    // A's model stream stops after its first text delta and stays open.
    events
        .until(|e| {
            notification(e).is_some_and(|n| {
                n.method == "item/agentMessage/delta" && n.params.header.session_id == a
            })
        })
        .await;
    let tb = supervisor
        .prompt(&b, "req-b", &prompt_text("Write a note.", "files-b"))
        .await
        .expect("B accepted")
        .turn_id;
    events
        .until(|e| {
            notification(e)
                .is_some_and(|n| n.method == "turn/started" && n.params.header.session_id == b)
        })
        .await;

    let stopped = supervisor.abort(&a).await.expect("abort answered");
    assert_eq!(stopped.interrupted_turn_id.as_ref(), Some(&ta));
    let done_a = events.turn_completed(&ta.0).await;
    assert_eq!(done_a["status"], "interrupted");
    let done_b = events.turn_completed(&tb.0).await;
    assert_eq!(done_b["status"], "completed");
    assert_eq!(
        std::fs::read_to_string(env.ws[1].join("notes").join("note.txt"))
            .expect("B wrote its note"),
        "written by session B, edited"
    );
    check_only_a_was_interrupted(&events, &a);

    // The interrupted session is still usable.
    let again = supervisor
        .prompt(&a, "req-a2", &prompt_text("Go on.", "stall-a"))
        .await
        .expect("accepted")
        .turn_id;
    let again_done = events.turn_completed(&again.0).await;
    assert_eq!(again_done["status"], "completed", "{again_done}");
    assert_eq!(
        env.requests("stall-a")
            .iter()
            .map(|r| r.outcome)
            .collect::<Vec<_>>(),
        [Outcome::Stalled, Outcome::Streamed]
    );
    assert_contiguous_seq(&events, &a.0);
    assert_contiguous_seq(&events, &b.0);
    supervisor.shutdown().await;
}

const COMPACT_A: &str = r#"
id: small-window
steps:
  - text: "A long answer that fills the small context window."
    usage: { input_tokens: 20000, output_tokens: 500 }
  - text: "Summary: the user asked for a long answer and got one."
  - text: "Answer after the compaction."
"#;

const HISTORY_B: &str = r#"
id: history-b
steps:
  - text: "B first answer."
  - text: "B second answer."
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compacting_one_session_leaves_the_history_of_the_other_untouched() {
    let env = Env::new(
        "compact",
        &[COMPACT_A, HISTORY_B],
        json!({ "compaction": { "keepRecentTokens": 1 } }),
    )
    .await;
    let (supervisor, mut events, _) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-small").await;
    let b = open(&supervisor, &env.cwd(1), "mock-large").await;

    let b1 = supervisor
        .prompt(&b, "b1", &prompt_text("B question one.", "history-b"))
        .await
        .expect("accepted")
        .turn_id;
    let a1 = supervisor
        .prompt(&a, "a1", "A question one.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&b1.0).await["status"], "completed");
    assert_eq!(events.turn_completed(&a1.0).await["status"], "completed");
    let compactions = |id: &str| {
        env.session_entries(id)
            .iter()
            .filter(|e| e["type"] == "compaction")
            .count()
    };
    assert_eq!(
        compactions(&a.0),
        1,
        "A crossed the threshold of its 32k window and compacted"
    );
    assert_eq!(compactions(&b.0), 0);

    let a2 = supervisor
        .prompt(&a, "a2", "A question two.")
        .await
        .expect("accepted")
        .turn_id;
    let b2 = supervisor
        .prompt(&b, "b2", "B question two.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&a2.0).await["status"], "completed");
    assert_eq!(events.turn_completed(&b2.0).await["status"], "completed");

    check_compacted_requests(&env);
    check_b_history_untouched(&env, &b);
    supervisor.shutdown().await;
}

const MCP_A: &str = r#"
id: mcp-a
steps:
  - tool_calls: [{ name: mcp__alpha__echo, input: { text: "hi from A" } }]
  - text: "A heard back."
"#;

const MCP_B: &str = r#"
id: mcp-b
steps:
  - tool_calls: [{ name: mcp__beta__echo, input: { text: "hi from B" } }]
  - text: "B heard back."
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_session_gets_only_the_mcp_servers_of_its_own_project() {
    let env = Env::new("mcp", &[MCP_A, MCP_B], json!({})).await;
    for (ws, server) in [(&env.ws[0], "alpha"), (&env.ws[1], "beta")] {
        let config = json!({ "mcpServers": { server: {
            "command": harness::node(), "args": [harness::mcp_fixture(), server], "exposure": "direct"
        }}});
        std::fs::create_dir_all(ws.join(".pi")).expect(".pi created");
        std::fs::write(ws.join(".pi").join("mcp.json"), config.to_string())
            .expect("mcp.json written");
    }
    let (supervisor, mut events, _) = env.start(&[env.ws[0].as_path(), env.ws[1].as_path()]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-large").await;
    let b = open(&supervisor, &env.cwd(1), "mock-large").await;
    let ta = supervisor
        .prompt(&a, "a", &prompt_text("Call alpha.", "mcp-a"))
        .await
        .expect("accepted")
        .turn_id;
    let tb = supervisor
        .prompt(&b, "b", &prompt_text("Call beta.", "mcp-b"))
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&ta.0).await["status"], "completed");
    assert_eq!(events.turn_completed(&tb.0).await["status"], "completed");

    for (session, server, cwd, selector) in [
        (&a, "alpha", env.cwd(0), "mcp-a"),
        (&b, "beta", env.cwd(1), "mcp-b"),
    ] {
        let results = harness_tools(&events, &session.0);
        println!("{server}: {results:?}");
        assert_eq!(results.len(), 1);
        assert_eq!(
            (results[0].0.as_str(), results[0].1.as_str()),
            (format!("mcp__{server}__echo").as_str(), "completed")
        );
        assert!(
            results[0].2.starts_with(&format!("{server} echoes")),
            "{}",
            results[0].2
        );
        assert!(
            results[0].2.contains(&cwd),
            "the server runs in the session's cwd: {}",
            results[0].2
        );
        let first = &env.requests(selector)[0].body;
        let other = if server == "alpha" {
            "mcp__beta__echo"
        } else {
            "mcp__alpha__echo"
        };
        assert!(
            first.contains(&format!("mcp__{server}__echo")) && !first.contains(other),
            "tools offered to {server}'s session"
        );
    }
    supervisor.shutdown().await;
}

const KILL_A: &str = r#"
id: kill-a
# Pi 1.5.2 drops the interrupted assistant message from the next request, which then holds two
# consecutive user messages. The Anthropic API merges them; the mock's strict alternation rule
# would reject the request (PLAN.md I18).
validation:
  rules: { role_order: false }
steps:
  - text: "Working on it"
    stall_after_events: 4
  - text: "Back after the restart."
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killing_the_agent_host_mid_prompt_restarts_it_and_restores_the_session() {
    let env = Env::new("kill", &[KILL_A], json!({})).await;
    let (supervisor, mut events, _) = env.start(&[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { epoch: 1, .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-large").await;
    let turn = supervisor
        .prompt(&a, "req-1", &prompt_text("Work.", "kill-a"))
        .await
        .expect("accepted")
        .turn_id;
    events
        .until(|e| notification(e).is_some_and(|n| n.method == "item/agentMessage/delta"))
        .await;
    let in_flight: Vec<_> = supervisor
        .calls()
        .into_iter()
        .map(|c| (c.method, c.state, c.turn_id))
        .collect();
    println!("in flight before the kill: {in_flight:?}");
    assert_eq!(
        in_flight,
        [(
            "session/prompt".to_owned(),
            CallState::Acknowledged,
            Some(turn.0.clone())
        )]
    );

    supervisor.kill().await;
    check_restart(&mut events, &turn, &a).await;

    let after = supervisor
        .prompt(&a, "req-2", "Continue.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&after.0).await["status"], "completed");
    let requests = env.requests("kill-a");
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1].body.contains("Work."),
        "the restored session still has the first prompt"
    );
    let count = assert_contiguous_seq(&events, &a.0);
    println!("seq 1..={count} across both connections");
    supervisor.shutdown().await;
}

/// One step with 100 parallel `write` calls of 4 KiB each: about 800 KiB of notifications,
/// more than the pipe and Core's reader buffer absorb, while the history (about 100k tokens)
/// stays below the compaction threshold of the 200k window.
fn flood_scenario() -> String {
    let content = "x".repeat(4096);
    let calls: Vec<String> = (0..100)
        .map(|i| {
            format!(
                r#"{{ name: write, input: {{ path: "flood/{i}.txt", content: "{content}" }} }}"#
            )
        })
        .collect();
    format!(
        "id: flood\nsteps:\n  - tool_calls: [{}]\n  - text: \"Wrote them all.\"\n",
        calls.join(", ")
    )
}

fn files_in(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).map_or(0, Iterator::count)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_core_reader_makes_the_agent_host_queue_with_bounded_memory() {
    let scenario = flood_scenario();
    let env = Env::new("backpressure", &[&scenario], json!({})).await;
    let mut config = env.config();
    config.event_queue = 1;
    config.heartbeat_interval = std::time::Duration::from_millis(50);
    config.heartbeat_timeout = std::time::Duration::from_millis(50);
    let (supervisor, mut events, _) = env.start_with(config, &[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let a = open(&supervisor, &env.cwd(0), "mock-large").await;
    let baseline = ping(&supervisor).await;
    let turn = supervisor
        .prompt(&a, "req", &prompt_text("Write the files.", "flood"))
        .await
        .expect("accepted")
        .turn_id;

    // Core takes no events until Pi finished the turn: both model requests answered and every
    // file written. Waiting polls those two conditions.
    let deadline = std::time::Instant::now() + harness::WAIT;
    while env.requests("flood").len() < 2 || files_in(&env.ws[0].join("flood")) < 100 {
        assert!(
            std::time::Instant::now() < deadline,
            "the turn did not finish while Core was stalled: {} model requests, {} files",
            env.requests("flood").len(),
            files_in(&env.ws[0].join("flood"))
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let done = events.turn_completed(&turn.0).await;
    assert_eq!(done["status"], "completed", "{done}");
    let after = ping(&supervisor).await;
    let items = events.tool_results(&a.0);
    assert_eq!(items.len(), 100);
    assert!(items.iter().all(|item| item["status"] == "completed"));
    let count = assert_contiguous_seq(&events, &a.0);
    assert!(
        !events
            .all
            .iter()
            .any(|e| matches!(e, HostEvent::Exited { .. })),
        "the backpressured host was not killed"
    );
    let produced: usize = events
        .notifications(&a.0)
        .iter()
        .map(|n| serde_json::to_vec(n).map_or(0, |bytes| bytes.len()))
        .sum();
    println!(
        "{count} notifications, {produced} bytes, Core event queue 1; \
         Agent Host outbound peak {} bytes (before the turn {}); RSS {} -> {} bytes",
        after.outbound_peak_bytes,
        baseline.outbound_peak_bytes,
        baseline.rss_bytes,
        after.rss_bytes
    );
    assert!(
        after.outbound_peak_bytes > 64 * 1024,
        "stdout pushed back and the Agent Host queued"
    );
    let peak = usize::try_from(after.outbound_peak_bytes).expect("fits");
    assert!(
        peak < produced,
        "the queue held part of the turn's events, never more than it produced"
    );
    assert_eq!(
        (after.outbound_queued_frames, after.outbound_queued_bytes),
        (0, 0)
    );
    supervisor.shutdown().await;
}

/// Each session's note holds its own text, and each read result shows only its own workspace.
fn check_own_notes(env: &Env, events: &harness::Recorder, a: &SessionId, b: &SessionId) {
    let note = |i: usize| {
        std::fs::read_to_string(env.ws[i].join("notes").join("note.txt")).expect("note exists")
    };
    assert_eq!(note(0), "written by session A, edited");
    assert_eq!(note(1), "written by session B, edited");
    for (session, own, other) in [(a, "session A", "session B"), (b, "session B", "session A")] {
        let results = harness_tools(events, &session.0);
        assert_eq!(
            results.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
            ["write", "edit", "read"]
        );
        assert!(results.iter().all(|r| r.1 == "completed"), "{results:?}");
        let read = &results[2].2;
        assert!(
            read.contains(&format!("written by {own}, edited")) && !read.contains(other),
            "{read}"
        );
    }
}

/// Both turns were running at the same time.
fn check_overlap(events: &harness::Recorder, a: &SessionId) {
    let order = events.labelled(a, |method| {
        method.starts_with("turn/") || method == "item/completed"
    });
    println!("interleaving: {}", order.join(" "));
    let position = |label: &str| {
        order
            .iter()
            .position(|o| o.starts_with(label))
            .expect(label)
    };
    assert!(
        position("B:turn/started") < position("A:turn/completed"),
        "B ran while A was running"
    );
    assert!(
        position("A:turn/started") < position("B:turn/completed"),
        "A ran while B was running"
    );
}

fn check_only_a_was_interrupted(events: &harness::Recorder, a: &SessionId) {
    let a_items: Vec<String> = events
        .notifications(&a.0)
        .iter()
        .filter(|n| n.method == "item/completed")
        .map(|n| {
            payload(n)["item"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    assert_eq!(a_items, ["interrupted"]);
    println!(
        "turns: {}",
        events
            .labelled(a, |method| method.starts_with("turn/"))
            .join(" ")
    );
}

/// A's requests: the answer, the summary request over A's history, then a request that starts
/// from the summary.
fn check_compacted_requests(env: &Env) {
    let a_bodies: Vec<String> = env
        .requests(harness::SMALL_WINDOW_SCENARIO)
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(a_bodies.len(), 3, "answer, summary, answer");
    assert!(
        a_bodies[1].contains("A question one."),
        "the summary request reads A's history"
    );
    assert!(
        a_bodies[2].contains("compacted into the following summary")
            && a_bodies[2].contains("Summary: the user asked")
    );
    assert!(
        !a_bodies[2].contains("A question one."),
        "A's first question now lives only in the summary"
    );
}

/// B's second request carries its whole history, B's file has no compaction, and nothing of A
/// reached B.
fn check_b_history_untouched(env: &Env, b: &SessionId) {
    let b_bodies: Vec<String> = env
        .requests("history-b")
        .into_iter()
        .map(|r| r.body)
        .collect();
    assert_eq!(b_bodies.len(), 2);
    for text in ["B question one.", "B first answer.", "B question two."] {
        assert!(
            b_bodies[1].contains(text),
            "B's second request lost {text:?}"
        );
    }
    assert!(
        !b_bodies
            .iter()
            .any(|body| body.contains("Summary:") || body.contains("A question")),
        "nothing of A reached B"
    );
    let entries = env.session_entries(&b.0);
    assert!(!entries.iter().any(|e| e["type"] == "compaction"));
    let roles: Vec<String> = entries
        .iter()
        .filter(|e| e["type"] == "message")
        .map(|e| e["message"]["role"].as_str().unwrap_or_default().to_owned())
        .collect();
    println!("B: entries {roles:?}; its second request keeps its whole history");
    // Pi records the system prompt as the first message entry.
    assert_eq!(roles, ["system", "user", "assistant", "user", "assistant"]);
}

/// After the kill: the exit, the uncertain prompt, a restart and the restored session.
async fn check_restart(events: &mut harness::Recorder, turn: &TurnId, a: &SessionId) {
    let exited = events
        .until(|e| matches!(e, HostEvent::Exited { .. }))
        .await;
    let uncertain = events
        .until(|e| matches!(e, HostEvent::Uncertain { .. }))
        .await;
    let restarting = events
        .until(|e| matches!(e, HostEvent::Restarting { .. }))
        .await;
    events
        .until(|e| matches!(e, HostEvent::Connected { epoch: 2, .. }))
        .await;
    let restored = events
        .until(|e| matches!(e, HostEvent::SessionRestored { .. }))
        .await;
    println!("{exited:?}\n{uncertain:?}\n{restarting:?}\n{restored:?}");
    assert!(matches!(
        exited,
        HostEvent::Exited {
            epoch: 1,
            reason: ExitReason::Killed,
            ..
        }
    ));
    let HostEvent::Uncertain { calls, .. } = uncertain else {
        unreachable!()
    };
    let states: Vec<_> = calls
        .iter()
        .map(|c| (c.method.as_str(), c.state, c.turn_id.as_deref()))
        .collect();
    assert_eq!(
        states,
        [(
            "session/prompt",
            CallState::Uncertain,
            Some(turn.0.as_str())
        )]
    );
    let HostEvent::SessionRestored {
        session_id,
        restored_messages,
        ..
    } = restored
    else {
        unreachable!()
    };
    assert_eq!(session_id, a.0);
    assert!(restored_messages >= 1, "the user's prompt was on disk");
}
