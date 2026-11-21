//! Terminals of a session through the tool I/O (T33): the session's directory and command
//! environment without credentials (A09), the model's terminal task with its screen file and
//! command notice (A10, Core side), sharing a user's terminal (A11), snapshots kept across
//! PiArc quitting, and the task ending with the terminal. Unix: the shells are bash and zsh.
#![cfg(unix)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_host::Peer;
use piarc_protocol::tasks::TaskStatus;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};
use crate::tasks::TasksConfig;
use crate::tool_io::{CommandEnv, ToolIo, ToolIoConfig, UserTerminal};

const WAIT: Duration = Duration::from_secs(20);
const SIZE: (u16, u16, u32, u32) = (100, 30, 8, 16);

/// Keeps every batch of every route.
#[derive(Default)]
struct Sink(Mutex<Vec<(String, Value)>>);

impl EventSink for Sink {
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        let mut seen = self.0.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            let events: Vec<Value> = serde_json::from_slice(&batch.payload).unwrap_or_default();
            for event in events {
                seen.push((batch.route.as_str().to_owned(), event));
            }
        }
        drop(done);
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    io: ToolIo,
    terminals: Terminals,
    tasks: TaskManager,
    sink: Arc<Sink>,
    close: CancellationToken,
}

impl Fixture {
    fn new(name: &str) -> Self {
        Self::with_env(name, |_| {})
    }

    /// A fixture whose command environment `edit` changed from [`base_env`].
    fn with_env(name: &str, edit: impl FnOnce(&mut Vec<(OsString, OsString)>)) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc term {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in ["ws 工作区/worktree 工作树/sub", "data", "home"] {
            std::fs::create_dir_all(root.join(dir)).expect("dir");
        }
        for rc in [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile"] {
            std::fs::write(root.join("home").join(rc), "").expect("rc");
        }
        let sink = Arc::new(Sink::default());
        let close = CancellationToken::new();
        let (events, coalescer, _) = crate::events::channel(
            Duration::from_millis(5),
            Arc::clone(&sink) as _,
            close.clone(),
        );
        tokio::spawn(coalescer.run());
        let terminals = Terminals::new(Handle::current(), events);
        let tasks = TaskManager::new(TasksConfig::default());
        terminals.attach(root.join("data"), tasks.clone());
        let mut env = base_env(&root.join("home"));
        edit(&mut env);
        let io = ToolIo::new(ToolIoConfig {
            command_env: CommandEnv::Fixed(env),
            ..ToolIoConfig::new(root.join("data"))
        })
        .with_tasks(tasks.clone())
        .with_terminals(terminals.clone());
        let worktree = root.join("ws 工作区/worktree 工作树");
        io.open_session("s", &worktree, &worktree)
            .expect("session s");
        io.open_session("t", &worktree, &worktree)
            .expect("session t");
        Self {
            root,
            io,
            terminals,
            tasks,
            sink,
            close,
        }
    }

    fn worktree(&self) -> PathBuf {
        std::fs::canonicalize(self.root.join("ws 工作区/worktree 工作树")).expect("canonical")
    }

