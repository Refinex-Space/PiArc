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
use piarc_core::secrets::{MemorySecretStore, SecretsConfig, SecretsService, test_master_key_name};
use piarc_core::tool_io::{ToolIo, ToolIoConfig};
use piarc_core::trust::TrustService;
use piarc_ports::BoxFuture;
use piarc_protocol::session::{ModelRef, SessionCreateParams, SessionEventNotification, SessionId};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_testkit::{MockProvider, RequestRecord, Scenario, ScenarioLibrary};
use serde_json::{Map, Value, json};

/// The scenario every request of the `mock-small` model (32k context window) uses.
pub const SMALL_WINDOW_SCENARIO: &str = "small-window";

/// Safety net for waits on the real Agent Host; assertions never depend on timing.
pub const WAIT: Duration = Duration::from_secs(20);

pub fn repo_root() -> PathBuf {
    // Not `canonicalize`: on Windows it gives a verbatim (`\\?\`) path, which Node cannot run a
    // script from.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the repository root")
        .to_path_buf()
}

/// The canonical spelling of an existing `path` as Core reports it: resolved links (macOS
/// `/private/var`), without the verbatim `\\?\` prefix `canonicalize` adds on Windows.
pub fn canonical(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).expect("the path exists");
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) if cfg!(windows) => PathBuf::from(plain),
        _ => canonical,
    }
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

/// Core's side of the connection: answers `trust/get` from a fixed set of trusted directories,
/// delegated tool I/O (`fs/*`, `exec/*`) with the real `ToolIo`, and records both; credentials
/// (`secrets/*`) with the real `SecretsService` over the data directory's vault, its master key
/// in an in-memory credential store.
pub struct Core {
    trusted: Vec<String>,
    /// When set, `trust/get` is answered by Core's real trust service instead of `trusted`.
    pub trust: Option<TrustService>,
    pub asked: Mutex<Vec<String>>,
    /// Faults to inject in the next preflights; an empty queue explicitly allows the call.
    pub policy_answers: Mutex<std::collections::VecDeque<Result<Value, ErrorObject>>>,
    pub io: ToolIo,
    pub secrets: SecretsService,
    pub calls: Arc<Mutex<Vec<Call>>>,
}

/// One `fs/*` or `exec/*` request Core answered.
#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub session: String,
    /// `origin.tool`: the canonical tool name the Agent Host sent.
    pub tool: Option<String>,
    /// The path as requested.
    pub path: Option<String>,
    /// The resolved path of a successful file operation.
    pub resolved: Option<String>,
    /// The error kind of a failed request.
    pub error: Option<String>,
}

impl Core {
    /// The recorded calls of `session`.
    pub fn calls_of(&self, session: &str) -> Vec<Call> {
        self.calls
            .lock()
            .expect("lock")
            .iter()
            .filter(|c| c.session == session)
            .cloned()
            .collect()
    }
}

impl InboundHandler for Core {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        // This harness tests delegation, scheduling and Pi parity. Its operator approves
        // every preflight. The scenario runner exercises the production approval ledger.
        if method == "policy/evaluate" {
            let reply = self
                .policy_answers
                .lock()
                .expect("policy queue")
                .pop_front()
                .unwrap_or_else(|| Ok(json!({"allowed": true})));
            return Box::pin(async move { reply });
        }
        if method == "policy/recover" {
            return Box::pin(async { Ok(json!({})) });
        }
        if method == "trust/get" {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            self.asked.lock().expect("lock").push(path.clone());
            if let Some(trust) = self.trust.clone() {
                return Box::pin(async move { trust.trust_get(params).await });
            }
            let trusted = self.trusted.contains(&path);
            return Box::pin(async move { Ok(json!({ "trusted": trusted })) });
        }
        if SecretsService::handles(&method) {
            let secrets = self.secrets.clone();
            return Box::pin(async move { secrets.dispatch(&method, params, peer).await });
        }
        if !ToolIo::handles(&method) {
            return Box::pin(async move {
                Err(ErrorObject::new(
                    ErrorKind::MethodNotFound,
                    format!("unexpected {method}"),
                    false,
                ))
            });
        }
        let text = |name: &str| params.get(name).and_then(Value::as_str).map(str::to_owned);
        let mut call = Call {
            method: method.clone(),
            session: text("sessionId").unwrap_or_default(),
            tool: params
                .get("origin")
                .and_then(|o| o.get("tool"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            path: text("path").or_else(|| text("command")),
            resolved: None,
            error: None,
        };
        let io = self.io.clone();
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            let result = io.dispatch(&method, params, peer).await;
            match &result {
                Ok(value) => {
                    call.resolved = value.get("path").and_then(Value::as_str).map(str::to_owned);
                }
                Err(error) => call.error = Some(format!("{:?}", error.data.kind)),
            }
            calls.lock().expect("lock").push(call);
            result
        })
    }
}

