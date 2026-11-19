//! Runs one scenario: a temporary root (its path has spaces and Chinese characters), one
//! strict mock per endpoint, Core's headless runtime with the real Agent Host bundle, the
//! actions, then every assertion. The runner only drives Core through its public API and
//! observes what Core delivers; it has no copy of Core's logic.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use piarc_core::agent_host::AgentHostLaunch;
use piarc_core::composer::UserInput;
use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::sessions::{ModelOp, Op, QueueOp, SessionsConfig};
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use super::checks::{check_files, check_fixture_files, check_requests};
pub use super::fixtures::INTERNAL_PROBES;
use super::fixtures::{command_env, prepare_workspace, resolve, write_file, write_json};
use super::format::{Action, EndpointSetup, InputAction, ScenarioSpec, Wire};
use super::gate::Gate;
use super::matcher::subset_mismatch;
use super::matcher::{ObservedEvent, check_events, compact, describe, matches, without_noise};
use crate::record::RequestRecord;
use crate::scenario::{Scenario, ScenarioLibrary};
use crate::server::MockProvider;

/// Safety net for every wait; no assertion depends on timing.
pub const WAIT: Duration = Duration::from_secs(30);

/// The Pi model id every endpoint offers.
pub const MOCK_MODEL: &str = "mock-model";

const L2_CREDENTIAL: &str = "piarc-l2-fake-vault-credential";

/// How to start the Agent Host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerConfig {
    /// The Node executable.
    pub node: PathBuf,
    /// The esbuild bundle `agent-host.mjs`.
    pub bundle: PathBuf,
    /// Pi's package directory next to it (`PI_PACKAGE_DIR`).
    pub pi_assets: PathBuf,
}

impl RunnerConfig {
    /// Builds the Agent Host bundle with `scripts/dev/build-agent-host.mjs` under `repo` and
    /// returns where it is. Node is `PIARC_TEST_NODE`, else `node` on `PATH`.
    ///
    /// # Errors
    ///
    /// A description when Node cannot run or the build fails.
    pub fn build(repo: &Path) -> Result<Self, String> {
        let node = std::env::var_os("PIARC_TEST_NODE")
            .map_or_else(|| PathBuf::from("node"), PathBuf::from);
        let script = repo
            .join("scripts")
            .join("dev")
            .join("build-agent-host.mjs");
        let status = Command::new(&node)
            .arg(&script)
            .current_dir(repo)
            .status()
            .map_err(|e| format!("cannot run {}: {e}", node.display()))?;
        if !status.success() {
            return Err(format!("building the Agent Host bundle failed: {status}"));
        }
        let dir = repo.join("agent-host").join("dist").join("bundle");
        Ok(Self {
            node,
            bundle: dir.join("agent-host.mjs"),
            pi_assets: dir.join("pi-assets"),
        })
    }
}

/// What one run produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// Every assertion that failed, each a readable report.
    pub failures: Vec<Failure>,
    /// The temporary root the scenario ran in.
    pub root: PathBuf,
    /// The root was removed afterwards.
    pub cleaned: bool,
}

/// One failed assertion.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Failure {
    /// `setup`, `action`, `events`, `files`, `requests`, `approvals`, `tool_batches`,
    /// `core_io`, `cleanup`.
    pub kind: &'static str,
    /// Readable report.
    pub message: String,
}

fn failure(kind: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        kind,
        message: message.into(),
    }
}

/// Runs `spec` on its own tokio runtime.
#[must_use]
pub fn run(spec: &ScenarioSpec, config: &RunnerConfig) -> RunOutcome {
    static RUNS: AtomicU64 = AtomicU64::new(0);
    let run = RUNS.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "piarc l2 {} 中文 {}-{run}",
        spec.id,
        std::process::id()
    ));
    let mut failures = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(run_in(spec, config, &root)),
        Err(e) => vec![failure("setup", format!("no tokio runtime: {e}"))],
    };
    let cleaned = match std::fs::remove_dir_all(&root) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            failures.push(failure(
                "cleanup",
                format!("cannot remove {}: {e}", root.display()),
            ));
            false
        }
    };
    RunOutcome {
        failures,
        root,
        cleaned,
    }
}

