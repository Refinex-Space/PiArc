//! Merging the outcomes of one event's handlers into one [`Decision`] (architecture section
//! 6.3.1, Claude Code's output fields per event).
//!
//! | Event | What counts |
//! |---|---|
//! | `PreToolUse` | `permissionDecision` (deny > ask > allow; `defer` is ask), exit 2 = deny, `updatedInput`, `additionalContext` |
//! | `PermissionRequest` | `decision.behavior` (deny > allow), `updatedInput`, `updatedPermissions`, `message`, `interrupt`; exit 2 is ignored |
//! | `UserPromptSubmit` | `decision: "block"` or exit 2 blocks, `additionalContext` and plain stdout add context |
//! | `Stop`, `SubagentStop` | `decision: "block"` or exit 2 continues the turn with the reason; `additionalContext` too |
//! | `PostToolBatch` | `decision: "block"` or exit 2 stops the loop with the reason; `additionalContext` for the next request |
//! | `SubagentStart` | `additionalContext` for the subagent's first request; exit 2's stderr goes to the user |
//! | `PreCompact` | `decision: "block"` or exit 2 blocks; plain stdout is the summary's instructions |
//! | `PostToolUse` | `decision: "block"` and exit 2 add feedback for the model, `additionalContext`, `updatedToolOutput` |
//! | `PostToolUseFailure` | as `PostToolUse` without `updatedToolOutput` |
//! | `SessionStart` | `additionalContext` and plain stdout add context; exit 2's stderr goes to the user |
//! | `SessionEnd`, `PostCompact`, `Notification` | nothing; exit 2's stderr goes to the user (not for `Notification`) |
//!
//! Every event but `SessionEnd`, `PreCompact`, `PostCompact` and `Notification` also takes
//! `systemMessage` (shown to the user) and `continue: false` with `stopReason` (the agent stops).
//! Non-blocking errors are shown to the user and the action continues, except that a handler
//! with `onFailure: "block"` blocks where the event can block (not on `SubagentStop`, as in
//! Claude Code).

use serde_json::{Map, Value};

use crate::event::{ExitTwo, HookEvent, PlainStdout};
use crate::output::{Kind, Outcome};

/// `PreToolUse`'s merged permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    /// Not blocked; later deny and ask rules and plan mode still apply.
    Allow,
    /// Ask the user.
    Ask,
    /// Refuse.
    Deny,
}

/// `PermissionRequest`'s merged answer.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestAnswer {
    /// Allow (true) or deny.
    pub allow: bool,
    /// Allow: the input to run with instead.
    pub updated_input: Option<Map<String, Value>>,
    /// Allow: permission updates, in handler order.
    pub updated_permissions: Vec<Value>,
    /// Deny: what the model reads.
    pub message: Option<String>,
    /// Deny: stop the agent too.
    pub interrupt: bool,
    /// Allow: where the handlers that gave `updated_permissions` are defined (T38, I122: a
    /// project's hooks may not persist permissions beyond the session).
    pub updated_by: Vec<crate::config::Source>,
}

/// The merged decision of one event.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Decision {
    /// The action is blocked, with this reason (`UserPromptSubmit`, `Stop` and `SubagentStop` —
    /// continue with it —, `PreCompact`, `PostToolBatch`).
    pub block: Option<String>,
    /// `PreToolUse`.
    pub permission: Option<Permission>,
    /// `PreToolUse`: the reason of the winning permission.
    pub permission_reason: Option<String>,
    /// `PreToolUse`: the input to run with instead.
    pub updated_input: Option<Map<String, Value>>,
    /// `PermissionRequest`.
    pub request: Option<RequestAnswer>,
    /// Text for the model's context, in handler order.
    pub context: Vec<String>,
    /// `PostToolUse` and `PostToolUseFailure`: feedback the model reads next to the result.
    pub feedback: Vec<String>,
    /// `PostToolUse`: the output the model reads instead.
    pub updated_output: Option<Value>,
    /// `PreCompact`: instructions for the summary.
    pub instructions: Vec<String>,
    /// `continue: false`: the agent stops, with this reason when given.
    pub stop: Option<Option<String>>,
    /// `systemMessage`s for the user.
    pub messages: Vec<String>,
    /// Errors for the user (non-blocking errors, exit 2's stderr where only the user reads it).
    pub errors: Vec<String>,
    /// Each handler's verdict for the audit, in handler order.
    pub verdicts: Vec<&'static str>,
}

impl Decision {
    /// Merges `outcomes` of `event`.
    #[must_use]
    pub fn merge(event: HookEvent, outcomes: &[Outcome]) -> Self {
        let mut m = Merger::default();
        for outcome in outcomes {
            let verdict = m.add(event, outcome);
            m.d.verdicts.push(verdict);
        }
        m.finish(event);
        m.d
    }
}

