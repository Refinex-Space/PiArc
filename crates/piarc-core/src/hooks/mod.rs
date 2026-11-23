//! Hooks in Core (architecture section 6.3, ADR-0039): every hook command runs here, whichever
//! process observed the event.
//!
//! - Configuration: the `hooks` of every settings layer, read the way a permission decision
//!   reads settings ([`TrustService::permission_settings`]), so an untrusted project's hooks
//!   (`.piarc/settings*.json`, `.claude/settings*.json`) are left out while the user's run.
//!   `disableAllHooks` turns them off; set outside managed settings it leaves the managed
//!   hooks on. Managed settings' `allowManagedHooksOnly` runs only the managed hooks and those
//!   of packages the managed settings turn on; each other handler an event matches is audited
//!   as skipped (T47).
//! - Input: the event's own fields plus `session_id`, `transcript_path`, `cwd`,
//!   `hook_event_name`, `prompt_id` once the session had input, and, where Claude Code sends
//!   them, `permission_mode` and `effort`. In a subagent `session_id`, `transcript_path` and
//!   `prompt_id` are the main session's and `agent_id`, `agent_type` name the subagent (T38).
//! - Running: `piarc-hooks` with `piarc-exec`'s process-tree spawner and the tools' command
//!   environment (plus the user's `hookAllowedEnvVars`); `http` handlers through `piarc-web`
//!   under `allowedHttpHookUrls` and `httpHookAllowedEnvVars`; `prompt` handlers through the
//!   workspace's Agent Host (`hooks/prompt`, [`HookOutlet`]); the session's turn token cancels
//!   them (ADR-0055).
//! - Order: a session's `UserPromptSubmit` hooks wait until its `SessionStart` hooks (startup,
//!   resume, fork) have finished, as in Claude Code ([`HooksService::starting`],
//!   [`HooksService::started`]; found by L3, T30).
//! - Afterwards: one `audit_events` row (`kind: "hook"`) per handler; `systemMessage`s and
//!   errors for the user go to `core/notices` (`{ type: "hook", id, sessionId, event, level,
//!   message }`); texts over 10,000 characters go to `<session tmp>/hooks/` and are replaced
//!   with a preview and the path.

mod launcher;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

pub(crate) use launcher::Launch;
use piarc_hooks::{
    Decision, HookConfig, HookEvent, HttpCall, HttpPort, HttpReply, HttpRules, JudgeCall,
    JudgePort, JudgeReply, LayerHooks, Ran, Runner, RunnerConfig, Source,
};
use piarc_ports::{BoxFuture, ProcessSpawner};
use piarc_protocol::hooks::{HooksPromptParams, HooksPromptResult};
use piarc_protocol::policy::PermissionMode;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::storage::{Storage, now_ms};
use crate::trust::TrustService;

/// The subagent a session is (T31, T38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentFacts {
    /// The subagent's session id: the hooks' `agent_id`.
    pub id: String,
    /// Its type: `agent_type`.
    pub kind: String,
}

/// What the hooks of one session run with.
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    /// The session the event happened in (scoped hooks, audit, notices).
    pub session_id: String,
    /// The main session: the hooks' `session_id`, `transcript_path` and `prompt_id`; the same
    /// as `session_id` outside subagents.
    pub main_session_id: String,
    /// Set in a subagent's session.
    pub agent: Option<AgentFacts>,
    /// The workspace root: where settings are read, `CLAUDE_PROJECT_DIR`.
    pub root: PathBuf,
    /// The session's working directory: the hooks' `cwd`.
    pub cwd: PathBuf,
    /// The session's temporary directory: long output goes to its `hooks/`.
    pub tmp_dir: PathBuf,
    /// The session's permission mode, when it is known.
    pub mode: Option<PermissionMode>,
    /// Whether paths compare without case (for `if` conditions).
    pub fold_case: bool,
    pub cancel: CancellationToken,
}

