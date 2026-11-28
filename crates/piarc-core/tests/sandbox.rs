//! Sandboxed sessions end to end (macOS, Seatbelt): `exec/run` requests go to `ToolIo` like
//! the Agent Host's, the command runs under `sandbox-exec` with the session's proxy, and the
//! assertions check what the sandbox let through and the exact error the command saw
//! (T11-A01, A02, A03, A05, A08, A09).
//!
//! The fixture's paths contain spaces, Chinese and regular-expression metacharacters. No test
//! here uses the external network: blocked connections fail at `connect()` inside the sandbox,
//! and the proxy refuses the one domain asked for before resolving it.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{SandboxSettings, ToolIo, ToolIoConfig};
use piarc_sandbox::PROTECTED_PATHS;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

const DENIED: &str = "Operation not permitted";

struct Fixture {
    root: PathBuf,
    ws: PathBuf,
    extra: PathBuf,
    io: ToolIo,
}

impl Fixture {
    async fn new(name: &str, deny_read: &[&str]) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc sandbox {name} 中文 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        let root = {
            std::fs::create_dir_all(&root).expect("root");
            std::fs::canonicalize(&root).expect("canonical root")
        };
        let ws = root.join("ws 工作 区 [x](y)+");
        let extra = root.join("extra 附加");
        for dir in [&ws, &extra, &root.join("outside"), &root.join("data")] {
            std::fs::create_dir_all(dir).expect("dir created");
        }
        let io = ToolIo::new(ToolIoConfig::new(root.join("data")));
        let settings = SandboxSettings {
            extra_dirs: vec![extra.clone()],
            deny_read: deny_read.iter().map(|rel| root.join(rel)).collect(),
            allowed_domains: Vec::new(),
        };
        io.open_sandboxed_session("s1", &ws, &ws, settings)
            .await
            .expect("sandboxed session opens");
        Self {
            root,
            ws,
            extra,
            io,
        }
    }

    fn session_tmp(&self) -> PathBuf {
        self.root
            .join("data")
            .join("sessions")
            .join("s1")
            .join("tmp")
    }

    /// Runs `command` in the workspace; returns stdout, stderr and the response.
    async fn run(&self, command: &str) -> Run {
        let (peer, frames) = Peer::channel(256);
        let reader = tokio::spawn(collect(frames));
        let result = self
            .io
            .dispatch(
                "exec/run",
                object(json!({ "sessionId": "s1", "requestId": "r1", "command": command })),
                peer,
            )
            .await
            .expect("exec/run answers");
        let (stdout, stderr) = reader.await.expect("reader");
        Run {
            stdout,
            stderr,
            result,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Best effort: a leftover temporary directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug)]
struct Run {
    stdout: String,
    stderr: String,
    result: Value,
}

impl Run {
    fn code(&self) -> Option<i64> {
        self.result["exitCode"].as_i64()
    }

    fn assert_ok(&self) {
        assert_eq!(self.code(), Some(0), "{self:#?}");
    }

    /// The command failed because Seatbelt refused, not for any other reason.
    fn assert_denied(&self) {
        assert_ne!(self.code(), Some(0), "{self:#?}");
        assert!(self.stderr.contains(DENIED), "{self:#?}");
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("params must be an object: {other}"),
    }
}

/// Collects `exec/output` notifications until the channel closes.
async fn collect(mut frames: mpsc::Receiver<Vec<u8>>) -> (String, String) {
    let (mut out, mut err) = (String::new(), String::new());
    while let Some(frame) = frames.recv().await {
        let message: Value = serde_json::from_slice(&frame).expect("a JSON frame");
        let params = &message["params"];
        let data = params["data"].as_str().expect("data");
        match params["stream"].as_str() {
            Some("stdout") => out.push_str(data),
            _ => err.push_str(data),
        }
    }
    (out, err)
}

/// A shell word for `path` (single quotes; the fixture paths contain none).
fn sh(path: &Path) -> String {
    let text = path.to_str().expect("UTF-8 path");
    assert!(!text.contains('\''));
    format!("'{text}'")
}