async fn run_in(spec: &ScenarioSpec, config: &RunnerConfig, root: &Path) -> Vec<Failure> {
    let env = match Env::prepare(spec, config, root).await {
        Ok(env) => env,
        Err(e) => return vec![failure("setup", e)],
    };
    let events = Arc::new(Events::default());
    let core = match env.start_core(&events) {
        Ok(core) => core,
        Err(e) => return vec![failure("setup", e)],
    };
    let mut driver = Driver {
        spec,
        env: &env,
        core,
        events: &events,
        sessions: BTreeMap::new(),
        turns: BTreeMap::new(),
        unlabeled_turns: Vec::new(),
        items: BTreeMap::new(),
        answered: BTreeSet::new(),
        approval_cursor: 0,
    };
    let mut failures = match driver.drive().await {
        Ok(()) => driver.assert_all(),
        Err(e) => vec![failure("action", format!("{e}\n{}", driver.context()))],
    };
    if let Err(e) = shutdown(&driver.core).await {
        failures.push(failure("cleanup", e));
    }
    failures
}

/// The directories, mocks and Pi configuration of one run.
struct Env {
    workspace: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    home: PathBuf,
    mocks: BTreeMap<String, MockProvider>,
    gate: Arc<Gate>,
    /// Kept across Core restarts, so a restarted Core finds its vault's master key.
    key_store: Arc<MemorySecretStore>,
    master_key: piarc_ports::SecretName,
    config: RunnerConfig,
    /// What commands start from (see [`command_env`]).
    command_env: piarc_core::tool_io::CommandEnv,
}