/// One event to run.
#[derive(Debug, Clone)]
pub(crate) struct Request {
    pub event: HookEvent,
    /// What the matchers see (tool name, `source`, `trigger`, …).
    pub subject: Option<String>,
    /// The event's own input fields.
    pub fields: Map<String, Value>,
    /// Tool events: the call (canonical tool name, input) `if` conditions match against.
    pub tool: Option<(String, Map<String, Value>)>,
}

/// The merged decision, with its texts bounded and joined.
#[derive(Debug, Clone, Default)]
pub(crate) struct Answer {
    pub decision: Decision,
    /// Context for the model.
    pub context: Option<String>,
    /// Feedback the model reads next to a tool result.
    pub feedback: Option<String>,
    /// Instructions for a compaction summary.
    pub instructions: Option<String>,
}

/// Checks a handler's `if` rule against a tool call (`tool_io::policy` implements it with
/// the permission rule matcher).
pub(crate) type Condition =
    fn(rule: &str, tool: &str, input: &Map<String, Value>, facts: &Facts) -> bool;

/// The handlers one event will run, with the settings they run under.
pub(crate) struct Plan {
    handlers: Vec<Arc<piarc_hooks::Handler>>,
    /// `allowedHttpHookUrls`, merged; `None` when unset.
    allowed_urls: Option<Vec<String>>,
    /// `httpHookAllowedEnvVars`, merged; `None` when unset.
    http_env: Option<Vec<String>>,
    /// `hookAllowedEnvVars` of the user's own settings (I93).
    hook_env: Vec<String>,
}

/// What `prompt` hooks reach of the session layer: one model call on the Agent Host of the
/// main session's workspace (`hooks/prompt`).
pub(crate) trait HookOutlet: Send + Sync {
    /// Asks `params` of the session's Agent Host.
    fn judge(
        &self,
        params: HooksPromptParams,
    ) -> BoxFuture<'static, Result<HooksPromptResult, String>>;

    /// Calls an MCP tool for an `mcp_tool` hook on the session's Agent Host (T41).
    fn mcp_tool(
        &self,
        params: piarc_protocol::hooks::HooksMcpToolParams,
    ) -> BoxFuture<'static, Result<piarc_protocol::hooks::HooksMcpToolResult, ErrorObject>>;
}

/// Bytes of an `http` hook's response read.
const HTTP_RESPONSE_BYTES: usize = 1024 * 1024;

/// `http` hooks through `piarc-web`: any address (the user wrote it), the handler's timeout
/// bounds the request (the runner drops it), the response is cut at 1 MiB.
struct WebPort {
    fetcher: std::sync::OnceLock<Result<Arc<piarc_web::Fetcher>, String>>,
}

impl WebPort {
    fn fetcher(&self) -> Result<Arc<piarc_web::Fetcher>, String> {
        self.fetcher
            .get_or_init(|| {
                let limits = piarc_web::FetchLimits {
                    max_body_bytes: HTTP_RESPONSE_BYTES,
                    timeout: std::time::Duration::from_secs(86_400),
                    ..piarc_web::FetchLimits::default()
                };
                piarc_web::Fetcher::new(limits, piarc_web::Allowlist::default())
                    .map(Arc::new)
                    .map_err(|e| e.to_string())
            })
            .clone()
    }
}

impl HttpPort for WebPort {
    fn post(&self, call: HttpCall) -> BoxFuture<'static, Result<HttpReply, String>> {
        let fetcher = self.fetcher();
        Box::pin(async move {
            let fetcher = fetcher?;
            let request = piarc_web::Call {
                method: piarc_web::Method::Post,
                url: call.url,
                headers: call.headers,
                body: call.body,
                max_body_bytes: HTTP_RESPONSE_BYTES,
            };
            // The runner bounds and cancels the request by dropping this future.
            let reply = fetcher
                .call(
                    &request,
                    piarc_web::Reach::Configured,
                    &CancellationToken::new(),
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(HttpReply {
                status: reply.status,
                body: reply.body,
            })
        })
    }
}

/// `prompt` hooks of one main session through the outlet.
struct SessionJudge {
    outlet: Option<Arc<dyn HookOutlet>>,
    session_id: String,
}

