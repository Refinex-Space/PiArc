//! T32: background commands through `ToolIo` with real process trees, without an Agent Host.
//! `run_in_background` answers at once and the output file fills (A01's Core side), KillShell
//! ends the command with its child and grandchild and keeps the output (A04), another session
//! cannot stop it (A05), and a Monitor's command runs as a task.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{CommandEnv, ToolIo, ToolIoConfig};
use serde_json::{Map, Value, json};

struct Fixture {
    root: PathBuf,
    io: ToolIo,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc background {name} 中文 {}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        for dir in ["ws 工作区", "data"] {
            std::fs::create_dir_all(root.join(dir)).expect("dir created");
        }
        let io = ToolIo::new(ToolIoConfig {
            command_env: CommandEnv::Fixed(base_env()),
            ..ToolIoConfig::new(root.join("data"))
        });
        let ws = root.join("ws 工作区");
        io.open_session("s", &ws, &ws).expect("session s");
        io.open_session("t", &ws, &ws).expect("session t");
        Self { root, io }
    }

    fn ws(&self) -> PathBuf {
        std::fs::canonicalize(self.root.join("ws 工作区")).expect("canonical")
    }

    async fn call(&self, session: &str, method: &str, params: Value) -> Result<Value, String> {
        let (peer, mut frames) = Peer::channel(64);
        let drain = tokio::spawn(async move { while frames.recv().await.is_some() {} });
        let Value::Object(mut params) = params else {
            panic!("params are an object");
        };
        params.insert("sessionId".into(), json!(session));
        if method == "exec/run" {
            params
                .entry("requestId")
                .or_insert_with(|| json!(format!("r-{}", nanos())));
        }
        let result = self
            .io
            .dispatch(method, params, peer)
            .await
            .map_err(|e| format!("{:?} {}", e.data.kind, e.message));
        drain.abort();
        result
    }

    async fn bash(&self, command: &str) -> Value {
        self.call("s", "exec/run", json!({ "command": command }))
            .await
            .expect("exec/run answers")
    }

    /// Waits until `file` in the workspace holds a line.
    async fn wait_for(&self, file: &str) -> String {
        let path = self.ws().join(file);
        let started = Instant::now();
        loop {
            if let Ok(text) = std::fs::read_to_string(&path)
                && text.ends_with('\n')
            {
                return text.trim().to_owned();
            }
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "{file} never appeared"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// What a command needs to find bash and the system tools.
fn base_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            [
                "PATH",
                "SystemRoot",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
            ]
            .iter()
            .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .collect()
}

/// The command that starts a child and a grandchild that ignore `SIGTERM`, writing their
/// process ids (Windows pids on Git Bash, from `/proc/<pid>/winpid`).
const TREE: &str = "pid() { if [ -r /proc/$1/winpid ]; then cat /proc/$1/winpid; else echo $1; fi; }; \
    bash -c 'trap \"\" TERM; sleep 120 & echo $! > grand.msys; wait' & echo $! > child.msys; \
    while [ ! -s grand.msys ]; do sleep 0.05; done; \
    pid $(cat child.msys) > child.pid; pid $(cat grand.msys) > grand.pid; echo started; wait";

/// Whether process `pid` exists, asked of the system (tasklist on Windows).
fn alive(pid: &str) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&out.stdout).contains(pid)
    } else {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .expect("kill runs")
            .success()
    }
}

async fn gone(pid: &str) -> bool {
    for _ in 0..100 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("an object")
}

#[tokio::test]
async fn a_background_command_answers_at_once_and_writes_its_output_file() {
    let f = Fixture::new("start");
    let started = Instant::now();
    let result = f
        .call(
            "s",
            "exec/run",
            json!({ "command": "echo 第一行; sleep 1; echo second", "background": true }),
        )
        .await
        .expect("answers");
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "answered at once"
    );
    assert_eq!(result["task"]["reason"], "requested");
    assert!(object(&result).get("exitCode").is_none());
    let task = result["task"]["taskId"].as_str().expect("id").to_owned();
    let path = result["task"]["outputPath"].as_str().expect("path");
    assert!(
        path.contains("tasks") && path.ends_with(&format!("{task}.log")),
        "{path}"
    );
    // The task ends on its own; its output is all in the file.
    let mut listed = Value::Null;
    for _ in 0..200 {
        listed = f
            .call("s", "exec/background/list", json!({}))
            .await
            .expect("list");
        if listed["tasks"][0]["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let ended = &listed["tasks"][0];
    assert_eq!(ended["status"], "completed", "{ended}");
    assert_eq!(ended["exitCode"], 0);
    assert_eq!(ended["kind"], "command");
    assert_eq!(ended["tail"], json!(["第一行", "second"]));
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task }))
        .await
        .expect("read");
    assert_eq!(read["text"], "第一行\nsecond\n");
    assert_eq!(read["nextOffset"], read["totalBytes"]);
}