/// T11-A01, A09: the workspace, the session's temporary directory and the extra directory
/// are writable; the home directory and other temporary paths are not.
#[tokio::test]
async fn writes_stay_inside_the_writable_directories() {
    let f = Fixture::new("writes", &[]).await;
    let allowed = [
        f.ws.join("新 文件.txt"),
        f.ws.join("nested dir/f.txt"),
        f.session_tmp().join("t.txt"),
        f.extra.join("e.txt"),
    ];
    for path in &allowed {
        let parent = path.parent().expect("parent");
        let run = f
            .run(&format!(
                "mkdir -p {} && printf ok > {} && cat {}",
                sh(parent),
                sh(path),
                sh(path)
            ))
            .await;
        run.assert_ok();
        assert_eq!(run.stdout, "ok");
    }
    // `$TMPDIR` is the session's temporary directory.
    let run = f
        .run("printf tmp > \"$TMPDIR/via-env\" && echo \"$TMPDIR\"")
        .await;
    run.assert_ok();
    assert_eq!(
        run.stdout.trim_end(),
        f.session_tmp().to_str().expect("UTF-8")
    );
    let home = std::env::var("HOME").expect("HOME");
    let denied = [
        PathBuf::from(&home).join(format!("piarc-sandbox-test-{}", std::process::id())),
        std::env::temp_dir().join(format!("piarc-sandbox-test-{}", std::process::id())),
        PathBuf::from(format!("/tmp/piarc-sandbox-test-{}", std::process::id())),
        f.root.join("outside").join("o.txt"),
    ];
    for path in &denied {
        let run = f.run(&format!("printf x > {}", sh(path))).await;
        run.assert_denied();
        assert!(!path.exists(), "{}", path.display());
    }
}

/// A concrete path for a protected pattern (`**` and `*` become one directory).
fn concrete(pattern: &str) -> String {
    pattern.replace("**", "m").replace('*', "w")
}

/// T11-A02, A09: every protected path, at the top of the workspace and nested, refuses
/// writes; `.git` cannot be moved away or hard-linked around.
#[tokio::test]
async fn protected_paths_refuse_writes() {
    let f = Fixture::new("protected", &[]).await;
    std::fs::create_dir_all(f.ws.join(".git").join("hooks")).expect(".git");
    std::fs::write(f.ws.join(".git").join("config"), "[core]\n").expect("config");
    for pattern in PROTECTED_PATHS {
        let rel = concrete(pattern);
        for base in [f.ws.clone(), f.ws.join("nested 子目录"), f.extra.clone()] {
            let target = base.join(&rel);
            std::fs::create_dir_all(target.parent().expect("parent")).expect("parent created");
            // The path itself, as a file (`.git/hooks` already exists as a directory).
            if !target.is_dir() {
                let before = std::fs::read(&target).ok();
                let run = f.run(&format!("printf x > {}", sh(&target))).await;
                run.assert_denied();
                assert_eq!(std::fs::read(&target).ok(), before, "{}", target.display());
            }
            // Below it, as a directory created outside the sandbox.
            let below = base.join("as-dir").join(&rel);
            std::fs::create_dir_all(&below).expect("protected dir created");
            let run = f
                .run(&format!("printf x > {}", sh(&below.join("inner"))))
                .await;
            run.assert_denied();
            assert!(!below.join("inner").exists());
        }
    }
    let config = f.ws.join(".git").join("config");
    let run = f
        .run("printf '[core]\\n\\thooksPath = /tmp\\n' >> .git/config")
        .await;
    run.assert_denied();
    assert_eq!(
        std::fs::read_to_string(&config).expect("config"),
        "[core]\n"
    );
    for command in [
        "mv .git .git-moved",
        "mv .git/hooks .git/hooks-moved",
        "ln .git/config linked-config",
        "mkdir .CLAUDE",
        "rm -rf .git",
    ] {
        f.run(command).await.assert_denied();
    }
    assert!(f.ws.join(".git").join("hooks").is_dir());
    assert!(config.is_file());
}