impl Env {
    async fn prepare(
        spec: &ScenarioSpec,
        config: &RunnerConfig,
        root: &Path,
    ) -> Result<Self, String> {
        let workspace = root.join("work space 工作区");
        let data = root.join("data 数据");
        let cache = root.join("cache");
        for dir in [&workspace, &data.join("pi"), &cache] {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        prepare_workspace(spec, root, &workspace)?;
        let mut mocks = BTreeMap::new();
        let mut providers = serde_json::Map::new();
        for (name, endpoint) in &spec.providers {
            let id = spec.mock_scenario_id(name);
            let library = Scenario::new(&id, endpoint.script())
                .and_then(|scenario| ScenarioLibrary::new().with(scenario))
                .map_err(|e| e.to_string())?;
            let mock = MockProvider::start(library)
                .await
                .map_err(|e| format!("mock `{name}`: {e}"))?;
            if endpoint.configure_as.is_none() {
                providers.insert(
                    pi_provider(name),
                    pi_provider_entry(
                        &mock,
                        endpoint.wire,
                        endpoint.vision,
                        endpoint.reasoning,
                        &id,
                    ),
                );
            }
            mocks.insert(name.clone(), mock);
        }
        let pi = data.join("pi");
        write_json(&pi.join("models.json"), &json!({ "providers": providers }))?;
        // Retries wait milliseconds, not seconds.
        write_json(
            &pi.join("settings.json"),
            &json!({ "retry": { "baseDelayMs": 5 } }),
        )?;
        let gate = Arc::new(Gate::new(spec.expect.tool_batches.clone()));
        let home = root.join("home 家");
        let command_env = command_env(&home)?;
        Ok(Self {
            workspace,
            data,
            cache,
            home,
            mocks,
            gate,
            key_store: Arc::new(MemorySecretStore::new()),
            master_key: test_master_key_name("l2"),
            config: config.clone(),
            command_env,
        })
    }

    fn core_config(&self) -> CoreConfig {
        let dirs = DataDirs::new(self.data.clone(), self.cache.clone()).ok();
        CoreConfig {
            dirs,
            memory_home: Some(self.home.clone()),
            sessions: SessionsConfig {
                launch: Some(AgentHostLaunch::Custom {
                    node: self.config.node.clone(),
                    bundle: self.config.bundle.clone(),
                    pi_package_dir: Some(self.config.pi_assets.clone()),
                    extra_args: Vec::new(),
                    extra_env: vec![("PI_OFFLINE".into(), "1".into())],
                }),
                ..SessionsConfig::default()
            },
            secret_store: Some(SecretStoreSetup {
                master_key: self.master_key.clone(),
                store: Arc::clone(&self.key_store) as _,
            }),
            tool_observer: Some(Arc::clone(&self.gate) as _),
            command_env: Some(self.command_env.clone()),
            ..CoreConfig::default()
        }
    }

    /// Starts Core; every Core of the run delivers to the same `events`.
    fn start_core(&self, events: &Arc<Events>) -> Result<CoreRuntime, String> {
        CoreRuntime::start(self.core_config(), Arc::new(Sink(Arc::clone(events))))
            .map_err(|e| format!("Core did not start: {e}"))
    }

    fn records(&self) -> BTreeMap<String, Vec<RequestRecord>> {
        self.mocks
            .iter()
            .map(|(name, mock)| (name.clone(), mock.records()))
            .collect()
    }
}

/// The Pi provider id of endpoint `name`.
fn pi_provider(name: &str) -> String {
    format!("mock-{name}")
}

fn pi_provider_entry(
    mock: &MockProvider,
    wire: Wire,
    vision: bool,
    reasoning: bool,
    scenario: &str,
) -> Value {
    let (base_url, api) = match wire {
        Wire::Anthropic => (mock.anthropic_base_url(), "anthropic-messages"),
        Wire::Openai => (mock.openai_base_url(), "openai-completions"),
    };
    // Header selection keeps the prompts free of scenario markers.
    let mut headers = serde_json::Map::new();
    headers.insert(crate::server::SCENARIO_HEADER.to_owned(), json!(scenario));
    let input = if vision {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    json!({
        "baseUrl": base_url, "api": api, "apiKey": "piarc-no-key",
        "models": [{
            "id": MOCK_MODEL, "name": MOCK_MODEL, "reasoning": reasoning, "input": input,
            "compat": if reasoning && wire==Wire::Openai {json!({"supportsReasoningEffort":true})} else {json!({})},
            "contextWindow": 200_000, "maxTokens": 4096,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "headers": headers
        }]
    })
}

/// Everything Core delivered, as `(route, event)`, with a way to wait for more.
#[derive(Default)]
struct Events {
    all: Mutex<Vec<(String, Value)>>,
    arrived: Notify,
}

impl Events {
    fn all(&self) -> Vec<(String, Value)> {
        self.all
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

struct Sink(Arc<Events>);

impl EventSink for Sink {
    fn deliver(&self, batches: Vec<EventBatch>, _done: DeliveryDone) -> Result<(), SinkClosed> {
        let mut all = self.0.all.lock().map_err(|_| SinkClosed)?;
        for batch in batches {
            // Core delivers every batch as a JSON array; anything else is kept as one value
            // so it shows up in reports instead of being dropped.
            match serde_json::from_slice::<Value>(&batch.payload) {
                Ok(Value::Array(events)) => {
                    let route = batch.route.as_str().to_owned();
                    all.extend(events.into_iter().map(|e| (route.clone(), e)));
                }
                Ok(other) => all.push((batch.route.as_str().to_owned(), other)),
                Err(e) => all.push((
                    batch.route.as_str().to_owned(),
                    json!({ "undecodable": e.to_string() }),
                )),
            }
        }
        drop(all);
        self.0.arrived.notify_waiters();
        Ok(())
    }
}

/// Executes the actions and holds what they produced.
struct Driver<'a> {
    spec: &'a ScenarioSpec,
    env: &'a Env,
    core: CoreRuntime,
    events: &'a Arc<Events>,
    /// Session label to session id, and back through [`Self::observed`].
    sessions: BTreeMap<String, String>,
    turns: BTreeMap<String, String>,
    unlabeled_turns: Vec<String>,
    items: BTreeMap<String, String>,
    answered: BTreeSet<String>,
    approval_cursor: usize,
}

impl Driver<'_> {
    async fn drive(&mut self) -> Result<(), String> {
        self.configure_providers().await?;
        self.open().await?;
        for (n, action) in self.spec.actions.iter().enumerate() {
            self.act(action)
                .await
                .map_err(|e| format!("actions[{n}] ({}) failed: {e}", action.name()))?;
        }
        // Every turn the actions started has finished before anything is checked.
        let mut started: Vec<String> = self.turns.values().cloned().collect();
        started.extend(self.unlabeled_turns.iter().cloned());
        for turn in started {
            self.wait_until(&format!("turn/completed of turn {turn}"), |events| {
                events
                    .iter()
                    .any(|e| e.method == "turn/completed" && e.params["turnId"] == turn.as_str())
            })
            .await?;
        }
        self.check_provider_settings().await
    }

    async fn configure_providers(&self) -> Result<(), String> {
        let mut configs: Vec<_> = self
            .spec
            .cloud_providers
            .iter()
            .map(|id| (json!({"kind":"cloud","id":id}), true))
            .collect();
        for (name, spec) in &self.spec.providers {
            let Some(setup) = spec.configure_as else {
                continue;
            };
            let mock = &self.env.mocks[name];
            let (base, api) = match spec.wire {
                Wire::Anthropic => (mock.anthropic_base_url(), "anthropic-messages"),
                Wire::Openai => (mock.openai_base_url(), "openai-completions"),
            };
            let kind = match setup {
                EndpointSetup::Local => "local",
                EndpointSetup::Custom => "custom",
            };
            configs.push((json!({"kind":kind,"id":pi_provider(name),"api":api,"baseUrl":base,"models":[MOCK_MODEL]}),setup==EndpointSetup::Custom));
        }
        for (config, keyed) in configs {
            let key = keyed.then(|| json!({"key":L2_CREDENTIAL}).to_string());
            let op = piarc_core::providers::Operation::save(&config.to_string(), key.as_deref())
                .map_err(|e| e.to_string())?;
            call(
                |done| self.core.provider_op(op, done),
                "configuring provider",
            )
            .await?;
        }
        Ok(())
    }

    async fn check_provider_settings(&self) -> Result<(), String> {
        if self.spec.expect.configured_providers.is_empty() {
            return Ok(());
        }
        let settings = call(
            |done| {
                self.core
                    .provider_op(piarc_core::providers::Operation::List, done)
            },
            "reading providers",
        )
        .await?;
        let catalog = call(
            |done| self.core.workspace_models(self.env.workspace.clone(), done),
            "checking available models",
        )
        .await?;
        for (id, expected) in &self.spec.expect.configured_providers {
            let actual = settings["providers"]
                .as_array()
                .and_then(|p| p.iter().find(|p| p["id"] == id.as_str()))
                .ok_or_else(|| format!("provider {id} missing"))?;
            if let Some(mismatch) = subset_mismatch(expected, actual, id) {
                return Err(mismatch);
            }
            if !catalog["models"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|m| m["provider"] == id.as_str()))
            {
                return Err(format!("provider {id} has no available model"));
            }
        }
        let scan = crate::plaintext::scan(&[&self.env.data], &[L2_CREDENTIAL.as_bytes()], None);
        if !scan.findings.is_empty() || !scan.unreadable.is_empty() {
            return Err(format!(
                "credential scan findings: {:?}, unreadable: {:?}",
                scan.findings, scan.unreadable
            ));
        }
        Ok(())
    }

    async fn open(&mut self) -> Result<(), String> {
        let workspace = self.env.workspace.clone();
        if self.spec.workspace.trusted {
            let (tx, rx) = oneshot::channel();
            self.core
                .trust_view(workspace.clone(), Some(true), move |r| {
                    let _ = tx.send(r.map(|_| Value::Null));
                })
                .map_err(|e| e.to_string())?;
            answer("trusting the workspace", rx).await?;
        }
        let ws = workspace.clone();
        call(
            |done| self.core.open_workspace(ws, done),
            "opening the workspace",
        )
        .await?;
        for (label, session) in self.spec.sessions() {
            if !session.deferred {
                self.create_session(&label, &session).await?;
            }
        }
        Ok(())
    }

    async fn create_session(
        &mut self,
        label: &str,
        session: &super::format::SessionSpec,
    ) -> Result<(), String> {
        let workspace = &self.env.workspace;
        let cwd = session.cwd.as_deref().map(|c| resolve(workspace, c));
        let model = Some(piarc_protocol::session::ModelRef {
            provider: pi_provider(&session.provider),
            id: MOCK_MODEL.into(),
        });
        let ws = workspace.to_owned();
        let created = call(
            |done| {
                self.core
                    .create_session_with_mode(ws, cwd, model, session.mode, done)
            },
            &format!("creating session `{label}`"),
        )
        .await?;
        let id = created["sessionId"]
            .as_str()
            .ok_or_else(|| format!("session `{label}`: no id in {created}"))?;
        self.sessions.insert(label.to_owned(), id.to_owned());
        Ok(())
    }

    async fn act(&mut self, action: &Action) -> Result<(), String> {
        match action {
            Action::Prompt(input) => self.input(input, Op::Prompt).await,
            Action::Steer(input) => self.input(input, Op::Steer).await,
            Action::FollowUp(input) => self.input(input, Op::FollowUp).await,
            Action::Compact { session } => {
                let accepted = self.op(session.as_deref(), Op::Compact).await?;
                let turn = accepted["turnId"]
                    .as_str()
                    .ok_or_else(|| format!("no compaction turn was started: {accepted}"))?;
                self.unlabeled_turns.push(turn.to_owned());
                Ok(())
            }
            Action::QueueEdit {
                session,
                item,
                text,
            } => {
                let item_id = self.item(item)?;
                let op = Op::Queue(QueueOp::Edit {
                    item_id,
                    text: text.clone(),
                });
                self.op(session.as_deref(), op).await.map(drop)
            }
            Action::QueueDelete { session, item } => {
                let op = Op::Queue(QueueOp::Delete {
                    item_id: self.item(item)?,
                });
                self.op(session.as_deref(), op).await.map(drop)
            }
            Action::QueueReorder { session, items } => {
                let ids = items
                    .iter()
                    .map(|i| self.item(i))
                    .collect::<Result<_, _>>()?;
                self.op(session.as_deref(), Op::Queue(QueueOp::Reorder(ids)))
                    .await
                    .map(drop)
            }
            Action::SetModel {
                session,
                provider,
                preview,
            } => {
                self.switch_model(session.as_deref(), provider, preview)
                    .await
            }
            Action::SetEffort { session, effort } => self
                .op(session.as_deref(), Op::Model(ModelOp::Effort(*effort)))
                .await
                .map(drop),
            Action::SetMode { session, mode } => self
                .op(session.as_deref(), Op::SetPermissionMode(*mode))
                .await
                .map(drop),
            Action::Abort { session } => self.op(session.as_deref(), Op::Abort).await.map(drop),
            Action::Wait(wait) => self.wait_for_event(wait).await,
            Action::WriteFile { path, content } => write_file(&self.env.workspace, path, content),
            Action::RestartCore {} => self.restart().await,
            Action::Resume { session } => {
                let id = self.session_id(session.as_deref())?;
                call(
                    |done| self.core.resume_session(id, done),
                    "resuming the session",
                )
                .await
                .map(drop)
            }
        }
    }

    async fn wait_for_event(&mut self, wait: &super::format::WaitAction) -> Result<(), String> {
        let matcher = wait.matcher();
        let session = self.label(wait.session.as_deref())?;
        let count = wait.count.unwrap_or(1);
        let turns = self.turns.clone();
        self.wait_until(&format!("{count} × {}", describe(&matcher)), |events| {
            events
                .iter()
                .filter(|e| matches(&matcher, &session, e, &turns))
                .count()
                >= count
        })
        .await
    }

    async fn switch_model(
        &self,
        session: Option<&str>,
        provider: &str,
        expected: &Value,
    ) -> Result<(), String> {
        let model = piarc_protocol::session::ModelRef {
            provider: pi_provider(provider),
            id: MOCK_MODEL.into(),
        };
        let preview = self
            .op(session, Op::Model(ModelOp::Preview(model.clone())))
            .await?;
        if let Some(why) = subset_mismatch(expected, &preview, "preview") {
            return Err(why);
        }
        self.op(session, Op::Model(ModelOp::Set(model, None)))
            .await
            .map(drop)
    }

    async fn input(&mut self, input: &InputAction, op: fn(UserInput) -> Op) -> Result<(), String> {
        let label = self.label(input.session.as_deref())?;
        if !self.sessions.contains_key(&label) {
            let sessions = self.spec.sessions();
            let spec = sessions
                .get(&label)
                .ok_or_else(|| format!("no session {label}"))?;
            self.create_session(&label, spec).await?;
        }
        let mut outgoing = UserInput {
            request_id: input.request_id.clone(),
            text: input.text.clone(),
            mentions: input.mentions.clone(),
            attachments: Vec::new(),
        };
        for file in &input.attachments {
            let path = self.spec.fixture(&file.fixture);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("invalid attachment file name: {}", path.display()))?;
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let id = self.session_id(input.session.as_deref())?;
            let stored = call(
                |done| {
                    self.core.store_attachment(
                        id,
                        name.to_owned(),
                        file.mime_type.clone(),
                        bytes,
                        done,
                    )
                },
                "storing a composer attachment",
            )
            .await?;
            outgoing.attachments.push(
                serde_json::from_value(stored)
                    .map_err(|e| format!("invalid attachment returned by Core: {e}"))?,
            );
        }
        let accepted = self.op(input.session.as_deref(), op(outgoing)).await?;
        if let Some(turn) = accepted["turnId"].as_str() {
            match &input.turn {
                Some(label) => {
                    self.turns.insert(label.clone(), turn.to_owned());
                }
                None => self.unlabeled_turns.push(turn.to_owned()),
            }
        } else if input.turn.is_some() {
            return Err(format!("no turn was started: {accepted}"));
        }
        if let Some(label) = &input.item {
            let item = accepted["itemId"]
                .as_str()
                .ok_or_else(|| format!("the input was not queued: {accepted}"))?;
            self.items.insert(label.clone(), item.to_owned());
        }
        Ok(())
    }

