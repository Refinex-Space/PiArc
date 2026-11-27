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

use super::checks::{check_files, check_fixture_files, check_json_lines, check_requests};
pub use super::fixtures::INTERNAL_PROBES;
use super::fixtures::{
    claude_changes, claude_snapshot, command_env, prepare_workspace, resolve, write_file,
    write_json,
};
use super::format::{Action, EndpointSetup, InputAction, ProviderSpec, ScenarioSpec, Wire};
use super::gate::Gate;
use super::matcher::subset_mismatch;
use super::matcher::{ObservedEvent, check_events, compact, describe, matches, without_noise};
use crate::record::RequestRecord;
use crate::scenario::{Scenario, ScenarioLibrary};
use crate::server::{MockProvider, Mode};
pub(super) use env::WORKSPACE_PLACEHOLDER;
use env::{Env, pi_provider};

mod approvals;
mod asserts;
mod browser;
mod checkpoints;
mod env;
mod harness;
mod l3;
mod login;
mod mcp;
mod packages;
mod settings;
mod terminals;
mod worktrees;

pub use l3::run_l3;

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
    /// `core_io`, `claude_config`, `cleanup`.
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

/// The directory scenario roots go in. Skills, commands and agent definitions are read from the
/// workspace upward, skipping only the (injected) home: a root inside the real user's home
/// would load that user's `~/.claude/skills` and `~/.agents/skills` as project files. Windows
/// keeps the temporary directory inside the home, so there the roots go in `%PUBLIC%`, which
/// every user can write and which is in no home and no repository (W3).
fn scenario_base() -> PathBuf {
    let temp = std::env::temp_dir();
    let inside_home = std::env::home_dir().is_some_and(|home| temp.starts_with(home));
    match std::env::var_os("PUBLIC") {
        Some(public) if inside_home => PathBuf::from(public),
        _ => temp,
    }
}

/// Runs `spec` on its own tokio runtime.
#[must_use]
pub fn run(spec: &ScenarioSpec, config: &RunnerConfig) -> RunOutcome {
    run_with(spec, config, Mode::Strict).0
}

/// Runs `spec` with mocks in `mode`; in [`Mode::L3`] also returns what [`l3::capture`] took
/// from the run before its root was removed.
fn run_with(spec: &ScenarioSpec, config: &RunnerConfig, mode: Mode) -> (RunOutcome, Option<Value>) {
    static RUNS: AtomicU64 = AtomicU64::new(0);
    let run = RUNS.fetch_add(1, Ordering::Relaxed);
    let root = scenario_base().join(format!(
        "piarc l2 {} 中文 {}-{run}",
        spec.id,
        std::process::id()
    ));
    let (mut failures, capture) = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(run_in(spec, config, &root, mode)),
        Err(e) => (
            vec![failure("setup", format!("no tokio runtime: {e}"))],
            None,
        ),
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
    let outcome = RunOutcome {
        failures,
        root,
        cleaned,
    };
    (outcome, capture)
}

