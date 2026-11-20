//! Connects a tool preflight, its approval and the actual I/O on the same connection. The
//! decision is `piarc_policy::decide` over the facts `assess` collects (T23, ADR-0031).
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_config::{Category, Settings};
use piarc_fs::{Access, Scope, display};
use piarc_host::Peer;
use piarc_policy::rules::{Hit, RuleSet};
use piarc_policy::{Boundary, Ledger, Outcome, Ruling};
use piarc_protocol::policy::{
    AnswerStatus, ApprovalAnswer, ApprovalDecision, ApprovalKind, ApprovalRequest, PermissionMode,
    PolicyEvaluateParams, PolicyEvaluateResult, PolicyToolsParams, PolicyToolsResult,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{SessionIo, ToolIo, exec, lock, to_value};
use crate::sessions::{SnapshotMsg, Snapshots};
use crate::storage::{Storage, now_ms};
use crate::trust::TrustService;

#[derive(Clone)]
pub(crate) struct Services {
    pub storage: Storage,
    pub trust: TrustService,
    pub snapshots: Snapshots,
    /// Runs hooks; `None` runs none (tests of the ladder alone).
    pub hooks: Option<crate::hooks::HooksService>,
}

struct Pending {
    call: String,
    reply: oneshot::Sender<(ApprovalAnswer, oneshot::Sender<Result<(), ErrorObject>>)>,
    peer: Peer,
}

mod assess;
mod edit;
mod grants;
pub(crate) mod hooks;
mod inputs;
pub(super) mod memory;
mod modes;
mod plan;
mod preview;
mod questions;
mod waits;
use waits::{post_card, wait_for_user, withdraw_card};
pub(crate) mod settings_view;
use grants::Grant;
pub(super) use grants::{FilePermit, claim_command, claim_fetch, file_permit};

/// `path` without `.` and `..` components (no file system access).
pub(super) fn lexical(path: &Path) -> PathBuf {
    assess::lexical(path)
}

#[derive(Default)]
pub(super) struct State {
    inputs: inputs::Inputs,
    mode: PermissionMode,
    project_auto: bool,
    /// Rules the user allowed for this session, in order.
    rules: Vec<String>,
    rule_cache: Option<(u64, Arc<RuleSet>)>,
    ledger: Ledger<Pending>,
    grants: HashMap<String, Grant>,
    expired: HashSet<String>,
    generation: CancellationToken,
    memory_epoch: CancellationToken,
    memory_scan: Option<(Option<String>, CancellationToken)>,
}

#[derive(Clone, Copy)]
pub(crate) enum Cleanup<'a> {
    /// The notification may arrive while the Host is preparing an automatic follow-up.
    Completed(&'a str),
    Interrupted,
    Disconnected,
}

pub(super) fn denied(reason: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::PermissionDenied, reason, false)
}

impl State {
    /// The session's current permission mode.
    pub(super) fn mode(&self) -> PermissionMode {
        self.mode
    }

    /// A subagent's mode follows its main session's (T31, `subagents::effective_mode`).
    pub(super) fn follow_mode(&mut self, mode: PermissionMode) {
        self.mode = mode;
    }

    /// The first approval waiting for the user.
    #[cfg(test)]
    pub(super) fn first_pending(&self) -> Option<ApprovalRequest> {
        self.ledger.pending().next().cloned()
    }

    fn publish(&self, id: &str, services: &Services) {
        services.snapshots.send(SnapshotMsg::Policy(
            id.to_owned(),
            self.mode,
            self.ledger.pending().cloned().collect(),
        ));
    }

    fn ruling(
        &mut self,
        services: &Services,
        settings: &Settings,
        id: &str,
        input: &mut piarc_policy::Input,
    ) -> (PermissionMode, Ruling) {
        // Keep the starting choice. Revoke a project-supplied automatic mode once its
        // source is untrusted or removed, without promoting a running manual session.
        if self.project_auto
            && (!settings.trust().is_trusted()
                || settings
                    .get("/permissions/defaultMode")
                    .and_then(Value::as_str)
                    != Some("acceptEdits"))
        {
            self.project_auto = false;
            self.mode = PermissionMode::Default;
            self.publish(id, services);
        }
        input.mode = self.mode;
        (self.mode, piarc_policy::decide(input))
    }