impl JudgePort for SessionJudge {
    fn judge(&self, call: JudgeCall) -> BoxFuture<'static, Result<JudgeReply, String>> {
        let Some(outlet) = self.outlet.clone() else {
            return Box::pin(async {
                Err("no Agent Host can answer prompt hooks here".to_owned())
            });
        };
        let params = HooksPromptParams {
            session_id: self.session_id.clone(),
            prompt: call.prompt,
            model: call.model,
            timeout_ms: call.timeout_ms,
        };
        Box::pin(async move {
            let answer = outlet.judge(params).await?;
            Ok(JudgeReply {
                text: answer.text,
                model: answer.model,
                input_tokens: answer.input_tokens,
                output_tokens: answer.output_tokens,
            })
        })
    }
}

/// `mcp_tool` hooks of one main session through the outlet (T41).
struct SessionMcp {
    outlet: Option<Arc<dyn HookOutlet>>,
    session_id: String,
}

impl piarc_hooks::McpToolPort for SessionMcp {
    fn call(
        &self,
        call: piarc_hooks::McpToolCall,
    ) -> BoxFuture<'static, Result<piarc_hooks::McpToolReply, ErrorObject>> {
        let Some(outlet) = self.outlet.clone() else {
            return Box::pin(async {
                Err(ErrorObject::new(
                    ErrorKind::HostUnavailable,
                    "no Agent Host can run mcp_tool hooks here",
                    false,
                ))
            });
        };
        let params = piarc_protocol::hooks::HooksMcpToolParams {
            session_id: self.session_id.clone(),
            server: call.server,
            tool: call.tool,
            arguments: call.arguments,
            timeout_ms: call.timeout_ms,
        };
        Box::pin(async move {
            let answer = outlet.mcp_tool(params).await?;
            Ok(piarc_hooks::McpToolReply {
                text: answer.text,
                is_error: answer.is_error,
            })
        })
    }
}

/// Runs hooks for every session of a Core. Cheap to clone.
#[derive(Clone)]
pub(crate) struct HooksService {
    inner: Arc<Inner>,
}

struct Inner {
    storage: Storage,
    trust: TrustService,
    notices: Option<EventSender>,
    spawner: Arc<dyn ProcessSpawner>,
    runner: RunnerConfig,
    condition: Condition,
    /// Each session's transcript (Pi's session file), as the Agent Host last reported it.
    transcripts: Mutex<HashMap<String, String>>,
    /// Each session's `SessionStart` runs in progress.
    starts: Mutex<HashMap<String, watch::Sender<u32>>>,
    /// Hooks scoped to one session, by session id: a subagent definition's while it runs
    /// (T31), the skills the session invoked until it closes (T37). Sources above every
    /// settings file, for that session only.
    scoped: Mutex<HashMap<String, Vec<Scoped>>>,
    /// Each main session's current `prompt_id` (T38, I115).
    prompts: Mutex<HashMap<String, String>>,
    http: Arc<WebPort>,
    outlet: Mutex<Option<Arc<dyn HookOutlet>>>,
}

/// Marks one `SessionStart` run in progress until it drops ([`HooksService::starting`]).
pub(crate) struct StartGuard {
    service: HooksService,
    session_id: String,
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Some(runs) = self
            .service
            .inner
            .starts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&self.session_id)
        {
            runs.send_modify(|n| *n = n.saturating_sub(1));
        }
    }
}

impl std::fmt::Debug for HooksService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HooksService")
            .field("runner", &self.inner.runner)
            .finish_non_exhaustive()
    }
}

/// The layer id of a subagent definition's hooks in audits and notices.
const SUBAGENT_LAYER: &str = "subagent";
/// The layer id of an invoked skill's hooks (T37).
const SKILL_LAYER: &str = "skill";

