//! S9: AHP handshake, framing faults, backpressure, crash restarts and call reconciliation,
//! injected through scripted fake Agent Hosts (`support`). Run with `--nocapture` to print the
//! observations recorded in `docs/spikes/S09-ahp-resilience.md`.

mod support;

use std::sync::Arc;
use std::time::Duration;

use piarc_host::{
    CallState, Error, ExitReason, HostEvent, HostEvents, HostSupervisor, SupervisorState,
};
use piarc_protocol::session::{SessionCreateParams, SessionId, SessionStopped};
use piarc_protocol::{Capability, ErrorKind};
use serde_json::json;
use support::{FakeSpawner, Script, TestClock, config, deps, script, until};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

fn caps(names: &[&str]) -> Vec<Capability> {
    names.iter().map(|n| Capability::new(*n)).collect()
}

#[tokio::test]
async fn handshake_exchanges_versions_and_enables_shared_capabilities() {
    let (welcome_tx, welcome_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        let welcome = host.hello("1.0", &["todo", "planMode"]).await;
        let _ = welcome_tx.send(welcome);
        host.until_stdin_closes().await;
        0
    })]);
    let mut config = config();
    config.capabilities = caps(&["planMode", "subagents"]);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    let (connected, _) = until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    let welcome = welcome_rx.await.expect("the fake host saw core/welcome");
    println!("host/hello  -> protocol 1.0, pi 1.5.2, capabilities [todo, planMode]");
    println!("core/welcome <- {welcome}");
    assert_eq!(
        welcome,
        json!({ "jsonrpc": "2.0", "id": 1, "result": {
            "protocol": "1.0", "enabled": ["planMode"], "workspace": "work space/项目", "connectionEpoch": 1
        }})
    );
    assert_eq!(
        connected,
        HostEvent::Connected {
            epoch: 1,
            pi_version: "1.5.2".into(),
            enabled: caps(&["planMode"]),
            pid: Some(1000)
        }
    );
    assert_eq!(supervisor.state(), SupervisorState::Connected { epoch: 1 });
    supervisor.shutdown().await;
}

#[tokio::test]
async fn refuses_a_different_major_version_with_a_readable_error_and_does_not_restart() {
    let (reply_tx, reply_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        let reply = host.hello("2.0", &[]).await;
        let _ = reply_tx.send(reply);
        3 // the Agent Host's exit code for a protocol mismatch
    })]);
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), TestClock::new()));
    let (rejected, _) = until(&mut events, |e| {
        matches!(e, HostEvent::HandshakeRejected { .. })
    })
    .await;
    let reply = reply_rx.await.expect("the fake host got an answer");
    println!("host/hello  -> protocol 2.0");
    println!("error       <- {reply}");
    assert_eq!(reply["error"]["data"]["kind"], "protocolVersionMismatch");
    assert_eq!(
        reply["error"]["data"]["details"],
        json!({ "local": "1.0", "remote": "2.0" })
    );
    let message = reply["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("local speaks 1.0, remote speaks 2.0"),
        "{message}"
    );
    let HostEvent::HandshakeRejected { error, .. } = rejected else {
        unreachable!()
    };
    assert_eq!(error.data.kind, ErrorKind::ProtocolVersionMismatch);
    let (_, before_stop) = until(&mut events, |e| matches!(e, HostEvent::Stopped)).await;
    assert!(before_stop.iter().any(|e| matches!(e,
        HostEvent::Exited { reason: ExitReason::HandshakeRejected, status: Some(s), .. } if s.code == Some(3))));
    assert!(
        !before_stop
            .iter()
            .any(|e| matches!(e, HostEvent::Restarting { .. }))
    );
    assert_eq!(spawner.spawned(), 1);
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
}

/// First run: opens `s1`, accepts prompt `req-1` as turn `t1`, starts the turn, then reads an
/// abort it never answers and hangs until killed.
fn turn_in_progress() -> Script {
    script(|mut host| async move {
        host.hello("1.0", &[]).await;
        host.accept_session("s1").await;
        let (id, params) = host.request("session/prompt").await;
        assert_eq!(params["requestId"], "req-1");
        host.respond(id, json!({ "turnId": "t1" })).await;
        host.notify("turn/started", "s1", 1, json!({ "turnId": "t1" }))
            .await;
        host.request("session/abort").await;
        std::future::pending::<i32>().await
    })
}

/// Second run: answers `session/resume`, reporting what Core sent.
fn resuming(seen: oneshot::Sender<serde_json::Value>) -> Script {
    script(|mut host| async move {
        host.hello("1.0", &[]).await;
        let (id, params) = host.request("session/resume").await;
        let _ = seen.send(params);
        host.respond(id, json!({ "sessionId": "s1", "restoredMessages": 4 }))
            .await;
        host.until_stdin_closes().await;
        0
    })
}

