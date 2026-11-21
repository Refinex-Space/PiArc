//! The session side of hooks (architecture section 6.3, ADR-0039): which facts a session's
//! hooks run with, AHP `hooks/run` for the events the Agent Host observes in Pi, and the events
//! Core observes itself (`UserPromptSubmit` before input goes to the Agent Host,
//! `Notification` when the user is told something). `PreToolUse` and `PermissionRequest` are
//! steps 2 and 8 of the decision ladder, in `policy/hooks.rs`.
//!
//! A hook's cancellation follows its session: an interrupted turn, a closed session or a lost
//! connection stops the handlers' process trees.

use std::path::{Path, PathBuf};

use piarc_hooks::{HookEvent, STOP_CONTINUATION_LIMIT};
use piarc_host::Peer;
use piarc_protocol::hooks::{HookStop, HooksRunParams, HooksRunResult, HostHookEvent};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value, json};
use tokio_util::sync::{CancellationToken, DropGuard};

use super::{SessionIo, ToolIo, lock, to_value};
use crate::hooks::{AgentFacts, Answer, Facts, HooksService, Request};

/// A token cancelled when `peer`'s connection ends (or the guard drops).
pub(super) fn linked(
    peer: &Peer,
    parent: Option<&CancellationToken>,
) -> (CancellationToken, DropGuard) {
    let token = parent.map_or_else(CancellationToken::new, CancellationToken::child_token);
    let watch = token.clone();
    let peer = peer.clone();
    tokio::spawn(async move {
        tokio::select! {
            () = peer.closed() => watch.cancel(),
            () = watch.cancelled() => {}
        }
    });
    (token.clone(), token.drop_guard())
}

/// Registers `token` with the session's running work, so an interrupted turn cancels it.
struct Running<'a> {
    session: &'a SessionIo,
    key: String,
}

impl<'a> Running<'a> {
    fn new(session: &'a SessionIo, token: &CancellationToken) -> Self {
        let key = format!(
            "hook:{}",
            crate::sessions::new_session_id().unwrap_or_default()
        );
        lock(&session.running).insert(key.clone(), token.clone());
        Self { session, key }
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.session.running).remove(&self.key);
    }
}

/// The input fields and matcher subject of each event the Agent Host reports. `effort` is
/// accepted everywhere; Core keeps it only on the events Claude Code sends it with.
#[expect(clippy::too_many_lines, reason = "a table with one arm per event")]
fn host_event(event: HostHookEvent) -> (HookEvent, &'static [&'static str], Option<&'static str>) {
    match event {
        HostHookEvent::SubagentStart => (HookEvent::SubagentStart, &[], None),
        HostHookEvent::SubagentStop => (
            HookEvent::SubagentStop,
            &[
                "stop_hook_active",
                "agent_transcript_path",
                "last_assistant_message",
                "background_tasks",
                "session_crons",
                "effort",
            ],
            None,
        ),
        HostHookEvent::PostToolBatch => (HookEvent::PostToolBatch, &["tool_calls", "effort"], None),
        HostHookEvent::SessionStart => (
            HookEvent::SessionStart,
            &["source", "model"],
            Some("source"),
        ),
        HostHookEvent::SessionEnd => (HookEvent::SessionEnd, &["reason"], Some("reason")),
        HostHookEvent::PostToolUse => (
            HookEvent::PostToolUse,
            &[
                "tool_name",
                "tool_input",
                "tool_response",
                "tool_use_id",
                "duration_ms",
                "effort",
            ],
            Some("tool_name"),
        ),
        HostHookEvent::PostToolUseFailure => (
            HookEvent::PostToolUseFailure,
            &[
                "tool_name",
                "tool_input",
                "tool_use_id",
                "error",
                "is_interrupt",
                "duration_ms",
                "effort",
            ],
            Some("tool_name"),
        ),
        HostHookEvent::Stop => (
            HookEvent::Stop,
            &[
                "stop_hook_active",
                "last_assistant_message",
                "background_tasks",
                "session_crons",
                "effort",
            ],
            None,
        ),
        HostHookEvent::PreCompact => (
            HookEvent::PreCompact,
            &["trigger", "custom_instructions"],
            Some("trigger"),
        ),
        HostHookEvent::PostCompact => (
            HookEvent::PostCompact,
            &["trigger", "compact_summary"],
            Some("trigger"),
        ),
        HostHookEvent::InstructionsLoaded => (
            HookEvent::InstructionsLoaded,
            &["file_path", "memory_type", "load_reason"],
            Some("load_reason"),
        ),
        HostHookEvent::StopFailure => (
            HookEvent::StopFailure,
            &["error", "error_details", "last_assistant_message"],
            Some("error"),
        ),
        HostHookEvent::UserPromptExpansion => (
            HookEvent::UserPromptExpansion,
            &[
                "expansion_type",
                "command_name",
                "command_args",
                "command_source",
                "prompt",
            ],
            Some("command_name"),
        ),
    }
}

