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
    /// Auto mode's review limit and outlet (T46).
    pub review: review::ReviewConfig,
}

struct Pending {
    call: String,
    reply: oneshot::Sender<(ApprovalAnswer, oneshot::Sender<Result<(), ErrorObject>>)>,
    /// The connection whose call waits; none for a network-domain card (T39), which the
    /// sandbox's proxy raises for a running command.
    peer: Option<Peer>,
}

mod assess;
mod edit;
mod grants;
pub(crate) mod hooks;
mod inputs;
pub(super) mod memory;
mod modes;
mod notebook;
mod notify;
mod plan;
mod prepare;
mod preview;
mod questions;
mod reasons;
pub(crate) mod review;
mod waits;
use prepare::{new_request, path_boundary, prepare};
use reasons::{
    LOST, argument_summary, audit_detail, check_network, check_permanent, check_unsandboxed,
    refusal_of,
};
use waits::{post_card, wait_for_user, withdraw_card};
pub(super) use waits::{post_network_card, withdraw_network_card};
pub(crate) mod settings_view;
use grants::Grant;
pub(super) use grants::{
    FilePermit, claim_command, claim_fetch, claim_memory, claim_monitor, claim_search, claim_skill,
    file_permit,
};

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
    /// `allowed-tools` of the skills and commands invoked in the current turn (T37), by
    /// grant: cleared when the turn ends ([`State::cancel`]).
    turn_rules: Vec<(u64, Vec<String>)>,
    next_turn_grant: u64,
    rule_cache: Option<(u64, Arc<RuleSet>)>,
    ledger: Ledger<Pending>,
    grants: HashMap<String, Grant>,
    expired: HashSet<String>,
    generation: CancellationToken,
    memory_epoch: CancellationToken,
    memory_scan: Option<(Option<String>, CancellationToken)>,
    /// Auto mode (T46): the reviewer's refusals and availability (a main session's apply to
    /// its subagents).
    auto: review::AutoState,
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
            self.auto.status(self.mode),
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
        // A network-domain card belongs to a running command, which may be a background one
        // that outlives the turn and the connection: it ends with its answer or timeout (T39).
        for (_, pending) in self.ledger.cancel_session_if(id, |r| {
            !(keep_memory
                && r.kind == ApprovalKind::PermissionExpansion
                && r.tool == "MemoryImport")
                && r.tool != piarc_protocol::policy::NETWORK_TOOL
        }) {
            if matches!(cause, Cleanup::Disconnected)
                || pending.peer.as_ref().is_some_and(Peer::is_closed)
            {
                self.expired.insert(pending.call);
            }
        }
        self.grants.clear();
        self.turn_rules.clear();
        self.publish(id, services);
    }

    /// Allows `rules` until the current turn ends (T37); returns the grant's id.
    pub(super) fn grant_turn_rules(&mut self, rules: Vec<String>) -> u64 {
        self.next_turn_grant += 1;
        self.turn_rules.push((self.next_turn_grant, rules));
        self.next_turn_grant
    }

    /// Withdraws grant `id` (its input did not start or join a turn).
    pub(super) fn revoke_turn_rules(&mut self, id: u64) {
        self.turn_rules.retain(|(grant, _)| *grant != id);
    }

    fn turn_rules(&self) -> Vec<String> {
        self.turn_rules
            .iter()
            .flat_map(|(_, rules)| rules.iter().cloned())
            .collect()
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
            .take_if(|_, p| {
                p.call == call && p.peer.as_ref().is_some_and(|p| p.same_connection(peer))
            })
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
        let settings = session_settings(services, &s).await?;
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
                // The reviewer is deciding the card (T46): no answer is taken.
                if request
                    .review
                    .as_ref()
                    .is_some_and(|r| r.state == piarc_protocol::policy::ReviewState::Reviewing)
                {
                    return Ok(json!({"status": AnswerStatus::Stale}));
                }
                match request.kind {
                    ApprovalKind::Question => questions::check_answer(request, &answer)?,
                    ApprovalKind::Plan => plan::check_answer(request, &answer)?,
                    _ => {}
                }
                if request.tool == piarc_protocol::policy::NETWORK_TOOL {
                    check_network(request, &answer)?;
                } else if answer.decision == ApprovalDecision::AllowAlways {
                    check_permanent(request, &answer)?;
                }
                check_unsandboxed(request, &answer)?;
                notify::check_answer(request, &answer)?;
            }
            let (request, pending) = match state.ledger.claim(&answer) {
                Ok(p) => p,
                Err(status) => return Ok(json!({"status": status})),
            };
            state.publish(&request.session_id, self.services()?);
            if pending.peer.as_ref().is_some_and(Peer::is_closed) {
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
            services.audit(&p.session_id, s.project(), &detail).await?;
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
        let settings = session_settings(services, s).await?;
        self.check_auto_mode(s, services, &settings, p).await?;
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
        let call = review::Call {
            s,
            services,
            settings: &settings,
            p,
            peer,
            generation: &generation,
        };
        let (choice, review) = self
            .question(&call, mode, &mut prepared, &mut ruling)
            .await?;
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
            updated_input: (allowed && updated).then(|| call_input(p)),
            context: pre.context,
            stop: stop.map(|reason| piarc_protocol::hooks::HookStop { reason }),
            mode: None,
            review,
        };
        let source = audit_source(answer.as_ref(), ruling.step);
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

    /// A call that asks (nothing otherwise): in Auto mode the reviewer answers the general
    /// question (T46),
    /// otherwise, or when it hands the card back, the user does. Returns the user's answer and
    /// the reviewer's decision; `ruling` becomes the reviewer's when it decided.
    async fn question(
        &self,
        call: &review::Call<'_>,
        mode: PermissionMode,
        prepared: &mut Prepared,
        ruling: &mut Ruling,
    ) -> Result<
        (
            Option<waits::Answered>,
            Option<piarc_protocol::policy::ToolReview>,
        ),
        ErrorObject,
    > {
        if ruling.outcome != Outcome::Ask {
            return Ok((None, None));
        }
        let (answer, note) =
            if mode == PermissionMode::Auto && piarc_policy::review::reviewable(ruling) {
                match self.auto_review(call, prepared).await? {
                    review::Reviewed::Allow(note) => {
                        *ruling = reviewed(Outcome::Allow, None);
                        (None, Some(note))
                    }
                    review::Reviewed::Deny(note, reason) => {
                        *ruling = reviewed(Outcome::Deny, Some(reason));
                        (None, Some(note))
                    }
                    review::Reviewed::User(answer) => (answer, None),
                }
            } else {
                let review::Call {
                    s,
                    services,
                    p,
                    peer,
                    generation,
                    ..
                } = *call;
                let answer = self
                    .ask_user(s, services, p, prepared, peer, generation)
                    .await?;
                (answer, None)
            };
        if answer
            .as_ref()
            .is_some_and(|(a, _)| a.decision != ApprovalDecision::Deny)
        {
            // The user allowed a call: the reviewer's run of refusals ends and a pause lifts.
            let root = super::subagents::rule_owner(call.s);
            lock(&root.policy).auto.resume();
        }
        Ok((answer, note))
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
        prepared.card.notification_allow = notify::allowed(&prepared.card);
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
        let (programs, sandbox) = if p.tool == "Bash" || p.tool == "Monitor" {
            let sandbox = self.sandbox_with(s, Some(settings));
            if sandbox.resolved.enabled && !sandbox.available {
                self.tell_unavailable();
            }
            (
                Some(self.exec.programs().await),
                sandbox.for_call(&p.tool, &p.input),
            )
        } else {
            (None, super::sandbox::CallSandbox::default())
        };
        prepare(
            Arc::clone(s),
            p.clone(),
            settings,
            peer.clone(),
            programs,
            rules,
            sandbox,
        )
        .await
    }
}

