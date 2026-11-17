//! `ToolIo` without an Agent Host: requests go straight to `dispatch`, notifications to a
//! channel [`Peer`]. Covers the path boundary (T07-A07), streamed command output and
//! cancellation (T07-A08) and per-session scopes.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{ToolIo, ToolIoConfig};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

struct Fixture {
    root: PathBuf,
    io: ToolIo,
}

impl Fixture {
    /// Two workspaces `ws a 甲` and `ws b 乙`, a file outside both, and sessions `a` and `b`.
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc tool-io {name} 中文 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        for dir in ["ws a 甲/src", "ws b 乙", "data"] {
            std::fs::create_dir_all(root.join(dir)).expect("dir created");
        }
        std::fs::write(root.join("outside.txt"), "outside").expect("written");
        let io = ToolIo::new(ToolIoConfig::new(root.join("data")));
        for (id, ws) in [("a", "ws a 甲"), ("b", "ws b 乙")] {
            io.open_session(id, &root.join(ws), &root.join(ws))
                .expect("session opens");
        }
        Self { root, io }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorObject> {
        let (peer, _frames) = Peer::channel(64);
        self.io.dispatch(method, object(params), peer).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("params must be an object: {other}"),
    }
}

fn text(path: &Path) -> String {
    std::fs::read_to_string(path).expect("reads")
}

#[tokio::test]
async fn reads_writes_and_lists_inside_the_session_workspace() {
    let f = Fixture::new("basic");
    let made = f
        .call(
            "fs/mkdir",
            json!({ "sessionId": "a", "path": "notes/新 目录" }),
        )
        .await
        .expect("mkdir");
    assert_eq!(made["created"], true);
    let written = f
        .call(
            "fs/write",
            json!({ "sessionId": "a", "path": "notes/新 目录/f.txt", "content": "第一\nsecond\n",
                    "origin": { "tool": "Write", "toolCallId": "t1" } }),
        )
        .await
        .expect("write");
    assert_eq!(written["bytesWritten"], 14);
    let read = f
        .call(
            "fs/read",
            json!({ "sessionId": "a", "path": f.path("ws a 甲/notes/新 目录/f.txt") }),
        )
        .await
        .expect("read");
    assert_eq!(read["text"], "第一\nsecond\n");
    assert_eq!(read["eof"], true);
    let stat = f
        .call("fs/stat", json!({ "sessionId": "a", "path": "notes" }))
        .await
        .expect("stat");
    assert_eq!(stat["kind"], "directory");
    let listing = f
        .call("fs/list", json!({ "sessionId": "a", "path": "." }))
        .await
        .expect("list");
    assert_eq!(
        listing["entries"],
        json!([{ "name": "notes", "kind": "directory" }, { "name": "src", "kind": "directory" }])
    );
    // The same relative path in session b resolves into b's workspace.
    let missing = f
        .call(
            "fs/read",
            json!({ "sessionId": "b", "path": "notes/新 目录/f.txt" }),
        )
        .await
        .expect_err("not in b");
    assert_eq!(missing.data.kind, ErrorKind::NotFound);
    let unknown = f
        .call("fs/stat", json!({ "sessionId": "zz", "path": "." }))
        .await
        .expect_err("no session");
    assert_eq!(unknown.data.kind, ErrorKind::SessionNotFound);
    let invalid = f
        .call("fs/read", json!({ "sessionId": "a" }))
        .await
        .expect_err("no path");
    assert_eq!(invalid.data.kind, ErrorKind::InvalidParams);
}

/// Every `fs/*` request on each outside file and directory.
fn boundary_calls(files: &[String], dirs: &[String]) -> Vec<(&'static str, Value)> {
    let mut calls = Vec::new();
    for file in files {
        for (method, extra) in [
            ("fs/stat", json!({})),
            ("fs/read", json!({})),
            ("fs/read", json!({ "mode": "blob" })),
            ("fs/write", json!({ "content": "pwned" })),
            ("fs/write", json!({ "content": "x", "append": true })),
            ("fs/grep", json!({ "pattern": "outside" })),
        ] {
            let mut params = object(extra);
            params.insert("sessionId".into(), json!("a"));
            params.insert("path".into(), json!(file));
            calls.push((method, Value::Object(params)));
        }
    }
    for dir in dirs {
        calls.extend([
            (
                "fs/mkdir",
                json!({ "sessionId": "a", "path": format!("{dir}/new-dir") }),
            ),
            ("fs/list", json!({ "sessionId": "a", "path": dir })),
            (
                "fs/glob",
                json!({ "sessionId": "a", "path": dir, "pattern": "*" }),
            ),
            (
                "fs/grep",
                json!({ "sessionId": "a", "path": dir, "pattern": "outside" }),
            ),
        ]);
    }
    calls
}