/// T11-A03: `denyRead` paths cannot be read (or moved out from under the rule); everything
/// else can.
#[tokio::test]
async fn deny_read_paths_are_unreadable() {
    let f = Fixture::new(
        "deny-read",
        &[
            "outside/secret 密钥.txt",
            "ws 工作 区 [x](y)+/secrets",
            "outside/missing-dir",
        ],
    )
    .await;
    std::fs::write(f.root.join("outside").join("secret 密钥.txt"), "s1").expect("secret");
    std::fs::write(f.root.join("outside").join("public.txt"), "p").expect("public");
    std::fs::create_dir_all(f.ws.join("secrets")).expect("secrets");
    std::fs::write(f.ws.join("secrets").join("key.pem"), "s2").expect("key");
    std::fs::write(f.ws.join("readme.txt"), "r").expect("readme");
    for path in [
        f.root.join("outside").join("secret 密钥.txt"),
        f.ws.join("secrets").join("key.pem"),
    ] {
        let run = f.run(&format!("cat {}", sh(&path))).await;
        run.assert_denied();
        assert_eq!(run.stdout, "");
    }
    f.run("ls secrets").await.assert_denied();
    f.run("mv secrets moved").await.assert_denied();
    for (path, content) in [
        (f.root.join("outside").join("public.txt"), "p"),
        (f.ws.join("readme.txt"), "r"),
        (PathBuf::from("/etc/hosts"), ""),
    ] {
        let run = f.run(&format!("cat {}", sh(&path))).await;
        run.assert_ok();
        assert!(run.stdout.starts_with(content));
    }
}

/// T11-A05: without the proxy a command reaches nothing: not a local listener, not a public
/// address; through the proxy, a domain outside the (empty) allowlist is refused.
#[tokio::test]
async fn connections_around_the_proxy_fail() {
    let f = Fixture::new("network", &[]).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener");
    listener.set_nonblocking(true).expect("nonblocking");
    let port = listener.local_addr().expect("addr").port();
    let python = |host: &str, port: u16| {
        format!(
            "/usr/bin/python3 -c 'import socket; socket.create_connection((\"{host}\", {port}), 3)'"
        )
    };
    for command in [
        // No proxy variables, straight to the address.
        format!(
            "env -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \\
             curl -sS -m 5 http://127.0.0.1:{port}/"
        ),
        format!("curl -sS -m 5 --noproxy '*' http://127.0.0.1:{port}/"),
        python("127.0.0.1", port),
        python("1.1.1.1", 443),
        python("2606:4700:4700::1111", 443),
    ] {
        let run = f.run(&command).await;
        assert_ne!(run.code(), Some(0), "{command}: {run:#?}");
        let refused = run.stderr.contains(DENIED)
            || run.stderr.contains("Couldn't connect to server")
            || run.stderr.contains("Failed to connect");
        assert!(refused, "{command}: {run:#?}");
    }
    assert!(
        listener.accept().is_err(),
        "a sandboxed command reached the listener"
    );
    // The proxy itself is reachable and refuses domains outside the allowlist.
    let run = f
        .run("curl -sS -m 5 -o /dev/null -w '%{http_code}' -D - http://example.com/")
        .await;
    assert_eq!(run.code(), Some(0), "{run:#?}");
    assert!(
        run.stdout.contains("x-piarc-proxy-denied: not-allowed"),
        "{run:#?}"
    );
    assert!(run.stdout.ends_with("403"), "{run:#?}");
    let run = f.run("curl -sS -m 5 https://example.com/").await;
    assert!(
        run.stderr.contains("CONNECT tunnel failed, response 403"),
        "{run:#?}"
    );
}

/// The pids of processes whose process group is `pgid`.
fn group_members(pgid: u32) -> Vec<u32> {
    let out = Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid="])
        .output()
        .expect("ps runs");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid: u32 = fields.next()?.parse().ok()?;
            let group: u32 = fields.next()?.parse().ok()?;
            (group == pgid).then_some(pid)
        })
        .collect()
}