/// One test's files, mock provider and Agent Host./// One test's files, mock provider and Agent Host.
pub struct Env {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    /// Core's vault service: the data directory's vault, its master key in an in-memory store.
    pub secrets: SecretsService,
    pub key_store: Arc<MemorySecretStore>,
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
        // Reads images (T07: the image path of Read is compared with Pi's own).
        let mut vision = model("mock-vision", 200_000);
        vision["input"] = json!(["text", "image"]);
        let models = json!({ "providers": { "piarc-mock": {
            "baseUrl": mock.anthropic_base_url(), "api": "anthropic-messages", "apiKey": "piarc-mock-test-key",
            "models": [model("mock-large", 200_000), small, vision]
        }}});
        write_json(&data_dir.join("pi").join("models.json"), &models);
        write_json(&data_dir.join("pi").join("settings.json"), &settings);
        let key_store = Arc::new(MemorySecretStore::new());
        let secrets = SecretsService::new(
            SecretsConfig::with_master_key(&data_dir, test_master_key_name("e2e")),
            Arc::clone(&key_store) as _,
        );
        Self {
            root,
            data_dir,
            secrets,
            key_store,
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
    pub fn start(&self, trusted: &[&Path]) -> (HostSupervisor, Recorder, Arc<Core>) {
        self.start_with(self.config(), trusted)
    }

    /// As [`Env::start`] with adjusted supervisor settings. Every Agent Host of one `Env` gets
    /// the same `SecretsService`, as every Agent Host of one Core does.
    pub fn start_with(
        &self,
        config: HostConfig,
        trusted: &[&Path],
    ) -> (HostSupervisor, Recorder, Arc<Core>) {
        self.start_core(config, trusted, None)
    }

    /// As [`Env::start`], with `trust/get` answered by Core's trust service `trust`.
    pub fn start_with_trust(&self, trust: TrustService) -> (HostSupervisor, Recorder, Arc<Core>) {
        self.start_core(self.config(), &[], Some(trust))
    }

    fn start_core(
        &self,
        config: HostConfig,
        trusted: &[&Path],
        trust: Option<TrustService>,
    ) -> (HostSupervisor, Recorder, Arc<Core>) {
        let secrets = self.secrets.clone();
        let core = Arc::new(Core {
            trust,
            trusted: trusted
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            asked: Mutex::default(),
            policy_answers: Mutex::default(),
            io: ToolIo::new(ToolIoConfig::new(self.data_dir.clone())),
            secrets,
            calls: Arc::default(),
        });
        let (supervisor, events) =
            agent_host::start(config, Arc::clone(&core) as Arc<dyn InboundHandler>);
        (
            supervisor,
            Recorder {
                events,
                all: Vec::new(),
            },
            core,
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

    /// The final tool items of `session_id` (every item type that carries a `tool`).
    pub fn tool_results(&self, session_id: &str) -> Vec<Value> {
        self.notifications(session_id)
            .into_iter()
            .filter(|n| n.method == "item/completed")
            .map(|n| payload(n)["item"].clone())
            .filter(|item| item.get("tool").is_some())
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

/// Opens a session in `cwd` with `model_id`, registers `cwd` as its workspace root with Core's
/// tool I/O, and returns its id.
pub async fn open(
    supervisor: &HostSupervisor,
    core: &Core,
    cwd: &str,
    model_id: &str,
) -> SessionId {
    let id = supervisor
        .create_session(SessionCreateParams::new(cwd).with_model(model(model_id)))
        .await
        .expect("session opens")
        .session_id;
    core.io
        .open_session(&id.0, Path::new(cwd), Path::new(cwd))
        .expect("Core knows the session's workspace");
    id
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

/// Loads the I/O spy (`packages/testkit/src/io-spy.ts`) into the Agent Host: its `fs` calls on
/// paths inside `roots` and all its `child_process` calls are written to the returned file when
/// it exits.
pub fn with_io_spy(config: &mut HostConfig, root: &Path, roots: &[PathBuf]) -> PathBuf {
    let report = root.join("io-spy.json");
    let spy = repo_root()
        .join("packages")
        .join("testkit")
        .join("src")
        .join("io-spy.ts");
    let mut watched: Vec<PathBuf> = roots.to_vec();
    // The Agent Host uses the paths as given; canonical spellings (macOS /private/var) count too.
    watched.extend(roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()));
    config.extra_env.push((
        "NODE_OPTIONS".into(),
        format!("--import={}", file_url(&spy)).into(),
    ));
    config.extra_env.push((
        "PIARC_IO_SPY_ROOTS".into(),
        std::env::join_paths(&watched).expect("joinable roots"),
    ));
    config
        .extra_env
        .push(("PIARC_IO_SPY_REPORT".into(), report.clone().into()));
    report
}

/// Milliseconds since the Unix epoch, comparable with the spy's `at`.
pub fn now_ms() -> u64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch");
    u64::try_from(since.as_millis()).expect("fits")
}

/// The spy's records: `{ module, fn, path?, at, stack }`.
pub fn spy_report(report: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(report).expect("the Agent Host wrote the spy report");
    serde_json::from_str(&text).expect("spy report is JSON")
}

/// A `file://` URL for `path` (Node's `--import` needs one on Windows).
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut url = String::from(if text.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            url.push(char::from(byte));
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

/// The tools a request offered the model: `(name, description)` in order.
pub fn offered_tools(body: &str) -> Vec<(String, String)> {
    let request: Value = serde_json::from_str(body).expect("JSON request");
    request["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .map(|t| {
                    (
                        t["name"].as_str().unwrap_or_default().to_owned(),
                        t["description"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The tool results of a request's history: `(tool_use name, text, is_error)` in order.
pub fn tool_results_in(body: &str) -> Vec<(String, String, bool)> {
    let request: Value = serde_json::from_str(body).expect("JSON request");
    let mut names = std::collections::HashMap::new();
    let mut results = Vec::new();
    for message in request["messages"].as_array().into_iter().flatten() {
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("tool_use") => {
                    names.insert(
                        block["id"].as_str().unwrap_or_default().to_owned(),
                        block["name"].as_str().unwrap_or_default().to_owned(),
                    );
                }
                Some("tool_result") => {
                    // Images appear as `[image <media type> <base64 data>]`.
                    let text = match &block["content"] {
                        Value::String(text) => text.clone(),
                        Value::Array(parts) => parts
                            .iter()
                            .map(|p| match p["type"].as_str() {
                                Some("image") => format!(
                                    "[image {} {}]",
                                    p["source"]["media_type"].as_str().unwrap_or_default(),
                                    p["source"]["data"].as_str().unwrap_or_default()
                                ),
                                _ => p["text"].as_str().unwrap_or_default().to_owned(),
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    let id = block["tool_use_id"].as_str().unwrap_or_default();
                    results.push((
                        names.get(id).cloned().unwrap_or_default(),
                        text,
                        block["is_error"].as_bool().unwrap_or(false),
                    ));
                }
                _ => {}
            }
        }
    }
    results
}

/// Routes Core's tracing output, which carries every Agent Host stderr line, to a log file for
/// this test binary and returns its path. Installed once; later calls return the same file.
pub fn capture_logs() -> &'static Path {
    static LOG: OnceLock<PathBuf> = OnceLock::new();
    LOG.get_or_init(|| {
        let path =
            std::env::temp_dir().join(format!("piarc e2e core log {}.log", std::process::id()));
        let file = std::fs::File::create(&path).expect("log file");
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Mutex::new(file))
            .with_ansi(false)
            .finish();
        tracing::subscriber::set_global_default(subscriber).expect("first subscriber");
        path
    })
}
