//! Harness of the session orchestration tests (T14): Core's headless runtime with a real data
//! directory, the real Agent Host bundle on Node (`AgentHostLaunch::Custom`) and the strict
//! mock provider. Provider scripts are data (`scenarios/*.yaml`), so T15 can move these cases
//! into its scenario format.

#![allow(dead_code, reason = "each test uses a different subset of the helpers")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::sessions::SessionsConfig;
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use piarc_testkit::{MockProvider, RequestRecord, ScenarioLibrary};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

/// Safety net for every wait; assertions never depend on timing.
pub const WAIT: Duration = Duration::from_secs(30);

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the repository root")
        .to_path_buf()
}

pub fn node() -> PathBuf {
    std::env::var_os("PIARC_TEST_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from)
}

/// The Agent Host bundle, built once per test binary.
pub fn bundle() -> &'static (PathBuf, PathBuf) {
    static BUNDLE: OnceLock<Result<(PathBuf, PathBuf), String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| {
            let root = repo_root();
            let status = Command::new(node())
                .arg(
                    root.join("scripts")
                        .join("dev")
                        .join("build-agent-host.mjs"),
                )
                .current_dir(&root)
                .status()
                .map_err(|e| format!("cannot run node: {e}"))?;
            if !status.success() {
                return Err(format!("building the Agent Host bundle failed: {status}"));
            }
            let dir = root.join("agent-host").join("dist").join("bundle");
            Ok((dir.join("agent-host.mjs"), dir.join("pi-assets")))
        })
        .as_ref()
        .unwrap_or_else(|e| panic!("{e}"))
}

/// Everything Core delivered, as `(route, event)`, with a way to wait for more.
#[derive(Default)]
pub struct Events {
    all: Mutex<Vec<(String, Value)>>,
    arrived: Notify,
}

impl Events {
    pub fn all(&self) -> Vec<(String, Value)> {
        self.all.lock().expect("lock").clone()
    }

    /// Events of `route`, in delivery order.
    pub fn on(&self, route: &str) -> Vec<Value> {
        self.all()
            .into_iter()
            .filter(|(r, _)| r == route)
            .map(|(_, v)| v)
            .collect()
    }

    /// Waits for the first event (delivered before or after this call) that `pred` accepts.
    pub async fn until(&self, what: &str, pred: impl Fn(&str, &Value) -> bool) -> Value {
        let wait = async {
            loop {
                let notified = self.arrived.notified();
                if let Some((_, event)) = self.all().into_iter().find(|(r, v)| pred(r, v)) {
                    return event;
                }
                notified.await;
            }
        };
        tokio::time::timeout(WAIT, wait)
            .await
            .unwrap_or_else(|_| panic!("no {what} within {WAIT:?}; got {:#?}", self.all()))
    }

