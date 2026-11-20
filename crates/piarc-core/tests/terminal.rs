//! Terminals in Core (T10): lifecycle events on `term/<id>`, pulled frames, errors, and
//! closing on shutdown. Unix only (the program is `sh`); W0 covers ConPTY.
#![cfg(unix)]

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_core::Result as CoreResult;
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

/// Starts a terminal and waits for its id: options are checked at once, the start itself
/// answers through the callback (T33, the PTY opens on the blocking pool).
fn create(core: &CoreRuntime, options: TerminalOptions) -> CoreResult<u32> {
    let (tx, rx) = channel();
    core.create_terminal(options, move |created| {
        let _ = tx.send(created);
    })?;
    rx.recv_timeout(WAIT).expect("create callback")
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
    let id = create(&core, options("printf '\\033]2;hi\\007\\007'; exit 3")).expect("terminal");
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
    let id = create(&core, options("echo framed; sleep 5")).expect("terminal");
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
        create(&core, bad).expect_err("bad size").kind(),
        ErrorKind::InvalidParams
    );
    let mut relative = options("true");
    relative.cwd = Some("relative/dir".into());
    assert_eq!(
        create(&core, relative).expect_err("relative cwd").kind(),
        ErrorKind::InvalidParams
    );
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn shutdown_closes_running_terminals() {
    let (core, rx) = start();
    let id = create(&core, options("sleep 30")).expect("terminal");
    core.shutdown_blocking().expect("shutdown");
    // The program was killed: its exit was reported before the sink was released, or the
    // terminal is simply gone; either way nothing keeps running.
    let _ = rx;
    assert_eq!(
        core.terminal_stats(id).expect_err("closed").kind(),
        ErrorKind::NotFound
    );
}

/// A directory of its own under the system temp directory, with a space and Chinese in the
/// name; removed on drop.
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("piarc 终端 {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Whether process `pid` is still running (a zombie has ended).
fn alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|out| {
            let stat = String::from_utf8_lossy(&out.stdout);
            out.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
        })
}

fn process_group(pid: u32) -> u32 {
    let out = std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("pgid")
}

/// A shell whose tree is more than its process group (T33-A12): a job in a process group of
/// its own (job control on) and a process that ignores the hangup and `SIGTERM`. Returns the
/// terminal, the shell's process group and the two pids.
fn tree_terminal(core: &CoreRuntime, dir: &TempDir) -> (u32, Vec<u32>) {
    let pids = dir.0.join("pids");
    let mut options = options(
        "set -m; sleep 300 & echo $! > \"$PIDS\"; \
         (trap '' HUP TERM; exec sleep 301) & echo $! >> \"$PIDS\"; \
         echo done >> \"$PIDS\"; wait",
    );
    options.cwd = Some(dir.0.clone());
    options.env = vec![("PIDS".into(), pids.display().to_string())];
    let id = create(core, options).expect("terminal");
    let deadline = Instant::now() + WAIT;
    let pids: Vec<u32> = loop {
        let text = std::fs::read_to_string(&pids).unwrap_or_default();
        if text.lines().any(|l| l == "done") {
            break text.lines().filter_map(|l| l.parse().ok()).collect();
        }
        assert!(Instant::now() < deadline, "the jobs never started");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(pids.len(), 2);
    for &pid in &pids {
        assert!(alive(pid), "{pid} runs");
        assert_eq!(
            process_group(pid),
            pid,
            "{pid} leads a process group of its own"
        );
    }
    (id, pids)
}

/// Every pid has ended within the hangup grace and some slack.
fn assert_ended(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&pid| alive(pid)) {
        assert!(
            Instant::now() < deadline,
            "still running: {:?}",
            pids.iter().filter(|&&pid| alive(pid)).collect::<Vec<_>>()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn closing_a_terminal_ends_its_whole_process_tree() {
    let dir = TempDir::new("close");
    let (core, _rx) = start();
    let (id, pids) = tree_terminal(&core, &dir);
    core.close_terminal(id).expect("close");
    assert_ended(&pids);
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn quitting_ends_every_terminal_tree_before_it_returns() {
    let dir = TempDir::new("quit");
    let (core, _rx) = start();
    let (_id, pids) = tree_terminal(&core, &dir);
    core.shutdown_blocking().expect("shutdown");
    // Shutdown waited out the grace and killed what ignored the hangup: nothing is left the
    // moment it returns.
    let left: Vec<u32> = pids.iter().copied().filter(|&pid| alive(pid)).collect();
    for &pid in &left {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
    assert!(left.is_empty(), "outlived the shutdown: {left:?}");
}
