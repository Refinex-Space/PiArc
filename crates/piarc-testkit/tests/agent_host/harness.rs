//! Harness for the end-to-end Agent Host tests: the real bundled Agent Host on Node, supervised
//! by Core's headless entry (`piarc_core::agent_host`), with the strict mock provider as the
//! model service. Each test gets its own temporary root with a data directory and two
//! workspaces whose paths contain spaces and Chinese characters.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use piarc_core::agent_host::{
    self, HostConfig, HostEvent, HostEvents, HostSupervisor, InboundHandler, Peer,
};
use piarc_ports::BoxFuture;
use piarc_protocol::session::{ModelRef, SessionEventNotification, SessionId};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_testkit::{MockProvider, RequestRecord, Scenario, ScenarioLibrary};
use serde_json::{Map, Value, json};

/// The scenario every request of the `mock-small` model (32k context window) uses.
pub const SMALL_WINDOW_SCENARIO: &str = "small-window";

/// Safety net for waits on the real Agent Host; assertions never depend on timing.
pub const WAIT: Duration = Duration::from_secs(20);

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the repository root exists")
}

/// The Node executable: `PIARC_TEST_NODE`, or `node` from PATH.
pub fn node() -> PathBuf {
    std::env::var_os("PIARC_TEST_NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from)
}

/// The Agent Host bundle, built once per test binary with `scripts/dev/build-agent-host.mjs`.
pub struct Bundle {
    pub file: PathBuf,
    pub pi_assets: PathBuf,
}

pub fn bundle() -> &'static Bundle {
    static BUNDLE: OnceLock<Result<Bundle, String>> = OnceLock::new();
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
            Ok(Bundle {
                file: dir.join("agent-host.mjs"),
                pi_assets: dir.join("pi-assets"),
            })
        })
        .as_ref()
        .unwrap_or_else(|e| panic!("{e}"))
}

/// The stdio MCP fixture server (`packages/testkit/src/mcp-echo-server.ts`).
pub fn mcp_fixture() -> PathBuf {
    repo_root()
        .join("packages")
        .join("testkit")
        .join("src")
        .join("mcp-echo-server.ts")
}

/// Answers `trust/get` from a fixed set of trusted directories and records the questions.
#[derive(Default)]
pub struct Trust {
    trusted: Vec<String>,
    pub asked: Mutex<Vec<String>>,
}

impl InboundHandler for Trust {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        _peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.asked.lock().expect("lock").push(path.clone());
        let trusted = self.trusted.contains(&path);
        Box::pin(async move {
            if method == "trust/get" {
                Ok(json!({ "trusted": trusted }))
            } else {
                Err(ErrorObject::new(
                    ErrorKind::MethodNotFound,
                    format!("unexpected {method}"),
                    false,
                ))
            }
        })
    }
}

/// One test's files, mock provider and Agent Host.
pub struct Env {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    /// Two session working directories.
    pub ws: [PathBuf; 2],
    pub mock: MockProvider,
}