    /// Shuts Core down and starts it again on the same directories; sessions keep their ids
    /// and are closed until resumed.
    async fn restart(&mut self) -> Result<(), String> {
        shutdown(&self.core).await?;
        self.core = self.env.start_core(self.events)?;
        let ws = self.env.workspace.clone();
        call(
            |done| self.core.open_workspace(ws, done),
            "reopening the workspace",
        )
        .await
        .map(drop)
    }

    fn session_id(&self, session: Option<&str>) -> Result<String, String> {
        let label = self.label(session)?;
        self.sessions
            .get(&label)
            .cloned()
            .ok_or_else(|| format!("session {label} has not been created"))
    }

    async fn op(&self, session: Option<&str>, op: Op) -> Result<Value, String> {
        let id = self.session_id(session)?;
        call(
            |done| self.core.session_op(id, op, done),
            "the session operation",
        )
        .await
    }

    fn label(&self, session: Option<&str>) -> Result<String, String> {
        self.spec.session_label(session)
    }

    fn item(&self, label: &str) -> Result<String, String> {
        self.items
            .get(label)
            .cloned()
            .ok_or_else(|| format!("no queue item `{label}`"))
    }

    /// The delivered session notifications, with session labels.
    fn observed(&self) -> Vec<ObservedEvent> {
        let labels: BTreeMap<String, &String> = self
            .sessions
            .iter()
            .map(|(label, id)| (format!("session/{id}"), label))
            .collect();
        self.events
            .all()
            .into_iter()
            .filter_map(|(route, event)| {
                let session = labels.get(&route)?;
                Some(ObservedEvent {
                    session: (*session).clone(),
                    method: event["method"].as_str().unwrap_or_default().to_owned(),
                    params: event["params"].clone(),
                })
            })
            .collect()
    }