    fn cancel(&mut self, id: &str, services: &Services, cause: Cleanup<'_>) {
        self.inputs.clear();
        self.generation.cancel();
        self.generation = CancellationToken::new();
        let keep_memory = match cause {
            Cleanup::Completed(turn) => self
                .memory_scan
                .as_ref()
                .is_some_and(|(owner, _)| owner.as_deref() != Some(turn)),
            Cleanup::Interrupted | Cleanup::Disconnected => {
                self.memory_epoch.cancel();
                self.memory_epoch = CancellationToken::new();
                false
            }
        };
        if !keep_memory && let Some((_, scan)) = self.memory_scan.take() {
            scan.cancel();
        }
        for (_, pending) in self.ledger.cancel_session_if(id, |r| {
            !(keep_memory
                && r.kind == ApprovalKind::PermissionExpansion
                && r.tool == "MemoryImport")
        }) {
            if matches!(cause, Cleanup::Disconnected) || pending.peer.is_closed() {
                self.expired.insert(pending.call);
            }
        }
        self.grants.clear();
        self.publish(id, services);
    }
}

impl Services {
    pub(super) async fn settings(&self, root: &Path) -> Result<Settings, ErrorObject> {
        let settings = self
            .trust
            .permission_settings(root)
            .await
            .map_err(|e| e.to_error_object())?;
        if settings
            .issues()
            .iter()
            .any(|issue| issue.severity == piarc_config::schema::Severity::Error)
        {
            return Err(denied(
                "Permission settings contain errors. Review the configuration before retrying.",
            ));
        }
        Ok(settings)
    }

    async fn audit(&self, id: &str, root: &Path, detail: &Value) -> Result<(), ErrorObject> {
        self.record("permission", id, root, detail).await
    }

    /// Appends an audit row of `kind` for session `id`.
    pub(super) async fn record(
        &self,
        kind: &str,
        id: &str,
        root: &Path,
        detail: &Value,
    ) -> Result<(), ErrorObject> {
        let row = piarc_store::AuditEvent {
            at: now_ms(),
            kind: kind.into(),
            session_id: Some(id.into()),
            workspace: Some(display(root)),
            detail: detail.to_string(),
        };
        self.storage
            .run(move |s| s.append_audit(&row))
            .await
            .map_err(|e| e.to_error_object())?
            .map_err(|e| denied(format!("Could not record the permission decision: {e}")))?;
        Ok(())
    }

    async fn persist(&self, root: &Path, answer: &ApprovalAnswer) -> Result<(), ErrorObject> {
        let root = root.to_owned();
        let table = self.storage.dirs().layers(&root);
        let rules = answer.rules.clone();
        let directory = answer.directory.clone();
        let items = tokio::task::spawn_blocking(move || {
            let mut values = Vec::new();
            if let Some(dir) = &directory {
                values.push((Category::AdditionalDirectory, dir.as_str()));
            }
            for rule in &rules {
                values.push((Category::AllowRule, rule.as_str()));
            }
            piarc_config::append_local_permissions(&table, &values)
        })
        .await
        .map_err(|e| denied(e.to_string()))?
        .map_err(|e| denied(e.to_string()))?;
        self.trust
            .confirm_items(&root, items)
            .await
            .map_err(|e| e.to_error_object())
    }
}

impl ToolIo {
    pub(crate) fn policy_services(mut self, services: Services) -> Self {
        self.policy = Some(services);
        self
    }

    pub(crate) fn clear_approvals(&self, id: &str, cause: Cleanup<'_>) {
        // An interrupt also reaches the subagents the session waits for (T31).
        let children = match cause {
            Cleanup::Completed(_) => Vec::new(),
            Cleanup::Interrupted | Cleanup::Disconnected => self.attached(id),
        };
        for id in std::iter::once(id).chain(children.iter().map(String::as_str)) {
            if let (Some(services), Ok(s)) = (&self.policy, self.session(id)) {
                lock(&s.files).discard_pending(None);
                lock(&s.policy).cancel(id, services, cause);
                lock(&s.uploads).cancel_writes(None);
            }
        }
    }

