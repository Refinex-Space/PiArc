//! T14-A01: records the Pi event sequences the projection's golden tests replay
//! (`agent-host/src/runtime/projector.golden.test.ts`). The real Agent Host runs one session per
//! scenario with `--test-record-events`: every raw Pi event and every registry step (turn
//! accepted, abort, queued input) lands in `<dir>/<sessionId>.jsonl`.
//!
//! Normal runs check that each committed recording still has the event types Pi produces now
//! (a Pi upgrade that adds, drops or renames an event fails here). With `PIARC_UPDATE_GOLDEN=1`
//! the recordings in `agent-host/test/golden/` are rewritten; the projector's expected output is
//! then a Vitest file snapshot (`npx vitest run agent-host -u`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use piarc_core::agent_host::HostEvent;
use piarc_protocol::session::{SessionFollowUp, SessionId, SessionInputParams, SessionSteer};
use serde_json::{Value, json};

use crate::harness::{self, Env, open, prompt_text};

const TOOLS: &str = r#"
id: golden-tools
steps:
  - text: "Working on the files."
    tool_calls:
      - { id: toolu_write, name: Write, input: { path: "notes/a b.txt", content: "first line\n" } }
      - { id: toolu_read, name: Read, input: { path: "notes/a b.txt" } }
      - { id: toolu_edit, name: Edit, input: { path: "notes/a b.txt", edits: [{ oldText: "first", newText: "1st" }] } }
      - { id: toolu_glob, name: Glob, input: { pattern: "**/*.txt" } }
      - { id: toolu_bash, name: Bash, input: { command: "echo 中文 output" } }
      - { id: toolu_grep, name: Grep, input: { pattern: "no-such-text-anywhere" } }
      - { id: toolu_missing, name: Read, input: { path: "missing.txt" } }
  - text: "Done."
"#;

const UNKNOWN_TOOLS: &str = r#"
id: golden-unknown-tools
steps:
  - tool_calls:
      - { id: toolu_agent, name: Agent, input: { description: "Find usages", prompt: "Find them." } }
      - { id: toolu_fetch, name: WebFetch, input: { url: "https://example.com/", prompt: "Summarize." } }
      - { id: toolu_mcp, name: mcp__echo__say, input: { text: "hi" } }
  - text: "Those tools are not available here."
"#;

const RETRY: &str = r#"
id: golden-retry
steps:
  - error: { kind: overloaded }
  - error: { kind: rate_limit, retry_after_secs: 1 }
  - text: "Recovered after two retries."
"#;

/// The steering message follows the tool results as a second user message (Pi 1.5.2): the
/// Anthropic API combines consecutive user turns, the mock's strict alternation does not.
const STEER: &str = r#"
id: golden-steer
validation:
  rules: { role_order: false }
steps:
  - text: "Waiting for the signal."
    tool_calls: [{ id: toolu_wait, name: Bash, input: { command: "while [ ! -f go ]; do sleep 0.05; done; echo go" } }]
  - text: "Got the steering message."
  - text: "Follow-up answered."
"#;

const ABORT_TOOLS: &str = r#"
id: golden-abort-tools
steps:
  - tool_calls:
      - { id: toolu_hang, name: Bash, input: { command: "sleep 30" } }
      - { id: toolu_after, name: Read, input: { path: "notes/x.txt" } }
  - text: "Answered after the interruption."
"#;

const ABORT_TEXT: &str = r#"
id: golden-abort-text
steps:
  - text: "Still thinking about the answer"
    stall_after_events: 4
  - text: "Answered after the interruption."
"#;

const COMPACTION: &str = r#"
id: small-window
steps:
  - text: "A long answer that fills the small context window."
    usage: { input_tokens: 20000, output_tokens: 500 }
  - text: "Summary: the user asked for a long answer and got one."
"#;