/// T07-A07, T16-A07: absolute paths, `..` and symlinks leading out of the workspace need the
/// user's approval for every `fs/*` method; until approvals exist (T20) they are refused with
/// `permissionDenied` (reason `outsideWorkspace`), and the target is not touched.
#[tokio::test]
async fn every_fs_method_refuses_paths_outside_the_workspace() {
    let f = Fixture::new("boundary");
    let outside = f.path("outside.txt");
    // Files and directories outside: by absolute path, by `..`, through symlinks.
    #[cfg_attr(
        not(unix),
        allow(unused_mut, reason = "the symlink cases below are added on Unix only")
    )]
    let mut files = vec![
        outside.to_string_lossy().into_owned(),
        "../outside.txt".to_owned(),
    ];
    #[cfg_attr(
        not(unix),
        allow(unused_mut, reason = "the symlink cases below are added on Unix only")
    )]
    let mut dirs = vec![f.root.to_string_lossy().into_owned(), "..".to_owned()];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, f.path("ws a 甲/link.txt")).expect("symlink");
        std::os::unix::fs::symlink(&f.root, f.path("ws a 甲/up")).expect("symlink");
        files.push("link.txt".to_owned());
        files.push("up/outside.txt".to_owned());
        dirs.push("up".to_owned());
    }
    let before = std::fs::metadata(&outside).expect("exists").modified().ok();
    let calls = boundary_calls(&files, &dirs);
    for (method, params) in calls {
        let error = f
            .call(method, params.clone())
            .await
            .expect_err("outside the workspace");
        assert_eq!(
            (error.data.kind, error.data.retryable),
            (ErrorKind::PermissionDenied, false),
            "{method} {params}: {error:?}"
        );
        let details = error.data.details.expect("details");
        let operation = if matches!(method, "fs/write" | "fs/mkdir") {
            "write"
        } else {
            "read"
        };
        assert_eq!(details["reason"], "outsideWorkspace", "{method} {params}");
        assert_eq!(details["operation"], operation, "{method} {params}");
        assert!(details["path"].is_string());
        assert!(
            error.message.contains("needs the user's approval"),
            "{}",
            error.message
        );
    }
    assert_eq!(text(&outside), "outside");
    assert_eq!(
        std::fs::metadata(&outside).expect("exists").modified().ok(),
        before
    );
    assert!(!f.path("new-dir").exists());
    assert!(
        !f.path("data/sessions/a/blobs").exists(),
        "no blob was copied"
    );
    // exec/run's working directory obeys the same boundary.
    let error = f
        .call(
            "exec/run",
            json!({ "sessionId": "a", "requestId": "r", "command": "true", "cwd": ".." }),
        )
        .await
        .expect_err("cwd outside");
    assert_eq!(error.data.kind, ErrorKind::OutsideWorkspace);
}

/// Reads `exec/output` frames from the peer channel.
async fn next_output(frames: &mut mpsc::Receiver<Vec<u8>>) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(10), frames.recv())
        .await
        .expect("output in time")
        .expect("a frame");
    let message: Value = serde_json::from_slice(&frame).expect("JSON frame");
    assert_eq!(message["method"], "exec/output");
    message["params"].clone()
}