/// Opens a session, starts a turn and sends an abort that stays unanswered.
async fn turn_with_pending_abort(
    supervisor: &HostSupervisor,
    events: &mut HostEvents,
) -> JoinHandle<piarc_host::Result<SessionStopped>> {
    until(events, |e| {
        matches!(e, HostEvent::Connected { epoch: 1, .. })
    })
    .await;
    let session = supervisor
        .create_session(SessionCreateParams::new("work space/项目"))
        .await
        .expect("session opens")
        .session_id;
    let accepted = supervisor
        .prompt(&session, "req-1", "hello")
        .await
        .expect("prompt is accepted");
    assert_eq!(accepted.turn_id.0, "t1");
    until(events, |e| matches!(e, HostEvent::Notification { notification, .. } if notification.method == "turn/started")).await;
    let abort = {
        let supervisor = supervisor.clone();
        tokio::spawn(async move { supervisor.abort(&session).await })
    };
    while supervisor.calls().len() < 2 {
        tokio::task::yield_now().await;
    }
    let in_flight: Vec<(String, CallState)> = supervisor
        .calls()
        .into_iter()
        .map(|c| (c.method, c.state))
        .collect();
    println!("in flight before the kill: {in_flight:?}");
    assert_eq!(
        in_flight,
        [
            ("session/prompt".into(), CallState::Acknowledged),
            ("session/abort".into(), CallState::Sent)
        ]
    );
    abort
}

#[tokio::test]
async fn killing_the_host_mid_prompt_marks_open_calls_uncertain_restarts_it_and_restores_the_session()
 {
    let (resume_tx, resume_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![turn_in_progress(), resuming(resume_tx)]);
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), TestClock::new()));
    let abort = turn_with_pending_abort(&supervisor, &mut events).await;

    supervisor.kill().await;
    let (uncertain, seen) = until(&mut events, |e| matches!(e, HostEvent::Uncertain { .. })).await;
    assert!(seen.iter().any(|e| matches!(
        e,
        HostEvent::Exited {
            epoch: 1,
            reason: ExitReason::Killed,
            ..
        }
    )));
    let HostEvent::Uncertain { epoch: 1, calls } = uncertain else {
        panic!("{uncertain:?}")
    };
    println!("uncertain after the kill: {calls:#?}");
    let states: Vec<_> = calls
        .iter()
        .map(|c| (c.method.as_str(), c.state, c.turn_id.as_deref()))
        .collect();
    assert_eq!(
        states,
        [
            ("session/prompt", CallState::Uncertain, Some("t1")),
            ("session/abort", CallState::Uncertain, None)
        ]
    );
    assert_eq!(calls[0].request_key.as_deref(), Some("req-1"));
    let abort = abort
        .await
        .expect("abort task joins")
        .expect_err("the abort never got an answer");
    assert!(
        matches!(abort, Error::Uncertain { .. }) && !abort.retryable(),
        "{abort:?}"
    );

    let (restarting, _) = until(&mut events, |e| matches!(e, HostEvent::Restarting { .. })).await;
    assert_eq!(
        restarting,
        HostEvent::Restarting {
            attempt: 1,
            delay: Duration::from_secs(1)
        }
    );
    until(&mut events, |e| {
        matches!(e, HostEvent::Connected { epoch: 2, .. })
    })
    .await;
    let (restored, _) = until(&mut events, |e| {
        matches!(e, HostEvent::SessionRestored { .. })
    })
    .await;
    assert_eq!(
        restored,
        HostEvent::SessionRestored {
            epoch: 2,
            session_id: "s1".into(),
            restored_messages: 4
        }
    );
    assert_eq!(
        resume_rx.await.expect("resume seen"),
        json!({ "sessionId": "s1", "cwd": "work space/项目", "lastSeq": 1 })
    );
    assert!(
        supervisor.calls().is_empty(),
        "nothing is replayed: {:?}",
        supervisor.calls()
    );
    assert_eq!(spawner.spawned(), 2);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_half_frame_followed_by_silence_is_treated_as_hung_and_core_keeps_running() {
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.send_raw(br#"{"jsonrpc":"2.0","method":"turn/started","params":{"sessi"#)
                .await;
            std::future::pending::<i32>().await
        }),
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.accept_session("after-restart").await;
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let mut config = config();
    config.heartbeat_interval = Duration::from_millis(20);
    config.heartbeat_timeout = Duration::from_millis(20);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    let (exited, _) = until(&mut events, |e| matches!(e, HostEvent::Exited { .. })).await;
    println!("after a half frame: {exited:?}");
    assert!(matches!(
        exited,
        HostEvent::Exited {
            epoch: 1,
            reason: ExitReason::Hung,
            ..
        }
    ));
    until(&mut events, |e| {
        matches!(e, HostEvent::Connected { epoch: 2, .. })
    })
    .await;
    let opened = supervisor
        .create_session(SessionCreateParams::new("w"))
        .await
        .expect("Core still serves calls");
    assert_eq!(opened.session_id.0, "after-restart");
    supervisor.shutdown().await;
}