/// The request of an event the Agent Host reported: its own fields (by the event's list), the
/// fields Claude Code always sends with it, the matcher's subject and the tool call.
fn host_request(event: HostHookEvent, input: Map<String, Value>) -> Request {
    let (event, keys, subject) = host_event(event);
    let mut fields: Map<String, Value> = input
        .into_iter()
        .filter(|(k, _)| keys.contains(&k.as_str()))
        .collect();
    if matches!(event, HookEvent::Stop | HookEvent::SubagentStop) {
        fields.entry("stop_hook_active").or_insert(json!(false));
        fields.entry("background_tasks").or_insert(json!([]));
        fields.entry("session_crons").or_insert(json!([]));
    }
    let tool = match (fields.get("tool_name"), fields.get("tool_input")) {
        (Some(Value::String(name)), Some(Value::Object(input))) => {
            Some((name.clone(), input.clone()))
        }
        _ => None,
    };
    Request {
        event,
        subject: subject
            .and_then(|k| fields.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned),
        fields,
        tool,
    }
}

/// Whether `path` lies in `root` after removing `.` and `..`.
fn within(root: &Path, path: &Path) -> bool {
    path.is_absolute() && super::policy::lexical(path).starts_with(root)
}

impl ToolIo {
    pub(super) fn hook_service(&self) -> Option<&HooksService> {
        self.policy.as_ref()?.hooks.as_ref()
    }

    /// Lets `prompt` hooks reach the sessions' Agent Hosts (the session layer, T38).
    pub(crate) fn set_hook_outlet(&self, outlet: std::sync::Arc<dyn crate::hooks::HookOutlet>) {
        if let Some(hooks) = self.hook_service() {
            hooks.set_outlet(outlet);
        }
    }

    /// The facts of an open session's hooks.
    pub(super) fn session_facts(
        &self,
        s: &SessionIo,
        id: &str,
        cancel: CancellationToken,
    ) -> Facts {
        let mode = lock(&s.policy).mode();
        let (main_session_id, agent) = match &s.subagent {
            Some(link) => (
                link.root_id.clone(),
                Some(AgentFacts {
                    id: id.to_owned(),
                    kind: link.agent_type.clone(),
                }),
            ),
            None => (id.to_owned(), None),
        };
        Facts {
            session_id: id.to_owned(),
            main_session_id,
            agent,
            root: s.project().to_path_buf(),
            cwd: s.scope.cwd().to_path_buf(),
            tmp_dir: s.tmp_dir.clone(),
            mode: Some(mode),
            fold_case: s.scope.case_insensitive(),
            cancel,
        }
    }

    /// Runs `request`'s hooks; nothing configured or matched is an empty [`Answer`] and does
    /// not resolve the command environment (the login shell, the first time).
    pub(super) async fn run_hooks(
        &self,
        hooks: &HooksService,
        facts: &Facts,
        request: &Request,
    ) -> Answer {
        // A session whose ConfigChange hooks pinned a layer plans with that value (T41).
        let pinned = self
            .session(&facts.session_id)
            .ok()
            .filter(|s| !lock(&s.config_pins).is_empty());
        let planned = match pinned {
            Some(s) => {
                hooks
                    .plan_adjusted(facts, request, |settings| Self::apply_pins(&s, settings))
                    .await
            }
            None => hooks.plan(facts, request).await,
        };
        match planned {
            Some(plan) => {
                let launch = self.exec.hook_launch().await;
                hooks.execute(facts, request, plan, launch).await
            }
            None => Answer::default(),
        }
    }

