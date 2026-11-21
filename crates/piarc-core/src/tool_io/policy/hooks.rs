//! The hook steps of the decision ladder (architecture section 6.2.3): step 2 `PreToolUse` and
//! step 8 `PermissionRequest`. Whatever a hook answers, `piarc_policy::decide` keeps deny and
//! ask rules, critical deletions and plan mode ahead of its allow; an `updatedInput` replaces
//! the call's arguments before the rules see them, so a hook cannot rewrite a call past a deny
//! rule.
//!
//! Also here: a handler's `if` condition ([`condition`]), one permission rule matched the way
//! a deny rule is (any Bash subcommand; a command that cannot be split matches, so the hook
//! runs).
use std::sync::Arc;

use piarc_config::Settings;
use piarc_hooks::{HookEvent, Permission, RequestAnswer};
use piarc_host::Peer;
use piarc_policy::rules::{Behavior, RuleSet, Subject};
use piarc_policy::{HookVerdict, Outcome, Ruling};
use piarc_protocol::policy::{ApprovalRequest, PermissionMode, PolicyEvaluateParams};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{Prepared, RULE_ASKS, SessionIo, ToolIo, lock};
use crate::hooks::{Facts, Request};
use piarc_protocol::ErrorObject;

/// Step 2's answer.
#[derive(Debug, Default)]
pub(super) struct PreAnswer {
    pub verdict: HookVerdict,
    pub updated_input: Option<Map<String, Value>>,
    pub context: Option<String>,
    /// `continue: false`.
    pub stop: Option<Option<String>>,
}

/// Tells the Agent Host that Core works on the call (`policy/pending`): hooks can run for
/// minutes, longer than the request's transport deadline, which the notification stops.
async fn working(peer: &Peer, p: &PolicyEvaluateParams) {
    use piarc_protocol::policy::{PolicyPending, PolicyPendingParams};
    let pending = PolicyPendingParams {
        session_id: p.session_id.clone(),
        tool_call_id: p.tool_call_id.clone(),
    };
    // A closed connection cancels the hooks through their token.
    let _ = peer.notify::<PolicyPending>(pending).await;
}

/// The arguments hooks see: the call's own, without the Agent Host's internal fields.
fn tool_input(p: &PolicyEvaluateParams) -> Map<String, Value> {
    let mut input = p.input.clone();
    input.remove("readPathCandidates");
    input
}

fn tool_request(event: HookEvent, p: &PolicyEvaluateParams) -> Request {
    let input = tool_input(p);
    let mut fields = Map::new();
    fields.insert("tool_name".into(), json!(p.tool));
    fields.insert("tool_input".into(), Value::Object(input.clone()));
    if event == HookEvent::PreToolUse {
        fields.insert("tool_use_id".into(), json!(p.tool_call_id));
    }
    if let Some(level) = &p.effort {
        fields.insert("effort".into(), json!({ "level": level }));
    }
    Request {
        event,
        subject: Some(p.tool.clone()),
        fields,
        tool: Some((p.tool.clone(), input)),
    }
}

/// `Bash(git status *)` → `{toolName: "Bash", ruleContent: "git status *"}`.
fn rule_value(rule: &str) -> Value {
    match rule.split_once('(') {
        Some((tool, rest)) if rest.ends_with(')') => {
            json!({"toolName": tool, "ruleContent": &rest[..rest.len() - 1]})
        }
        _ => json!({"toolName": rule}),
    }
}

/// What the approval card would offer to save, in Claude Code's `permission_suggestions` form.
fn suggestions(card: &ApprovalRequest) -> Value {
    let mut list = Vec::new();
    if !card.rules.is_empty() {
        list.push(json!({
            "type": "addRules",
            "rules": card.rules.iter().map(|r| rule_value(r)).collect::<Vec<_>>(),
            "behavior": "allow",
            "destination": "localSettings",
        }));
    }
    if let Some(dir) = &card.directory {
        list.push(
            json!({"type": "addDirectories", "directories": [dir], "destination": "localSettings"}),
        );
    }
    Value::Array(list)
}

