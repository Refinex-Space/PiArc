//! Everyday commands inside a sandboxed session (macOS, Seatbelt; T11-A07): git, a Python
//! script, `cargo build` and `npm install`.
//!
//! Network: `npm install` and the `cargo build` with a crates.io dependency reach the real
//! registries (`registry.npmjs.org`, `index.crates.io`, `static.crates.io`) through the
//! session's proxy. Without network access these two tests fail and say so; they never pass
//! silently (architecture section 12.6). The git, Python and offline cargo tests need no
//! network.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use piarc_core::agent_host::Peer;
use piarc_core::tool_io::{SandboxSettings, ToolIo, ToolIoConfig};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

const REGISTRIES: [&str; 3] = ["registry.npmjs.org", "index.crates.io", "static.crates.io"];

struct Fixture {
    root: PathBuf,
    ws: PathBuf,
    io: ToolIo,
}

impl Fixture {
    async fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc sandbox cmd {name} 中文 {}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        let ws = root.join("ws 工作 区");
        std::fs::create_dir_all(&ws).expect("workspace");
        std::fs::create_dir_all(root.join("data")).expect("data");
        let io = ToolIo::new(ToolIoConfig::new(root.join("data")));
        let settings = SandboxSettings {
            allowed_domains: REGISTRIES.iter().map(|&d| d.to_owned()).collect(),
            ..SandboxSettings::default()
        };
        io.open_sandboxed_session("s1", &ws, &ws, settings)
            .await
            .expect("sandboxed session opens");
        Self { root, ws, io }
    }

    /// Runs `command` in the workspace with `env` on top; prints and returns the outcome.
    async fn run(&self, command: &str, env: Value) -> (i64, String, String) {
        let (peer, frames) = Peer::channel(256);
        let reader = tokio::spawn(collect(frames));
        let started = Instant::now();
        let result = self
            .io
            .dispatch(
                "exec/run",
                object(json!({ "sessionId": "s1", "requestId": "r1",
                               "command": command, "env": env })),
                peer,
            )
            .await
            .expect("exec/run answers");
        let (out, err) = reader.await.expect("reader");
        let code = result["exitCode"].as_i64().unwrap_or(-1);
        println!(
            "$ {command}\n  exit {code} in {:?}\n--- stdout\n{out}--- stderr\n{err}---",
            started.elapsed()
        );
        (code, out, err)
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

/// Fails with the reason when `host` cannot be reached from this machine (outside the
/// sandbox): the test needs the registry.
async fn require_network(host: &str) {
    let reachable = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((host, 443)),
    )
    .await;
    assert!(
        matches!(reachable, Ok(Ok(_))),
        "this test needs network access to {host}:443, which is unreachable: {reachable:?}"
    );
}

/// The toolchain `cargo test` runs with, so rustup in the sandbox picks the same one.
fn rust_env() -> Value {
    let mut env = Map::new();
    // Commands see the caller's environment (T17); CI sets `CARGO_TERM_COLOR=always`, and the
    // assertions read cargo's plain text.
    env.insert("CARGO_TERM_COLOR".into(), Value::String("never".into()));
    if let Ok(toolchain) = std::env::var("RUSTUP_TOOLCHAIN") {
        env.insert("RUSTUP_TOOLCHAIN".into(), Value::String(toolchain));
    }
    Value::Object(env)
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    std::fs::write(path, text).expect("written");
}

#[tokio::test]
async fn git_status_add_and_commit() {
    let f = Fixture::new("git").await;
    // The repository is created outside the sandbox: `git init` writes `.git/config` and
    // `.git/hooks`, which the sandbox protects.
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "PiArc Test"],
        &["config", "user.email", "test@piarc.invalid"],
    ] {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(&f.ws)
            .status()
            .expect("git runs");
        assert!(status.success());
    }
    write(&f.ws.join("src/说明.txt"), "hello\n");
    let (code, out, _) = f
        .run(
            "git status --porcelain && git add -A && git commit -q -m 'first commit' \
             && git log --oneline && git status --porcelain",
            json!({}),
        )
        .await;
    assert_eq!(code, 0);
    assert!(out.starts_with("?? src/\n"), "{out}");
    assert!(out.trim_end().ends_with("first commit"), "{out}");
}

#[tokio::test]
async fn a_python_script_runs() {
    let f = Fixture::new("python").await;
    write(
        &f.ws.join("tool 脚本.py"),
        "import json, pathlib, sys, tempfile\n\
         out = pathlib.Path('out.json')\n\
         out.write_text(json.dumps({'python': sys.version_info[:2]}))\n\
         with tempfile.NamedTemporaryFile(delete=False) as t:\n\
         \x20   t.write(b'x')\n\
         print(out.read_text(), tempfile.gettempdir())\n",
    );
    let (code, out, _) = f.run("python3 'tool 脚本.py'", json!({})).await;
    assert_eq!(code, 0);
    assert!(out.starts_with("{\"python\": [3,"), "{out}");
    assert!(
        out.trim_end().ends_with("tmp"),
        "the session's temporary directory: {out}"
    );
    assert!(f.ws.join("out.json").is_file());
}

fn cargo_project(ws: &Path, dependency: &str) {
    write(
        &ws.join("hello/Cargo.toml"),
        &format!(
            "[package]\nname = \"hello\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
             [dependencies]\n{dependency}\n"
        ),
    );
}

#[tokio::test]
async fn cargo_build_without_dependencies() {
    let f = Fixture::new("cargo-offline").await;
    cargo_project(&f.ws, "");
    write(
        &f.ws.join("hello/src/main.rs"),
        "fn main() { println!(\"built in the sandbox\"); }\n",
    );
    let (code, out, _) = f
        .run(
            "cd hello && cargo build --offline && ./target/debug/hello",
            rust_env(),
        )
        .await;
    assert_eq!(code, 0);
    assert_eq!(out, "built in the sandbox\n");
}

#[tokio::test]
async fn cargo_build_with_a_crates_io_dependency() {
    require_network("index.crates.io").await;
    let f = Fixture::new("cargo-registry").await;
    cargo_project(&f.ws, "itoa = \"=1.0.15\"");
    write(
        &f.ws.join("hello/src/main.rs"),
        "fn main() { println!(\"{}\", itoa::Buffer::new().format(42_u8)); }\n",
    );
    let (code, out, err) = f
        .run(
            "cd hello && cargo build && ./target/debug/hello",
            rust_env(),
        )
        .await;
    assert_eq!(code, 0, "{err}");
    assert_eq!(out, "42\n");
    assert!(err.contains("Downloaded itoa v1.0.15"), "{err}");
}

#[tokio::test]
async fn npm_install_from_the_registry() {
    require_network("registry.npmjs.org").await;
    let f = Fixture::new("npm").await;
    write(
        &f.ws.join("package.json"),
        "{ \"name\": \"sandboxed\", \"version\": \"1.0.0\", \"private\": true,\n  \
         \"dependencies\": { \"is-number\": \"7.0.0\" } }\n",
    );
    let (code, out, err) = f
        .run(
            "npm install --no-audit --no-fund && \
             node -e 'console.log(require(\"is-number\")(42))'",
            json!({}),
        )
        .await;
    assert_eq!(code, 0, "{err}");
    assert!(out.contains("added 1 package"), "{out}");
    assert!(out.trim_end().ends_with("true"), "{out}");
    assert!(f.ws.join("node_modules/is-number/package.json").is_file());
}