/// Steps whose question a `PermissionRequest` hook's rewritten input cannot skip: rules and
/// checks that ask whatever the mode.
const RULE_ASKS: &[&str] = &[
    "askRule",
    "unsandboxed",
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
    services.audit(&p.session_id, s.project(), detail).await?;
    let decision = answer.as_ref().map(|a| a.decision);
    if let Some(answer) = answer.filter(|a| a.decision == ApprovalDecision::AllowAlways) {
        if generation.is_cancelled() || peer.is_closed() {
            return Err(denied(LOST));
        }
        services.persist(s.project(), &answer).await?;
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
    // A skill's grant belongs to the session whose turn invoked it (a subagent's own).
    let own_turn = (!std::ptr::eq(owner, s)).then(|| lock(&s.policy).turn_rules());
    let mut state = lock(&owner.policy);
    let state = &mut *state;
    let mut turn = own_turn.unwrap_or_else(|| state.turn_rules());
    if settings.managed_rules_only() {
        // Only managed rules decide (T47): a skill's `allowed-tools` grants nothing.
        turn.clear();
    }
    assess::rule_set(
        &settings.permission_lists(),
        &state.rules,
        &turn,
        s.scope.root(),
        &mut state.rule_cache,
    )
}

/// The session's `Read(…)` deny rules, applied to search results (R5, I120): a deny on a file
/// keeps its lines and its name out of Grep and Glob over a directory, as for Read itself.
pub(crate) struct ReadDeny {
    rules: Arc<RuleSet>,
    places: assess::Places,
}

impl ReadDeny {
    pub(crate) fn denies(&self, path: &Path) -> bool {
        assess::read_denied(&self.rules, &self.places, path)
    }
}

impl ToolIo {
    /// The filter for session `s`'s search results; `None` without a permission service.
    pub(super) async fn read_deny(&self, s: &SessionIo) -> Result<Option<ReadDeny>, ErrorObject> {
        let Ok(services) = self.services() else {
            return Ok(None);
        };
        let settings = session_settings(services, s).await?;
        Ok(Some(ReadDeny {
            rules: rules_of(s, &settings),
            places: assess::Places::new(&s.scope),
        }))
    }
}

/// The workspace's rules without a session's own (`agents/list`, T31).
pub(super) fn workspace_rules(settings: &Settings, root: &Path) -> Arc<RuleSet> {
    assess::rule_set(&settings.permission_lists(), &[], &[], root, &mut None)
}

/// Whether a `Skill(<name>)` deny rule (or a deny of the whole tool) hides skill `name` (T37).
pub(super) fn denies_skill(rules: &RuleSet, name: &str) -> bool {
    rules
        .find(
            piarc_policy::rules::Behavior::Deny,
            "Skill",
            piarc_policy::rules::Subject::Name(name),
            None,
        )
        .is_some_and(|(_, certainty)| certainty == piarc_policy::rules::Certainty::Certain)
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
            let call = p.tool_call_id.clone();
            let binding = self
                .grant
                .binding
                .clone()
                .ok_or_else(|| denied("Missing file approval directory."))?;
            self.card.diff = Some(
                tokio::task::spawn_blocking(move || {
                    preview::file_preview(&tool, &call, &input, &path, &label, &binding)
                })
                .await
                .map_err(|e| denied(format!("Preview unavailable: {e}")))??,
            );
        }
        Ok(())
    }
}