impl Env {
    /// Creates the directories, starts the mock with `scenarios` (YAML) and writes Pi's
    /// `models.json` and `settings.json` into `<data>/pi/`.
    pub async fn new(name: &str, scenarios: &[&str], settings: Value) -> Self {
        let root =
            std::env::temp_dir().join(format!("piarc e2e {name} 中文 {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("old root removed");
        }
        let data_dir = root.join("data");
        let ws = [root.join("ws a 甲"), root.join("ws b 乙")];
        for dir in [&data_dir.join("pi"), &ws[0], &ws[1]] {
            std::fs::create_dir_all(dir).expect("directory created");
        }
        let mut library = ScenarioLibrary::new();
        for yaml in scenarios {
            library
                .insert(Scenario::from_yaml_str("test", yaml).expect("valid scenario"))
                .expect("unique id");
        }
        let mock = MockProvider::start(library).await.expect("mock starts");
        let model = |id: &str, window: u64| {
            json!({ "id": id, "name": id, "reasoning": false, "input": ["text"],
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                    "contextWindow": window, "maxTokens": 4096 })
        };
        // Compaction replaces the first user message, and with it a scenario marker, so every
        // request of `mock-small` selects its scenario by header.
        let mut small = model("mock-small", 32_000);
        small["headers"] = json!({ "x-piarc-scenario": SMALL_WINDOW_SCENARIO });
        let models = json!({ "providers": { "piarc-mock": {
            "baseUrl": mock.anthropic_base_url(), "api": "anthropic-messages", "apiKey": "piarc-mock-test-key",
            "models": [model("mock-large", 200_000), small]
        }}});
        write_json(&data_dir.join("pi").join("models.json"), &models);
        write_json(&data_dir.join("pi").join("settings.json"), &settings);
        Self {
            root,
            data_dir,
            ws,
            mock,
        }
    }

    /// Supervisor settings for this environment.
    pub fn config(&self) -> HostConfig {
        let bundle = bundle();
        let mut config = HostConfig::new(
            self.root.clone(),
            self.data_dir.clone(),
            node(),
            bundle.file.clone(),
        );
        config.pi_package_dir = Some(bundle.pi_assets.clone());
        // No network: the model catalog is never refreshed.
        config.extra_env.push(("PI_OFFLINE".into(), "1".into()));
        config
    }

    /// Starts the real Agent Host; `trusted` directories get project-level Pi resources.
    pub fn start(&self, trusted: &[&Path]) -> (HostSupervisor, Recorder, Arc<Trust>) {
        self.start_with(self.config(), trusted)
    }

    /// As [`Env::start`] with adjusted supervisor settings.
    pub fn start_with(
        &self,
        config: HostConfig,
        trusted: &[&Path],
    ) -> (HostSupervisor, Recorder, Arc<Trust>) {
        let trust = Arc::new(Trust {
            trusted: trusted
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            asked: Mutex::default(),
        });
        let (supervisor, events) =
            agent_host::start(config, Arc::clone(&trust) as Arc<dyn InboundHandler>);
        (
            supervisor,
            Recorder {
                events,
                all: Vec::new(),
            },
            trust,
        )
    }

    pub fn cwd(&self, index: usize) -> String {
        self.ws[index].to_string_lossy().into_owned()
    }

    /// The mock's request log for one scenario selector.
    pub fn requests(&self, selector: &str) -> Vec<RequestRecord> {
        self.mock
            .records()
            .into_iter()
            .filter(|r| r.scenario.as_deref() == Some(selector))
            .collect()
    }

    /// Session entries Pi persisted for `session_id` (JSONL under `<data>/pi/sessions/`).
    pub fn session_entries(&self, session_id: &str) -> Vec<Value> {
        let sessions = self.data_dir.join("pi").join("sessions");
        let mut found = Vec::new();
        for dir in std::fs::read_dir(&sessions)
            .expect("sessions directory")
            .flatten()
        {
            for file in std::fs::read_dir(dir.path())
                .expect("session group")
                .flatten()
            {
                let text = std::fs::read_to_string(file.path()).expect("session file reads");
                let entries: Vec<Value> = text
                    .lines()
                    .map(|l| serde_json::from_str(l).expect("JSONL entry"))
                    .collect();
                if entries.first().is_some_and(|e| e["id"] == session_id) {
                    found = entries;
                }
            }
        }
        found
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Best effort: a leftover temp directory does not affect other tests.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).expect("serializes"))
        .expect("file written");
}

/// Records every event while waiting for specific ones.
pub struct Recorder {
    events: HostEvents,
    pub all: Vec<HostEvent>,
}

