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
use piarc_core::secrets::{MemorySecretStore, test_master_key_name};
use piarc_core::sessions::{Op, QueueOp, SessionsConfig};
use piarc_core::{
    CoreConfig, CoreRuntime, DataDirs, DeliveryDone, EventBatch, EventSink, SecretStoreSetup,
    SinkClosed,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use super::checks::{check_files, check_fixture_files, check_requests};
use super::format::{Action, InputAction, ScenarioSpec, Wire};
use super::gate::Gate;
use super::matcher::{ObservedEvent, check_events, compact, describe, matches, without_noise};
use crate::record::RequestRecord;
use crate::scenario::{Scenario, ScenarioLibrary};
use crate::server::MockProvider;

/// Safety net for every wait; no assertion depends on timing.
pub const WAIT: Duration = Duration::from_secs(30);

/// The Pi model id every endpoint offers.
pub const MOCK_MODEL: &str = "mock-model";

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
        for (path, content) in &spec.workspace.files {
            write_file(&workspace, path, content)?;
        }
        for (path, name) in &spec.workspace.fixtures {
            let target = resolve(&workspace, path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::copy(spec.fixture(name), &target)
                .map_err(|e| format!("fixture {name} → {}: {e}", target.display()))?;
        }
        for session in spec.sessions().values() {
            if let Some(cwd) = &session.cwd {
                let dir = resolve(&workspace, cwd);
                std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
        }
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
            providers.insert(
                pi_provider(name),
                pi_provider_entry(&mock, endpoint.wire, endpoint.vision, &id),
            );
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
        let command_env = command_env(root)?;
        Ok(Self {
            workspace,
            data,
            cache,
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

fn pi_provider_entry(mock: &MockProvider, wire: Wire, vision: bool, scenario: &str) -> Value {
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
        "baseUrl": base_url, "api": api, "apiKey": "piarc-mock-test-key",
        "models": [{
            "id": MOCK_MODEL, "name": MOCK_MODEL, "reasoning": false, "input": input,
            "contextWindow": 200_000, "maxTokens": 4096,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "headers": headers
        }]
    })
}

fn resolve(workspace: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|part| *part != ".")
        .fold(workspace.to_path_buf(), |path, part| path.join(part))
}

/// Variables PiArc's processes carry that commands must not see (T17): what Electron, Node and
/// PiArc set in the real application, here added to the test process's environment.
pub const INTERNAL_PROBES: [(&str, &str); 4] = [
    ("ELECTRON_RUN_AS_NODE", "1"),
    ("NODE_OPTIONS", "--no-deprecation"),
    ("PI_CODING_AGENT_DIR", "/l2/pi"),
    ("PIARC_L2_INTERNAL", "1"),
];

/// The command environment of a run's Core: the login shell (on Unix `/bin/bash` with a home
/// directory of the run, whose `.bash_profile` puts `<home>/bin` with the program
/// `l2-login-tool` on `PATH` and sets `L2_LOGIN_PROFILE`) started from the test process's
/// environment plus [`INTERNAL_PROBES`] and `L2_USER_VAR=kept`. Windows has no login shell:
/// the same environment, stripped.
fn command_env(root: &Path) -> Result<piarc_core::tool_io::CommandEnv, String> {
    let home = root.join("home 家");
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
    let mut base: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
        .filter(|(k, _)| k != "HOME" && k != "SHELL" && k != "BASH_ENV")
        .collect();
    base.extend(
        INTERNAL_PROBES
            .iter()
            .map(|(k, v)| (std::ffi::OsString::from(k), std::ffi::OsString::from(v))),
    );
    base.push(("L2_USER_VAR".into(), "kept".into()));
    if cfg!(unix) {
        let tool = bin.join("l2-login-tool");
        std::fs::write(&tool, "#!/bin/sh\necho 'login PATH works'\n")
            .map_err(|e| format!("{}: {e}", tool.display()))?;
        make_executable(&tool)?;
        let quoted = bin.display().to_string().replace('\'', r"'\''");
        std::fs::write(
            home.join(".bash_profile"),
            format!("export PATH='{quoted}':\"$PATH\"\nexport L2_LOGIN_PROFILE=loaded\n"),
        )
        .map_err(|e| format!("{}: {e}", home.display()))?;
        base.push(("HOME".into(), home.into_os_string()));
        base.push(("SHELL".into(), "/bin/bash".into()));
    }
    Ok(piarc_core::tool_io::CommandEnv::LoginShell { base })
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_file(workspace: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = resolve(workspace, relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
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
}

impl Driver<'_> {
    async fn drive(&mut self) -> Result<(), String> {
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
            let cwd = session.cwd.as_deref().map(|c| resolve(&workspace, c));
            let model = Some(piarc_protocol::session::ModelRef {
                provider: pi_provider(&session.provider),
                id: MOCK_MODEL.into(),
            });
            let ws = workspace.clone();
            let created = call(
                |done| self.core.create_session(ws, cwd, model, done),
                &format!("creating session `{label}`"),
            )
            .await?;
            let id = created["sessionId"]
                .as_str()
                .ok_or_else(|| format!("session `{label}`: no id in {created}"))?;
            self.sessions.insert(label, id.to_owned());
        }
        Ok(())
    }

    async fn act(&mut self, action: &Action) -> Result<(), String> {
        match action {
            Action::Prompt(input) => self.input(input, Op::Prompt(input.text.clone())).await,
            Action::Steer(input) => self.input(input, Op::Steer(input.text.clone())).await,
            Action::FollowUp(input) => self.input(input, Op::FollowUp(input.text.clone())).await,
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
            Action::Abort { session } => self.op(session.as_deref(), Op::Abort).await.map(drop),
            Action::Wait(wait) => {
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

    async fn input(&mut self, input: &InputAction, op: Op) -> Result<(), String> {
        let accepted = self.op(input.session.as_deref(), op).await?;
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
        Ok(self.sessions.get(&label).cloned().unwrap_or_default())
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
        &self,
        what: &str,
        done: impl Fn(&[ObservedEvent]) -> bool,
    ) -> Result<(), String> {
        let wait = async {
            loop {
                let notified = self.events.arrived.notified();
                if done(&self.observed()) {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(WAIT, wait)
            .await
            .map_err(|_| format!("no {what} within {WAIT:?}"))
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
        if !self.spec.approvals.is_empty() {
            // No approval requests exist before T20: every declared answer stays unused, and an
            // unused answer is a failure, never a silent pass.
            failures.push(failure(
                "approvals",
                format!(
                    "approvals: {} answer(s) declared, but Core issued 0 approval requests",
                    self.spec.approvals.len()
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