/// T07-A08: output arrives as notifications while the command runs; the response carries the
/// exit code.
#[tokio::test]
async fn exec_run_streams_output_before_the_command_ends() {
    let f = Fixture::new("stream");
    let (peer, mut frames) = Peer::channel(64);
    let io = f.io.clone();
    let started = Instant::now();
    let run = tokio::spawn(async move {
        io.dispatch(
            "exec/run",
            object(json!({ "sessionId": "a", "requestId": "r1",
                "command": "printf 'first 中\\n'; sleep 2; printf 'second\\n' >&2; echo \"$PIARC_T\"; exit 4",
                "env": { "PIARC_T": "overlay" } })),
            peer,
        )
        .await
    });
    let first = next_output(&mut frames).await;
    assert_eq!(
        (
            &first["requestId"],
            &first["stream"],
            &first["seq"],
            &first["data"]
        ),
        (
            &json!("r1"),
            &json!("stdout"),
            &json!(1),
            &json!("first 中\n")
        )
    );
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(!run.is_finished(), "the command is still running");
    // stdout and stderr are separate pipes: their relative order is not defined.
    let mut rest = [
        next_output(&mut frames).await,
        next_output(&mut frames).await,
    ];
    rest.sort_by_key(|p| p["seq"].as_u64());
    assert_eq!((&rest[0]["seq"], &rest[1]["seq"]), (&json!(2), &json!(3)));
    let mut by_stream: Vec<(String, String)> = rest
        .iter()
        .map(|p| (p["stream"].to_string(), p["data"].to_string()))
        .collect();
    by_stream.sort();
    assert_eq!(
        by_stream,
        [
            (r#""stderr""#.to_owned(), r#""second\n""#.to_owned()),
            (r#""stdout""#.to_owned(), r#""overlay\n""#.to_owned())
        ]
    );
    let result = run.await.expect("joins").expect("runs");
    assert_eq!(
        (&result["exitCode"], &result["killed"]),
        (&json!(4), &json!(false))
    );
    // T17: the structured result of the bash card and the model's view of the output.
    assert_eq!(result["outcome"], "failure");
    assert_eq!(result["timedOut"], false);
    assert_eq!(result["timeout"], json!({ "ms": 120_000 }));
    assert!(result["durationMs"].as_u64().expect("duration") >= 2000);
    assert_eq!(result["output"]["totalChars"], 23);
    assert!(result["output"].get("tail").is_none());
}

/// T07-A08: `exec/kill` terminates the running command and `exec/run` reports it.
#[tokio::test]
async fn exec_kill_terminates_the_command() {
    let f = Fixture::new("kill");
    let (peer, mut frames) = Peer::channel(64);
    let io = f.io.clone();
    let run = tokio::spawn(async move {
        io.dispatch(
            "exec/run",
            object(json!({ "sessionId": "a", "requestId": "long",
                "command": "echo $$ > pid; echo ready; exec sleep 30" })),
            peer,
        )
        .await
    });
    assert_eq!(next_output(&mut frames).await["data"], "ready\n");
    let started = Instant::now();
    let killed = f
        .call(
            "exec/kill",
            json!({ "sessionId": "a", "requestId": "long" }),
        )
        .await
        .expect("kill answered");
    assert_eq!(killed, json!({ "killed": true }));
    let result = run.await.expect("joins").expect("runs");
    assert_eq!(result["killed"], true);
    assert!(result.get("exitCode").is_none_or(|c| c != 0), "{result}");
    assert!(started.elapsed() < Duration::from_secs(5));
    #[cfg(unix)]
    {
        let pid = text(&f.path("ws a 甲/pid")).trim().to_owned();
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .expect("kill -0 runs")
            .success();
        assert!(!alive, "process {pid} still runs");
    }
    let again = f
        .call(
            "exec/kill",
            json!({ "sessionId": "a", "requestId": "long" }),
        )
        .await
        .expect("kill answered");
    assert_eq!(again, json!({ "killed": false }));
}

#[tokio::test]
async fn a_closed_connection_terminates_the_command() {
    let f = Fixture::new("closed");
    let (peer, frames) = Peer::channel(1);
    drop(frames);
    let started = Instant::now();
    let result =
        f.io.dispatch(
            "exec/run",
            object(json!({ "sessionId": "a", "requestId": "orphan", "command": "exec sleep 30" })),
            peer,
        )
        .await
        .expect("runs");
    assert_eq!(result["killed"], true);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn glob_and_grep_search_the_session_workspace() {
    let f = Fixture::new("search");
    std::fs::write(
        f.path("ws a 甲/src/main 主.rs"),
        "fn main() {\n    todo();\n}\n",
    )
    .expect("written");
    std::fs::write(f.path("ws a 甲/.gitignore"), "target/\n").expect("written");
    std::fs::create_dir_all(f.path("ws a 甲/target")).expect("dir");
    std::fs::write(f.path("ws a 甲/target/gen.rs"), "fn main() {}\n").expect("written");
    let found = f
        .call(
            "fs/glob",
            json!({ "sessionId": "a", "path": ".", "pattern": "*.rs" }),
        )
        .await
        .expect("glob");
    assert_eq!(found["matches"], json!(["src/main 主.rs"]));
    let grep = f
        .call(
            "fs/grep",
            json!({ "sessionId": "a", "path": "src", "pattern": "TODO", "ignoreCase": true }),
        )
        .await
        .expect("grep");
    assert_eq!(
        grep["lines"],
        json!([{ "path": "main 主.rs", "lineNumber": 2, "text": "    todo();", "isMatch": true }])
    );
}