/// T36: `mcp/statusChanged` is the Agent Host's own state, without a session header; it
/// reaches Core as a host notification. Other notifications still need one.
#[tokio::test]
async fn the_pools_status_arrives_as_a_host_notification() {
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        host.send_raw(
            b"{\"jsonrpc\":\"2.0\",\"method\":\"mcp/statusChanged\",\"params\":{\"servers\":[]}}\n",
        )
        .await;
        host.until_stdin_closes().await;
        0
    })]);
    let (supervisor, mut events) = HostSupervisor::start(config(), deps(spawner, TestClock::new()));
    let (event, seen) = until(&mut events, |e| {
        matches!(e, HostEvent::HostNotification { .. })
    })
    .await;
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, HostEvent::FrameError { .. })),
        "{seen:?}"
    );
    let HostEvent::HostNotification { method, params, .. } = event else {
        unreachable!("matched above");
    };
    assert_eq!(method, "mcp/statusChanged");
    assert_eq!(params.get("servers"), Some(&json!([])));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn invalid_json_oversized_frames_and_batches_are_dropped_without_ending_the_connection() {
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        host.send_raw(b"{not json}\n").await;
        let mut oversized = vec![b' '; 2048];
        oversized.extend_from_slice(b"{}\n");
        host.send_raw(&oversized).await;
        host.send_raw(b"[{\"jsonrpc\":\"2.0\",\"method\":\"turn/started\"}]\n")
            .await;
        host.send_raw(b"{\"jsonrpc\":\"2.0\",\"method\":\"turn/started\",\"params\":{}}\n")
            .await;
        host.notify("turn/started", "s1", 1, json!({ "turnId": "t1" }))
            .await;
        host.accept_session("still-alive").await;
        host.until_stdin_closes().await;
        0
    })]);
    let mut config = config();
    config.max_frame_bytes = 1024;
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    let (_, seen) = until(&mut events, |e| matches!(e, HostEvent::Notification { .. })).await;
    let errors: Vec<ErrorKind> = seen
        .iter()
        .filter_map(|e| match e {
            HostEvent::FrameError { error, .. } => Some(error.data.kind),
            _ => None,
        })
        .collect();
    println!("frame errors before the valid notification: {errors:?}");
    assert_eq!(
        errors,
        [
            ErrorKind::ParseError,
            ErrorKind::FrameTooLarge,
            ErrorKind::InvalidRequest,
            ErrorKind::InvalidRequest
        ]
    );
    assert!(!seen.iter().any(|e| matches!(e, HostEvent::Exited { .. })));
    assert_eq!(
        supervisor
            .create_session(SessionCreateParams::new("w"))
            .await
            .expect("connection continues")
            .session_id
            .0,
        "still-alive"
    );
    assert_eq!(supervisor.state(), SupervisorState::Connected { epoch: 1 });
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_slow_event_consumer_pushes_back_on_the_host_without_buffering_or_killing_it() {
    const NOTIFICATIONS: u64 = 5_000;
    let (progress_tx, mut progress_rx) = tokio::sync::watch::channel(0_u64);
    let spawner = FakeSpawner::with_pipe_bytes(
        vec![script(move |mut host| async move {
            host.hello("1.0", &[]).await;
            for seq in 1..=NOTIFICATIONS {
                host.notify(
                    "item/agentMessage/delta",
                    "s1",
                    seq,
                    json!({ "turnId": "t", "itemId": "m#0", "delta": "0123456789" }),
                )
                .await;
                let _ = progress_tx.send(seq);
            }
            host.until_stdin_closes().await;
            0
        })],
        4 * 1024,
    );
    let mut config = config();
    config.event_queue = 8;
    config.heartbeat_interval = Duration::from_millis(10);
    config.heartbeat_timeout = Duration::from_millis(10);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    // Do not read events: the host must stall, not Core's memory grow.
    let stalled_at = loop {
        let before = *progress_rx.borrow_and_update();
        if tokio::time::timeout(Duration::from_millis(300), progress_rx.changed())
            .await
            .is_err()
        {
            break before;
        }
    };
    let frame_bytes = 150;
    println!(
        "stalled after {stalled_at} of {NOTIFICATIONS} notifications (event queue 8, pipe 4 KiB, about {frame_bytes} bytes per frame)"
    );
    assert!(
        stalled_at < 8 + 1 + (4 * 1024 / 100) + 64,
        "Core kept reading: {stalled_at}"
    );
    let mut seqs = Vec::new();
    while seqs.len() < usize::try_from(NOTIFICATIONS).expect("small") {
        match tokio::time::timeout(support::EVENT_WAIT, events.recv())
            .await
            .expect("events flow")
            .expect("open")
        {
            HostEvent::Notification { notification, .. } => {
                seqs.push(notification.params.header.seq)
            }
            HostEvent::Exited { reason, .. } => {
                panic!("the host was killed while backpressured: {reason:?}")
            }
            _ => {}
        }
    }
    assert!(
        seqs.iter().copied().eq(1..=NOTIFICATIONS),
        "every notification arrives once, in order"
    );
    assert_eq!(supervisor.state(), SupervisorState::Connected { epoch: 1 });
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_full_write_queue_refuses_new_calls_with_a_retryable_busy_error() {
    let spawner = FakeSpawner::with_pipe_bytes(
        vec![script(|mut host| async move {
            host.hello("1.0", &[]).await;
            // Never reads stdin again: Core's writes back up.
            std::future::pending::<i32>().await
        })],
        1024,
    );
    let mut config = config();
    config.write_queue_frames = 4;
    config.call_timeout = Duration::from_secs(3600);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    let big = "x".repeat(4096);
    let mut waiting = Vec::new();
    let busy = loop {
        let supervisor = supervisor.clone();
        let cwd = big.clone();
        let call = tokio::spawn(async move {
            supervisor
                .create_session(SessionCreateParams::new(&cwd))
                .await
        });
        tokio::task::yield_now().await;
        if call.is_finished() {
            break call.await.expect("joins");
        }
        waiting.push(call);
        assert!(waiting.len() < 64, "the write queue never filled");
    };
    println!(
        "{} calls queued or in the pipe before Busy: {busy:?}",
        waiting.len()
    );
    let error = busy.expect_err("refused");
    assert!(matches!(error, Error::Busy { .. }), "{error:?}");
    assert!(error.retryable());
    assert_eq!(error.kind(), ErrorKind::Busy);
    supervisor.kill().await;
    for call in waiting {
        let result = call.await.expect("joins");
        assert!(matches!(result, Err(Error::Uncertain { .. })), "{result:?}");
    }
}

#[tokio::test]
async fn gives_up_after_the_sixth_crash_within_ten_minutes() {
    let crash = || {
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            1
        })
    };
    let spawner = FakeSpawner::new((0..7).map(|_| crash()).collect());
    let clock = TestClock::new();
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), Arc::clone(&clock)));
    let (gave_up, seen) = until(&mut events, |e| matches!(e, HostEvent::GaveUp { .. })).await;
    let restarts: Vec<(u32, Duration)> = seen
        .iter()
        .filter_map(|e| match e {
            HostEvent::Restarting { attempt, delay } => Some((*attempt, *delay)),
            _ => None,
        })
        .collect();
    let crashes = seen
        .iter()
        .filter(|e| {
            matches!(
                e,
                HostEvent::Exited {
                    reason: ExitReason::Crashed,
                    ..
                }
            )
        })
        .count();
    println!(
        "crashes {crashes}, restarts {restarts:?}, then {gave_up:?} after {:?} on the test clock",
        clock.elapsed()
    );
    assert_eq!(crashes, 6);
    assert_eq!(
        restarts.iter().map(|r| r.0).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        restarts.iter().map(|r| r.1.as_secs()).collect::<Vec<_>>(),
        [1, 2, 4, 8, 16]
    );
    assert_eq!(gave_up, HostEvent::GaveUp { restarts: 5 });
    until(&mut events, |e| matches!(e, HostEvent::Stopped)).await;
    assert_eq!(spawner.spawned(), 6);
    assert!(clock.elapsed() < Duration::from_secs(600));
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
    let refused = supervisor
        .create_session(SessionCreateParams::new("w"))
        .await
        .expect_err("stopped");
    assert_eq!(refused.kind(), ErrorKind::ShuttingDown);
}

