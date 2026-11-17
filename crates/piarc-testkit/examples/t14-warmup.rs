//! T14-A09, the warm-up measurement: `cargo run --release -p piarc-testkit --example t14-warmup`.
//!
//! Each of 10 rounds starts a fresh Core on the same data directory and measures
//!
//! - `open_workspace` until the Agent Host is ready (handshake complete), and
//! - `open_workspace` plus `resume_session` of a session with history (the session reopened
//!   from its file),
//!
//! with the real Agent Host bundle on the `node` of PATH (or `PIARC_TEST_NODE`). It prints every
//! measurement and the maximum, and fails when a maximum exceeds the budget of architecture
//! chapter 11 (1.0 s).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::sessions::{Op, SessionsConfig};
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use piarc_protocol::session::ModelRef;
use piarc_testkit::{MockProvider, Scenario, ScenarioLibrary};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const BUDGET: Duration = Duration::from_secs(1);
const ROUNDS: usize = 10;

struct Quiet;

impl EventSink for Quiet {
    fn deliver(&self, _: Vec<EventBatch>, _: DeliveryDone) -> Result<(), SinkClosed> {
        Ok(())
    }
}

async fn call(
    f: impl FnOnce(Box<dyn FnOnce(piarc_core::Result<Value>) + Send>) -> piarc_core::Result<()>,
) -> Value {
    let (tx, rx) = oneshot::channel();
    f(Box::new(move |result| {
        let _ = tx.send(result);
    }))
    .expect("queued");
    rx.await.expect("answered").expect("succeeded")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repository root")
        .to_path_buf()
}

/// The directories, the mock and Core's settings of the measurement.
struct Setup {
    base: PathBuf,
    ws: PathBuf,
    config: CoreConfig,
    /// Kept alive for the whole run.
    _mock: MockProvider,
}

async fn setup() -> Setup {
    let root = repo_root();
    let node =
        std::env::var_os("PIARC_TEST_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from);
    let status = Command::new(&node)
        .arg(
            root.join("scripts")
                .join("dev")
                .join("build-agent-host.mjs"),
        )
        .current_dir(&root)
        .status()
        .expect("node runs");
    assert!(status.success(), "building the Agent Host bundle failed");
    let bundle = root.join("agent-host").join("dist").join("bundle");
    let base = std::env::temp_dir().join(format!("piarc t14 warmup 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (data, cache, ws) = (
        base.join("data"),
        base.join("cache"),
        base.join("ws 工作区"),
    );
    for dir in [data.join("pi"), cache.clone(), ws.clone()] {
        std::fs::create_dir_all(dir).expect("directories");
    }
    let script = "id: chat\nsteps:\n  - text: \"An answer to keep.\"\n";
    let mock = MockProvider::start(
        ScenarioLibrary::new()
            .with(Scenario::from_yaml_str("warmup", script).expect("script"))
            .expect("library"),
    )
    .await
    .expect("mock");
    let models = json!({ "providers": { "piarc-mock": {
        "baseUrl": mock.anthropic_base_url(), "api": "anthropic-messages", "apiKey": "k",
        "models": [{ "id": "mock-large", "name": "mock-large", "reasoning": false, "input": ["text"],
            "contextWindow": 200_000, "maxTokens": 4096,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }] } } });
    std::fs::write(data.join("pi").join("models.json"), models.to_string()).expect("models");
    let config = CoreConfig {
        dirs: Some(DataDirs::new(data, cache).expect("dirs")),
        sessions: SessionsConfig {
            launch: Some(AgentHostLaunch::Custom {
                node,
                bundle: bundle.join("agent-host.mjs"),
                pi_package_dir: Some(bundle.join("pi-assets")),
                extra_args: Vec::new(),
                extra_env: vec![("PI_OFFLINE".into(), "1".into())],
            }),
            ..SessionsConfig::default()
        },
        secret_store: Some(SecretStoreSetup {
            master_key: test_master_key_name("warmup"),
            store: Arc::new(MemorySecretStore::new()),
        }),
        ..CoreConfig::default()
    };
    Setup {
        base,
        ws,
        config,
        _mock: mock,
    }
}

/// A session with a conversation to reopen; returns its id.
async fn seed_session(setup: &Setup) -> String {
    let core = CoreRuntime::start(setup.config.clone(), Arc::new(Quiet)).expect("Core");
    let model = Some(ModelRef {
        provider: "piarc-mock".into(),
        id: "mock-large".into(),
    });
    let session = call(|done| core.create_session(setup.ws.clone(), None, model, done)).await;
    let id = session["sessionId"].as_str().expect("id").to_owned();
    let prompt = Op::Prompt("Hello [[piarc-scenario:chat]]".into());
    call(|done| core.session_op(id.clone(), prompt, done)).await;
    // The measurement needs the answer in the session file.
    let sessions = setup.base.join("data").join("pi").join("sessions");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !answer_saved(&sessions) {
        assert!(Instant::now() < deadline, "the answer was not saved");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    stop(core).await;
    id
}

#[tokio::main]
async fn main() {
    let setup = setup().await;
    let id = seed_session(&setup).await;
    let (mut opens, mut resumes) = (Vec::new(), Vec::new());
    for round in 1..=ROUNDS {
        let core = CoreRuntime::start(setup.config.clone(), Arc::new(Quiet)).expect("Core");
        let started = Instant::now();
        let view = call(|done| core.open_workspace(setup.ws.clone(), done)).await;
        let open = started.elapsed();
        assert_eq!(view["host"], "ready");
        let resumed = call(|done| core.resume_session(id.clone(), done)).await;
        let with_resume = started.elapsed();
        assert!(
            resumed["restoredMessages"].as_u64().is_some_and(|n| n >= 2),
            "{resumed}"
        );
        println!(
            "round {round:2}: open to ready {:6.1} ms, open + resume {:6.1} ms",
            ms(open),
            ms(with_resume)
        );
        opens.push(open);
        resumes.push(with_resume);
        stop(core).await;
    }
    let (max_open, max_resume) = (max(&opens), max(&resumes));
    println!(
        "max of {ROUNDS}: open to ready {:.1} ms, open + resume {:.1} ms (budget {} ms)",
        ms(max_open),
        ms(max_resume),
        BUDGET.as_millis()
    );
    let _ = std::fs::remove_dir_all(&setup.base);
    assert!(
        max_open <= BUDGET && max_resume <= BUDGET,
        "over the warm-up budget"
    );
}

fn answer_saved(sessions: &Path) -> bool {
    let files = std::fs::read_dir(sessions)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|group| {
            std::fs::read_dir(group.path())
                .into_iter()
                .flatten()
                .flatten()
        });
    files
        .filter_map(|file| std::fs::read_to_string(file.path()).ok())
        .any(|text| text.contains("An answer to keep."))
}

async fn stop(core: CoreRuntime) {
    let (tx, rx) = oneshot::channel();
    core.shutdown(move || {
        let _ = tx.send(());
    })
    .expect("shutdown");
    rx.await.expect("stopped");
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn max(values: &[Duration]) -> Duration {
    values.iter().copied().max().unwrap_or_default()
}