impl Recorder {
    /// Waits for the first event (seen before or after this call) matching `pred`.
    pub async fn until(&mut self, pred: impl Fn(&HostEvent) -> bool) -> HostEvent {
        if let Some(event) = self.all.iter().find(|e| pred(e)) {
            return event.clone();
        }
        loop {
            let event = tokio::time::timeout(WAIT, self.events.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!("no matching event within {WAIT:?}; saw {:#?}", self.all)
                })
                .expect("the event stream is open");
            self.all.push(event.clone());
            if pred(&event) {
                return event;
            }
        }
    }

    /// Waits for `turn/completed` of `turn_id` and returns its params.
    pub async fn turn_completed(&mut self, turn_id: &str) -> Value {
        let event = self
            .until(|e| {
                notification(e).is_some_and(|n| {
                    n.method == "turn/completed" && payload(n)["turnId"] == turn_id
                })
            })
            .await;
        notification(&event).map(payload).expect("a notification")
    }

    /// The notifications of `session_id`, in arrival order.
    pub fn notifications(&self, session_id: &str) -> Vec<&SessionEventNotification> {
        self.all
            .iter()
            .filter_map(notification)
            .filter(|n| n.params.header.session_id.0 == session_id)
            .collect()
    }

    /// Notifications passing `keep` (by method), as `A:<method>:<status>` for session `a` and
    /// `B:...` for any other session, in arrival order.
    pub fn labelled(&self, a: &SessionId, keep: impl Fn(&str) -> bool) -> Vec<String> {
        self.all
            .iter()
            .filter_map(notification)
            .filter(|n| keep(&n.method))
            .map(|n| {
                let who = if &n.params.header.session_id == a {
                    "A"
                } else {
                    "B"
                };
                let status = payload(n)["status"].as_str().unwrap_or("-").to_owned();
                format!("{who}:{}:{status}", n.method)
            })
            .collect()
    }

    /// The final `dynamicToolCall` items of `session_id`.
    pub fn tool_results(&self, session_id: &str) -> Vec<Value> {
        self.notifications(session_id)
            .into_iter()
            .filter(|n| n.method == "item/completed")
            .map(|n| payload(n)["item"].clone())
            .filter(|item| item["type"] == "dynamicToolCall")
            .collect()
    }
}

pub fn notification(event: &HostEvent) -> Option<&SessionEventNotification> {
    match event {
        HostEvent::Notification { notification, .. } => Some(notification),
        _ => None,
    }
}

/// The method-specific members of a notification.
pub fn payload(notification: &SessionEventNotification) -> Value {
    Value::Object(notification.params.payload.clone())
}

pub fn model(id: &str) -> Option<ModelRef> {
    Some(ModelRef {
        provider: "piarc-mock".into(),
        id: id.into(),
    })
}

/// Opens a session in `cwd` with `model_id` and returns its id.
pub async fn open(supervisor: &HostSupervisor, cwd: &str, model_id: &str) -> SessionId {
    supervisor
        .create_session(cwd, model(model_id))
        .await
        .expect("session opens")
        .session_id
}

/// A prompt that selects mock scenario `selector`.
pub fn prompt_text(text: &str, selector: &str) -> String {
    format!("{text} [[piarc-scenario:{selector}]]")
}

/// Asserts that every session's `seq` runs 1, 2, 3, ... without gaps or repeats.
pub fn assert_contiguous_seq(recorder: &Recorder, session_id: &str) -> usize {
    let seqs: Vec<u64> = recorder
        .notifications(session_id)
        .iter()
        .map(|n| n.params.header.seq)
        .collect();
    let expected: Vec<u64> = (1..=u64::try_from(seqs.len()).expect("small")).collect();
    assert_eq!(seqs, expected, "seq of session {session_id}");
    seqs.len()
}

/// The `host/ping` status: the Agent Host's resident memory and queue counters.
pub async fn ping(supervisor: &HostSupervisor) -> piarc_protocol::host::HostStatus {
    supervisor
        .call::<piarc_protocol::host::HostPing>(piarc_protocol::host::HostPingParams { sent_at: 0 })
        .await
        .expect("ping answered")
}