#[tokio::test]
async fn shutdown_asks_the_host_to_exit_and_does_not_restart_it() {
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        let (id, params) = host.request("host/shutdown").await;
        assert_eq!(params["reason"], "coreShutdown");
        host.respond(id, json!({ "closedSessions": 0 })).await;
        0
    })]);
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    supervisor.shutdown().await;
    let (_, seen) = until(&mut events, |e| matches!(e, HostEvent::Stopped)).await;
    assert!(seen.iter().any(|e| matches!(e, HostEvent::Exited { reason: ExitReason::Shutdown, status: Some(s), .. } if s.success())));
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, HostEvent::Restarting { .. }))
    );
    assert_eq!(spawner.spawned(), 1);
}

#[tokio::test]
async fn calls_before_the_first_connection_fail_as_host_unavailable() {
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        // Never says hello in time.
        host.until_stdin_closes().await;
        0
    })]);
    let mut config = config();
    config.handshake_timeout = Duration::from_millis(50);
    config.restart.max_restarts = 0;
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    let early = supervisor
        .close_session(&SessionId("s".into()))
        .await
        .expect_err("not connected");
    assert_eq!(early.kind(), ErrorKind::HostUnavailable);
    assert!(early.retryable());
    let (exited, _) = until(&mut events, |e| matches!(e, HostEvent::Exited { .. })).await;
    assert!(matches!(
        exited,
        HostEvent::Exited {
            reason: ExitReason::HandshakeTimeout,
            ..
        }
    ));
    until(&mut events, |e| {
        matches!(e, HostEvent::GaveUp { restarts: 0 })
    })
    .await;
}