    pub(crate) fn finish_tool(&self, id: &str, call: &str) {
        if let Ok(s) = self.session(id) {
            lock(&s.files).discard_pending(Some(call));
            lock(&s.policy).grants.remove(call);
            lock(&s.uploads).cancel_writes(Some(call));
        }
    }

    pub(super) fn services(&self) -> Result<&Services, ErrorObject> {
        self.policy
            .as_ref()
            .ok_or_else(|| denied("Permission service is unavailable."))
    }

    pub(super) fn cancel_wait(
        &self,
        id: &str,
        call: &str,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(id)?;
        let mut state = lock(&s.policy);
        state.inputs.cancel(call, peer);
        if state
            .ledger
            .take_if(|_, p| p.call == call && p.peer.same_connection(peer))
            .is_some()
        {
            state.publish(id, self.services()?);
        }
        Ok(json!({}))
    }

    pub(super) fn recover(&self, id: &str, call: &str) -> Result<Value, ErrorObject> {
        let s = self.session(id)?;
        let state = lock(&s.policy);
        let expired = state.expired.contains(call);
        Ok(if expired {
            json!({"reason":LOST})
        } else {
            json!({})
        })
    }

    /// `policy/tools`: tools a deny rule without a specifier removes from the model's list.
    pub(super) async fn denied_tools(&self, p: PolicyToolsParams) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let services = self.services()?;
        let settings = services.settings(s.scope.root()).await?;
        let rules = rules_of(&s, &settings);
        let denied = p
            .tools
            .into_iter()
            .filter(|t| {
                rules
                    .whole_tool(piarc_policy::rules::Behavior::Deny, t)
                    .is_some()
            })
            .collect();
        to_value(&PolicyToolsResult { denied })
    }

    pub(crate) async fn answer_approval(
        &self,
        answer: ApprovalAnswer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&answer.session_id)?;
        let receive = {
            let mut state = lock(&s.policy);
            if let Some(request) = state
                .ledger
                .pending()
                .find(|r| r.request_id == answer.request_id)
            {
                match request.kind {
                    ApprovalKind::Question => questions::check_answer(request, &answer)?,
                    ApprovalKind::Plan => plan::check_answer(request, &answer)?,
                    _ => {}
                }
                if answer.decision == ApprovalDecision::AllowAlways {
                    check_permanent(request, &answer)?;
                }
            }
            let (request, pending) = match state.ledger.claim(&answer) {
                Ok(p) => p,
                Err(status) => return Ok(json!({"status": status})),
            };
            state.publish(&request.session_id, self.services()?);
            if pending.peer.is_closed() {
                state.expired.insert(pending.call);
                return Ok(json!({"status":AnswerStatus::Stale}));
            }
            let (tx, rx) = oneshot::channel();
            pending.reply.send((answer, tx)).map_err(|_| denied(LOST))?;
            rx
        };
        receive.await.map_err(|_| denied(LOST))??;
        Ok(json!({"status":AnswerStatus::Applied}))
    }

    pub(super) async fn evaluate(
        &self,
        p: PolicyEvaluateParams,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id)?;
        let services = self.services()?;
        let mut p = p;
        let result = self.evaluate_call(&s, services, &mut p, &peer).await;
        if let Err(error) = &result {
            let mode = lock(&s.policy).mode;
            let detail = json!({"tool":p.tool,"toolCallId":p.tool_call_id,"arguments":argument_summary(&p),"mode":mode,
                "step":"preflightError","errorKind":error.data.kind,"source":"automatic","conclusion":"deny"});
            services
                .audit(&p.session_id, s.scope.root(), &detail)
                .await?;
        }
        result
    }

    async fn evaluate_call(
        &self,
        s: &Arc<SessionIo>,
        services: &Services,
        p: &mut PolicyEvaluateParams,
        peer: &Peer,
    ) -> Result<Value, ErrorObject> {
        super::subagents::prepare_call(s, p)?;
        let generation = inputs::begin(s, p, peer).await?;
        let settings = services.settings(s.scope.root()).await?;
        let (hook_token, _hook_guard) = super::hooks::linked(peer, Some(&generation));
        let pre = self
            .pre_tool_use(s, p, &settings, peer, hook_token.clone())
            .await;
        let mut updated = false;
        if let Some(input) = pre.updated_input {
            p.input = input;
            updated = true;
        }
        let mut prepared = self.prepared(s, p, &settings, peer).await?;
        prepared.assessment.input.hook = pre.verdict;
        let (mode, mut ruling) = prepared.decide(s, services, &settings, peer, &generation)?;
        let mut stop = pre.stop;
        if ruling.outcome == Outcome::Ask {
            let step = hooks::Ladder {
                s,
                services,
                settings: &settings,
                peer,
                generation: &generation,
                token: hook_token.clone(),
            };
            ruling = self
                .permission_step(&step, p, &mut prepared, ruling, &mut updated, &mut stop)
                .await?;
        }
        let choice = if ruling.outcome == Outcome::Ask {
            self.ask_user(s, services, p, &mut prepared, peer, &generation)
                .await?
        } else {
            None
        };
        let (answer, ack) = choice.unzip();
        let reason = refusal_of(
            answer.as_ref(),
            &ruling,
            &prepared,
            s.scope.case_insensitive(),
        );
        let allowed = reason.is_none();
        // EnterPlanMode and an approved plan switch the session's mode (T26).
        let switch = if allowed {
            plan::mode_switch(&p.tool, mode, answer.as_ref())
        } else {
            None
        };
        let mut result = PolicyEvaluateResult {
            allowed,
            reason,
            updated_input: (allowed && updated).then(|| {
                let mut input = p.input.clone();
                input.remove("readPathCandidates");
                input
            }),
            context: pre.context,
            stop: stop.map(|reason| piarc_protocol::hooks::HookStop { reason }),
            mode: None,
        };
        let source = match (&answer, ruling.step) {
            (Some(_), _) => "user",
            (None, "hookDeny" | "hookAllow" | "permissionRequestHook") => "hook",
            _ => "automatic",
        };
        let mut detail = audit_detail(p, mode, &ruling, &prepared.card, result.allowed, source);
        super::subagents::annotate(&mut detail, s);
        let prepared = result.allowed.then_some(prepared);
        let commit = commit(s, services, p, peer, &generation, &detail, answer, prepared).await;
        if let Some(ack) = ack {
            // The answering window may have closed; the commit stands either way.
            let _ = ack.send(commit.clone());
        }
        commit?;
        if let Some(switch) = switch {
            self.switch_mode(&p.session_id, switch).await?;
            result.mode = Some(switch.mode);
        }
        to_value(&result)
    }

    /// Shows the card (with its preview) and waits for the user's answer.
    async fn ask_user(
        &self,
        s: &SessionIo,
        services: &Services,
        p: &PolicyEvaluateParams,
        prepared: &mut Prepared,
        peer: &Peer,
        generation: &CancellationToken,
    ) -> Result<Option<waits::Answered>, ErrorObject> {
        prepared.add_preview(p).await?;
        // `Notification` hooks: an approval waits for the user.
        let (io, id) = (self.clone(), p.session_id.clone());
        let message = format!("PiArc needs your permission to use {}", p.tool);
        tokio::spawn(async move {
            io.notification_hooks(&id, "permission_prompt", &message)
                .await;
        });
        wait_for_user(s, services, p, &prepared.card, peer, generation).await
    }

    /// The facts of the call as it stands (rules, programs, paths).
    async fn prepared(
        &self,
        s: &Arc<SessionIo>,
        p: &PolicyEvaluateParams,
        settings: &Settings,
        peer: &Peer,
    ) -> Result<Prepared, ErrorObject> {
        let rules = rules_of(s, settings);
        let programs = if p.tool == "Bash" {
            Some(self.exec.programs().await)
        } else {
            None
        };
        prepare(
            Arc::clone(s),
            p.clone(),
            settings,
            peer.clone(),
            programs,
            rules,
        )
        .await
    }
}