/// What step 8 needs from the call's evaluation.
pub(super) struct Ladder<'a> {
    pub s: &'a Arc<SessionIo>,
    pub services: &'a super::Services,
    pub settings: &'a Settings,
    pub peer: &'a Peer,
    pub generation: &'a CancellationToken,
    pub token: CancellationToken,
}

impl ToolIo {
    /// Step 8: `PermissionRequest` hooks answer before the user is asked. An allow with an
    /// `updatedInput` meets the deny and ask rules again; an allow applies its
    /// `updatedPermissions`; a deny with `interrupt` stops the agent.
    pub(super) async fn permission_step(
        &self,
        step: &Ladder<'_>,
        p: &mut PolicyEvaluateParams,
        prepared: &mut Prepared,
        ruling: Ruling,
        updated: &mut bool,
        stop: &mut Option<Option<String>>,
    ) -> Result<Ruling, ErrorObject> {
        let Some(answer) = self
            .permission_request(
                step.s,
                p,
                &prepared.card,
                step.settings,
                step.peer,
                step.token.clone(),
            )
            .await
        else {
            return Ok(ruling);
        };
        if !answer.allow {
            let reason = answer
                .message
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "Denied by a PermissionRequest hook.".to_owned());
            if answer.interrupt {
                stop.get_or_insert(answer.message);
            }
            return Ok(piarc_policy::after_permission_request(
                ruling,
                &HookVerdict::Deny(reason),
            ));
        }
        let mut ruling = piarc_policy::after_permission_request(ruling, &HookVerdict::Allow);
        if ruling.outcome != Outcome::Allow {
            return Ok(ruling);
        }
        if let Some(input) = answer.updated_input {
            p.input = input;
            *updated = true;
            *prepared = self.prepared(step.s, p, step.settings, step.peer).await?;
            let (_, again) = prepared.decide(
                step.s,
                step.services,
                step.settings,
                step.peer,
                step.generation,
            )?;
            if again.outcome == Outcome::Deny
                || (again.outcome == Outcome::Ask && RULE_ASKS.contains(&again.step))
            {
                ruling = again;
            }
        }
        if ruling.outcome == Outcome::Allow {
            let project = answer
                .updated_by
                .iter()
                .any(|source| project_source(source, step.s.project()));
            self.apply_permissions(
                step.s,
                p,
                &answer.updated_permissions,
                project,
                step.services,
            )
            .await;
        }
        Ok(ruling)
    }

    /// Step 2, under the settings the decision loaded for its rules.
    pub(super) async fn pre_tool_use(
        &self,
        s: &SessionIo,
        p: &PolicyEvaluateParams,
        settings: &piarc_config::Settings,
        peer: &Peer,
        cancel: CancellationToken,
    ) -> PreAnswer {
        let Some(hooks) = self.hook_service() else {
            return PreAnswer::default();
        };
        let facts = self.session_facts(s, &p.session_id, cancel);
        let request = tool_request(HookEvent::PreToolUse, p);
        let Some(plan) = hooks.plan_in(settings, &facts, &request) else {
            return PreAnswer::default();
        };
        working(peer, p).await;
        let launch = self.exec.hook_launch().await;
        let answer = hooks.execute(&facts, &request, plan, launch).await;
        let d = answer.decision;
        let verdict = match d.permission {
            None => HookVerdict::None,
            Some(Permission::Allow) => HookVerdict::Allow,
            Some(Permission::Ask) => HookVerdict::Ask,
            Some(Permission::Deny) => {
                let reason = d
                    .permission_reason
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| "Blocked by a PreToolUse hook.".to_owned());
                HookVerdict::Deny(reason)
            }
        };
        PreAnswer {
            verdict,
            updated_input: d.updated_input,
            context: answer.context,
            stop: d.stop,
        }
    }

    /// Step 8: the hooks' answer before the user is asked, or `None`; under the settings the
    /// decision loaded for its rules.
    pub(super) async fn permission_request(
        &self,
        s: &SessionIo,
        p: &PolicyEvaluateParams,
        card: &ApprovalRequest,
        settings: &piarc_config::Settings,
        peer: &Peer,
        cancel: CancellationToken,
    ) -> Option<RequestAnswer> {
        let hooks = self.hook_service()?;
        let facts = self.session_facts(s, &p.session_id, cancel);
        let mut request = tool_request(HookEvent::PermissionRequest, p);
        request
            .fields
            .insert("permission_suggestions".into(), suggestions(card));
        let plan = hooks.plan_in(settings, &facts, &request)?;
        working(peer, p).await;
        let launch = self.exec.hook_launch().await;
        hooks
            .execute(&facts, &request, plan, launch)
            .await
            .decision
            .request
    }

    /// Applies a `PermissionRequest` allow's `updatedPermissions`: `addRules` to the session
    /// or the `.piarc/` files and `setMode` for the session. Everything else (other types,
    /// `userSettings`, `.claude/`, bypass or auto mode) is left out and the user is told.
    ///
    /// `project`: a project's hook gave them (I122, ADR-0055). Their effect then stays within
    /// what the project's trust covers: the mode changes for the session without becoming the
    /// workspace's remembered mode, and allow rules written to `.piarc/` files are not confirmed
    /// for the trust decision, so they wait for the user like any other new project rule.
    pub(super) async fn apply_permissions(
        &self,
        s: &SessionIo,
        p: &PolicyEvaluateParams,
        updates: &[Value],
        project: bool,
        services: &super::Services,
    ) {
        let mut refused = Vec::new();
        for update in updates {
            if let Err(why) = self.apply_one(s, p, update, project, services).await {
                refused.push(why);
            }
        }
        if let (Some(hooks), false) = (self.hook_service(), refused.is_empty()) {
            let facts = self.session_facts(s, &p.session_id, CancellationToken::new());
            let message = format!(
                "PermissionRequest hook: some permission updates were not applied: {}",
                refused.join("; ")
            );
            hooks
                .notify(&facts, HookEvent::PermissionRequest, "error", &message)
                .await;
        }
    }

    async fn apply_one(
        &self,
        s: &SessionIo,
        p: &PolicyEvaluateParams,
        update: &Value,
        project: bool,
        services: &super::Services,
    ) -> Result<(), String> {
        let text = |key: &str| update.get(key).and_then(Value::as_str).unwrap_or_default();
        let destination = text("destination");
        match text("type") {
            "setMode" if destination == "session" => {
                let mode = match text("mode") {
                    "default" | "manual" => PermissionMode::Default,
                    "acceptEdits" => PermissionMode::AcceptEdits,
                    "plan" => PermissionMode::Plan,
                    other => return Err(format!("mode {other:?} cannot be set by a hook")),
                };
                if project {
                    self.session_mode(&p.session_id, mode)
                        .map_err(|e| e.message)
                } else {
                    self.changed_mode(&p.session_id, mode)
                        .await
                        .map_err(|e| e.message)
                }
            }
            "addRules" => {
                let behavior = text("behavior");
                let rules: Vec<String> = update
                    .get("rules")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        let tool = r.get("toolName")?.as_str()?;
                        Some(match r.get("ruleContent").and_then(Value::as_str) {
                            Some(content) => format!("{tool}({content})"),
                            None => tool.to_owned(),
                        })
                    })
                    .collect();
                for rule in &rules {
                    piarc_policy::rules::parse(rule, Behavior::Allow)
                        .map_err(|e| format!("invalid rule {rule:?}: {e}"))?;
                }
                let layer = match destination {
                    "session" if behavior == "allow" => {
                        let mut state = lock(&s.policy);
                        for rule in rules {
                            if !state.rules.contains(&rule) {
                                state.rules.push(rule);
                            }
                        }
                        return Ok(());
                    }
                    "localSettings" => piarc_config::ids::PROJECT_LOCAL,
                    "projectSettings" => piarc_config::ids::PROJECT,
                    other => return Err(format!("{behavior} rules cannot be added to {other:?}")),
                };
                if !matches!(behavior, "allow" | "ask" | "deny") {
                    return Err(format!("unknown rule behavior {behavior:?}"));
                }
                self.add_rules(s, layer, behavior, &rules, !project, services)
                    .await
            }
            other => Err(format!(
                "{other:?} updates to {destination:?} are not supported"
            )),
        }
    }

    async fn add_rules(
        &self,
        s: &SessionIo,
        layer: &'static str,
        behavior: &str,
        rules: &[String],
        confirm: bool,
        services: &super::Services,
    ) -> Result<(), String> {
        let root = s.project().to_path_buf();
        let table = services.storage.dirs().layers(&root);
        let (key, list) = (behavior.to_owned(), rules.to_vec());
        let written = tokio::task::spawn_blocking(move || {
            let mut file = None;
            for rule in &list {
                file = Some(piarc_config::edit_permission_rule(
                    &table,
                    layer,
                    &key,
                    None,
                    Some(rule),
                )?);
            }
            Ok::<_, piarc_config::WriteError>(file)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        // The hook's own allow rules are not new for the trust decision: a trusted hook
        // (or the user's own) wrote them, like a native confirmation would have.
        if behavior == "allow"
            && confirm
            && let Some(file) = written
        {
            let source = file
                .strip_prefix(&root)
                .unwrap_or(&file)
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let items = rules
                .iter()
                .map(|rule| piarc_config::Item {
                    category: piarc_config::Category::AllowRule,
                    source: source.clone(),
                    name: rule.clone(),
                })
                .collect();
            services
                .trust
                .confirm_items(&root, items)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Whether a hook defined in `source` is a project's: a project settings file, or a skill or
/// subagent definition below the project root.
fn project_source(source: &piarc_hooks::Source, root: &std::path::Path) -> bool {
    use piarc_config::ids;
    match source.layer.as_str() {
        ids::PROJECT | ids::PROJECT_LOCAL | ids::CLAUDE_PROJECT | ids::CLAUDE_PROJECT_LOCAL => true,
        "subagent" | "skill" => source.file.as_ref().is_some_and(|f| f.starts_with(root)),
        _ => false,
    }
}

/// Whether a tool call matches a handler's `if` rule (Claude Code's semantics: like a deny
/// rule; an invalid rule or a command that cannot be judged lets the hook run).
pub(crate) fn condition(rule: &str, tool: &str, input: &Map<String, Value>, facts: &Facts) -> bool {
    use piarc_policy::paths::{PathContext, posix};
    if piarc_policy::rules::parse(rule, Behavior::Deny).is_err() {
        return true;
    }
    let root_posix = posix(&facts.root);
    let mut set = RuleSet::default();
    set.add_source(
        piarc_policy::rules::Source {
            id: "hook".into(),
            anchor: root_posix.clone(),
        },
        [(Behavior::Deny, rule)],
    );
    let field = |k: &str| input.get(k).and_then(Value::as_str);
    let hit = |subject: Subject<'_>, ctx: Option<&PathContext<'_>>| {
        set.find(Behavior::Deny, tool, subject, ctx).is_some()
    };
    match tool {
        "Bash" => {
            let analysis = piarc_policy::bash::analyze(field("command").unwrap_or_default());
            !analysis.unresolved.is_empty()
                || analysis
                    .commands
                    .iter()
                    .any(|c| hit(Subject::Command(&c.text()), None))
        }
        "PowerShell" => hit(Subject::Command(field("command").unwrap_or_default()), None),
        "Read" | "Write" | "Edit" | "Glob" | "Grep" | "NotebookEdit" => {
            let path = field(super::prepare::path_key(tool)).unwrap_or(".");
            let absolute = super::assess::lexical(&facts.cwd.join(path));
            let home = std::env::home_dir().map(|h| posix(&h)).unwrap_or_default();
            let cwd = posix(&facts.cwd);
            let ctx = PathContext {
                home: &home,
                cwd: &cwd,
                anchor: &root_posix,
                fold_case: facts.fold_case,
            };
            hit(Subject::Paths(&[posix(&absolute)]), Some(&ctx))
        }
        "WebFetch" => match field("url").and_then(piarc_web::rule_host) {
            Some(host) => hit(Subject::Domain(&host), None),
            None => true,
        },
        "Agent" => hit(
            Subject::Name(field("subagent_type").unwrap_or_default()),
            None,
        ),
        "Skill" => hit(Subject::Name(field("skill").unwrap_or_default()), None),
        _ => hit(Subject::Tool, None),
    }
}
