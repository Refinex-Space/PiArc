//! Terminals in Core (T10): lifecycle events on `term/<id>`, pulled frames, errors, and
//! closing on shutdown. Unix only (the program is `sh`); W0 covers ConPTY.
#![cfg(unix)]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_core::{
    CoreConfig, CoreRuntime, DeliveryDone, EventBatch, EventSink, SinkClosed, TerminalOptions,
};
use piarc_protocol::ErrorKind;
use piarc_protocol::term_frame;
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

/// Forwards each batch's route and events; completes deliveries at once.
struct ChannelSink {
    tx: Mutex<Sender<(String, Vec<Value>)>>,
}

impl EventSink for ChannelSink {
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        let tx = self.tx.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            let events: Vec<Value> = serde_json::from_slice(&batch.payload).unwrap_or_default();
            let _ = tx.send((batch.route.as_str().to_owned(), events));
        }
        drop(done);
        Ok(())
    }
}

fn start() -> (CoreRuntime, Receiver<(String, Vec<Value>)>) {
    let (tx, rx) = channel();
    let sink = Arc::new(ChannelSink { tx: Mutex::new(tx) });
    (
        CoreRuntime::start(CoreConfig::default(), sink).expect("runtime"),
        rx,
    )
}

fn options(script: &str) -> TerminalOptions {
    TerminalOptions {
        cols: 40,
        rows: 6,
        cell_width: 8,
        cell_height: 16,
        command: Some(("sh".into(), vec!["-c".into(), script.into()])),
        cwd: Some(std::env::temp_dir()),
        env: Vec::new(),
    }
}

fn events_until_exit(rx: &Receiver<(String, Vec<Value>)>, route: &str) -> Vec<Value> {
    let deadline = Instant::now() + WAIT;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let (got, events) = rx.recv_timeout(left).expect("terminal events");
        if got != route {
            continue;
        }
        let exited = events.iter().any(|e| e["type"] == "exited");
        seen.extend(events);
        if exited {
            return seen;
        }
    }
}

#[test]
fn lifecycle_events_arrive_on_the_terminal_route() {
    let (core, rx) = start();
    let id = core
        .create_terminal(options("printf '\\033]2;hi\\007\\007'; exit 3"))
        .expect("terminal");
    let events = events_until_exit(&rx, &format!("term/{id}"));
    assert!(events.contains(&serde_json::json!({ "type": "title", "title": "hi" })));
    assert!(events.contains(&serde_json::json!({ "type": "bell", "count": 1 })));
    assert_eq!(
        events.last(),
        Some(&serde_json::json!({ "type": "exited", "code": 3 }))
    );
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn frames_are_pulled_through_a_callback() {
    let (core, _rx) = start();
    let id = core
        .create_terminal(options("echo framed; sleep 5"))
        .expect("terminal");
    let deadline = Instant::now() + WAIT;
    loop {
        let (tx, frame_rx) = channel();
        core.terminal_frame(id, 1, true, move |frame| {
            let _ = tx.send(frame);
        })
        .expect("frame request");
        let bytes = frame_rx
            .recv_timeout(WAIT)
            .expect("callback")
            .expect("frame");
        let frame = term_frame::decode(&bytes).expect("decodes");
        let mut screen = term_frame::Screen::new();
        screen.apply(&frame).expect("reset frame applies");
        if screen.plain_text().contains("framed") {
            break;
        }
        assert!(Instant::now() < deadline, "the output never showed up");
        std::thread::sleep(Duration::from_millis(20));
    }
    let stats = core.terminal_stats(id).expect("stats");
    assert!(stats.frames >= 1);
    core.close_terminal(id).expect("close");
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn unknown_terminals_and_bad_options_are_structured_errors() {
    let (core, _rx) = start();
    let error = core.terminal_write(99, b"x".to_vec()).expect_err("unknown");
    assert_eq!(error.kind(), ErrorKind::NotFound);
    let mut bad = options("true");
    bad.cols = 0;
    assert_eq!(
        core.create_terminal(bad).expect_err("bad size").kind(),
        ErrorKind::InvalidParams
    );
    let mut relative = options("true");
    relative.cwd = Some("relative/dir".into());
    assert_eq!(
        core.create_terminal(relative)
            .expect_err("relative cwd")
            .kind(),
        ErrorKind::InvalidParams
    );
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn shutdown_closes_running_terminals() {
    let (core, rx) = start();
    let id = core.create_terminal(options("sleep 30")).expect("terminal");
    core.shutdown_blocking().expect("shutdown");
    // The program was killed: its exit was reported before the sink was released, or the
    // terminal is simply gone; either way nothing keeps running.
    let _ = rx;
    assert_eq!(
        core.terminal_stats(id).expect_err("closed").kind(),
        ErrorKind::NotFound
    );
}