#[tokio::test]
async fn shutdown_and_restarts_never_wait_for_a_consumer_that_stopped_reading() {
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        for seq in 1..=5 {
            host.notify(
                "turn/started",
                "s1",
                seq,
                json!({ "turnId": format!("t{seq}") }),
            )
            .await;
        }
        host.until_stdin_closes().await;
        0
    })]);
    let mut config = config();
    config.event_queue = 1;
    // host/shutdown's answer is stuck behind the held-back notifications: close stdin soon.
    config.shutdown_timeout = Duration::from_millis(100);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    // The reader now holds back notifications 2..5; nobody reads events any more.
    tokio::time::timeout(support::EVENT_WAIT, supervisor.shutdown())
        .await
        .expect("shutdown completed without the consumer");
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
    let (_, seen) = until(&mut events, |e| matches!(e, HostEvent::Stopped)).await;
    let notifications = seen
        .iter()
        .filter(|e| matches!(e, HostEvent::Notification { .. }))
        .count();
    assert!(notifications >= 1, "{seen:#?}");
    assert!(seen.iter().any(|e| matches!(
        e,
        HostEvent::Exited {
            reason: ExitReason::Shutdown,
            ..
        }
    )));
}

/// Hands the `Peer` of each request to the test, then holds it like a quiet `exec/run` until
/// the connection ends.
struct QuietCommand {
    peers: std::sync::Mutex<Option<oneshot::Sender<piarc_host::Peer>>>,
}

impl piarc_host::InboundHandler for QuietCommand {
    fn handle(
        &self,
        _method: String,
        _params: serde_json::Map<String, serde_json::Value>,
        peer: piarc_host::Peer,
    ) -> piarc_ports::BoxFuture<'static, Result<serde_json::Value, piarc_protocol::ErrorObject>>
    {
        if let Some(tx) = self.peers.lock().expect("lock").take() {
            let _ = tx.send(peer.clone());
        }
        Box::pin(async move {
            peer.closed().await;
            Ok(json!({ "exitCode": null, "killed": true }))
        })
    }
}

#[tokio::test]
async fn a_crash_ends_the_peers_of_requests_still_running() {
    let (crash_tx, crash_rx) = oneshot::channel::<()>();
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.send(&json!({ "jsonrpc": "2.0", "id": 7, "method": "exec/run", "params": {} }))
                .await;
            let _ = crash_rx.await;
            1
        }),
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let (peer_tx, peer_rx) = oneshot::channel();
    let mut deps = deps(spawner, TestClock::new());
    deps.inbound = Arc::new(QuietCommand {
        peers: std::sync::Mutex::new(Some(peer_tx)),
    });
    let (supervisor, mut events) = HostSupervisor::start(config(), deps);
    let peer = tokio::time::timeout(support::EVENT_WAIT, peer_rx)
        .await
        .expect("the request reached the handler")
        .expect("peer sent");
    assert!(!peer.is_closed());
    let _ = crash_tx.send(());
    until(&mut events, |e| matches!(e, HostEvent::Exited { .. })).await;
    // The command watching this peer must learn that its connection is gone.
    tokio::time::timeout(Duration::from_secs(5), peer.closed())
        .await
        .expect("Peer::closed completes when the Agent Host crashes");
    assert!(peer.is_closed());
    until(&mut events, |e| {
        matches!(e, HostEvent::Connected { epoch: 2, .. })
    })
    .await;
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_crash_during_restore_keeps_the_sessions_for_the_next_restart() {
    let (crash_tx, crash_rx) = oneshot::channel::<()>();
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.accept_session("s1").await;
            host.accept_session("s2").await;
            let _ = crash_rx.await;
            1
        }),
        // Crashes on the first resume, before answering it.
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.request("session/resume").await;
            1
        }),
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            for _ in 0..2 {
                let (id, params) = host.request("session/resume").await;
                host.respond(
                    id,
                    json!({ "sessionId": params["sessionId"], "restoredMessages": 0 }),
                )
                .await;
            }
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    supervisor
        .create_session(SessionCreateParams::new("work space/项目"))
        .await
        .expect("s1");
    supervisor
        .create_session(SessionCreateParams::new("work space/项目"))
        .await
        .expect("s2");
    let _ = crash_tx.send(());
    let (_, seen) = until(&mut events, |e| {
        matches!(e, HostEvent::Connected { epoch: 3, .. })
    })
    .await;
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, HostEvent::SessionRestoreFailed { .. })),
        "a lost connection is not a failed session: {seen:#?}"
    );
    let mut restored = Vec::new();
    while restored.len() < 2 {
        let (event, _) = until(&mut events, |e| {
            matches!(e, HostEvent::SessionRestored { .. })
        })
        .await;
        if let HostEvent::SessionRestored {
            epoch: 3,
            session_id,
            ..
        } = event
        {
            restored.push(session_id);
        }
    }
    restored.sort();
    assert_eq!(restored, ["s1", "s2"]);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn an_error_answer_to_a_heartbeat_does_not_stop_hang_detection() {
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            // `request` would answer the heartbeat itself.
            let ping = host.recv().await;
            assert_eq!(ping["method"], "host/ping");
            host.send(&json!({ "jsonrpc": "2.0", "id": ping["id"], "error": {
                "code": -32603, "message": "ping failed",
                "data": { "kind": "internalError", "retryable": false }
            }}))
            .await;
            // Then hangs without reading or writing anything.
            std::future::pending::<i32>().await
        }),
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let mut config = config();
    config.heartbeat_interval = Duration::from_millis(20);
    config.heartbeat_timeout = Duration::from_millis(20);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    let (exited, _) = until(&mut events, |e| matches!(e, HostEvent::Exited { .. })).await;
    assert!(
        matches!(
            exited,
            HostEvent::Exited {
                epoch: 1,
                reason: ExitReason::Hung,
                ..
            }
        ),
        "{exited:?}"
    );
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_consumer_held_back_by_frame_errors_does_not_get_the_host_killed() {
    const BAD_FRAMES: usize = 50;
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        for _ in 0..BAD_FRAMES {
            host.send_raw(b"{not json\n").await;
        }
        host.until_stdin_closes().await;
        0
    })]);
    let mut config = config();
    config.event_queue = 1;
    config.heartbeat_interval = Duration::from_millis(10);
    config.heartbeat_timeout = Duration::from_millis(10);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    // Hold the consumer back long enough for several missed heartbeats.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut frame_errors = 0;
    while frame_errors < BAD_FRAMES {
        match tokio::time::timeout(support::EVENT_WAIT, events.recv())
            .await
            .expect("events flow")
            .expect("open")
        {
            HostEvent::FrameError { .. } => frame_errors += 1,
            HostEvent::Exited { reason, .. } => {
                panic!("the host was killed while backpressured: {reason:?}")
            }
            _ => {}
        }
    }
    assert_eq!(supervisor.state(), SupervisorState::Connected { epoch: 1 });
    supervisor.shutdown().await;
}