/// Steps whose question a `PermissionRequest` hook's rewritten input cannot skip: rules and
/// checks that ask whatever the mode.
const RULE_ASKS: &[&str] = &[
    "askRule",
    "criticalPath",
    "unresolved",
    "invalidRule",
    "requiresUserInteraction",
    "planApproval",
    "protectedPath",
    "hookAsk",
];

/// Record the decision, save a permanent answer and issue the grant of an allowed call.
#[expect(clippy::too_many_arguments, reason = "the parts of one decision")]
async fn commit(
    s: &SessionIo,
    services: &Services,
    p: &PolicyEvaluateParams,
    peer: &Peer,
    generation: &CancellationToken,
    detail: &Value,
    answer: Option<ApprovalAnswer>,
    allowed: Option<Prepared>,
) -> Result<(), ErrorObject> {
    services
        .audit(&p.session_id, s.scope.root(), detail)
        .await?;
    let decision = answer.as_ref().map(|a| a.decision);
    if let Some(answer) = answer.filter(|a| a.decision == ApprovalDecision::AllowAlways) {
        if generation.is_cancelled() || peer.is_closed() {
            return Err(denied(LOST));
        }
        services.persist(s.scope.root(), &answer).await?;
    }
    if let Some(prepared) = allowed {
        if generation.is_cancelled() || peer.is_closed() {
            return Err(denied(LOST));
        }
        if decision == Some(ApprovalDecision::AllowSession)
            && prepared.boundary != Boundary::Protected
        {
            // A subagent's answer allows its whole tree: the rules go to the main session.
            let mut owner = lock(&super::subagents::rule_owner(s).policy);
            for rule in &prepared.card.rules {
                if !owner.rules.contains(rule) {
                    owner.rules.push(rule.clone());
                }
            }
        }
        lock(&s.policy)
            .grants
            .insert(p.tool_call_id.clone(), prepared.grant);
    }
    Ok(())
}