async fn run_in(
    spec: &ScenarioSpec,
    config: &RunnerConfig,
    root: &Path,
    mode: Mode,
) -> (Vec<Failure>, Option<Value>) {
    let env = match Env::prepare(spec, config, root, mode).await {
        Ok(env) => env,
        Err(e) => return (vec![failure("setup", e)], None),
    };
    // T24-A08: Claude Code's configuration is read only, in every scenario.
    let claude_before = claude_snapshot(root);
    let events = Arc::new(Events::default());
    let core = match env.start_core(&events) {
        Ok(core) => core,
        Err(e) => return (vec![failure("setup", e)], None),
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
        restores: BTreeMap::new(),
        terminals: BTreeMap::new(),
        mode,
        asks: Vec::new(),
        browser: browser::BrowserClient::default(),
    };
    let mut failures = match driver.drive().await {
        Ok(()) => {
            driver.json_lines_written().await;
            driver.assert_all()
        }
        Err(e) => vec![failure("action", format!("{e}\n{}", driver.context()))],
    };
    // Taken before shutdown: Core's last events and the workspace as the run left it.
    let capture = (mode == Mode::L3).then(|| driver.capture());
    if let Err(e) = shutdown(&driver.core).await {
        failures.push(failure("cleanup", e));
    }
    let changes = claude_changes(&claude_before, &claude_snapshot(root));
    if !changes.is_empty() {
        failures.push(failure(
            "claude_config",
            format!(
                "PiArc changed Claude Code configuration:
{}",
                changes.join(
                    "
"
                )
            ),
        ));
    }
    (failures, capture)
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
    /// Session id → its latest rewind's undo id (T28).
    restores: BTreeMap<String, String>,
    /// [`Mode::L3`]: approvals beyond the scripted ones are refused instead of failing.
    mode: Mode,
    /// Every approval answered, in order, as `{tool, call, decision, scripted}` (L3 capture).
    asks: Vec<Value>,
    /// Session id → the terminal `open_terminal` opened last (T34).
    terminals: BTreeMap<String, u32>,
    /// The built-in browser's fake desktop client (`browser`).
    browser: browser::BrowserClient,
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
        self.browser_settled().await?;
        self.check_provider_settings().await?;
        self.check_config_diagnostics().await?;
        self.check_audit().await
    }

    async fn open(&mut self) -> Result<(), String> {
        let workspace = self.env.workspace.clone();
        if self.spec.workspace.trusted {
            let version = self
                .core
                .trust()
                .map_err(|e| e.to_string())?
                .view(&workspace)
                .await
                .map_err(|e| e.to_string())?
                .version;
            let (tx, rx) = oneshot::channel();
            self.core
                .trust_view(workspace.clone(), Some((true, version)), move |r| {
                    let _ = tx.send(r.map(|_| Value::Null));
                })
                .map_err(|e| e.to_string())?;
            answer("trusting the workspace", rx).await?;
        }
        self.install_packages().await?;
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
        let model = (!session.settings_model).then(|| piarc_protocol::session::ModelRef {
            provider: pi_provider(&session.provider),
            id: self
                .spec
                .providers
                .get(&session.provider)
                .map_or(MOCK_MODEL, |endpoint| endpoint.model_id())
                .into(),
        });
        let ws = workspace.to_owned();
        let created = call(
            |done| worktrees::create(&self.core, ws, cwd, model, session, done),
            &format!("creating session `{label}`"),
        )
        .await?;
        let id = created["sessionId"]
            .as_str()
            .ok_or_else(|| format!("session `{label}`: no id in {created}"))?;
        self.sessions.insert(label.to_owned(), id.to_owned());
        Ok(())
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one arm per scenario action; each arm only delegates"
    )]
    async fn act(&mut self, action: &Action) -> Result<(), String> {
        match action {
            Action::Prompt(input) => self.input(input, Op::Prompt).await,
            Action::Steer(input) => self.input(input, Op::Steer).await,
            Action::FollowUp(input) => self.input(input, Op::FollowUp).await,
            Action::Compact {
                session,
                instructions,
            } => {
                self.compact_session(session.as_deref(), instructions.clone())
                    .await
            }
            Action::SideChat {
                session,
                panel,
                text,
                answer,
            } => {
                let actual = self
                    .op(
                        session.as_deref(),
                        Op::SideChatAsk {
                            panel_id: panel.clone(),
                            text: text.clone(),
                        },
                    )
                    .await?;
                if actual["text"].as_str() != Some(answer.as_str()) || actual["stopped"] != false {
                    return Err(format!("side chat answer differed: {actual}"));
                }
                self.op(
                    session.as_deref(),
                    Op::SideChatControl {
                        panel_id: panel.clone(),
                        close: true,
                    },
                )
                .await
                .map(drop)
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
                rejected,
            } => {
                self.switch_model(session.as_deref(), provider, preview, rejected.as_deref())
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
            Action::SetPrefs(prefs) => self.set_prefs(prefs).await,
            Action::DeleteSession { session } => {
                let id = self.session_id(session.as_deref())?;
                call(
                    |done| self.core.delete_session(id, done),
                    "deleting session",
                )
                .await
                .map(drop)
            }
            Action::SweepWorktrees(spec) => self.sweep_worktrees(spec).await,
            Action::CheckWorktree(spec) => self.check_worktree(spec).await,
            Action::RemoveWorktree(spec) => self.remove_worktree(spec).await,
            Action::KeepWorktree(spec) => self.keep_worktree(spec).await,
            Action::CheckGit(spec) => self.check_git(spec),
            Action::Search(spec) => self.search(spec).await,
            Action::CheckStoredSession { session, fields } => {
                self.check_stored_session(session.as_deref(), fields)
            }
            Action::CheckTrust { fields } => self.check_trust(fields).await,
            Action::Wait(wait) => self.wait_for_event(wait).await,
            Action::WriteFile { path, content } => write_file(&self.env.workspace, path, content),
            Action::WriteManaged { path, content } => {
                self.write_managed(path, content.as_deref()).await
            }
            Action::SetWebSearchKey { backend, key } => call(
                |done| {
                    self.core
                        .set_web_search_key(backend.clone(), key.clone(), done)
                },
                "saving the web search key",
            )
            .await
            .map(drop),
            Action::CheckCommands { present, absent } => self.check_commands(present, absent).await,
            Action::SetOutputStyle { name } => {
                let ws = self.env.workspace.clone();
                call(
                    |done| self.core.set_output_style(Some(ws), name.clone(), done),
                    "setting the output style",
                )
                .await
                .map(drop)
            }
            Action::AdvanceClock { seconds } => {
                self.env.clock.advance(Duration::from_secs_f64(*seconds));
                Ok(())
            }
            Action::StopTask { session, kind } => self.stop_task(session.as_deref(), *kind).await,
            Action::OpenTerminal { session } => self.open_terminal(session.as_deref()).await,
            Action::TypeTerminal { session, text } => self.type_terminal(session.as_deref(), text),
            Action::ShareTerminal { session, shared } => {
                self.share_terminal(session.as_deref(), *shared).await
            }
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
            Action::Fork(fork) => self.fork(fork).await,
            Action::CheckHarness(check) => self.check_harness(check).await,
            Action::CheckUsage(check) => self.check_usage(check).await,
            Action::CheckCost(check) => self.check_cost(check).await,
            Action::Rewind(spec) => self.rewind(spec).await,
            Action::UndoRewind(spec) => self.undo_rewind(spec).await,
            Action::CheckChanges(spec) => self.check_changes(spec).await,
            Action::Discard(spec) => self.discard(spec).await,
            Action::SwitchBranch(spec) => self.switch_branch(spec).await,
            Action::CheckBranch(spec) => self.check_branch(spec).await,
            Action::CheckFiles(spec) => self.check_files_now(spec),
            Action::SignIn(spec) => self.sign_in(spec).await,
            Action::SignOut {} => self.sign_out().await,
            Action::McpSignIn(spec) => self.mcp_sign_in(spec).await,
        }
    }

    async fn compact_session(
        &mut self,
        session: Option<&str>,
        instructions: Option<String>,
    ) -> Result<(), String> {
        let accepted = self.op(session, Op::Compact(instructions)).await?;
        let turn = accepted["turnId"]
            .as_str()
            .ok_or_else(|| format!("no compaction turn was started: {accepted}"))?;
        self.unlabeled_turns.push(turn.to_owned());
        Ok(())
    }

    async fn set_prefs(&self, prefs: &super::format::PrefsAction) -> Result<(), String> {
        let change = piarc_core::sessions::SessionPrefsChange {
            custom_title: prefs.title.clone().map(Some),
            pinned: prefs.pinned,
            archived: prefs.archived,
        };
        self.op(prefs.session.as_deref(), Op::Prefs(change))
            .await
            .map(drop)
    }

    fn check_stored_session(&self, session: Option<&str>, fields: &Value) -> Result<(), String> {
        let id = self.session_id(session)?;
        let storage = self.core.storage().map_err(|e| e.to_string())?;
        let record = storage
            .with(|db| db.session(&id))
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let actual = record.map_or(
            Value::Null,
            |r| json!({"title":r.title(),"pinned":r.pinned,"archived":r.archived}),
        );
        subset_mismatch(fields, &actual, "stored session").map_or(Ok(()), Err)
    }

    async fn check_trust(&self, fields: &Value) -> Result<(), String> {
        let service = self.core.trust().map_err(|e| e.to_string())?;
        let view = service
            .view(&self.env.workspace)
            .await
            .map_err(|e| e.to_string())?;
        let actual = serde_json::to_value(view).map_err(|e| e.to_string())?;
        subset_mismatch(fields, &actual, "trust view").map_or(Ok(()), Err)
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
        &mut self,
        session: Option<&str>,
        provider: &str,
        expected: &Value,
        rejected: Option<&str>,
    ) -> Result<(), String> {
        let model = piarc_protocol::session::ModelRef {
            provider: pi_provider(provider),
            id: self
                .spec
                .providers
                .get(provider)
                .map_or(MOCK_MODEL, |endpoint| endpoint.model_id())
                .into(),
        };
        let preview = self
            .op(session, Op::Model(ModelOp::Preview(model.clone())))
            .await?;
        if let Some(why) = subset_mismatch(expected, &preview, "preview") {
            return Err(why);
        }
        let id = self.session_id(session)?;
        let (tx, rx) = oneshot::channel();
        self.core
            .session_op(
                id,
                Op::Model(ModelOp::Set(model, None)),
                Box::new(move |r| {
                    let _ = tx.send(r);
                }),
            )
            .map_err(|e| e.to_string())?;
        let result = answer("the model switch", rx);
        tokio::pin!(result);
        let outcome = loop {
            let events = Arc::clone(self.events);
            let notified = events.arrived.notified();
            self.answer_visible().await?;
            tokio::select! { result=&mut result=>break result, ()=notified=>{} }
        };
        match (outcome, rejected) {
            (Err(message), Some(expected)) if message.contains(expected) => Ok(()),
            (Ok(_), Some(expected)) => Err(format!("expected model switch rejection: {expected}")),
            (other, _) => other.map(drop),
        }
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
        let answer = self.op(input.session.as_deref(), op(outgoing)).await;
        let accepted = match (&input.rejected, answer) {
            (None, answer) => answer?,
            (Some(want), Err(error)) if error.contains(want.as_str()) => return Ok(()),
            (Some(want), answer) => {
                return Err(format!(
                    "expected a refusal containing {want:?}, got {answer:?}"
                ));
            }
        };
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

    /// `stop_task`: the newest running task of the session (and kind) in the last snapshot.
    async fn stop_task(
        &self,
        session: Option<&str>,
        kind: Option<piarc_protocol::tasks::TaskKind>,
    ) -> Result<(), String> {
        let label = self.label(session)?;
        let wanted = kind.map(|k| serde_json::to_value(k).unwrap_or(Value::Null));
        let task = self
            .observed()
            .into_iter()
            .rev()
            .filter(|e| e.method == "core/tasks" && e.session == label)
            .map(|e| e.params)
            .find(|row| {
                row["status"] == "running" && wanted.as_ref().is_none_or(|k| &row["kind"] == k)
            })
            .and_then(|row| row["taskId"].as_str().map(str::to_owned))
            .ok_or_else(|| format!("session `{label}` has no running task to stop"))?;
        call(|done| self.core.stop_task(task, done), "stop_task")
            .await
            .map(drop)
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
        let mut result = Vec::new();
        for (route, event) in self.events.all() {
            if route == "core/sessions" {
                for row in event["sessions"].as_array().into_iter().flatten() {
                    if let Some(label) = row["id"]
                        .as_str()
                        .and_then(|id| labels.get(&format!("session/{id}")))
                    {
                        result.push(ObservedEvent {
                            session: (*label).clone(),
                            method: route.clone(),
                            params: row.clone(),
                        });
                    }
                }
            } else if route == "core/tasks" {
                // Background tasks (T32) count among their main session's events.
                for row in event["tasks"].as_array().into_iter().flatten() {
                    if let Some(label) = row["ownerSessionId"]
                        .as_str()
                        .and_then(|id| labels.get(&format!("session/{id}")))
                    {
                        result.push(ObservedEvent {
                            session: (*label).clone(),
                            method: route.clone(),
                            params: row.clone(),
                        });
                    }
                }
            } else if route == "core/notices" {
                // Notices of a session (hooks, T25) count among its events.
                if let Some(label) = event["sessionId"]
                    .as_str()
                    .and_then(|id| labels.get(&format!("session/{id}")))
                {
                    result.push(ObservedEvent {
                        session: (*label).clone(),
                        method: route.clone(),
                        params: event.clone(),
                    });
                }
            } else if route == "core/settings" {
                // A workspace's settings changed (T47: managed settings): every session's event.
                for label in labels.values() {
                    result.push(ObservedEvent {
                        session: (*label).clone(),
                        method: route.clone(),
                        params: event.clone(),
                    });
                }
            } else if let Some(label) = labels.get(&route) {
                result.push(ObservedEvent {
                    session: (*label).clone(),
                    method: event["method"].as_str().unwrap_or_default().to_owned(),
                    params: event["params"].clone(),
                });
            }
        }
        result
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
                self.browser_tick()?;
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