    async fn wait_until(
        &mut self,
        what: &str,
        done: impl Fn(&[ObservedEvent]) -> bool,
    ) -> Result<(), String> {
        let wait = async {
            loop {
                let events = Arc::clone(self.events);
                let notified = events.arrived.notified();
                self.answer_visible().await?;
                if done(&self.observed()) {
                    return Ok(());
                }
                notified.await;
            }
        };
        tokio::time::timeout(WAIT, wait)
            .await
            .map_err(|_| format!("no {what} within {WAIT:?}"))?
    }

    async fn answer_visible(&mut self) -> Result<(), String> {
        use piarc_protocol::policy::ApprovalRequest;

        let snapshots: Vec<Value> = {
            let all = self
                .events
                .all
                .lock()
                .map_err(|_| "event log unavailable")?;
            let new = all[self.approval_cursor..]
                .iter()
                .filter(|(route, _)| route == "core/sessions")
                .map(|(_, v)| v.clone())
                .collect();
            self.approval_cursor = all.len();
            new
        };
        for event in snapshots {
            for session in event["sessions"].as_array().into_iter().flatten() {
                let cards = session["approvals"]
                    .as_array()
                    .ok_or("session snapshot lacks approvals")?;
                if session["pendingApprovals"].as_u64() != Some(cards.len() as u64) {
                    return Err(format!(
                        "pendingApprovals disagrees with the {} cards in the snapshot",
                        cards.len()
                    ));
                }
                for raw in cards {
                    let card: ApprovalRequest =
                        serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
                    self.answer_card(card).await?;
                }
            }
        }
        Ok(())
    }