/// The session's rule set for the current settings (cached while nothing changed); a
/// subagent's is its main session's (T31).
fn rules_of(s: &SessionIo, settings: &Settings) -> Arc<RuleSet> {
    let owner = super::subagents::rule_owner(s);
    let mut state = lock(&owner.policy);
    let state = &mut *state;
    assess::rule_set(
        &settings.permission_lists(),
        &state.rules,
        s.scope.root(),
        &mut state.rule_cache,
    )
}

/// The workspace's rules without a session's own (`agents/list`, T31).
pub(super) fn workspace_rules(settings: &Settings, root: &Path) -> Arc<RuleSet> {
    assess::rule_set(&settings.permission_lists(), &[], root, &mut None)
}

/// Whether an `Agent(<name>)` deny rule (or a deny of the whole tool) removes type `name`.
pub(super) fn denies_agent(rules: &RuleSet, name: &str) -> bool {
    rules
        .find(
            piarc_policy::rules::Behavior::Deny,
            "Agent",
            piarc_policy::rules::Subject::Name(name),
            None,
        )
        .is_some_and(|(_, certainty)| certainty == piarc_policy::rules::Certainty::Certain)
}

/// A permanent answer must carry every value the card offered, each a valid allow rule.
fn check_permanent(request: &ApprovalRequest, answer: &ApprovalAnswer) -> Result<(), ErrorObject> {
    let refused = || denied("This permission cannot be saved.");
    if request.protected_path == Some(true)
        || (request.rules.is_empty() && request.directory.is_none())
        || answer.directory.is_some() != request.directory.is_some()
        || answer.rules.is_empty() != request.rules.is_empty()
        || answer.rules.len() > piarc_policy::bash::MAX_RULES
    {
        return Err(refused());
    }
    for rule in &answer.rules {
        piarc_policy::rules::parse(rule, piarc_policy::rules::Behavior::Allow)
            .map_err(|e| denied(format!("Invalid rule {rule:?}: {e}")))?;
    }
    Ok(())
}

const LOST: &str = "Permission denied because the pending approval expired. Request a new approval before retrying.";

fn refusal(prepared: &Prepared, case_insensitive: bool, feedback: Option<&str>) -> String {
    let boundary = match prepared.boundary {
        Boundary::Outside => {
            "This operation needs the user's approval: it is outside the session's directories."
                .into()
        }
        Boundary::Protected => {
            let name = prepared
                .card
                .path
                .as_deref()
                .and_then(|p| piarc_fs::access::protected_component(Path::new(p), case_insensitive))
                .unwrap_or_else(|| "The target".into());
            format!("{name} is a protected path.")
        }
        Boundary::Inside => String::new(),
    };
    format!(
        "User denied {}. {boundary} {} Ask the user before trying again.",
        prepared.card.tool,
        feedback.unwrap_or("")
    )
}