#[tokio::test]
async fn a_requested_restart_is_not_a_failure_and_restores_the_sessions() {
    let (resume_tx, resume_rx) = oneshot::channel();
    let first = script(|mut host| async move {
        host.hello("1.0", &[]).await;
        host.accept_session("s1").await;
        let (id, params) = host.request("host/shutdown").await;
        assert_eq!(params["reason"], "coreShutdown");
        host.respond(id, json!({ "closedSessions": 1 })).await;
        0
    });
    let spawner = FakeSpawner::new(vec![first, resuming(resume_tx)]);
    let clock = TestClock::new();
    let (supervisor, mut events) =
        HostSupervisor::start(config(), deps(Arc::clone(&spawner), Arc::clone(&clock)));
    until(&mut events, |e| {
        matches!(e, HostEvent::Connected { epoch: 1, .. })
    })
    .await;
    supervisor
        .create_session(SessionCreateParams::new("work space/项目"))
        .await
        .expect("session opens");

    supervisor.restart().await;
    let (restored, seen) = until(&mut events, |e| {
        matches!(e, HostEvent::SessionRestored { .. })
    })
    .await;
    assert!(seen.iter().any(|e| matches!(
        e,
        HostEvent::Exited { epoch: 1, reason: ExitReason::Restarted, status: Some(s) } if s.success()
    )));
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, HostEvent::Restarting { .. })),
        "no backoff: {seen:?}"
    );
    assert!(
        seen.iter()
            .any(|e| matches!(e, HostEvent::Connected { epoch: 2, .. }))
    );
    assert_eq!(
        restored,
        HostEvent::SessionRestored {
            epoch: 2,
            session_id: "s1".into(),
            restored_messages: 4
        }
    );
    assert_eq!(resume_rx.await.expect("resume seen")["sessionId"], "s1");
    assert_eq!(clock.elapsed(), Duration::ZERO, "no backoff delay");
    assert_eq!(spawner.spawned(), 2);
    supervisor.shutdown().await;
}

/// T19-A08: a retry issued as soon as the replacement process connects must wait for its
/// session. Other sessions can use the same connection while that resume is outstanding.
#[tokio::test]
async fn a_prompt_waits_for_its_own_session_to_be_restored() {
    check_prompt_during_restore(false).await;
}

#[tokio::test]
async fn a_failed_restore_returns_its_error_to_a_waiting_prompt() {
    check_prompt_during_restore(true).await;
}

