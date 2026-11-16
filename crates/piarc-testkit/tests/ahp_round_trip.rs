//! T07-A10: AHP round trips of small `fs/read` requests, p95 ≤ 5 ms over at least 1,000
//! requests (architecture section 11). A Node client (`packages/testkit/src/
//! ahp-fs-read-client.ts`) stands in for the Agent Host bundle: Core's supervisor starts it and
//! answers its handshake and its `fs/read` requests with the real `ToolIo`, over real pipes.
//!
//! A test binary of its own, so no other test runs beside the timing. Needs `node` on PATH (or
//! `PIARC_TEST_NODE`). Run with `--nocapture` for the timings in
//! `docs/spikes/S04-operations-delegation.md`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_core::agent_host::{self, HostConfig, HostEvent, InboundHandler};
use piarc_core::tool_io::{ToolIo, ToolIoConfig};
use piarc_protocol::PROTOCOL_VERSION;
use serde_json::Value;

const COUNT: usize = 2000;
const WARMUP: usize = 200;

fn repo_root() -> PathBuf {
    // Not `canonicalize`: on Windows it gives a verbatim (`\\?\`) path, which Node cannot run a
    // script from.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the repository root")
        .to_path_buf()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_fs_reads_round_trip_within_the_budget() {
    let root = std::env::temp_dir().join(format!("piarc round trip 中文 {}", std::process::id()));
    let (ws, data) = (root.join("ws"), root.join("data"));
    std::fs::create_dir_all(&ws).expect("ws created");
    std::fs::create_dir_all(&data).expect("data created");
    std::fs::write(ws.join("small 小.txt"), "a small file\n".repeat(40)).expect("written");
    let report = root.join("round-trip.json");

    let node =
        std::env::var_os("PIARC_TEST_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from);
    let client = repo_root()
        .join("packages")
        .join("testkit")
        .join("src")
        .join("ahp-fs-read-client.ts");
    let mut config = HostConfig::new(root.clone(), data.clone(), node, client);
    for arg in [
        "--protocol".to_owned(),
        PROTOCOL_VERSION.to_string(),
        "--session".to_owned(),
        "bench".to_owned(),
        "--path".to_owned(),
        "small 小.txt".to_owned(),
        "--count".to_owned(),
        COUNT.to_string(),
        "--warmup".to_owned(),
        WARMUP.to_string(),
        "--report".to_owned(),
        report.to_string_lossy().into_owned(),
    ] {
        config.extra_args.push(arg.into());
    }
    // Plain ToolIo as Core's inbound handler: nothing but the real dispatch in the round trip.
    let io = ToolIo::new(ToolIoConfig::new(data));
    io.open_session("bench", &ws, &ws).expect("session scope");
    let (supervisor, mut events) =
        agent_host::start(config, Arc::new(io) as Arc<dyn InboundHandler>);
    let connected = tokio::time::timeout(Duration::from_secs(20), events.recv())
        .await
        .expect("an event in time");
    assert!(
        matches!(connected, Some(HostEvent::Connected { .. })),
        "{connected:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    while !report.exists() {
        assert!(Instant::now() < deadline, "no timing report");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let stats: Value =
        serde_json::from_str(&std::fs::read_to_string(&report).expect("report reads"))
            .expect("report is JSON");
    supervisor.shutdown().await;
    // Best effort: a leftover temporary directory does not affect other tests.
    let _ = std::fs::remove_dir_all(&root);

    let ms = |name: &str| stats[name].as_f64().expect("a number");
    println!(
        "fs/read round trip over {} requests (after {WARMUP} warm-up): p50 {:.3} ms, \
         p95 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
        stats["count"],
        ms("p50"),
        ms("p95"),
        ms("p99"),
        ms("max")
    );
    assert_eq!(
        stats["count"].as_u64(),
        Some(u64::try_from(COUNT).expect("fits"))
    );
    assert!(ms("p95") <= 5.0, "p95 {} ms exceeds 5 ms", ms("p95"));
}