fn golden_dir() -> PathBuf {
    harness::repo_root()
        .join("agent-host")
        .join("test")
        .join("golden")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_golden_recordings_match_what_pi_produces_now() {
    let env = Env::new(
        "golden",
        &[
            TOOLS,
            UNKNOWN_TOOLS,
            RETRY,
            STEER,
            ABORT_TOOLS,
            ABORT_TEXT,
            COMPACTION,
        ],
        json!({ "compaction": { "keepRecentTokens": 1 }, "retry": { "baseDelayMs": 5 } }),
    )
    .await;
    let recordings = env.root.join("recordings");
    let mut config = env.config();
    config
        .extra_args
        .extend(["--test-record-events".into(), recordings.clone().into()]);
    let (supervisor, mut events, core) = env.start_with(config, &[]);
    events
        .until(|e| matches!(e, HostEvent::Connected { .. }))
        .await;
    let ws = env.cwd(0);
    std::fs::create_dir_all(env.ws[0].join("notes")).expect("notes");
    std::fs::write(env.ws[0].join("notes").join("x.txt"), "x\n").expect("x");
    let mut sessions: BTreeMap<String, SessionId> = BTreeMap::new();

    for (name, selector, prompt) in [
        ("tools", "golden-tools", "Edit the notes."),
        (
            "unknown-tools",
            "golden-unknown-tools",
            "Use the other tools.",
        ),
        ("retry", "golden-retry", "Answer despite errors."),
    ] {
        let id = open(&supervisor, &core, &ws, "mock-large").await;
        let turn = supervisor
            .prompt(&id, name, &prompt_text(prompt, selector))
            .await
            .expect("accepted")
            .turn_id;
        events.turn_completed(&turn.0).await;
        sessions.insert(name.into(), id);
    }

    let steer = steer_and_follow_up(&env, &supervisor, &core, &mut events).await;
    sessions.insert("steer".into(), steer);
    for (name, selector, item) in [
        ("abort-tools", "golden-abort-tools", Some("toolu_hang")),
        ("abort-text", "golden-abort-text", None),
    ] {
        let id = abort_then_continue(&env, &supervisor, &core, &mut events, selector, item).await;
        sessions.insert(name.into(), id);
    }
    let compacted = open(&supervisor, &core, &ws, "mock-small").await;
    let turn = supervisor
        .prompt(&compacted, "c1", "A question that fills the window.")
        .await
        .expect("accepted")
        .turn_id;
    events.turn_completed(&turn.0).await;
    sessions.insert("compaction".into(), compacted);
    supervisor.shutdown().await;

    check_recordings(&recordings, &sessions);
}

/// Compares (or, with `PIARC_UPDATE_GOLDEN=1`, rewrites) the committed recordings.
fn check_recordings(recordings: &Path, sessions: &BTreeMap<String, SessionId>) {
    for (name, id) in sessions {
        let recorded = read_recording(&recordings.join(format!("{}.jsonl", id.0)));
        let fixture = golden_dir().join(format!("{name}.events.json"));
        if std::env::var_os("PIARC_UPDATE_GOLDEN").is_some() {
            write_fixture(&fixture, name, &recorded);
            continue;
        }
        let committed: Value = serde_json::from_str(
            &std::fs::read_to_string(&fixture)
                .unwrap_or_else(|e| panic!("{}: {e}", fixture.display())),
        )
        .expect("fixture is JSON");
        let committed = committed["steps"].as_array().cloned().unwrap_or_default();
        assert_eq!(
            kinds(&recorded),
            kinds(&committed),
            "{name}: Pi's events changed; rerun with PIARC_UPDATE_GOLDEN=1 and review the \
             projection snapshots"
        );
    }
}

/// A turn whose tool waits for a file: a steering message and a follow-up arrive while it runs.
async fn steer_and_follow_up(
    env: &Env,
    supervisor: &piarc_core::agent_host::HostSupervisor,
    core: &harness::Core,
    events: &mut harness::Recorder,
) -> SessionId {
    let ws = env.cwd(0);
    let id = open(supervisor, core, &ws, "mock-large").await;
    let turn = supervisor
        .prompt(
            &id,
            "steer",
            &prompt_text("Wait for the signal.", "golden-steer"),
        )
        .await
        .expect("accepted")
        .turn_id;
    started(events, "toolu_wait").await;
    let input = |request_id: &str, text: &str| SessionInputParams {
        session_id: id.clone(),
        request_id: request_id.into(),
        text: text.into(),
        mentions: Vec::new(),
        attachments: Vec::new(),
    };
    supervisor
        .session_call::<SessionSteer>(&id, Some("s1"), input("s1", "Also mention the signal."))
        .await
        .expect("steered");
    supervisor
        .session_call::<SessionFollowUp>(&id, Some("f1"), input("f1", "Then say goodbye."))
        .await
        .expect("queued");
    std::fs::write(env.ws[0].join("go"), "").expect("signal");
    events.turn_completed(&turn.0).await;
    // The follow-up runs as its own turn.
    events
        .until(|e| {
            harness::notification(e).is_some_and(|n| {
                n.method == "turn/completed"
                    && n.params.header.session_id == id
                    && harness::payload(n)["turnId"] != turn.0
            })
        })
        .await;
    std::fs::remove_file(env.ws[0].join("go")).expect("signal removed");
    id
}

/// A turn interrupted while `item` runs (or while the reply streams), then a second prompt whose
/// request must pass every validation rule, `tool_pairing` and `role_order` included.
async fn abort_then_continue(
    env: &Env,
    supervisor: &piarc_core::agent_host::HostSupervisor,
    core: &harness::Core,
    events: &mut harness::Recorder,
    selector: &str,
    item: Option<&str>,
) -> SessionId {
    let id = open(supervisor, core, &env.cwd(0), "mock-large").await;
    let turn = supervisor
        .prompt(&id, "a1", &prompt_text("Start something long.", selector))
        .await
        .expect("accepted")
        .turn_id;
    match item {
        Some(item) => started(events, item).await,
        None => {
            events
                .until(|e| {
                    harness::notification(e).is_some_and(|n| {
                        n.method == "item/agentMessage/delta" && n.params.header.session_id == id
                    })
                })
                .await;
        }
    }
    supervisor.abort(&id).await.expect("aborted");
    assert_eq!(
        events.turn_completed(&turn.0).await["status"],
        "interrupted"
    );
    let next = supervisor
        .prompt(&id, "a2", "Continue.")
        .await
        .expect("accepted")
        .turn_id;
    assert_eq!(events.turn_completed(&next.0).await["status"], "completed");
    let rejected: Vec<_> = env
        .requests(selector)
        .into_iter()
        .filter(|r| !r.violations.is_empty())
        .collect();
    assert!(rejected.is_empty(), "{selector}: {rejected:#?}");
    id
}

async fn started(events: &mut harness::Recorder, item: &str) {
    events
        .until(|e| {
            harness::notification(e).is_some_and(|n| {
                n.method == "item/started" && harness::payload(n)["item"]["itemId"] == item
            })
        })
        .await;
}

fn read_recording(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .map(|line| serde_json::from_str(line).expect("recorded JSON"))
        .collect()
}

/// The kinds of steps: `event:<type>` or `control:<name>`, as a set (counts and the order of
/// parallel tool events may vary between runs).
fn kinds(steps: &[Value]) -> BTreeSet<String> {
    steps
        .iter()
        .map(|step| match (step.get("type"), step.get("control")) {
            (Some(kind), _) => format!("event:{}", kind.as_str().unwrap_or_default()),
            (None, Some(control)) => format!("control:{}", control.as_str().unwrap_or_default()),
            _ => "unknown".to_owned(),
        })
        .collect()
}

fn write_fixture(path: &Path, name: &str, steps: &[Value]) {
    std::fs::create_dir_all(path.parent().expect("golden dir")).expect("golden dir");
    let fixture = json!({
        "description": format!("Recorded from the real Agent Host and Pi 1.5.2 ({name}); \
            regenerate with PIARC_UPDATE_GOLDEN=1 cargo test -p piarc-testkit --test agent_host golden"),
        "source": "recorded",
        "steps": steps,
    });
    let mut text = serde_json::to_string_pretty(&fixture).expect("serializes");
    text.push('\n');
    std::fs::write(path, text).expect("fixture written");
}