/// Why the call may not run, or `None` when it may: the user's refusal (keep planning for a
/// plan), the ladder's, or a lost approval.
fn refusal_of(
    answer: Option<&ApprovalAnswer>,
    ruling: &Ruling,
    prepared: &Prepared,
    case_insensitive: bool,
) -> Option<String> {
    match (answer, ruling.outcome) {
        (Some(a), _) if a.decision == ApprovalDecision::Deny => {
            Some(if prepared.card.kind == ApprovalKind::Plan {
                plan::keep_planning(a)
            } else {
                refusal(prepared, case_insensitive, a.feedback.as_deref())
            })
        }
        (Some(_), _) | (None, Outcome::Allow) => None,
        (None, Outcome::Deny) => Some(ruling_reason(ruling)),
        (None, Outcome::Ask) => Some(LOST.into()),
    }
}

/// What the model reads when the ladder refuses without asking.
fn ruling_reason(ruling: &Ruling) -> String {
    match ruling.step {
        "planMode" => piarc_policy::PLAN_MODE_REFUSAL.to_owned(),
        "notInPlanMode" => piarc_policy::NOT_IN_PLAN_MODE.to_owned(),
        "hookDeny" | "permissionRequestHook" => ruling
            .reason
            .clone()
            .unwrap_or_else(|| "Permission denied by a hook.".to_owned()),
        _ => match ruling.hits.first() {
            Some(hit) => format!(
                "Permission denied by the rule {} in the {} settings. Do not retry this action; if it is needed, ask the user to change the rule.",
                hit.rule, hit.source
            ),
            None => "Permission denied.".to_owned(),
        },
    }
}

