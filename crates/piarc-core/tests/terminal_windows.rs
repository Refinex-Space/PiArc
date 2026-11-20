//! T33-A12 on Windows: closing a terminal and quitting end everything its shell started (the
//! Job Object the shell joins), including processes started with their own console handling.
//! The Unix counterpart is in `terminal.rs`.
#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use piarc_core::{
    CoreConfig, CoreRuntime, DeliveryDone, EventBatch, EventSink, SinkClosed, TerminalOptions,
};

const WAIT: Duration = Duration::from_secs(30);

struct NullSink;

impl EventSink for NullSink {
    fn deliver(&self, _batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        drop(done);
        Ok(())
    }
}

/// A directory with a space and Chinese in the name, removed on drop.
struct TempDir(PathBuf);

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

fn alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
}

/// PowerShell in a terminal starting two long-running programs: `ping` sharing the console
/// and `cmd` running another `ping`. Returns the terminal and the two pids.
fn tree_terminal(core: &CoreRuntime, dir: &TempDir) -> (u32, Vec<u32>) {
    let pids = dir.0.join("pids");
    let script = "$a = Start-Process ping.exe -ArgumentList '-n','300','127.0.0.1' -NoNewWindow -PassThru; \
         $b = Start-Process cmd.exe -ArgumentList '/c','ping -n 301 127.0.0.1 > NUL' -NoNewWindow -PassThru; \
         Add-Content -Encoding ascii -Path $env:PIDS -Value $a.Id, $b.Id, 'done'; \
         Start-Sleep -Seconds 300";
    let options = TerminalOptions {
        cols: 80,
        rows: 24,
        cell_width: 8,
        cell_height: 16,
        command: Some((
            "powershell.exe".into(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                script.into(),
            ],
        )),
        cwd: Some(dir.0.clone()),
        env: vec![("PIDS".into(), pids.display().to_string())],
    };
    let (tx, rx) = channel();
    core.create_terminal(options, move |created| {
        let _ = tx.send(created);
    })
    .expect("options");
    let id = rx.recv_timeout(WAIT).expect("callback").expect("terminal");
    let deadline = Instant::now() + WAIT;
    let pids: Vec<u32> = loop {
        let text = std::fs::read_to_string(&pids).unwrap_or_default();
        if text.lines().any(|l| l.trim() == "done") {
            break text.lines().filter_map(|l| l.trim().parse().ok()).collect();
        }
        assert!(Instant::now() < deadline, "the programs never started");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(pids.len(), 2);
    for &pid in &pids {
        assert!(alive(pid), "{pid} runs");
    }
    (id, pids)
}

fn start() -> CoreRuntime {
    CoreRuntime::start(CoreConfig::default(), Arc::new(NullSink)).expect("runtime")
}

#[test]
fn closing_a_terminal_ends_its_whole_process_tree() {
    let dir = TempDir::new("close");
    let core = start();
    let (id, pids) = tree_terminal(&core, &dir);
    core.close_terminal(id).expect("close");
    let deadline = Instant::now() + Duration::from_secs(10);
    while pids.iter().any(|&pid| alive(pid)) {
        assert!(Instant::now() < deadline, "still running: {pids:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn quitting_ends_every_terminal_tree_before_it_returns() {
    let dir = TempDir::new("quit");
    let core = start();
    let (_id, pids) = tree_terminal(&core, &dir);
    core.shutdown_blocking().expect("shutdown");
    // Terminating a job is asynchronous: allow the processes a moment to go.
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&pid| alive(pid)) {
        assert!(Instant::now() < deadline, "outlived the shutdown: {pids:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
}