/// The decision being built, with the inputs waiting for the final permission.
#[derive(Default)]
struct Merger {
    d: Decision,
    /// `updatedInput` of the first handler with the current winning permission.
    pending_input: Option<(Option<Permission>, Map<String, Value>)>,
    /// `updatedInput` of the first handler without a permission.
    loose_input: Option<Map<String, Value>>,
}

impl Merger {
    fn add(&mut self, event: HookEvent, o: &Outcome) -> &'static str {
        if event.uses_common_fields() {
            if let Some(message) = o.field("systemMessage").filter(|m| !m.trim().is_empty()) {
                self.d.messages.push(message.to_owned());
            }
            if o.stops() && self.d.stop.is_none() {
                self.d.stop = Some(o.field("stopReason").map(str::to_owned));
            }
        }
        match &o.kind {
            Kind::Error(message) => {
                self.d.errors.push(message.clone());
                if o.handler.block_on_failure {
                    return self.fail_closed(event, message);
                }
                if o.timed_out {
                    "timeout"
                } else if o.cancelled {
                    "cancelled"
                } else {
                    "error"
                }
            }
            Kind::Blocking(reason) => self.blocking(event, o, reason),
            Kind::Success => self.success(event, o),
        }
    }

    /// `onFailure: "block"`: an error blocks where the event can.
    fn fail_closed(&mut self, event: HookEvent, message: &str) -> &'static str {
        match event {
            HookEvent::SubagentStop => "error",
            HookEvent::PreToolUse => {
                self.permit(Permission::Deny, Some(message.to_owned()));
                "deny"
            }
            HookEvent::PermissionRequest => {
                self.answer(RequestAnswer {
                    allow: false,
                    updated_input: None,
                    updated_permissions: Vec::new(),
                    message: Some(message.to_owned()),
                    interrupt: false,
                    updated_by: Vec::new(),
                });
                "deny"
            }
            _ if event.exit_two() == ExitTwo::Blocks => {
                self.d.block.get_or_insert_with(|| message.to_owned());
                "block"
            }
            _ => "error",
        }
    }

    fn blocking(&mut self, event: HookEvent, o: &Outcome, reason: &str) -> &'static str {
        match event.exit_two() {
            ExitTwo::Blocks => {
                if event == HookEvent::PreToolUse {
                    let reason = o
                        .specific_field("permissionDecisionReason")
                        .unwrap_or(reason);
                    self.permit(Permission::Deny, Some(reason.to_owned()));
                    "deny"
                } else {
                    self.d.block.get_or_insert_with(|| reason.to_owned());
                    "block"
                }
            }
            ExitTwo::ToModel => {
                if !reason.is_empty() {
                    self.d.feedback.push(reason.to_owned());
                }
                self.context_of(o);
                "block"
            }
            ExitTwo::ToUser => {
                if !reason.is_empty() {
                    self.d
                        .errors
                        .push(format!("{} hook: {reason}", event.name()));
                }
                "error"
            }
            ExitTwo::Ignored => {
                if event == HookEvent::PermissionRequest {
                    return self.permission_request(o);
                }
                "none"
            }
        }
    }

    fn success(&mut self, event: HookEvent, o: &Outcome) -> &'static str {
        match event {
            HookEvent::PreToolUse => self.pre_tool_use(o),
            HookEvent::PermissionRequest => self.permission_request(o),
            HookEvent::SessionEnd | HookEvent::PostCompact | HookEvent::Notification => "none",
            _ => {
                let mut verdict = "none";
                if o.field("decision") == Some("block")
                    && !matches!(event, HookEvent::SessionStart | HookEvent::SubagentStart)
                {
                    let reason = o.field("reason").unwrap_or_default().to_owned();
                    verdict = "block";
                    if event.exit_two() == ExitTwo::ToModel {
                        if !reason.is_empty() {
                            self.d.feedback.push(reason);
                        }
                    } else {
                        let reason = if reason.is_empty() {
                            format!("Blocked by a {} hook.", event.name())
                        } else {
                            reason
                        };
                        self.d.block.get_or_insert(reason);
                    }
                }
                if self.context_of(o) && verdict == "none" {
                    verdict = "context";
                }
                if event == HookEvent::PostToolUse
                    && let Some(output) = o.specific().and_then(|s| s.get("updatedToolOutput"))
                {
                    self.d.updated_output.get_or_insert_with(|| output.clone());
                    verdict = "updated";
                }
                match (event.plain_stdout(), &o.text) {
                    (PlainStdout::Context, Some(text)) => {
                        self.d.context.push(text.clone());
                        if verdict == "none" {
                            verdict = "context";
                        }
                    }
                    (PlainStdout::Instructions, Some(text)) => {
                        self.d.instructions.push(text.clone());
                        verdict = "instructions";
                    }
                    _ => {}
                }
                verdict
            }
        }
    }

    /// Adds `hookSpecificOutput.additionalContext`; returns whether there was some.
    fn context_of(&mut self, o: &Outcome) -> bool {
        match o.specific_field("additionalContext") {
            Some(text) if !text.trim().is_empty() => {
                self.d.context.push(text.to_owned());
                true
            }
            _ => false,
        }
    }

    fn pre_tool_use(&mut self, o: &Outcome) -> &'static str {
        let decision = match o.specific_field("permissionDecision") {
            Some("allow") => Some(Permission::Allow),
            Some("ask" | "defer") => Some(Permission::Ask),
            Some("deny") => Some(Permission::Deny),
            _ => match o.field("decision") {
                // Deprecated top-level form.
                Some("approve") => Some(Permission::Allow),
                Some("block") => Some(Permission::Deny),
                _ => None,
            },
        };
        let reason = o
            .specific_field("permissionDecisionReason")
            .or_else(|| o.field("reason"))
            .map(str::to_owned);
        self.context_of(o);
        if let Some(decision) = decision {
            self.permit(decision, reason);
        }
        if let Some(input) = o
            .specific()
            .and_then(|s| s.get("updatedInput"))
            .and_then(Value::as_object)
        {
            self.offer_input(decision, input);
        }
        match decision {
            Some(Permission::Allow) => "allow",
            Some(Permission::Ask) => "ask",
            Some(Permission::Deny) => "deny",
            None if o.specific().is_some_and(|s| s.contains_key("updatedInput")) => "updated",
            None => "none",
        }
    }

    /// Records a handler's permission; the strictest wins, its first reason with it.
    fn permit(&mut self, decision: Permission, reason: Option<String>) {
        match self.d.permission {
            Some(current) if current >= decision => {}
            _ => {
                self.d.permission = Some(decision);
                self.d.permission_reason = reason;
                self.pending_input = None;
            }
        }
    }

    fn offer_input(&mut self, decision: Option<Permission>, input: &Map<String, Value>) {
        // Kept with the decision that produced it; an input without a decision applies when
        // no handler decides otherwise.
        if decision.is_some() && decision == self.d.permission {
            self.pending_input
                .get_or_insert_with(|| (decision, input.clone()));
        } else if decision.is_none() {
            self.loose_input.get_or_insert_with(|| input.clone());
        }
    }

    fn permission_request(&mut self, o: &Outcome) -> &'static str {
        let Some(decision) = o.specific().and_then(|s| s.get("decision")) else {
            return "none";
        };
        let text = |key: &str| decision.get(key).and_then(Value::as_str).map(str::to_owned);
        match decision.get("behavior").and_then(Value::as_str) {
            Some("allow") => {
                let updated_permissions = decision
                    .get("updatedPermissions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let updated_by = if updated_permissions.is_empty() {
                    Vec::new()
                } else {
                    vec![o.handler.source.clone()]
                };
                self.answer(RequestAnswer {
                    allow: true,
                    updated_input: decision
                        .get("updatedInput")
                        .and_then(Value::as_object)
                        .cloned(),
                    updated_permissions,
                    message: None,
                    interrupt: false,
                    updated_by,
                });
                "allow"
            }
            Some("deny") => {
                self.answer(RequestAnswer {
                    allow: false,
                    updated_input: None,
                    updated_permissions: Vec::new(),
                    message: text("message"),
                    interrupt: decision.get("interrupt") == Some(&Value::Bool(true)),
                    updated_by: Vec::new(),
                });
                "deny"
            }
            _ => "none",
        }
    }

    /// Deny beats allow; allows add their permission updates, the first input wins.
    fn answer(&mut self, next: RequestAnswer) {
        match &mut self.d.request {
            None => self.d.request = Some(next),
            Some(current) if current.allow && !next.allow => self.d.request = Some(next),
            Some(current) if current.allow => {
                current.updated_permissions.extend(next.updated_permissions);
                current.updated_by.extend(next.updated_by);
                if current.updated_input.is_none() {
                    current.updated_input = next.updated_input;
                }
            }
            Some(current) => current.interrupt |= next.interrupt && !next.allow,
        }
    }

    fn finish(&mut self, event: HookEvent) {
        if event == HookEvent::PreToolUse {
            self.d.updated_input = match (self.d.permission, self.pending_input.take()) {
                (Some(Permission::Deny), _) => None,
                (_, Some((_, input))) => Some(input),
                (None, None) => self.loose_input.take(),
                (Some(_), None) => None,
            };
            if self.d.permission == Some(Permission::Deny) && self.d.permission_reason.is_none() {
                self.d.permission_reason = Some("Blocked by a PreToolUse hook.".to_owned());
            }
        }
        if matches!(event, HookEvent::Stop | HookEvent::SubagentStop) && self.d.stop.is_some() {
            // `continue: false` ends the turn even when another handler blocks.
            self.d.block = None;
        }
        if event == HookEvent::UserPromptSubmit
            && let Some(reason) = &self.d.stop
        {
            self.d.block.get_or_insert_with(|| {
                reason
                    .clone()
                    .unwrap_or_else(|| "Stopped by a UserPromptSubmit hook.".to_owned())
            });
        }
    }
}

#[cfg(test)]
#[path = "decision_tests.rs"]
mod tests;
