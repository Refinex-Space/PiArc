//! S9: AHP handshake, framing faults, backpressure, crash restarts and call reconciliation,
//! injected through scripted fake Agent Hosts (`support`). Run with `--nocapture` to print the
//! observations recorded in `docs/spikes/S09-ahp-resilience.md`.

mod support;

use std::sync::Arc;
use std::time::Duration;

use piarc_host::{
    CallState, Error, ExitReason, HostEvent, HostEvents, HostSupervisor, SupervisorState,
};
use piarc_protocol::session::{SessionId, SessionStopped};
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
        .create_session("work space/项目", None)
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
        .create_session("w", None)
        .await
        .expect("Core still serves calls");
    assert_eq!(opened.session_id.0, "after-restart");
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
            .create_session("w", None)
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
        let call = tokio::spawn(async move { supervisor.create_session(&cwd, None).await });
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
        .create_session("w", None)
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