    async fn answer_card(
        &mut self,
        card: piarc_protocol::policy::ApprovalRequest,
    ) -> Result<(), String> {
        use super::format::ApprovalDecision as Choice;
        use piarc_protocol::policy::{ApprovalAnswer, ApprovalDecision as Decision};
        if self.answered.contains(&card.request_id) {
            return Ok(());
        }
        let expected = self
            .spec
            .approvals
            .get(self.answered.len())
            .ok_or_else(|| format!("unexpected approval for {}", card.tool))?;
        if expected.tool.as_ref().is_some_and(|t| t != &card.tool) {
            return Err(format!(
                "approval expected {:?}, got {}",
                expected.tool, card.tool
            ));
        }
        if expected.kind.is_some_and(|kind| kind != card.kind) {
            return Err(format!(
                "approval expected {:?}, got {:?}",
                expected.kind, card.kind
            ));
        }
        let answer = ApprovalAnswer {
            request_id: card.request_id.clone(),
            session_id: card.session_id,
            revision: card.revision,
            connection_epoch: card.connection_epoch,
            feedback: expected.feedback.clone(),
            rule: card.rule,
            directory: card.directory,
            decision: match expected.decision {
                Choice::Allow => Decision::AllowOnce,
                Choice::Session => Decision::AllowSession,
                Choice::Always => Decision::AllowAlways,
                Choice::Deny => Decision::Deny,
            },
        };
        let result = call(
            |done| self.core.answer_approval(answer, done),
            "answering an approval",
        )
        .await?;
        if result["status"] != "applied" {
            return Err(format!("approval was not applied: {result}"));
        }
        self.answered.insert(card.request_id);
        Ok(())
    }