/// The rule as stored in the audit. Exact command rules can embed credentials: a digest
/// identifies the setting without copying its arguments into the database.
fn audit_rule(hit: &Hit) -> String {
    let command = hit.rule.starts_with("Bash(") || hit.rule.starts_with("PowerShell(");
    if !command || hit.rule.contains('*') {
        return hit.rule.clone();
    }
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(hit.rule.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let tool = hit.rule.split('(').next().unwrap_or_default();
    format!("{tool}:sha256:{digest}")
}

fn audit_detail(
    p: &PolicyEvaluateParams,
    mode: PermissionMode,
    ruling: &Ruling,
    card: &ApprovalRequest,
    allowed: bool,
    source: &str,
) -> Value {
    let hits: Vec<Value> = ruling
        .hits
        .iter()
        .map(|h| json!({"rule": audit_rule(h), "source": h.source, "behavior": h.behavior}))
        .collect();
    let first = ruling.hits.first();
    json!({"tool":p.tool,"toolCallId":p.tool_call_id,"arguments":argument_summary(p),"mode":mode,
        "step":ruling.step,"rule":first.map(audit_rule),"ruleSource":first.map(|h| &h.source),
        "rules":hits,"offered":card.rules.len(),
        "conclusion": if allowed {"allow"} else {"deny"}, "source":source})
}

fn argument_summary(p: &PolicyEvaluateParams) -> Value {
    // Do not store model-supplied text or shell arguments, which can contain secrets.
    json!({"keys":p.input.keys().collect::<Vec<_>>(), "path":p.input.get("path").and_then(Value::as_str),
        "commandBytes":p.input.get("command").and_then(Value::as_str).map(str::len),
        "contentBytes":p.input.get("content").and_then(Value::as_str).map(str::len),
        "editCount":p.input.get("edits").and_then(Value::as_array).map(Vec::len)})
}

struct Prepared {
    card: ApprovalRequest,
    boundary: Boundary,
    assessment: assess::Assessment,
    grant: Grant,
    preview: Option<(PathBuf, String)>,
}

impl Prepared {
    fn decide(
        &mut self,
        s: &SessionIo,
        services: &Services,
        settings: &Settings,
        peer: &Peer,
        generation: &CancellationToken,
    ) -> Result<(PermissionMode, Ruling), ErrorObject> {
        let (mode, ruling) = {
            let mut state = lock(&s.policy);
            if peer.is_closed() || generation.is_cancelled() {
                return Err(denied(LOST));
            }
            state.ruling(
                services,
                settings,
                &self.card.session_id,
                &mut self.assessment.input,
            )
        };
        // Only an automatic Bash allowance relies on resolved programs and checked paths.
        if matches!(ruling.step, "readOnly" | "acceptEdits") && self.grant.tool == "Bash" {
            self.grant.programs = std::mem::take(&mut self.assessment.programs);
            self.grant.targets = std::mem::take(&mut self.assessment.targets);
        }
        Ok((mode, ruling))
    }

    async fn add_preview(&mut self, p: &PolicyEvaluateParams) -> Result<(), ErrorObject> {
        if let Some((path, label)) = self.preview.take() {
            let input = p.input.clone();
            let tool = p.tool.clone();
            let binding = self
                .grant
                .binding
                .clone()
                .ok_or_else(|| denied("Missing file approval directory."))?;
            self.card.diff = Some(
                tokio::task::spawn_blocking(move || {
                    preview::file_preview(&tool, &input, &path, &label, &binding)
                })
                .await
                .map_err(|e| denied(format!("Preview unavailable: {e}")))??,
            );
        }
        Ok(())
    }
}

fn new_request(p: &PolicyEvaluateParams, peer: &Peer) -> Result<ApprovalRequest, ErrorObject> {
    Ok(ApprovalRequest {
        request_id: crate::sessions::new_session_id().map_err(|e| e.to_error_object())?,
        session_id: p.session_id.clone(),
        revision: 1,
        connection_epoch: peer.epoch(),
        tool: p.tool.clone(),
        kind: ApprovalKind::Command,
        command: None,
        cwd: None,
        path: None,
        diff: None,
        rules: Vec::new(),
        directory: None,
        protected_path: None,
        plan: None,
        questions: Vec::new(),
        subagent: None,
    })
}

#[expect(
    clippy::too_many_lines,
    reason = "one arm per tool family, kept together"
)]
async fn prepare(
    s: Arc<SessionIo>,
    p: PolicyEvaluateParams,
    settings: &Settings,
    peer: Peer,
    programs: Option<exec::utility::Programs>,
    rules: Arc<RuleSet>,
) -> Result<Prepared, ErrorObject> {
    let dirs: Vec<PathBuf> = settings
        .get("/permissions/additionalDirectories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|d| s.scope.root().join(d))
        .collect();
    tokio::task::spawn_blocking(move || {
        let scope = with_directories(s.scope.clone(), &dirs)?;
        let places = assess::Places::new(&scope);
        let mut card = new_request(&p, &peer)?;
        let mut grant = Grant::new(&p, peer);
        let mut preview = None;
        let mut boundary = Boundary::Inside;
        let field = |key: &str| p.input.get(key).and_then(Value::as_str);
        let assessment = match p.tool.as_str() {
            "Bash" | "PowerShell" => {
                let cmd = field("command").ok_or_else(|| denied("The command text is missing."))?;
                let cwd = exec::launch_dir(&s, None)?.dir;
                let assessment = match &programs {
                    Some(programs) if p.tool == "Bash" => {
                        let facts = assess::BashFacts {
                            scope: &scope,
                            shell_cwd: &cwd,
                            shell_cwd_posix: piarc_policy::paths::posix(&cwd),
                            places: &places,
                            programs,
                            resolved: std::cell::RefCell::default(),
                            targets: std::cell::RefCell::default(),
                        };
                        assess::bash_call(&rules, &facts, cmd)
                    }
                    _ => assess::powershell_call(&rules, &places, cmd),
                };
                card.command = Some(cmd.to_owned());
                card.cwd = Some(display(&cwd));
                grant.cwd = Some(cwd);
                grant.command = Some(cmd.to_owned());
                grant.scope = Some(scope.clone());
                assessment
            }
            "Read" | "Glob" | "Grep" | "Write" | "Edit" => {
                let raw = field("path").unwrap_or(".");
                let (file_boundary, target) = prepare_file(&scope, &p, &mut card)?;
                boundary = file_boundary;
                let binding = piarc_fs::DirectoryBinding::capture(&target)
                    .map_err(|e| e.to_error_object())?;
                if matches!(p.tool.as_str(), "Write" | "Edit")
                    && scope.check(&display(&target), Access::Read).is_ok()
                {
                    scope
                        .clone()
                        .for_bound_path(&binding, target.clone(), Access::Read)
                        .map_err(|e| e.to_error_object())?;
                    preview = Some((target.clone(), scope.label(&target)));
                }
                grant.binding = Some(binding);
                grant.path = Some(target.clone());
                let named = assess::lexical(&scope.cwd().join(raw));
                assess::file_call(&rules, &places, &p.tool, &named, &target, boundary)
            }
            tool => {
                if tool == "ExitPlanMode" {
                    card.kind = ApprovalKind::Plan;
                    card.plan = Some(field("plan").unwrap_or_default().to_owned());
                } else {
                    card.command = Some(format!("{} {}", p.tool, Value::Object(p.input.clone())));
                }
                assess::other_call(&rules, &places, tool, &p.input)
            }
        };
        if assessment.input.protected {
            boundary = Boundary::Protected;
        }
        card.protected_path = Some(boundary == Boundary::Protected);
        if boundary != Boundary::Protected {
            card.rules.clone_from(&assessment.rules);
        }
        Ok(Prepared {
            card,
            boundary,
            assessment,
            grant,
            preview,
        })
    })
    .await
    .map_err(|e| denied(format!("Permission preflight failed: {e}")))?
}

fn with_directories(mut scope: Scope, dirs: &[PathBuf]) -> Result<Scope, ErrorObject> {
    for dir in dirs {
        // A repository-controlled link is not a durable identity for an external directory.
        // Store physical paths from native confirmations; review a redirected target anew.
        let resolved = scope
            .locate(&display(dir))
            .map_err(|e| e.to_error_object())?;
        if dir.starts_with(scope.root()) && scope.key(&resolved) != scope.key(&assess::lexical(dir))
        {
            continue;
        }
        match std::fs::metadata(&resolved) {
            Ok(meta) if meta.is_dir() => {
                scope = scope
                    .with_added_dir(&resolved)
                    .map_err(|e| e.to_error_object())?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(denied(format!(
                    "Cannot inspect a configured permission directory: {e}"
                )));
            }
        }
    }
    Ok(scope)
}

fn prepare_file(
    scope: &Scope,
    p: &PolicyEvaluateParams,
    card: &mut ApprovalRequest,
) -> Result<(Boundary, PathBuf), ErrorObject> {
    let raw = p.input.get("path").and_then(Value::as_str).unwrap_or(".");
    let target = scope.locate(raw).map_err(|e| e.to_error_object())?;
    let write = matches!(p.tool.as_str(), "Write" | "Edit");
    let boundary = path_boundary(scope, raw, write)?;
    card.kind = if boundary == Boundary::Outside {
        ApprovalKind::PermissionExpansion
    } else {
        ApprovalKind::FileChange
    };
    card.path = Some(display(&target));
    if boundary == Boundary::Outside {
        card.directory = if target.is_dir() {
            Some(display(&target))
        } else {
            target.parent().map(display)
        };
    }
    Ok((boundary, target))
}

fn path_boundary(scope: &Scope, path: &str, write: bool) -> Result<Boundary, ErrorObject> {
    let access = if write { Access::Write } else { Access::Read };
    let resolved = scope.locate(path).map_err(|e| e.to_error_object())?;
    if write {
        let lexical = scope.cwd().join(path);
        if [lexical.as_path(), resolved.as_path()].iter().any(|p| {
            piarc_fs::access::protected_component(
                p.strip_prefix(scope.root()).unwrap_or(p),
                scope.case_insensitive(),
            )
            .is_some()
        }) {
            return Ok(Boundary::Protected);
        }
    }
    match scope.check(path, access) {
        Ok(_) => Ok(Boundary::Inside),
        Err(piarc_fs::Error::NeedsApproval { .. }) => Ok(Boundary::Outside),
        Err(e) => Err(e.to_error_object()),
    }
}

#[cfg(test)]
mod tests;