/// Hooks scoped to a session: where they come from and the `hooks` object.
#[derive(Debug, Clone)]
struct Scoped {
    /// `subagent`, or `skill:<name>`: one entry per key.
    key: String,
    layer: &'static str,
    file: Option<PathBuf>,
    hooks: Value,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The hooks of `settings` that run, highest precedence first.
pub(crate) fn config_of(settings: &piarc_config::Settings) -> HookConfig {
    config_with(settings, &[]).run
}

/// The reason in the audit of a handler that `allowManagedHooksOnly` keeps from running.
pub(crate) const MANAGED_ONLY: &str = "managedOnly";

/// The hooks that run and, under `allowManagedHooksOnly`, those that would have run (T47).
struct Configs {
    run: HookConfig,
    skipped: Option<HookConfig>,
}

/// Which hooks of a layer run under the managed settings (T47, design addendum sections 5.2
/// and 5.3): `disableAllHooks` in managed settings turns every hook off; elsewhere it turns off
/// all but the managed hooks; `allowManagedHooksOnly` keeps the managed hooks and the hooks of
/// packages the managed settings turn on.
fn managed_hooks(settings: &piarc_config::Settings) -> (bool, bool, impl Fn(&str) -> bool + '_) {
    let managed = settings.managed();
    let on = |pointer: &str| managed.and_then(|m| m.pointer(pointer)) == Some(&Value::Bool(true));
    let all_off = on("/disableAllHooks");
    let others_off = settings
        .table()
        .layers()
        .iter()
        .rev()
        .filter(|spec| spec.id != piarc_config::ids::ENTERPRISE)
        .find_map(|spec| settings.layer(spec.id)?.get("disableAllHooks")?.as_bool())
        .unwrap_or(false);
    let only = on("/allowManagedHooksOnly");
    let managed_layer = move |layer: &str| {
        layer == piarc_config::ids::ENTERPRISE
            || layer.strip_prefix("plugin:").is_some_and(|id| {
                managed
                    .and_then(|m| m.get("plugins"))
                    .and_then(|p| p.get(id))
                    == Some(&Value::Bool(true))
            })
    };
    (all_off, others_off || only, managed_layer)
}

/// [`config_of`] with a session's scoped hooks (T31, T37) above the settings files, and the
/// confirmed hooks of the extension packages in effect below them (T40, layer `plugin:<id>`).
fn config_with(settings: &piarc_config::Settings, scoped: &[Scoped]) -> Configs {
    let packages: Vec<(String, Option<PathBuf>, Value)> = settings
        .packages()
        .active
        .iter()
        .filter_map(|package| {
            package.hooks().map(|hooks| {
                (
                    format!("plugin:{}", package.id()),
                    package.manifest.hooks_file.clone(),
                    hooks,
                )
            })
        })
        .collect();
    let packages = packages.iter().map(|(layer, file, hooks)| LayerHooks {
        source: Source {
            layer: layer.clone(),
            file: file.clone(),
        },
        hooks: Some(hooks),
    });
    let scoped = scoped.iter().map(|scoped| LayerHooks {
        source: Source {
            layer: scoped.layer.to_owned(),
            file: scoped.file.clone(),
        },
        hooks: Some(&scoped.hooks),
    });
    let layers: Vec<LayerHooks<'_>> = scoped
        .into_iter()
        .chain(
            settings
                .table()
                .layers()
                .iter()
                .rev()
                .map(|spec| LayerHooks {
                    source: Source {
                        layer: spec.id.to_owned(),
                        file: spec.file().map(Path::to_owned),
                    },
                    hooks: settings.layer(spec.id).and_then(|v| v.get("hooks")),
                }),
        )
        .chain(packages)
        .collect();
    let (all_off, managed_only, managed_layer) = managed_hooks(settings);
    let (kept, others): (Vec<LayerHooks<'_>>, Vec<LayerHooks<'_>>) = layers
        .into_iter()
        .partition(|layer| !managed_only || managed_layer(&layer.source.layer));
    let audited = settings.get("/allowManagedHooksOnly") == Some(&Value::Bool(true));
    Configs {
        run: HookConfig::parse(&kept, all_off),
        skipped: (audited && !all_off).then(|| HookConfig::parse(&others, false)),
    }
}

/// Whether Claude Code sends `permission_mode` with `event`.
fn has_mode(event: HookEvent) -> bool {
    matches!(
        event,
        HookEvent::UserPromptSubmit
            | HookEvent::PreToolUse
            | HookEvent::PermissionRequest
            | HookEvent::PostToolUse
            | HookEvent::PostToolUseFailure
            | HookEvent::Stop
            | HookEvent::SubagentStop
            | HookEvent::PostToolBatch
    )
}

/// Whether Claude Code sends `effort` with `event`: the events with a tool-use context.
fn has_effort(event: HookEvent) -> bool {
    matches!(
        event,
        HookEvent::PreToolUse
            | HookEvent::PermissionRequest
            | HookEvent::PostToolUse
            | HookEvent::PostToolUseFailure
            | HookEvent::Stop
            | HookEvent::SubagentStop
            | HookEvent::PostToolBatch
    )
}

/// A list of strings at `pointer` of the merged settings; `None` when absent.
fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    Some(
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

impl HooksService {
    pub(crate) fn new(
        storage: Storage,
        trust: TrustService,
        notices: Option<EventSender>,
        spawner: Arc<dyn ProcessSpawner>,
        runner: RunnerConfig,
        condition: Condition,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                storage,
                trust,
                notices,
                spawner,
                runner,
                condition,
                transcripts: Mutex::default(),
                starts: Mutex::default(),
                scoped: Mutex::default(),
                prompts: Mutex::default(),
                http: Arc::new(WebPort {
                    fetcher: std::sync::OnceLock::new(),
                }),
                outlet: Mutex::default(),
            }),
        }
    }

    /// Lets `prompt` hooks reach the sessions' Agent Hosts.
    pub(crate) fn set_outlet(&self, outlet: Arc<dyn HookOutlet>) {
        *lock(&self.inner.outlet) = Some(outlet);
    }

    /// A new user input of main session `session_id`: its hooks' `prompt_id` from now on.
    pub(crate) fn new_prompt(&self, session_id: &str) -> String {
        let id = crate::sessions::new_session_id().unwrap_or_else(|_| now_ms().to_string());
        lock(&self.inner.prompts).insert(session_id.to_owned(), id.clone());
        id
    }

    fn prompt_id(&self, session_id: &str) -> Option<String> {
        lock(&self.inner.prompts).get(session_id).cloned()
    }

    /// Runs a subagent definition's `hooks` (from `file`) for `session_id`'s events until
    /// [`Self::unscope_hooks`] (T31). The caller checked the project's trust.
    pub(crate) fn scope_hooks(&self, session_id: &str, file: Option<&Path>, hooks: Value) {
        self.scope(session_id, "subagent".into(), SUBAGENT_LAYER, file, hooks);
    }

    /// Runs skill `name`'s `hooks` (from `file`) for `session_id`'s events until the session
    /// closes (T37, ADR-0054 rule 11); invoking it again changes nothing. The caller checked
    /// the project's trust.
    pub(crate) fn scope_skill_hooks(
        &self,
        session_id: &str,
        name: &str,
        file: Option<&Path>,
        hooks: Value,
    ) {
        self.scope(
            session_id,
            format!("skill:{name}"),
            SKILL_LAYER,
            file,
            hooks,
        );
    }

    fn scope(
        &self,
        session_id: &str,
        key: String,
        layer: &'static str,
        file: Option<&Path>,
        hooks: Value,
    ) {
        let mut scoped = lock(&self.inner.scoped);
        let entries = scoped.entry(session_id.to_owned()).or_default();
        if entries.iter().any(|s| s.key == key) {
            return;
        }
        entries.push(Scoped {
            key,
            layer,
            file: file.map(Path::to_owned),
            hooks,
        });
    }

    /// The subagent ended or the session closed: its scoped hooks stop applying.
    pub(crate) fn unscope_hooks(&self, session_id: &str) {
        lock(&self.inner.scoped).remove(session_id);
    }

    /// Remembers where `session_id`'s transcript is.
    pub(crate) fn set_transcript(&self, session_id: &str, path: &str) {
        self.inner
            .transcripts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session_id.to_owned(), path.to_owned());
    }

    /// Marks a `SessionStart` run of `session_id` in progress until the guard drops. The Agent
    /// Host reports `SessionStart` while it opens the session, so its `hooks/run` reaches Core
    /// before the open's answer and is marked before any prompt of the session arrives.
    pub(crate) fn starting(&self, session_id: &str) -> StartGuard {
        self.inner
            .starts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(session_id.to_owned())
            .or_insert_with(|| watch::channel(0).0)
            .send_modify(|n| *n += 1);
        StartGuard {
            service: self.clone(),
            session_id: session_id.to_owned(),
        }
    }

    /// Waits until no `SessionStart` run of `session_id` is in progress (or `cancel`).
    pub(crate) async fn started(&self, session_id: &str, cancel: &CancellationToken) {
        let runs = self
            .inner
            .starts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .map(watch::Sender::subscribe);
        if let Some(mut runs) = runs {
            tokio::select! {
                // The sender lives in the map for good, so the wait cannot fail.
                _ = runs.wait_for(|n| *n == 0) => {}
                () = cancel.cancelled() => {}
            }
        }
    }

    fn transcript(&self, session_id: &str) -> String {
        self.inner
            .transcripts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// The handlers `request` would run, or `None`. Settings that cannot be read run nothing
    /// and tell the user.
    pub(crate) async fn plan(&self, facts: &Facts, request: &Request) -> Option<Plan> {
        self.plan_adjusted(facts, request, |_| ()).await
    }

    /// [`Self::plan`] with `adjust` applied to the loaded settings first (a session's pinned
    /// layers, T41).
    pub(crate) async fn plan_adjusted(
        &self,
        facts: &Facts,
        request: &Request,
        adjust: impl FnOnce(&mut piarc_config::Settings),
    ) -> Option<Plan> {
        let mut settings = match self.inner.trust.permission_settings(&facts.root).await {
            Ok(settings) => settings,
            Err(error) => {
                let message = format!(
                    "{} hooks did not run: the settings could not be read ({error})",
                    request.event.name()
                );
                self.notify(facts, request.event, "error", &message).await;
                return None;
            }
        };
        adjust(&mut settings);
        self.plan_in(&settings, facts, request)
    }

    /// [`Self::plan`] under `settings` already loaded for the same work: a permission decision
    /// reads its settings once for the rules and its hook steps.
    pub(crate) fn plan_in(
        &self,
        settings: &piarc_config::Settings,
        facts: &Facts,
        request: &Request,
    ) -> Option<Plan> {
        let configs = {
            let scoped = lock(&self.inner.scoped);
            config_with(
                settings,
                scoped.get(&facts.session_id).map_or(&[], Vec::as_slice),
            )
        };
        let select = |config: &HookConfig| {
            let mut handlers = config.select(request.event, request.subject.as_deref());
            if let Some((tool, input)) = &request.tool {
                handlers.retain(|h| {
                    h.condition
                        .as_deref()
                        .is_none_or(|rule| (self.inner.condition)(rule, tool, input, facts))
                });
            }
            handlers
        };
        if let Some(skipped) = &configs.skipped {
            self.audit_skipped(facts, request, select(skipped));
        }
        let handlers = select(&configs.run);
        if handlers.is_empty() {
            return None;
        }
        let hook_env = string_list(
            settings
                .layer(piarc_config::ids::USER)
                .and_then(|v| v.get("hookAllowedEnvVars")),
        )
        .unwrap_or_default();
        Some(Plan {
            handlers,
            allowed_urls: string_list(settings.get("/allowedHttpHookUrls")),
            http_env: string_list(settings.get("/httpHookAllowedEnvVars")),
            hook_env,
        })
    }

    /// Runs a [`Plan`] of `request` with the shells and environment of `launch`. Callers resolve
    /// `launch` only once a plan exists: it can come from the user's login shell.
    pub(crate) async fn execute(
        &self,
        facts: &Facts,
        request: &Request,
        plan: Plan,
        launch: Launch,
    ) -> Answer {
        let input = self.input(facts, request);
        let cwd = if facts.cwd.is_dir() {
            facts.cwd.clone()
        } else {
            facts.root.clone()
        };
        let rules = HttpRules {
            allowed_urls: plan.allowed_urls,
            allowed_env_vars: plan.http_env,
            env: launch
                .expansion
                .iter()
                .filter_map(|(k, v)| Some((k.to_str()?.to_owned(), v.to_str()?.to_owned())))
                .collect(),
        };
        let judge = SessionJudge {
            outlet: lock(&self.inner.outlet).clone(),
            session_id: facts.main_session_id.clone(),
        };
        let mcp = SessionMcp {
            outlet: lock(&self.inner.outlet).clone(),
            session_id: facts.main_session_id.clone(),
        };
        let handlers = plan.handlers;
        let runner = Runner::new(
            Arc::clone(&self.inner.spawner),
            Arc::new(launcher::CoreLauncher {
                launch,
                project_dir: facts.root.clone(),
                extra: plan.hook_env,
            }),
            self.inner.runner,
        )
        .with_http(self.inner.http.clone(), rules)
        .with_judge(Arc::new(judge))
        .with_mcp(Arc::new(mcp));
        let ran = piarc_hooks::run(
            &runner,
            request.event,
            &handlers,
            &Value::Object(input),
            &cwd,
            &facts.cancel,
        )
        .await;
        self.audit(facts, request, &ran).await;
        let answer = bounded(facts, request.event, ran);
        for message in &answer.decision.messages {
            self.notify(facts, request.event, "message", message).await;
        }
        for error in &answer.decision.errors {
            self.notify(facts, request.event, "error", error).await;
        }
        // `stopReason` is for the user (a blocked prompt reports it as the refusal instead).
        if let Some(Some(reason)) = &answer.decision.stop
            && request.event != HookEvent::UserPromptSubmit
        {
            self.notify(facts, request.event, "message", reason).await;
        }
        answer
    }

    fn input(&self, facts: &Facts, request: &Request) -> Map<String, Value> {
        let mut input = request.fields.clone();
        input.insert("session_id".into(), json!(facts.main_session_id));
        input.insert(
            "transcript_path".into(),
            json!(self.transcript(&facts.main_session_id)),
        );
        input.insert("cwd".into(), json!(piarc_fs::display(&facts.cwd)));
        match self.prompt_id(&facts.main_session_id) {
            Some(id) => input.insert("prompt_id".into(), json!(id)),
            None => input.remove("prompt_id"),
        };
        match &facts.agent {
            Some(agent) => {
                input.insert("agent_id".into(), json!(agent.id));
                input.insert("agent_type".into(), json!(agent.kind));
            }
            None => {
                input.remove("agent_id");
                input.remove("agent_type");
            }
        }
        if !has_effort(request.event) {
            input.remove("effort");
        }
        match facts.mode {
            Some(mode) if has_mode(request.event) => {
                input.insert("permission_mode".into(), json!(mode));
            }
            _ => {
                input.remove("permission_mode");
            }
        }
        input.insert("hook_event_name".into(), json!(request.event.name()));
        input
    }

    /// One audit row per handler `allowManagedHooksOnly` kept from running (T47), written in
    /// the background: the decision does not wait for it.
    fn audit_skipped(
        &self,
        facts: &Facts,
        request: &Request,
        handlers: Vec<Arc<piarc_hooks::Handler>>,
    ) {
        if handlers.is_empty() {
            return;
        }
        let rows: Vec<piarc_store::AuditEvent> = handlers
            .iter()
            .map(|handler| piarc_store::AuditEvent {
                at: now_ms(),
                kind: "hook".into(),
                session_id: Some(facts.session_id.clone()),
                workspace: Some(piarc_fs::display(&facts.root)),
                detail: piarc_hooks::skipped_detail(
                    request.event,
                    request.subject.as_deref(),
                    handler,
                    MANAGED_ONLY,
                )
                .to_string(),
            })
            .collect();
        let storage = self.inner.storage.clone();
        let session = facts.session_id.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            let written = storage
                .run(move |db| {
                    rows.iter()
                        .try_for_each(|row| db.append_audit(row).map(drop))
                })
                .await;
            if !matches!(written, Ok(Ok(()))) {
                tracing::warn!(target: "piarc_core::hooks", %session,
                    "cannot record skipped hooks in the audit");
            }
        });
    }

    async fn audit(&self, facts: &Facts, request: &Request, ran: &Ran) {
        let rows: Vec<piarc_store::AuditEvent> = ran
            .outcomes
            .iter()
            .zip(&ran.decision.verdicts)
            .map(|(outcome, verdict)| piarc_store::AuditEvent {
                at: now_ms(),
                kind: "hook".into(),
                session_id: Some(facts.session_id.clone()),
                workspace: Some(piarc_fs::display(&facts.root)),
                detail: piarc_hooks::audit_detail(
                    request.event,
                    request.subject.as_deref(),
                    outcome,
                    verdict,
                )
                .to_string(),
            })
            .collect();
        let written = self
            .inner
            .storage
            .run(move |db| {
                rows.iter()
                    .try_for_each(|row| db.append_audit(row).map(drop))
            })
            .await;
        if !matches!(written, Ok(Ok(()))) {
            tracing::warn!(target: "piarc_core::hooks", session = %facts.session_id,
                "cannot record hook runs in the audit");
        }
    }

    /// A notice for the user on `core/notices`. The client labels it with the event, so a
    /// leading "`<Event>` hook error:" or "`<Event>` hook:" is left out of `message`.
    pub(crate) async fn notify(&self, facts: &Facts, event: HookEvent, level: &str, message: &str) {
        tracing::info!(target: "piarc_core::hooks", session = %facts.session_id,
            event = event.name(), level, "{message}");
        let name = event.name();
        let message = [
            format!("{name} hook error: "),
            format!("{name} hook stopped: "),
            format!("{name} hook: "),
        ]
        .iter()
        .find_map(|prefix| message.strip_prefix(prefix.as_str()))
        .unwrap_or(message);
        let Some(events) = &self.inner.notices else {
            return;
        };
        let id = crate::sessions::new_session_id().unwrap_or_else(|_| now_ms().to_string());
        let notice = json!({
            "type": "hook",
            "id": id,
            "sessionId": facts.session_id,
            "event": event.name(),
            "level": level,
            "message": message,
        });
        if let Ok(event) = Event::from_json(RouteKey::notices(), &notice) {
            // Only a Core shutting down refuses it.
            let _ = events.send(event).await;
        }
    }
}

/// Bounds the decision's texts: context, feedback and messages over the limit go to a file.
fn bounded(facts: &Facts, event: HookEvent, ran: Ran) -> Answer {
    let dir = facts.tmp_dir.join("hooks");
    let mut decision = ran.decision;
    let stamp = now_ms();
    let mut n = 0;
    let mut bound = |texts: &mut Vec<String>, what: &str| {
        for text in texts.iter_mut() {
            n += 1;
            let name = format!("{}-{what}-{stamp}-{n}", event.name());
            *text = piarc_hooks::spill::bound(text, &dir, &name);
        }
    };
    bound(&mut decision.context, "context");
    bound(&mut decision.feedback, "feedback");
    bound(&mut decision.messages, "message");
    let join = |texts: &[String]| (!texts.is_empty()).then(|| texts.join("\n\n"));
    let instructions: Vec<String> = decision
        .instructions
        .iter()
        .map(|t| piarc_hooks::spill::cut(t))
        .collect();
    Answer {
        context: join(&decision.context),
        feedback: join(&decision.feedback),
        instructions: join(&instructions),
        decision,
    }
}

#[cfg(test)]
mod managed_tests;