    /// The last events and the requests so far, for a failed action.
    fn context(&self) -> String {
        let events = self.observed();
        let from = events.len().saturating_sub(12);
        let mut out = format!("  last delivered events ({} in all):\n", events.len());
        for (i, e) in events.iter().enumerate().skip(from) {
            out.push_str(&format!(
                "    #{i} [{}] {} {}\n",
                e.session,
                e.method,
                compact(&without_noise(&e.params), 160)
            ));
        }
        for (name, records) in self.env.records() {
            for (n, r) in records.iter().enumerate() {
                let rules: Vec<&str> = r.violations.iter().map(|v| v.rule.id()).collect();
                out.push_str(&format!(
                    "  request {name}#{n}: {:?} {rules:?}\n",
                    r.outcome
                ));
            }
        }
        out
    }

    fn assert_all(&self) -> Vec<Failure> {
        let mut failures = Vec::new();
        let events = self.observed();
        let session_of = |s: Option<&str>| self.label(s).unwrap_or_default();
        if let Err(report) =
            check_events(&self.spec.expect.events, &events, &self.turns, session_of)
        {
            failures.push(failure("events", report));
        }
        for f in check_files(&self.spec.expect.files, &self.env.workspace) {
            failures.push(failure("files", f));
        }
        for f in check_fixture_files(self.spec, &self.env.workspace) {
            failures.push(failure("files", f));
        }
        for f in check_requests(self.spec, &self.env.records()) {
            failures.push(failure("requests", f));
        }
        for f in self.env.gate.failures() {
            failures.push(failure("tool_batches", f));
        }
        let calls = self.env.gate.calls();
        for expected in &self.spec.expect.core_io {
            let seen: BTreeSet<&str> = calls
                .iter()
                .filter(|(call, _)| call.as_deref() == Some(expected.call.as_str()))
                .map(|(_, method)| method.as_str())
                .collect();
            if !seen.contains(expected.method.as_str()) {
                failures.push(failure(
                    "core_io",
                    format!(
                        "core_io: no `{}` request for tool call `{}`; Core saw {seen:?}",
                        expected.method, expected.call
                    ),
                ));
            }
        }
        if self.spec.approvals.len() != self.answered.len() {
            failures.push(failure(
                "approvals",
                format!(
                    "approvals: {} answer(s) declared, but Core issued {} approval requests",
                    self.spec.approvals.len(),
                    self.answered.len()
                ),
            ));
        }
        failures
    }
}