    async fn call(&self, session: &str, method: &str, params: Value) -> Result<Value, String> {
        let (peer, mut frames) = Peer::channel(64);
        let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });
        let Value::Object(mut params) = params else {
            panic!("params are an object");
        };
        params.insert("sessionId".into(), json!(session));
        if method == "exec/run" {
            params.entry("requestId").or_insert_with(|| json!("r-1"));
        }
        let result = self
            .io
            .dispatch(method, params, peer)
            .await
            .map_err(|e| format!("{:?} {}", e.data.kind, e.message));
        drain.abort();
        result
    }

    async fn user_terminal(&self, restore: Option<String>) -> crate::terminal::Opened {
        self.io
            .open_user_terminal(
                "s",
                UserTerminal {
                    size: SIZE,
                    restore,
                },
            )
            .await
            .expect("user terminal")
    }

    /// Waits until terminal `id`'s whole text satisfies `test`.
    /// The whole text of terminal `id` as its screen file holds it: lines as the programs
    /// wrote them (a long path wraps at the terminal's width).
    async fn all_text(&self, id: u32) -> String {
        let session = self.terminals.session(id).expect("terminal");
        tokio::task::spawn_blocking(move || {
            let options = TextOptions {
                unwrap: true,
                ..TextOptions::default()
            };
            session.text(TextRange::All, options).unwrap_or_default()
        })
        .await
        .expect("text")
    }

    async fn wait_text(&self, id: u32, what: &str, test: impl Fn(&str) -> bool) -> String {
        let started = Instant::now();
        loop {
            let text = self.all_text(id).await;
            if test(&text) {
                return text;
            }
            assert!(
                started.elapsed() < WAIT,
                "waiting for {what}; screen:\n{text}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_for<T>(&self, what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
        let started = Instant::now();
        loop {
            if let Some(found) = probe() {
                return found;
            }
            assert!(started.elapsed() < WAIT, "waiting for {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn events_of(&self, id: u32) -> Vec<Value> {
        let route = format!("term/{id}");
        self.sink
            .0
            .lock()
            .expect("sink")
            .iter()
            .filter(|(r, _)| *r == route)
            .map(|(_, e)| e.clone())
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Collected first: a guard in the `for` head would live through the loop.
        let ids: Vec<u32> = lock(&self.terminals.inner.entries)
            .keys()
            .copied()
            .collect();
        for id in ids {
            self.terminals.close_now(id, false);
        }
        self.close.cancel();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The environment commands and terminals start from, with things that must not reach them.
fn base_env(home: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("HOME".into(), home.as_os_str().to_owned()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("SHELL".into(), "/bin/zsh".into()),
        // Neither a credential nor an arbitrary exported variable may reach the terminal
        // (ADR-0035): the same filter as commands.
        ("ANTHROPIC_API_KEY".into(), "sk-ant-test-secret".into()),
        ("PIARC_TEST_TOKEN".into(), "token-value".into()),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_terminal_starts_in_the_session_directory_with_the_command_environment() {
    let f = Fixture::new("env");
    // The session's shell directory moves with a command; the terminal starts there.
    f.call("s", "exec/run", json!({ "command": "cd sub" }))
        .await
        .expect("cd");
    let opened = f.user_terminal(None).await;
    let id = opened.terminal_id;
    f.terminals
        .write(id, b"pwd; env | sort; echo END-OF-ENV\r".to_vec())
        .expect("type");
    let text = f
        .wait_text(id, "the environment", |t| {
            t.lines().any(|l| l == "END-OF-ENV")
        })
        .await;
    let sub = f.worktree().join("sub");
    assert!(
        text.lines().any(|l| Path::new(l) == sub),
        "started in {}:\n{text}",
        sub.display()
    );
    assert!(!text.contains("sk-ant-test-secret") && !text.contains("ANTHROPIC_API_KEY"));
    assert!(!text.contains("token-value") && !text.contains("PIARC_TEST_TOKEN"));
    for expected in [
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
        "LANG=en_US.UTF-8",
    ] {
        assert!(
            text.lines().any(|l| l == expected),
            "{expected} missing:\n{text}"
        );
    }
    // A login shell may reorder PATH (macOS `path_helper`); what Core passed is still there.
    let path = text
        .lines()
        .find_map(|l| l.strip_prefix("PATH="))
        .expect("PATH");
    for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        assert!(
            path.split(':').any(|d| d == dir),
            "{dir} missing from PATH {path}"
        );
    }
    assert!(
        text.lines()
            .any(|l| l.starts_with("PIARC_SHELL_INTEGRATION=")),
        "the integration was loaded"
    );
    // The working directory came back through OSC 7 too.
    let pwd = f
        .wait_for("the pwd event", || {
            f.events_of(id)
                .iter()
                .find(|e| e["type"] == "pwd")
                .map(|e| e["path"].as_str().unwrap_or_default().to_owned())
        })
        .await;
    assert_eq!(std::fs::canonicalize(&pwd).expect("pwd"), sub);
    let info = f.terminals.info(id).expect("info");
    assert_eq!(info.task_id.as_deref(), Some(opened.task_id.as_str()));
    assert!(!info.shared);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_without_a_locale_still_takes_typed_chinese() {
    // An app started from the Dock has no LANG, and a login profile rarely sets one: bash's
    // line editor in the C locale turns typed bytes above 0x7f into Meta keys.
    let f = Fixture::with_env("locale", |env| env.retain(|(name, _)| name != "LANG"));
    let result = f
        .call(
            "s",
            "exec/run",
            json!({ "command": "printf '中文 typed\\n'", "background": true, "terminal": true }),
        )
        .await
        .expect("exec/run");
    let task_id = result["task"]["taskId"].as_str().expect("task").to_owned();
    let notice = f
        .wait_for("the command's notice", || {
            f.tasks
                .pending("s")
                .into_iter()
                .find(|n| n.source.starts_with(&task_id))
        })
        .await;
    assert!(
        notice.text.contains("Command: printf '中文 typed"),
        "{}",
        notice.text
    );
    assert!(
        notice.text.lines().any(|l| l == "中文 typed"),
        "the command ran as typed:\n{}",
        notice.text
    );
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task_id }))
        .await
        .expect("read");
    let text = read["text"].as_str().expect("text");
    assert!(
        text.contains("Last command: `printf '中文 typed\\n'` ended with exit code 0."),
        "{text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_model_reads_its_terminal_task_and_hears_when_the_command_ends() {
    let f = Fixture::new("agent");
    let result = f
        .call(
            "s",
            "exec/run",
            json!({
                "command": "printf 'hello\\nworld\\n'; sh -c 'exit 3'",
                "background": true,
                "terminal": true,
            }),
        )
        .await
        .expect("exec/run");
    let task_id = result["task"]["taskId"].as_str().expect("task").to_owned();
    assert_eq!(result["task"]["reason"], "requested");
    let notice = f
        .wait_for("the command's notice", || {
            f.tasks
                .pending("s")
                .into_iter()
                .find(|n| n.source.starts_with(&task_id))
        })
        .await;
    assert!(
        notice.text.contains("Status: exit code 3"),
        "{}",
        notice.text
    );
    assert!(notice.text.contains("world"), "{}", notice.text);
    // The model sees its task and reads the screen file through Core.
    let list = f
        .call("s", "exec/background/list", json!({}))
        .await
        .expect("list");
    let task = list["tasks"]
        .as_array()
        .and_then(|t| t.iter().find(|t| t["taskId"] == task_id.as_str()))
        .expect("listed");
    assert_eq!(task["kind"], "terminal");
    assert_eq!(task["terminal"]["origin"], "agent");
    // The command's exit code shows on the task, which runs on: the terminal stays open.
    assert_eq!(task["status"], "running");
    assert_eq!(task["exitCode"], 3);
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task_id }))
        .await
        .expect("read");
    let text = read["text"].as_str().expect("text");
    assert!(
        text.contains(
            "Last command: `printf 'hello\\nworld\\n'; sh -c 'exit 3'` ended with exit code 3."
        ),
        "{text}"
    );
    // The body is the formatter's text of the terminal at that moment.
    let id = task["terminal"]["terminalId"]
        .as_u64()
        .and_then(|i| u32::try_from(i).ok())
        .expect("id");
    let formatted = f.all_text(id).await;
    let body = text
        .split_once("oldest first:\n\n")
        .map(|(_, b)| b)
        .expect("header");
    assert_eq!(body.trim_end(), formatted.trim_end());
    assert!(formatted.contains("hello\nworld"));
    // The shell Core picked says nothing of its own (macOS bash's zsh notice).
    assert!(
        !formatted.contains("default interactive shell"),
        "{formatted}"
    );
    // KillShell closes it: the task ends as killed.
    let killed = f
        .call("s", "exec/background/kill", json!({ "taskId": task_id }))
        .await
        .expect("kill");
    assert_eq!(killed["task"]["status"], "killed");
}

/// Session `s` neither lists nor reads task `task_id`.
async fn assert_hidden(f: &Fixture, task_id: &str) {
    let list = f
        .call("s", "exec/background/list", json!({}))
        .await
        .expect("list");
    assert!(
        !list.to_string().contains(task_id),
        "an unshared terminal is not listed"
    );
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task_id }))
        .await;
    assert!(read.expect_err("not readable").starts_with("NotFound"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_model_cannot_read_a_terminal_the_user_did_not_share() {
    let f = Fixture::new("share");
    let opened = f.user_terminal(None).await;
    let (id, task_id) = (opened.terminal_id, opened.task_id.clone());
    f.terminals
        .write(id, b"echo private-output\r".to_vec())
        .expect("type");
    f.wait_text(id, "the output", |t| {
        t.lines().any(|l| l == "private-output")
    })
    .await;
    // Give the screen file loop its chance: nothing may be written for an unshared terminal.
    tokio::time::sleep(bound::VIEW_INTERVAL * 3).await;
    let view = f
        .root
        .join("data/sessions/s/tasks")
        .join(format!("{task_id}.log"));
    assert_hidden(&f, &task_id).await;
    assert!(!view.exists(), "no screen file for an unshared terminal");
    let kill = f
        .call("s", "exec/background/kill", json!({ "taskId": task_id }))
        .await;
    assert!(kill.expect_err("not stoppable").starts_with("NotFound"));
    // Shared: listed, readable, announced to the session.
    assert!(f.terminals.set_shared(id, true).await.expect("share"));
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task_id }))
        .await
        .expect("readable once shared");
    assert!(
        read["text"]
            .as_str()
            .is_some_and(|t| t.contains("private-output"))
    );
    assert!(view.exists());
    let notice = f
        .tasks
        .pending("s")
        .into_iter()
        .find(|n| n.source.starts_with(&task_id))
        .expect("a share notice");
    assert!(notice.text.contains("shared a terminal"), "{}", notice.text);
    // Another session still cannot.
    let other = f
        .call("t", "exec/background/read", json!({ "taskId": task_id }))
        .await;
    assert!(other.is_err());
    // KillShell still cannot stop the user's terminal.
    let kill = f
        .call("s", "exec/background/kill", json!({ "taskId": task_id }))
        .await;
    assert!(kill.expect_err("not stoppable").starts_with("NotFound"));
    // Unshared again: hidden, and the file is gone.
    assert!(f.terminals.set_shared(id, false).await.expect("unshare"));
    assert!(!view.exists());
    assert_hidden(&f, &task_id).await;
    assert!(!f.terminals.set_shared(id, false).await.expect("no change"));
}