    /// Waits until `cond` holds for everything delivered so far.
    pub async fn wait(&self, what: &str, cond: impl Fn(&Self) -> bool) {
        let wait = async {
            loop {
                let notified = self.arrived.notified();
                if cond(self) {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(WAIT, wait)
            .await
            .unwrap_or_else(|_| panic!("not {what} within {WAIT:?}; got {:#?}", self.all()));
    }

    /// Waits for `turn/completed` of `turn_id` on session `id`; returns its params.
    pub async fn turn_completed(&self, id: &str, turn_id: &str) -> Value {
        let route = format!("session/{id}");
        let event = self
            .until("turn/completed", |r, v| {
                r == route && v["method"] == "turn/completed" && v["params"]["turnId"] == turn_id
            })
            .await;
        event["params"].clone()
    }

    /// The notifications of session `id` with `method`.
    pub fn of(&self, id: &str, method: &str) -> Vec<Value> {
        self.on(&format!("session/{id}"))
            .into_iter()
            .filter(|v| v["method"] == method)
            .map(|v| v["params"].clone())
            .collect()
    }
}

struct Sink(Arc<Events>);

impl EventSink for Sink {
    fn deliver(&self, batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        let mut all = self.0.all.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            let events: Vec<Value> =
                serde_json::from_slice(&batch.payload).expect("a batch is a JSON array");
            for event in events {
                all.push((batch.route.as_str().to_owned(), event));
            }
        }
        drop(all);
        self.0.arrived.notify_waiters();
        Ok(())
    }
}

/// One test's directories and mock provider.
pub struct Env {
    pub root: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    /// The workspace (its path has spaces and Chinese characters).
    pub ws: PathBuf,
    pub mock: MockProvider,
    pub key_store: Arc<MemorySecretStore>,
    /// The vault's master key name: one per environment, so a restarted Core finds its vault.
    pub master_key: piarc_ports::SecretName,
}

impl Env {
    /// Directories, Pi's `models.json` and `settings.json`, and the mock with every provider
    /// script of `scenarios/`.
    pub async fn new(name: &str) -> Self {
        Self::with_scenario(name, None).await
    }

    /// Adds a generated response when its input would be too large for a checked-in fixture.
    pub async fn with_scenario(name: &str, extra: Option<piarc_testkit::Scenario>) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc sessions {name} 中文 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        let data = root.join("data 数据");
        let cache = root.join("cache");
        let ws = root.join("work space 工作区");
        for dir in [data.join("pi"), cache.clone(), ws.clone()] {
            std::fs::create_dir_all(dir).expect("directory");
        }
        let scenarios = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("sessions")
            .join("scenarios");
        let mut library = ScenarioLibrary::load_paths(&[scenarios]).expect("provider scripts load");
        if let Some(scenario) = extra {
            library.insert(scenario).expect("generated scenario");
        }
        let mock = MockProvider::start(library).await.expect("mock starts");
        let models = json!({ "providers": { "piarc-mock": {
            "baseUrl": mock.anthropic_base_url(), "api": "anthropic-messages",
            "apiKey": "piarc-mock-test-key",
            "models": [{ "id": "mock-large", "name": "mock-large", "reasoning": false,
                "input": ["text"], "contextWindow": 200_000, "maxTokens": 4096,
                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }]
        }}});
        write_json(&data.join("pi").join("models.json"), &models);
        // These orchestration fixtures exercise tool execution after approval. Their user
        // preapproves only the calls used as barriers or batch boundaries (an `Edit` rule
        // covers Write, T23).
        write_json(
            &data.join("settings.json"),
            &json!({ "permissions": { "allow": [
                "Bash(while [ ! -f go ]; do sleep 0.05; done; echo go)",
                "Bash(sleep 30)", "Edit(files/out.txt)"
            ]}}),
        );
        // Retries wait milliseconds, not seconds.
        let settings = json!({ "retry": { "baseDelayMs": 5 } });
        write_json(&data.join("pi").join("settings.json"), &settings);
        Self {
            root,
            data,
            cache,
            ws,
            mock,
            key_store: Arc::new(MemorySecretStore::new()),
            master_key: test_master_key_name("sessions"),
        }
    }

    /// Core's settings for this environment; `extra_args` go to every Agent Host.
    pub fn config(&self, extra_args: &[&str]) -> CoreConfig {
        let (bundle, pi_assets) = bundle();
        CoreConfig {
            home: Some(self.root.join("home")),
            dirs: Some(DataDirs::new(self.data.clone(), self.cache.clone()).expect("absolute")),
            sessions: SessionsConfig {
                launch: Some(AgentHostLaunch::Custom {
                    node: node(),
                    bundle: bundle.clone(),
                    pi_package_dir: Some(pi_assets.clone()),
                    extra_args: extra_args.iter().map(Into::into).collect(),
                    extra_env: vec![("PI_OFFLINE".into(), "1".into())],
                }),
                ..SessionsConfig::default()
            },
            secret_store: Some(SecretStoreSetup {
                master_key: self.master_key.clone(),
                store: Arc::clone(&self.key_store) as _,
            }),
            // A fixed command environment: the runner's login shell is not part of these tests,
            // and cargo's `DYLD_*` (kept where SIP is off, as on CI's macOS) correctly turns off
            // the automatic allows that rely on resolving programs (T23).
            command_env: Some(piarc_core::tool_io::CommandEnv::Fixed(command_env())),
            ..CoreConfig::default()
        }
    }

    /// Starts Core with `config`.
    pub fn start(&self, config: CoreConfig) -> (CoreRuntime, Arc<Events>) {
        let events = Arc::new(Events::default());
        let core =
            CoreRuntime::start(config, Arc::new(Sink(Arc::clone(&events)))).expect("Core starts");
        (core, events)
    }

    /// The mock's requests for provider script `scenario`.
    pub fn requests(&self, scenario: &str) -> Vec<RequestRecord> {
        self.mock
            .records()
            .into_iter()
            .filter(|r| r.scenario.as_deref() == Some(scenario))
            .collect()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Best effort: a leftover directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).expect("serializes")).expect("written");
}

/// A callback for one of Core's request methods and the receiver of its result.
pub fn reply() -> (
    impl FnOnce(piarc_core::Result<Value>) + Send + 'static,
    oneshot::Receiver<piarc_core::Result<Value>>,
) {
    let (tx, rx) = oneshot::channel();
    (
        move |result| {
            let _ = tx.send(result);
        },
        rx,
    )
}

/// Waits for a result `reply()` delivers.
pub async fn answer(rx: oneshot::Receiver<piarc_core::Result<Value>>) -> piarc_core::Result<Value> {
    tokio::time::timeout(WAIT, rx)
        .await
        .expect("Core answered in time")
        .expect("Core answered")
}

/// Shuts Core down and waits for it.
pub async fn shutdown(core: CoreRuntime) {
    let (tx, rx) = oneshot::channel();
    core.shutdown(move || {
        let _ = tx.send(());
    })
    .expect("shutdown starts");
    tokio::time::timeout(WAIT, rx)
        .await
        .expect("shutdown in time")
        .expect("shutdown reported");
}

/// The mock's model.
pub fn mock_model() -> Option<piarc_protocol::session::ModelRef> {
    Some(piarc_protocol::session::ModelRef {
        provider: "piarc-mock".into(),
        id: "mock-large".into(),
    })
}

/// A prompt that selects provider script `scenario`.
pub fn prompt_text(text: &str, scenario: &str) -> String {
    format!("{text} [[piarc-scenario:{scenario}]]")
}

/// The texts of the user messages of a request body, in order (text blocks only; tool results
/// are left out).
pub fn user_texts(body: &str) -> Vec<String> {
    let request: Value = serde_json::from_str(body).expect("JSON request");
    request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "user")
        .flat_map(|m| match &m["content"] {
            Value::String(text) => vec![text.clone()],
            Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        })
        .collect()
}

/// The roles of a request's messages.
pub fn roles(body: &str) -> Vec<String> {
    let request: Value = serde_json::from_str(body).expect("JSON request");
    request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["role"].as_str().map(str::to_owned))
        .collect()
}

/// The variables commands get in these tests (as `exec_commands.rs` does).
fn command_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            ["PATH", "HOME", "SystemRoot", "ProgramFiles", "TEMP", "TMP"]
                .iter()
                .any(|name| k.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .collect()
}