/// Calls one of Core's callback methods and waits for its answer.
async fn call(
    start: impl FnOnce(Box<dyn FnOnce(piarc_core::Result<Value>) + Send>) -> piarc_core::Result<()>,
    what: &str,
) -> Result<Value, String> {
    let (tx, rx) = oneshot::channel();
    start(Box::new(move |result| {
        // The receiver is gone only when the wait below timed out.
        let _ = tx.send(result);
    }))
    .map_err(|e| format!("{what}: {e}"))?;
    answer(what, rx).await
}

async fn answer(
    what: &str,
    rx: oneshot::Receiver<piarc_core::Result<Value>>,
) -> Result<Value, String> {
    match tokio::time::timeout(WAIT, rx).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(e))) => Err(format!("{what}: Core answered {:?}: {e}", e.kind())),
        Ok(Err(_)) => Err(format!("{what}: Core dropped the answer")),
        Err(_) => Err(format!("{what}: no answer within {WAIT:?}")),
    }
}

async fn shutdown(core: &CoreRuntime) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    core.shutdown(move || {
        let _ = tx.send(());
    })
    .map_err(|e| format!("Core shutdown: {e}"))?;
    tokio::time::timeout(WAIT, rx)
        .await
        .map_err(|_| "Core did not shut down in time".to_owned())?
        .map_err(|_| "Core dropped the shutdown report".to_owned())
}
