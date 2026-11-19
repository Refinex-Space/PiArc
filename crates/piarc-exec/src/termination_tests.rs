//! How commands end (T17): a timeout, a cancellation and a dropped runtime end the whole process
//! tree, grandchildren included, checked by process id; `SIGTERM` comes before `SIGKILL`;
//! timeouts follow [`ExecLimits`] on an injected clock; 50 MB on each pipe does not block.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    CommandExit, CommandRunner, CommandSpec, ExecLimits, OutputCapture, OutputChunk,
    ProcessTreeSpawner, Stream,
};

fn bash() -> PathBuf {
    crate::shells::detect(&crate::shells::Probe::system(&env()), None)
        .bash
        .expect("bash")
}

fn env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            [
                "PATH",
                "SystemRoot",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "LOCALAPPDATA",
            ]
            .iter()
            .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .collect()
}

fn spec(command: &str) -> CommandSpec {
    let (args, carried) = crate::shells::bash_invocation(command);
    let mut env = env();
    env.extend(carried);
    CommandSpec {
        program: bash(),
        args,
        cwd: std::env::temp_dir(),
        env,
        launcher: None,
        timeout: None,
        kill_grace: Duration::from_secs(2),
    }
}

fn runner() -> CommandRunner {
    CommandRunner::new(Arc::new(ProcessTreeSpawner))
}

/// The operating system's pid of the process `$!` names: Git Bash numbers its processes
/// itself and keeps the Windows pid in `/proc/<pid>/winpid`.
const LAST_PID: &str = if cfg!(windows) {
    "$(cat /proc/$!/winpid)"
} else {
    "$!"
};

/// The shell starts a child bash, which starts a long `sleep` (the grandchild); both pids are
/// printed as `pids <child> <grandchild>` before anything waits.
fn tree_command(tail: &str) -> String {
    format!(
        "echo started; bash -c 'sleep 120 & echo \"$1 {LAST_PID}\" > \"$0\"; wait' \"$PIDS\" child & \
         while [ ! -s \"$PIDS\" ]; do sleep 0.05; done; echo \"pids {LAST_PID} $(cut -d' ' -f2 \"$PIDS\")\"; {tail}"
    )
}

fn pid_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("piarc-exec-t17-{name}-{}", std::process::id()))
}

fn tree_spec(name: &str, tail: &str) -> CommandSpec {
    let file = pid_file(name);
    let _ = std::fs::remove_file(&file);
    let mut spec = spec(&tree_command(tail));
    let shown = file.to_string_lossy().replace('\\', "/");
    spec.env.push(("PIDS".into(), shown.into()));
    spec
}

/// Collects stdout and reports the two descendant pids once they are printed.
async fn watch_output(
    mut rx: mpsc::Receiver<OutputChunk>,
    pids: tokio::sync::oneshot::Sender<Vec<u32>>,
) -> String {
    let mut out = String::new();
    let mut pids = Some(pids);
    while let Some(chunk) = rx.recv().await {
        if chunk.stream == Stream::Stdout {
            out.push_str(&String::from_utf8_lossy(&chunk.bytes));
            if let Some(line) = out.lines().find(|l| l.starts_with("pids "))
                && let Some(sender) = pids.take()
            {
                let found = line
                    .split_whitespace()
                    .skip(1)
                    .map(|p| p.parse().expect("a pid"))
                    .collect();
                let _ = sender.send(found);
            }
        }
    }
    out
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits"));
    nix::sys::signal::kill(pid, None).is_ok()
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    !crate::job::terminated(pid)
}

