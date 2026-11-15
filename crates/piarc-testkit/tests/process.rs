//! The `piarc-mock-provider` binary (T05-A08) and its HTTP request log (T05-A07).

mod support;

use std::io::{BufRead as _, BufReader};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

use serde_json::json;
use support::{parse_sse, post, send};

const BIN: &str = env!("CARGO_BIN_EXE_piarc-mock-provider");

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("piarc mock 进程 {tag} {}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create the temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Best effort: a leftover temp dir does not affect other tests (names are unique).
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spawn(args: &[&str]) -> Child {
    Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the mock provider binary")
}

async fn wait(child: Child) -> (ExitStatus, String) {
    let waited = tokio::task::spawn_blocking(move || {
        let output = child.wait_with_output().expect("wait for the child");
        (
            output.status,
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    });
    tokio::time::timeout(Duration::from_secs(20), waited)
        .await
        .expect("the process exits within 20 s")
        .expect("the wait task completes")
}

fn write_scenario(dir: &Path) {
    std::fs::write(
        dir.join("hello.yaml"),
        "id: hello\nsteps:\n  - text: \"hello from the process\"\n",
    )
    .expect("write the scenario");
}

#[tokio::test]
async fn prints_the_port_serves_and_exits_when_stdin_closes() {
    let dir = TempDir::new("serve");
    write_scenario(&dir.0);
    let scenarios = dir.0.to_str().expect("UTF-8 path");
    let mut child = spawn(&["--port", "0", "--scenarios", scenarios]);

    let stdout = child.stdout.take().expect("piped stdout");
    let mut first_line = String::new();
    BufReader::new(stdout)
        .read_line(&mut first_line)
        .expect("read the first stdout line");
    let port: u16 = first_line
        .trim_end()
        .parse()
        .expect("the first line is the port");
    assert_ne!(port, 0);
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));

    let request = json!({
        "model": "m",
        "stream": true,
        "messages": [{ "role": "user", "content": "[[piarc-scenario:hello]]" }],
    });
    let reply = post(address, "/v1/messages", None, &request).await;
    assert_eq!(reply.status, 200);
    assert_eq!(
        parse_sse(&reply.body)
            .last()
            .and_then(|e| e.name.clone())
            .as_deref(),
        Some("message_stop")
    );

    let log = send(address, "GET", "/_piarc/requests", &[], "").await;
    let records = log.json();
    assert_eq!(records.as_array().map(Vec::len), Some(1));
    assert_eq!(records[0]["seq"], 0);
    assert_eq!(records[0]["scenario"], "hello");
    assert_eq!(records[0]["step_index"], 0);
    assert_eq!(records[0]["format"], "anthropic_messages");
    assert_eq!(records[0]["violations"], json!([]));
    assert_eq!(records[0]["body"], request.to_string());

    drop(child.stdin.take());
    let (status, stderr) = wait(child).await;
    assert!(status.success(), "exit status {status}, stderr: {stderr}");
    assert!(
        tokio::net::TcpStream::connect(address).await.is_err(),
        "the port is released"
    );
}

#[tokio::test]
async fn rejects_bad_arguments_with_exit_code_2() {
    let child = spawn(&["--port", "not-a-port", "--scenarios", "x"]);
    let (status, stderr) = wait(child).await;
    assert_eq!(status.code(), Some(2));
    assert!(stderr.contains("is not a port number"), "{stderr}");

    let child = spawn(&["--port", "0"]);
    let (status, stderr) = wait(child).await;
    assert_eq!(status.code(), Some(2));
    assert!(stderr.contains("--scenarios"), "{stderr}");
}

#[tokio::test]
async fn fails_on_an_invalid_scenario_file() {
    let dir = TempDir::new("invalid");
    std::fs::write(dir.0.join("broken.yaml"), "id: broken\nsteps: []\n").expect("write");
    let child = spawn(&["--scenarios", dir.0.to_str().expect("UTF-8 path")]);
    let (status, stderr) = wait(child).await;
    assert_eq!(status.code(), Some(1));
    assert!(stderr.contains("at least one step"), "{stderr}");
}