#[tokio::test(flavor = "multi_thread")]
async fn snapshots_survive_quitting_and_closing_drops_them() {
    let f = Fixture::new("snapshot");
    let opened = f.user_terminal(None).await;
    f.terminals
        .write(opened.terminal_id, b"echo before-restart-42\r".to_vec())
        .expect("type");
    f.wait_text(opened.terminal_id, "the output", |t| {
        t.lines().any(|l| l == "before-restart-42")
    })
    .await;
    f.terminals.shutdown().await;
    let snap = f
        .root
        .join("data/sessions/s/terminals")
        .join(format!("{}.snap", opened.task_id));
    assert!(snap.exists(), "PiArc quitting saves the terminal");
    let task = f
        .tasks
        .snapshot()
        .tasks
        .into_iter()
        .find(|t| t.task_id == opened.task_id)
        .expect("task");
    assert_eq!(task.status, TaskStatus::Interrupted);
    // The next start continues from it: the old screen comes first.
    let again = f.user_terminal(Some(opened.task_id.clone())).await;
    assert_eq!(
        again.restored,
        Some(piarc_term::snapshot::Restored::Snapshot)
    );
    f.wait_text(again.terminal_id, "the restored screen", |t| {
        t.contains("before-restart-42")
    })
    .await;
    assert!(!snap.exists(), "the old snapshot was taken over");
    // Closing a terminal for good drops its snapshot.
    let new_snap = f
        .root
        .join("data/sessions/s/terminals")
        .join(format!("{}.snap", again.task_id));
    std::fs::write(&new_snap, b"stale").expect("pretend it was saved");
    f.terminals.close(again.terminal_id).expect("close");
    f.wait_for("the closed task", || {
        f.tasks
            .snapshot()
            .tasks
            .into_iter()
            .find(|t| t.task_id == again.task_id && t.status != TaskStatus::Running)
    })
    .await;
    assert!(!new_snap.exists());
}