async fn wait_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while pids.iter().any(|&pid| alive(pid)) {
        assert!(Instant::now() < deadline, "still running: {pids:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!("all exited: {pids:?}");
}

async fn run_tree(
    name: &str,
    tail: &str,
    timeout: Option<Duration>,
    cancel_after_pids: bool,
) -> (CommandExit, String, Vec<u32>) {
    let (tx, rx) = mpsc::channel(16);
    let (pids_tx, pids_rx) = tokio::sync::oneshot::channel();
    let reader = tokio::spawn(watch_output(rx, pids_tx));
    let mut spec = tree_spec(name, tail);
    spec.timeout = timeout;
    let cancel = CancellationToken::new();
    let run = tokio::spawn({
        let cancel = cancel.clone();
        async move { runner().run(spec, tx, cancel).await }
    });
    let pids = pids_rx.await.expect("the command printed its pids");
    assert_eq!(pids.len(), 2, "{pids:?}");
    assert!(pids.iter().all(|&pid| alive(pid)), "{pids:?}");
    if cancel_after_pids {
        cancel.cancel();
    }
    let exit = run.await.expect("joins").expect("runs");
    let out = reader.await.expect("reader");
    let _ = std::fs::remove_file(pid_file(name));
    (exit, out, pids)
}

#[tokio::test]
async fn a_timeout_ends_child_and_grandchild() {
    let started = Instant::now();
    let (exit, out, pids) =
        run_tree("timeout", "sleep 120", Some(Duration::from_secs(3)), false).await;
    assert!(exit.timed_out && !exit.killed, "{exit:?}");
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(out.starts_with("started\n"), "{out}");
    wait_gone(&pids).await;
}

#[tokio::test]
async fn a_cancellation_ends_child_and_grandchild() {
    let (exit, _, pids) = run_tree("cancel", "sleep 120", None, true).await;
    assert!(exit.killed && !exit.timed_out, "{exit:?}");
    wait_gone(&pids).await;
}

#[tokio::test]
async fn background_processes_end_with_the_command() {
    // The shell exits at once; what it left running goes with it.
    let (exit, _, pids) = run_tree("leftover", "exit 0", None, false).await;
    assert_eq!(exit.status.code, Some(0));
    wait_gone(&pids).await;
}

#[test]
fn shutting_the_runtime_down_ends_the_tree() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let pids = runtime.block_on(async {
        let (tx, rx) = mpsc::channel(16);
        let (pids_tx, pids_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(watch_output(rx, pids_tx));
        let spec = tree_spec("shutdown", "sleep 120");
        tokio::spawn(async move { runner().run(spec, tx, CancellationToken::new()).await });
        pids_rx.await.expect("pids")
    });
    // Core's shutdown drops its runtime with the commands still running.
    runtime.shutdown_timeout(Duration::from_secs(1));
    let _ = std::fs::remove_file(pid_file("shutdown"));
    let check = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    check.block_on(wait_gone(&pids));
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_comes_first_and_sigkill_follows() {
    // A command that cleans up on SIGTERM gets to do so.
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    let reader = tokio::spawn(async move {
        let mut out = String::new();
        while let Some(chunk) = rx.recv().await {
            out.push_str(&String::from_utf8_lossy(&chunk.bytes));
            if out.contains("ready") {
                canceller.cancel();
            }
        }
        out
    });
    let exit = runner()
        .run(
            spec("trap 'echo cleaned up; exit 0' TERM; echo ready; while :; do sleep 0.05; done"),
            tx,
            cancel,
        )
        .await
        .expect("runs");
    assert!(exit.killed);
    assert!(reader.await.expect("reader").contains("cleaned up"));

    // One that ignores SIGTERM is killed after the grace period.
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
    let cancel = CancellationToken::new();
    let canceller = cancel.clone();
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if String::from_utf8_lossy(&chunk.bytes).contains("ready") {
                canceller.cancel();
            }
        }
    });
    let mut stubborn = spec("trap '' TERM; echo ready; sleep 60");
    stubborn.kill_grace = Duration::from_millis(500);
    let started = Instant::now();
    let exit = runner().run(stubborn, tx, cancel).await.expect("runs");
    assert!(exit.killed);
    assert_eq!(exit.status.signal, Some(9), "{exit:?}");
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert!(started.elapsed() < Duration::from_secs(10));
}

/// Runs `sleep 100000` with the timeout `limits` gives for `requested`, on a clock the test
/// controls: returns the duration the runner's deadline was set to and how the command ended
/// once the test let that deadline pass.
async fn held_run(requested: Option<Duration>) -> (Duration, CommandExit) {
    let limits = ExecLimits::default();
    let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
    let release = Arc::new(tokio::sync::Notify::new());
    let clock = Arc::new(ReleasedClock {
        asked: Arc::clone(&asked),
        release: Arc::clone(&release),
    });
    let mut long = spec("echo started; sleep 100000");
    long.timeout = Some(limits.timeout(requested).duration);
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
    let runner = CommandRunner::with_clock(Arc::new(ProcessTreeSpawner), clock);
    let run = tokio::spawn(async move { runner.run(long, tx, CancellationToken::new()).await });
    // The command is running and its deadline is set; nothing ends it until the clock says so.
    let first = rx.recv().await.expect("output");
    assert_eq!(first.bytes, b"started\n");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!run.is_finished(), "the command ended before its timeout");
    let deadline = asked.lock().expect("asked").clone();
    assert_eq!(deadline.len(), 1, "{deadline:?}");
    release.notify_waiters();
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let exit = tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .expect("ends once the timeout passes")
        .expect("joins")
        .expect("runs");
    (deadline[0], exit)
}

