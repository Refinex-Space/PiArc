//! Hooks in Core (architecture section 6.3, ADR-0039): every hook command runs here, whichever
//! process observed the event.
//!
//! - Configuration: the `hooks` of every settings layer, read the way a permission decision
//!   reads settings ([`TrustService::permission_settings`]), so an untrusted project's hooks
//!   (`.piarc/settings*.json`, `.claude/settings*.json`) are left out while the user's run.
//!   `disableAllHooks` after merging turns them all off.
//! - Input: the event's own fields plus `session_id`, `transcript_path`, `cwd`,
//!   `hook_event_name` and, where Claude Code sends it, `permission_mode`.
//! - Running: `piarc-hooks` with `piarc-exec`'s process-tree spawner and the tools' command
//!   environment; the session's turn token cancels them.
//! - Afterwards: one `audit_events` row (`kind: "hook"`) per handler; `systemMessage`s and
//!   errors for the user go to `core/notices` (`{ type: "hook", id, sessionId, event, level,
//!   message }`); texts over 10,000 characters go to `<session tmp>/hooks/` and are replaced
//!   with a preview and the path.

mod launcher;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

pub(crate) use launcher::Launch;
use piarc_hooks::{Decision, HookConfig, HookEvent, LayerHooks, Ran, Runner, RunnerConfig, Source};
use piarc_ports::ProcessSpawner;
use piarc_protocol::policy::PermissionMode;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::storage::{Storage, now_ms};
use crate::trust::TrustService;

/// What the hooks of one session run with.
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    pub session_id: String,
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
    pub launch: Launch,
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

/// The handlers one event will run.
pub(crate) struct Plan(Vec<Arc<piarc_hooks::Handler>>);

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
}

impl std::fmt::Debug for HooksService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HooksService")
            .field("runner", &self.inner.runner)
            .finish_non_exhaustive()
    }
}

/// The hooks of `settings`, highest precedence first.
pub(crate) fn config_of(settings: &piarc_config::Settings) -> HookConfig {
    let layers: Vec<LayerHooks<'_>> = settings
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
        })
        .collect();
    let disabled = settings.get("/disableAllHooks") == Some(&Value::Bool(true));
    HookConfig::parse(&layers, disabled)
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
            }),
        }
    }

    /// Remembers where `session_id`'s transcript is.
    pub(crate) fn set_transcript(&self, session_id: &str, path: &str) {
        self.inner
            .transcripts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session_id.to_owned(), path.to_owned());
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

    /// Runs `request`'s hooks; nothing configured or matched is an empty [`Answer`].
    pub(crate) async fn run(&self, facts: &Facts, request: &Request) -> Answer {
        match self.plan(facts, request).await {
            Some(plan) => self.execute(facts, request, plan).await,
            None => Answer::default(),
        }
    }

    /// The handlers `request` would run, or `None`. Settings that cannot be read run nothing
    /// and tell the user.
    pub(crate) async fn plan(&self, facts: &Facts, request: &Request) -> Option<Plan> {
        let settings = match self.inner.trust.permission_settings(&facts.root).await {
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
        let config = config_of(&settings);
        let mut handlers = config.select(request.event, request.subject.as_deref());
        if let Some((tool, input)) = &request.tool {
            handlers.retain(|h| {
                h.condition
                    .as_deref()
                    .is_none_or(|rule| (self.inner.condition)(rule, tool, input, facts))
            });
        }
        (!handlers.is_empty()).then_some(Plan(handlers))
    }

    /// Runs a [`Plan`] of `request`.
    pub(crate) async fn execute(&self, facts: &Facts, request: &Request, plan: Plan) -> Answer {
        let handlers = plan.0;
        let input = self.input(facts, request);
        let cwd = if facts.cwd.is_dir() {
            facts.cwd.clone()
        } else {
            facts.root.clone()
        };
        let runner = Runner::new(
            Arc::clone(&self.inner.spawner),
            Arc::new(launcher::CoreLauncher {
                launch: facts.launch.clone(),
                project_dir: facts.root.clone(),
            }),
            self.inner.runner,
        );
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
        input.insert("session_id".into(), json!(facts.session_id));
        input.insert(
            "transcript_path".into(),
            json!(self.transcript(&facts.session_id)),
        );
        input.insert("cwd".into(), json!(piarc_fs::display(&facts.cwd)));
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