async fn check_prompt_during_restore(reject: bool) {
    let (started, restoring) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let first = script(|mut host| async move {
        host.hello("1.0", &[]).await;
        host.accept_session("s1").await;
        host.until_stdin_closes().await;
        0
    });
    let second = script(move |mut host| async move {
        host.hello("1.0", &[]).await;
        let (resume, _) = host.request("session/resume").await;
        let _ = started.send(());
        host.accept_session("s2").await;
        released.await.expect("allow the resume");
        if reject {
            host.send(&json!({ "jsonrpc": "2.0", "id": resume, "error": {
                "code": -32000, "message": "the session could not be restored",
                "data": { "kind": "sessionNotFound", "retryable": false }
            }}))
            .await;
        } else {
            host.respond(resume, json!({ "sessionId": "s1", "restoredMessages": 1 }))
                .await;
            let (id, input) = host.request("session/prompt").await;
            assert_eq!(input["sessionId"], "s1");
            host.respond(id, json!({ "turnId": "retry" })).await;
        }
        host.until_stdin_closes().await;
        0
    });
    let spawner = FakeSpawner::new(vec![first, second]);
    let (supervisor, mut events) = HostSupervisor::start(config(), deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    let s1 = supervisor
        .create_session(SessionCreateParams::new("workspace"))
        .await
        .expect("s1")
        .session_id;
    supervisor.restart().await;
    restoring
        .await
        .expect("session/resume reached the new process");
    let retry = supervisor.prompt(&s1, "retry", "Try again");
    tokio::pin!(retry);
    // Poll until the call has either sent its frame or suspended on session restoration.
    tokio::select! {
        biased;
        result = &mut retry => panic!("the pending restore allowed a prompt: {result:?}"),
        () = std::future::ready(()) => {}
    }
    assert!(
        !supervisor
            .calls()
            .iter()
            .any(|call| call.method == "session/prompt"),
        "a pending restore must keep this session's input out of the wire ledger"
    );
    supervisor
        .create_session(SessionCreateParams::new("workspace"))
        .await
        .expect("other session");
    release.send(()).expect("release the restore");
    let outcome = retry.await;
    if reject {
        let error = outcome.expect_err("failed resume must reject the unsent prompt");
        assert_eq!(error.kind(), ErrorKind::SessionNotFound);
        assert!(
            error
                .to_string()
                .contains("the session could not be restored")
        );
    } else {
        assert_eq!(outcome.expect("prompt after restore").turn_id.0, "retry");
    }
    supervisor.shutdown().await;
}

/// R1-A4: the sessions are reopened inside the command loop, so a restore the new process never
/// answers does not keep `shutdown()` waiting for the call timeout.
#[tokio::test]
async fn a_restore_that_hangs_does_not_hold_back_shutdown() {
    let (crash_tx, crash_rx) = oneshot::channel::<()>();
    let (resumed_tx, resumed_rx) = oneshot::channel::<()>();
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.accept_session("s1").await;
            let _ = crash_rx.await;
            1
        }),
        // Reads the resume and never answers it; still answers host/shutdown.
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.request("session/resume").await;
            let _ = resumed_tx.send(());
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let mut config = config();
    config.call_timeout = Duration::from_secs(600);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    supervisor
        .create_session(SessionCreateParams::new("work space/项目"))
        .await
        .expect("s1");
    let _ = crash_tx.send(());
    resumed_rx.await.expect("the restore started");
    let session = SessionId("s1".into());
    let waiting = supervisor.prompt(&session, "retry", "Try again.");
    tokio::pin!(waiting);
    tokio::select! {
        biased;
        result = &mut waiting => panic!("the prompt did not wait: {result:?}"),
        () = std::future::ready(()) => {}
    }
    tokio::time::timeout(Duration::from_secs(20), supervisor.shutdown())
        .await
        .expect("shutdown does not wait for the pending restore");
    assert_eq!(
        waiting.await.expect_err("never sent").kind(),
        ErrorKind::HostUnavailable
    );
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
}

/// R1-A7: the Agent Host's requests are dispatched only on a connection whose handshake Core
/// accepted; after a refusal they get an error and never reach the handler.
#[tokio::test]
async fn requests_on_a_refused_connection_are_not_dispatched() {
    let (answers_tx, answers_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        let refusal = host.hello("2.0", &[]).await;
        host.send(&json!({ "jsonrpc": "2.0", "id": 7, "method": "trust/get", "params": { "path": "/w" } }))
            .await;
        let answer = host.recv().await;
        let _ = answers_tx.send((refusal, answer));
        3
    })]);
    let trust = Arc::new(support::TrustTable {
        trusted: true,
        ..support::TrustTable::default()
    });
    let mut deps = deps(spawner, TestClock::new());
    deps.inbound = Arc::clone(&trust) as _;
    let (supervisor, mut events) = HostSupervisor::start(config(), deps);
    until(&mut events, |e| matches!(e, HostEvent::Stopped)).await;
    let (refusal, answer) = answers_rx.await.expect("the fake host read both answers");
    assert_eq!(refusal["error"]["data"]["kind"], "protocolVersionMismatch");
    assert_eq!(answer["id"], 7);
    assert_eq!(
        answer["error"]["data"]["kind"], "invalidRequest",
        "{answer}"
    );
    assert!(trust.asked.lock().expect("lock").is_empty());
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
}