    /// AHP `hooks/run` from the Agent Host of `workspace`; `ours` says whether the session is
    /// one of the workspace's. The session may already be closed in Core (`SessionEnd`): its
    /// working directory then comes from the request and must lie in the workspace.
    pub(crate) async fn hooks_run(
        &self,
        workspace: &Path,
        ours: bool,
        params: Map<String, Value>,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let p: HooksRunParams = super::parse("hooks/run", params)?;
        super::check_session_id(&p.session_id)?;
        let Some(hooks) = self.hook_service() else {
            return to_value(&HooksRunResult::default());
        };
        if !ours && self.session(&p.session_id).is_ok() {
            // Open in Core but not in this workspace: its hooks, transcript and prompt
            // ordering are not this Agent Host's to touch (R1-A13).
            let mut error = ErrorObject::new(
                ErrorKind::SessionNotFound,
                format!("hooks/run: no session {} in this workspace", p.session_id),
                false,
            );
            error.data.details = Some(json!({ "sessionId": p.session_id }));
            return Err(error);
        }
        let requested = PathBuf::from(&p.cwd);
        if !within(workspace, &requested) {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                format!("hooks/run: {} is not in this workspace", p.cwd),
                false,
            ));
        }
        if let Some(path) = &p.transcript_path {
            hooks.set_transcript(&p.session_id, path);
        }
        // Marked before anything awaits: the session's prompts wait for it.
        let _starting = (p.event == HostHookEvent::SessionStart
            && p.input.get("source").and_then(Value::as_str) != Some("compact"))
        .then(|| hooks.starting(&p.session_id));
        let request = host_request(p.event, p.input);
        let event = request.event;
        let (token, _guard) = linked(peer, None);
        let answer = match self.session(&p.session_id) {
            Ok(s) => {
                let _running = Running::new(&s, &token);
                let facts = self.session_facts(&s, &p.session_id, token.clone());
                // The subagent events match the agent type (T38).
                let request = match (&facts.agent, event) {
                    (Some(agent), HookEvent::SubagentStart | HookEvent::SubagentStop) => Request {
                        subject: Some(agent.kind.clone()),
                        ..request
                    },
                    _ => request,
                };
                self.run_hooks(hooks, &facts, &request).await
            }
            Err(_) => {
                let facts = Facts {
                    session_id: p.session_id.clone(),
                    main_session_id: p.session_id.clone(),
                    agent: None,
                    root: workspace.to_path_buf(),
                    cwd: super::policy::lexical(&requested),
                    tmp_dir: self.session_dir(&p.session_id).join("tmp"),
                    mode: None,
                    fold_case: cfg!(any(windows, target_os = "macos")),
                    cancel: token.clone(),
                };
                self.run_hooks(hooks, &facts, &request).await
            }
        };
        let result = self
            .host_result(hooks, &p.session_id, event, p.continuations, answer)
            .await;
        to_value(&result)
    }

    async fn host_result(
        &self,
        hooks: &HooksService,
        id: &str,
        event: HookEvent,
        continuations: Option<u64>,
        answer: Answer,
    ) -> HooksRunResult {
        let d = answer.decision;
        let stop = d.stop.clone().map(|reason| HookStop { reason });
        let mut result = HooksRunResult {
            stop,
            ..HooksRunResult::default()
        };
        match event {
            HookEvent::Stop | HookEvent::SubagentStop => {
                let continues = d.block.is_some() || answer.context.is_some();
                if continues && continuations.unwrap_or(0) >= u64::from(STOP_CONTINUATION_LIMIT) {
                    if let Ok(s) = self.session(id) {
                        let facts = self.session_facts(&s, id, CancellationToken::new());
                        let message = format!(
                            "{} hooks continued the turn {STOP_CONTINUATION_LIMIT} times in a row; PiArc ended the turn.",
                            event.name()
                        );
                        hooks.notify(&facts, event, "error", &message).await;
                    }
                } else {
                    result.block = d.block;
                    result.context = answer.context;
                }
            }
            HookEvent::PreCompact => {
                if let (Some(reason), Ok(s)) = (&d.block, self.session(id)) {
                    let facts = self.session_facts(&s, id, CancellationToken::new());
                    let message = format!("Compaction blocked: {reason}");
                    hooks.notify(&facts, event, "message", &message).await;
                }
                result.block = d.block;
                result.instructions = answer.instructions;
            }
            HookEvent::PostToolUse | HookEvent::PostToolUseFailure => {
                result.context = answer.context;
                result.feedback = answer.feedback;
                if event == HookEvent::PostToolUse {
                    result.updated_output = d.updated_output;
                }
            }
            HookEvent::SessionStart | HookEvent::SubagentStart => {
                // `watchPaths` of SessionStart start the session's FileChanged watch (T41).
                if let Some(paths) = &d.watch_paths {
                    self.set_watch_paths(id, paths).await;
                }
                result.context = answer.context;
            }
            HookEvent::UserPromptExpansion => {
                result.block = d.block;
                result.context = answer.context;
            }
            HookEvent::PostToolBatch => {
                if let (Some(reason), Ok(s)) = (&d.block, self.session(id)) {
                    let facts = self.session_facts(&s, id, CancellationToken::new());
                    let message = format!("Stopped after the tool calls: {reason}");
                    hooks.notify(&facts, event, "message", &message).await;
                }
                result.block = d.block;
                result.context = answer.context;
            }
            _ => {}
        }
        result
    }

    /// `UserPromptSubmit` for input `text` before it goes to the Agent Host: `Err` with the
    /// reason when a hook blocks it, otherwise the context hooks added.
    pub(crate) async fn user_prompt_submit(
        &self,
        id: &str,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, String> {
        let (Some(hooks), Ok(s)) = (self.hook_service(), self.session(id)) else {
            return Ok(None);
        };
        let token = cancel.child_token();
        let _running = Running::new(&s, &token);
        // Claude Code runs a session's SessionStart hooks before its first prompt's.
        hooks.started(id, &token).await;
        // Every input is a new prompt for the hooks' `prompt_id` (T38, I115).
        hooks.new_prompt(id);
        let facts = self.session_facts(&s, id, token.clone());
        let mut fields = Map::new();
        fields.insert("prompt".into(), json!(text));
        let request = Request {
            event: HookEvent::UserPromptSubmit,
            subject: None,
            fields,
            tool: None,
        };
        let answer = self.run_hooks(hooks, &facts, &request).await;
        match answer.decision.block {
            Some(reason) => Err(reason),
            None => Ok(answer.context),
        }
    }

    /// `UserPromptExpansion` (T41): a slash command, skill or MCP prompt the user typed is about
    /// to become the input (`command_name` is the matcher). `Err` with the reason when a hook
    /// blocks it, otherwise the context hooks added.
    pub(crate) async fn user_prompt_expansion(
        &self,
        id: &str,
        fields: Map<String, Value>,
    ) -> Result<Option<String>, String> {
        let (Some(hooks), Ok(s)) = (self.hook_service(), self.session(id)) else {
            return Ok(None);
        };
        let token = CancellationToken::new();
        let _running = Running::new(&s, &token);
        hooks.started(id, &token).await;
        let facts = self.session_facts(&s, id, token.clone());
        let request = Request {
            event: HookEvent::UserPromptExpansion,
            subject: fields
                .get("command_name")
                .and_then(Value::as_str)
                .map(str::to_owned),
            fields,
            tool: None,
        };
        let answer = self.run_hooks(hooks, &facts, &request).await;
        match answer.decision.block {
            Some(reason) => Err(reason),
            None => Ok(answer.context),
        }
    }

    /// `Notification`: Core tells the user something (`notification_type` is the matcher).
    pub(crate) async fn notification_hooks(&self, id: &str, kind: &str, message: &str) {
        let (Some(hooks), Ok(s)) = (self.hook_service(), self.session(id)) else {
            return;
        };
        let token = CancellationToken::new();
        let _running = Running::new(&s, &token);
        let facts = self.session_facts(&s, id, token.clone());
        let mut fields = Map::new();
        fields.insert("message".into(), json!(message));
        fields.insert("title".into(), json!("PiArc"));
        fields.insert("notification_type".into(), json!(kind));
        let request = Request {
            event: HookEvent::Notification,
            subject: Some(kind.to_owned()),
            fields,
            tool: None,
        };
        self.run_hooks(hooks, &facts, &request).await;
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