/// The arguments the call runs with, without the Agent Host's internal fields.
fn call_input(p: &PolicyEvaluateParams) -> serde_json::Map<String, Value> {
    let mut input = p.input.clone();
    input.remove("readPathCandidates");
    input
}

/// Who decided a call, for the audit: the user (on the card or, T42, from a notification), a
/// hook, the Auto mode reviewer (T46), or the rules.
fn audit_source(answer: Option<&ApprovalAnswer>, step: &str) -> &'static str {
    match (answer, step) {
        (Some(a), _) if a.via == Some(piarc_protocol::policy::AnswerVia::Notification) => {
            "notification"
        }
        (Some(_), _) => "user",
        (None, "hookDeny" | "hookAllow" | "permissionRequestHook") => "hook",
        (None, "autoReview") => "reviewer",
        _ => "automatic",
    }
}

/// The ruling the Auto mode reviewer made (T46): allowed this once, or refused with `reason`.
fn reviewed(outcome: Outcome, reason: Option<String>) -> Ruling {
    Ruling {
        outcome,
        step: "autoReview",
        hits: Vec::new(),
        reason,
    }
}

/// Session `s`'s permission settings: its project's, with the layers its `ConfigChange` hooks
/// kept at an earlier value (T41).
async fn session_settings(
    services: &Services,
    s: &SessionIo,
) -> Result<piarc_config::Settings, ErrorObject> {
    let mut settings = services.settings(s.project()).await?;
    ToolIo::apply_pins(s, &mut settings);
    Ok(settings)
}
#[cfg(test)]
mod tests;