/// T11-A08: output streams before the command ends; exit codes and stderr come through.
#[tokio::test]
async fn sandboxed_commands_stream_and_report_exit_codes() {
    let f = Fixture::new("stream", &[]).await;
    let run = f.run("printf '中文\\n'; echo oops >&2; exit 7").await;
    assert_eq!(run.code(), Some(7));
    assert_eq!(run.result["killed"], false);
    assert_eq!(run.stdout, "中文\n");
    assert_eq!(run.stderr, "oops\n");

    let (peer, mut frames) = Peer::channel(16);
    let io = f.io.clone();
    let started = Instant::now();
    let call = tokio::spawn(async move {
        io.dispatch(
            "exec/run",
            object(json!({ "sessionId": "s1", "requestId": "r2",
                           "command": "echo first; sleep 2; echo second" })),
            peer,
        )
        .await
    });
    let first = tokio::time::timeout(Duration::from_secs(10), frames.recv())
        .await
        .expect("first output in time")
        .expect("a frame");
    let first: Value = serde_json::from_slice(&first).expect("JSON");
    assert_eq!(first["params"]["data"], "first\n");
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(!call.is_finished(), "the command is still running");
    drop(frames);
    // Dropping the notification channel closes the peer; the command is then terminated.
    let result = call.await.expect("joins").expect("answers");
    assert_eq!(result["killed"], true);
}

/// T11-A08: `exec/kill` ends the command, its children and grandchildren: nothing of its
/// process group is left.
#[tokio::test]
async fn killing_a_sandboxed_command_leaves_no_process() {
    let f = Fixture::new("kill", &[]).await;
    let (peer, mut frames) = Peer::channel(64);
    let io = f.io.clone();
    // The shell prints its pid (the group id: sandbox-exec execs the shell), starts a child
    // that starts a grandchild, and waits.
    let command = "echo $$; sh -c 'sleep 300 & sleep 300; wait' & sleep 300 & wait";
    let call = tokio::spawn(async move {
        io.dispatch(
            "exec/run",
            object(json!({ "sessionId": "s1", "requestId": "r3", "command": command })),
            peer,
        )
        .await
    });
    let frame = tokio::time::timeout(Duration::from_secs(10), frames.recv())
        .await
        .expect("pid in time")
        .expect("a frame");
    let frame: Value = serde_json::from_slice(&frame).expect("JSON");
    let pgid: u32 = frame["params"]["data"]
        .as_str()
        .and_then(|data| data.trim().parse().ok())
        .expect("the shell's pid");
    let deadline = Instant::now() + Duration::from_secs(10);
    while group_members(pgid).len() < 5 {
        assert!(
            Instant::now() < deadline,
            "tree did not start: {:?}",
            group_members(pgid)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!("before kill, group {pgid}: {:?}", group_members(pgid));
    let killed =
        f.io.dispatch(
            "exec/kill",
            object(json!({ "sessionId": "s1", "requestId": "r3" })),
            Peer::channel(1).0,
        )
        .await
        .expect("kill answers");
    assert_eq!(killed["killed"], true);
    let result = call.await.expect("joins").expect("answers");
    assert_eq!(result["killed"], true);
    // T17: the group gets SIGTERM first; the shell exits on it (SIGKILL follows the grace
    // period for whatever ignores it).
    assert_eq!(result["signal"], 15);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !group_members(pgid).is_empty() {
        assert!(
            Instant::now() < deadline,
            "left behind: {:?}",
            group_members(pgid)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    println!("after kill, group {pgid}: {:?}", group_members(pgid));
}

/// Closing the session stops its proxy (started with its first sandboxed command, T39).
#[tokio::test]
async fn closing_the_session_stops_its_proxy() {
    let f = Fixture::new("close", &[]).await;
    assert_eq!(f.io.sandbox_proxy_port("s1"), None, "no command ran yet");
    f.run("true").await;
    let port = f.io.sandbox_proxy_port("s1").expect("a proxy");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
    );
    f.io.close_session("s1");
    let deadline = Instant::now() + Duration::from_secs(5);
    while tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
    {
        assert!(Instant::now() < deadline, "the proxy still listens");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