/// Holds every request until released and records how many run at once.
#[derive(Default)]
struct GateState {
    running: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
    arrived: std::sync::atomic::AtomicUsize,
    released: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Default)]
struct Gate(Arc<GateState>);

impl piarc_host::InboundHandler for Gate {
    fn handle(
        &self,
        _method: String,
        _params: serde_json::Map<String, serde_json::Value>,
        _peer: piarc_host::Peer,
    ) -> piarc_ports::BoxFuture<'static, Result<serde_json::Value, piarc_protocol::ErrorObject>>
    {
        use std::sync::atomic::Ordering;
        let state = Arc::clone(&self.0);
        let now = state.running.fetch_add(1, Ordering::SeqCst) + 1;
        state.peak.fetch_max(now, Ordering::SeqCst);
        state.arrived.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let mut released = state.released.subscribe();
            // The sender lives in `state`, which this future holds.
            let _ = released.wait_for(|open| *open).await;
            state.running.fetch_sub(1, Ordering::SeqCst);
            Ok(json!({ "trusted": false }))
        })
    }
}

/// R1-A14: the Agent Host's requests in progress are bounded; the rest wait in the pipe until
/// one finishes, and all are answered in the end.
#[tokio::test]
async fn the_agent_hosts_requests_in_progress_are_bounded() {
    use std::sync::atomic::Ordering;
    let (answers_tx, answers_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![script(|mut host| async move {
        host.hello("1.0", &[]).await;
        for id in 10..16 {
            host.send(&json!({ "jsonrpc": "2.0", "id": id, "method": "trust/get", "params": { "path": "/w" } }))
                .await;
        }
        let mut answered = Vec::new();
        while answered.len() < 6 {
            let frame = host.recv().await;
            if frame.get("result").is_some() {
                answered.push(frame["id"].as_i64().expect("numeric id"));
            }
        }
        let _ = answers_tx.send(answered);
        host.until_stdin_closes().await;
        0
    })]);
    let gate = Gate::default();
    let mut config = config();
    config.inbound_concurrency = 2;
    let mut deps = deps(spawner, TestClock::new());
    deps.inbound = Arc::new(gate.clone());
    let (supervisor, mut events) = HostSupervisor::start(config, deps);
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    while gate.0.arrived.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    // The reader waits for a permit: nothing more reaches the handler while two are held.
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(gate.0.arrived.load(Ordering::SeqCst), 2);
    gate.0.released.send_replace(true);
    let mut answered = answers_rx.await.expect("every request answered");
    answered.sort_unstable();
    assert_eq!(answered, [10, 11, 12, 13, 14, 15]);
    assert_eq!(gate.0.peak.load(Ordering::SeqCst), 2);
    supervisor.shutdown().await;
}

/// R1-A3: a `session/create` with a Core-chosen id that times out stays tracked, so the next
/// connection reopens it under that id and both sides agree on the session.
#[tokio::test]
async fn a_create_that_times_out_is_reconciled_by_the_next_restore() {
    let (crash_tx, crash_rx) = oneshot::channel::<()>();
    let (resumed_tx, resumed_rx) = oneshot::channel();
    let spawner = FakeSpawner::new(vec![
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            host.request("session/create").await; // never answered
            let _ = crash_rx.await;
            1
        }),
        script(|mut host| async move {
            host.hello("1.0", &[]).await;
            let (id, params) = host.request("session/resume").await;
            let _ = resumed_tx.send(params.clone());
            host.respond(
                id,
                json!({ "sessionId": params["sessionId"], "restoredMessages": 0 }),
            )
            .await;
            host.until_stdin_closes().await;
            0
        }),
    ]);
    let mut config = config();
    config.call_timeout = Duration::from_millis(200);
    let (supervisor, mut events) = HostSupervisor::start(config, deps(spawner, TestClock::new()));
    until(&mut events, |e| matches!(e, HostEvent::Connected { .. })).await;
    let mut params = SessionCreateParams::new("work space/项目");
    params.session_id = Some(SessionId("chosen-by-core".into()));
    let error = supervisor
        .create_session(params)
        .await
        .expect_err("no answer");
    assert_eq!(error.kind(), ErrorKind::Timeout);
    assert_eq!(supervisor.open_sessions(), ["chosen-by-core"]);
    let _ = crash_tx.send(());
    let resumed = resumed_rx.await.expect("the session is resumed");
    assert_eq!(resumed["sessionId"], "chosen-by-core");
    assert_eq!(resumed["cwd"], "work space/项目");
    until(&mut events, |e| {
        matches!(e, HostEvent::SessionRestored { session_id, .. } if session_id == "chosen-by-core")
    })
    .await;
    supervisor.shutdown().await;
}
