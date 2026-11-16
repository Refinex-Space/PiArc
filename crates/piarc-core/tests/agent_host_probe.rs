//! `CoreRuntime::run_agent_host_probe` (T12): the probe runs on Core's own runtime, which must
//! be able to start and talk to processes.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;

use piarc_core::host_probe::ProbeOptions;
use piarc_core::{CoreConfig, CoreRuntime, DeliveryDone, EventBatch, EventSink, SinkClosed};
use piarc_protocol::session::ModelRef;

struct NullSink;

impl EventSink for NullSink {
    fn deliver(&self, _batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        Ok(())
    }
}

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("piarc probe 探针 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("root");
    root.canonicalize().expect("canonical")
}

/// A packaged layout whose `node` exits at once, so the Agent Host never connects.
fn broken_resources(root: &std::path::Path) -> PathBuf {
    let agent_host = root.join("Resources").join("agent-host");
    let bin = agent_host.join("node").join("bin");
    std::fs::create_dir_all(&bin).expect("node/bin");
    std::fs::create_dir_all(agent_host.join("pi-assets")).expect("pi-assets");
    std::fs::write(agent_host.join("agent-host.mjs"), "").expect("bundle");
    let node = bin.join("node");
    std::fs::write(&node, "#!/bin/sh\nexit 3\n").expect("node");
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    root.join("Resources")
}

#[test]
fn a_probe_whose_agent_host_exits_reports_an_error() {
    let root = temp_root();
    let resources = broken_resources(&root);
    let workspace = root.join("ws");
    let data_dir = root.join("data");
    std::fs::create_dir_all(&workspace).expect("ws");
    std::fs::create_dir_all(&data_dir).expect("data");
    let core = CoreRuntime::start(
        CoreConfig {
            coalesce_interval: Duration::from_millis(16),
        },
        Arc::new(NullSink),
    )
    .expect("runtime starts");
    let (tx, rx) = channel();
    core.run_agent_host_probe(
        ProbeOptions {
            resources_dir: resources,
            workspace,
            data_dir,
            model: ModelRef {
                provider: "none".into(),
                id: "none".into(),
            },
            prompt: "unused".into(),
            timeout: Duration::from_secs(20),
        },
        move |report| {
            let _ = tx.send(report);
        },
    )
    .expect("probe starts");
    let report = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the probe reports back instead of panicking the runtime");
    let error = report.expect_err("the Agent Host never connected");
    assert!(
        error.to_string().contains("exited before the handshake"),
        "{error}"
    );
    core.shutdown_blocking().expect("Core stops");
    std::fs::remove_dir_all(root).expect("cleanup");
}