/// A clock whose sleeps record their duration and complete when `release` is notified.
struct ReleasedClock {
    asked: Arc<std::sync::Mutex<Vec<Duration>>>,
    release: Arc<tokio::sync::Notify>,
}

impl piarc_ports::Clock for ReleasedClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) -> piarc_ports::BoxFuture<'static, ()> {
        self.asked.lock().expect("asked").push(duration);
        let release = Arc::clone(&self.release);
        // Registered before returning, so a release right after cannot be missed.
        let mut notified = Box::pin(release.notified_owned());
        notified.as_mut().enable();
        Box::pin(notified)
    }
}

/// T17-A04: the runner's deadline is the default 2 minutes, a 15-minute request runs with the
/// 10-minute maximum, and the command times out when that deadline passes (an injected clock,
/// so no minutes go by; tokio's paused clock cannot advance while Windows reads pipes on
/// blocking threads).
#[tokio::test]
async fn timeouts_default_to_two_minutes_and_stop_at_ten() {
    let (deadline, exit) = held_run(None).await;
    assert_eq!(deadline, Duration::from_secs(120));
    assert!(exit.timed_out && !exit.killed, "{exit:?}");
    let (deadline, exit) = held_run(Some(Duration::from_secs(15 * 60))).await;
    assert_eq!(deadline, Duration::from_secs(600));
    assert!(exit.timed_out, "{exit:?}");
    let (deadline, exit) = held_run(Some(Duration::from_secs(5))).await;
    assert_eq!(deadline, Duration::from_secs(5));
    assert!(exit.timed_out, "{exit:?}");
}

#[tokio::test]
async fn fifty_megabytes_on_each_pipe_do_not_block() {
    const MB50: usize = 50 * 1024 * 1024;
    let command = format!(
        "head -c {MB50} /dev/zero | tr '\\0' o & head -c {MB50} /dev/zero | tr '\\0' e >&2 & wait"
    );
    let file = std::env::temp_dir().join(format!("piarc-exec-t17-50mb-{}.txt", std::process::id()));
    let target = {
        let file = file.clone();
        Box::new(move || {
            let writer = std::fs::File::create(&file)?;
            Ok((
                Box::new(writer) as Box<dyn std::io::Write + Send>,
                file.display().to_string(),
            ))
        })
    };
    let mut capture = OutputCapture::new(ExecLimits::default(), target);
    let (tx, mut rx) = mpsc::channel::<OutputChunk>(16);
    let consumer = tokio::spawn(async move {
        let mut bytes = [0_usize; 2];
        while let Some(chunk) = rx.recv().await {
            bytes[usize::from(chunk.stream == Stream::Stderr)] += chunk.bytes.len();
            capture.push(chunk.stream, &chunk.bytes);
        }
        (bytes, capture.finish(true))
    });
    let started = Instant::now();
    let mut big = spec(&command);
    big.timeout = Some(Duration::from_secs(120));
    let exit = runner()
        .run(big, tx, CancellationToken::new())
        .await
        .expect("runs");
    let (bytes, captured) = consumer.await.expect("consumer");
    println!("100 MB through both pipes in {:?}", started.elapsed());
    assert_eq!(exit.status.code, Some(0), "{exit:?}");
    assert!(!exit.timed_out);
    assert_eq!(bytes, [MB50, MB50]);
    assert_eq!(captured.total_chars, (2 * MB50) as u64);
    assert!(captured.truncated());
    assert_eq!(
        std::fs::metadata(&file).expect("spilled").len(),
        (2 * MB50) as u64
    );
    std::fs::remove_file(&file).expect("cleanup");
}