/// T32-A04: KillShell ends the command, its child and its grandchild (which ignore SIGTERM),
/// records `killed` and keeps the output file.
#[tokio::test]
async fn killshell_ends_the_whole_tree_and_keeps_the_output() {
    let f = Fixture::new("tree");
    let result = f
        .call(
            "s",
            "exec/run",
            json!({ "command": TREE, "background": true }),
        )
        .await
        .expect("answers");
    let task = result["task"]["taskId"].as_str().expect("id").to_owned();
    let child = f.wait_for("child.pid").await;
    let grand = f.wait_for("grand.pid").await;
    assert!(alive(&child) && alive(&grand), "the tree runs");
    let killed = f
        .call("s", "exec/background/kill", json!({ "taskId": task }))
        .await
        .expect("KillShell answers");
    assert_eq!(killed["stopped"], true);
    assert_eq!(killed["task"]["status"], "killed");
    assert!(killed["tail"].as_str().expect("tail").contains("started"));
    for (name, pid) in [("child", &child), ("grandchild", &grand)] {
        assert!(gone(pid).await, "the {name} {pid} still runs");
    }
    let read = f
        .call("s", "exec/background/read", json!({ "taskId": task }))
        .await
        .expect("the output file stays");
    assert_eq!(read["text"], "started\n");
    // A second KillShell reports the task as it ended.
    let again = f
        .call("s", "exec/background/kill", json!({ "taskId": task }))
        .await
        .expect("answers");
    assert_eq!(again["stopped"], false);
}

/// T32-A05: another session's task id is unknown to KillShell (and to list and read).
#[tokio::test]
async fn killshell_cannot_stop_another_sessions_task() {
    let f = Fixture::new("other");
    let result = f
        .call(
            "s",
            "exec/run",
            json!({ "command": "echo ready; sleep 60", "background": true }),
        )
        .await
        .expect("answers");
    let task = result["task"]["taskId"].as_str().expect("id").to_owned();
    let refused = f
        .call("t", "exec/background/kill", json!({ "taskId": task }))
        .await
        .expect_err("not t's task");
    assert!(refused.starts_with("NotFound"), "{refused}");
    assert!(
        f.call("t", "exec/background/read", json!({ "taskId": task }))
            .await
            .is_err()
    );
    let t_tasks = f
        .call("t", "exec/background/list", json!({}))
        .await
        .expect("list");
    assert_eq!(t_tasks["tasks"], json!([]));
    let s_tasks = f
        .call("s", "exec/background/list", json!({}))
        .await
        .expect("list");
    assert_eq!(s_tasks["tasks"][0]["status"], "running");
    let killed = f
        .call("s", "exec/background/kill", json!({ "taskId": task }))
        .await
        .expect("its own session stops it");
    assert_eq!(killed["task"]["status"], "killed");
}

#[tokio::test]
async fn a_monitor_runs_its_command_as_a_task() {
    let f = Fixture::new("monitor");
    let started = f
        .call(
            "s",
            "exec/monitor",
            json!({
                "requestId": "m1",
                "command": "for i in 1 2 3; do echo line $i; done",
                "description": "三行",
                "timeoutMs": 7_200_000,
            }),
        )
        .await
        .expect("exec/monitor answers");
    assert_eq!(started["timeoutMs"], 1_800_000, "cut to 30 minutes");
    assert_eq!(started["requestedTimeoutMs"], 7_200_000);
    let task = started["taskId"].as_str().expect("id").to_owned();
    let mut listed = Value::Null;
    for _ in 0..200 {
        listed = f
            .call("s", "exec/background/list", json!({}))
            .await
            .expect("list");
        if listed["tasks"][0]["status"] != "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let monitor = &listed["tasks"][0];
    assert_eq!(monitor["taskId"], task.as_str());
    assert_eq!(monitor["kind"], "monitor");
    assert_eq!(monitor["title"], "三行");
    assert_eq!(monitor["status"], "completed");
    assert_eq!(monitor["tail"], json!(["line 1", "line 2", "line 3"]));
    let bash = f.bash("echo still here").await;
    assert_eq!(bash["outcome"], "success");
}
