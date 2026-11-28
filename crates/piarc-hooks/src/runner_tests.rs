//! The runner over a minimal spawner (tokio's process, direct child only). Process-tree
//! termination with the production spawner is tested in `piarc-core` (`tests/hooks.rs`), which
//! may depend on `piarc-exec`.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::Instant;

use piarc_ports::{BoxFuture, SpawnedProcess};
use serde_json::json;

use super::*;
use crate::config::Source;

struct TokioSpawner;

struct Child(tokio::process::Child);

impl ProcessControl for Child {
    fn pid(&self) -> Option<u32> {
        self.0.id()
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.0.start_kill()
    }

    fn wait(&mut self) -> BoxFuture<'_, std::io::Result<ExitStatus>> {
        Box::pin(async move {
            let status = self.0.wait().await?;
            use std::os::unix::process::ExitStatusExt;
            Ok(ExitStatus {
                code: status.code(),
                signal: status.signal(),
            })
        })
    }
}

impl ProcessSpawner for TokioSpawner {
    fn spawn(&self, spec: SpawnSpec) -> std::io::Result<SpawnedProcess> {
        let mut child = tokio::process::Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(std::io::Error::other("missing pipe"));
        };
        Ok(SpawnedProcess {
            stdin: Box::pin(stdin),
            stdout: Box::pin(stdout),
            stderr: Box::pin(stderr),
            control: Box::new(Child(child)),
        })
    }
}

struct Sh;

impl Launcher for Sh {
    fn spec(&self, command: &Command, cwd: &Path) -> Result<SpawnSpec, Error> {
        if command.command == "missing-shell" {
            return Err(Error::CannotStart("no shell for this hook".into()));
        }
        Ok(SpawnSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), command.command.clone().into()],
            cwd: cwd.to_owned(),
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
        })
    }
}

fn handler(command: &str, timeout: Option<Duration>) -> Arc<Handler> {
    Arc::new(Handler {
        action: crate::config::Action::Command(crate::config::Command {
            command: command.into(),
            args: None,
            shell: None,
        }),
        timeout,
        condition: None,
        block_on_failure: false,
        source: Source {
            layer: "user".into(),
            file: None,
        },
        pointer: "/hooks/Stop/0/hooks/0".into(),
    })
}

fn runner(output_limit: usize) -> Runner {
    Runner::new(
        Arc::new(TokioSpawner),
        Arc::new(Sh),
        RunnerConfig {
            timeouts: Timeouts::default(),
            kill_grace: Duration::from_millis(200),
            output_limit,
        },
    )
}

fn exit_code(run: &HandlerRun) -> Option<i32> {
    match run.status {
        RunStatus::Exited(status) => status.code,
        _ => None,
    }
}

#[tokio::test]
async fn input_goes_to_stdin_and_output_and_exit_codes_come_back() {
    let cwd = std::env::temp_dir();
    let runs = runner(1 << 20)
        .run(
            HookEvent::Stop,
            &[
                handler("cat", None),
                handler("echo oops >&2; exit 2", None),
                handler("pwd", None),
            ],
            &json!({"hook_event_name": "Stop", "text": "中文"}),
            &cwd,
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(exit_code(&runs[0]), Some(0));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&runs[0].stdout).ok(),
        Some(json!({"hook_event_name": "Stop", "text": "中文"}))
    );
    assert_eq!(exit_code(&runs[1]), Some(2));
    assert_eq!(runs[1].stderr, "oops\n");
    let printed = PathBuf::from(runs[2].stdout.trim());
    assert_eq!(
        printed.canonicalize().ok(),
        cwd.canonicalize().ok(),
        "the hook runs in the given directory"
    );
}

#[tokio::test]
async fn handlers_of_one_event_run_in_parallel() {
    let sleepy: Vec<Arc<Handler>> = (0..4)
        .map(|n| handler(&format!("sleep 0.6; echo {n}"), None))
        .collect();
    let started = Instant::now();
    let runs = runner(1 << 20)
        .run(
            HookEvent::PreToolUse,
            &sleepy,
            &json!({}),
            &std::env::temp_dir(),
            &CancellationToken::new(),
        )
        .await;
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_millis(1800), "took {elapsed:?}");
    let outputs: Vec<&str> = runs.iter().map(|r| r.stdout.trim()).collect();
    assert_eq!(outputs, ["0", "1", "2", "3"]);
}

#[tokio::test]
async fn a_timeout_stops_the_handler_and_cancellation_stops_every_handler() {
    let started = Instant::now();
    let runs = runner(1 << 20)
        .run(
            HookEvent::Stop,
            &[handler(
                "echo started; exec sleep 30",
                Some(Duration::from_millis(300)),
            )],
            &json!({}),
            &std::env::temp_dir(),
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(
        runs[0].status,
        RunStatus::TimedOut(Duration::from_millis(300))
    );
    assert_eq!(runs[0].stdout, "started\n");
    assert!(started.elapsed() < Duration::from_secs(5));

    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stopper.cancel();
    });
    let started = Instant::now();
    let runs = runner(1 << 20)
        .run(
            HookEvent::Stop,
            &[
                handler("exec sleep 30", None),
                handler("exec sleep 31", None),
            ],
            &json!({}),
            &std::env::temp_dir(),
            &cancel,
        )
        .await;
    assert!(runs.iter().all(|r| r.status == RunStatus::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn large_output_on_both_pipes_does_not_stall_and_is_capped() {
    // 2 MB on each pipe, more than any pipe buffer: the hook only exits if both are drained.
    let command =
        "head -c 2000000 /dev/zero | tr '\\0' a; head -c 2000000 /dev/zero | tr '\\0' b >&2";
    let runs = runner(1000)
        .run(
            HookEvent::PostToolUse,
            &[handler(command, Some(Duration::from_secs(20)))],
            &json!({}),
            &std::env::temp_dir(),
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(exit_code(&runs[0]), Some(0));
    assert_eq!(runs[0].stdout, "a".repeat(1000));
    assert_eq!(runs[0].stderr, "b".repeat(1000));
}

#[tokio::test]
async fn a_hook_that_cannot_start_is_reported_and_one_that_ignores_stdin_still_runs() {
    let runs = runner(1 << 20)
        .run(
            HookEvent::Stop,
            &[handler("missing-shell", None), handler("exit 0", None)],
            &json!({"big": "x".repeat(1 << 20)}),
            &std::env::temp_dir(),
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(
        runs[0].status,
        RunStatus::NotStarted("no shell for this hook".into())
    );
    assert_eq!(exit_code(&runs[1]), Some(0));
}
