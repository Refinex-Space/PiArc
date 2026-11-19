//! Connects a tool preflight, its approval and the actual I/O on the same connection.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_config::{Category, LayerTable, Settings};
use piarc_fs::{Access, Scope, display};
use piarc_host::Peer;
use piarc_policy::{Boundary, Ledger};
use piarc_protocol::policy::{
    AnswerStatus, ApprovalAnswer, ApprovalDecision, ApprovalKind, ApprovalRequest, PermissionMode,
    PolicyEvaluateParams, PolicyEvaluateResult,
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
}

struct Pending {
    call: String,
    reply: oneshot::Sender<(ApprovalAnswer, oneshot::Sender<Result<(), ErrorObject>>)>,
    peer: Peer,
}

mod inputs;
pub(super) mod memory;

#[derive(Default)]
pub(super) struct State {
    inputs: inputs::Inputs,
    mode: PermissionMode,
    project_auto: bool,
    rules: HashSet<String>,
    ledger: Ledger<Pending>,
    grants: HashMap<String, Grant>,
    expired: HashSet<String>,
    generation: CancellationToken,
    memory_epoch: CancellationToken,
    memory_scan: Option<(Option<String>, CancellationToken)>,
}

pub(crate) enum Cleanup<'a> {
    /// The notification may arrive while the Host is preparing an automatic follow-up.
    Completed(&'a str),
    Interrupted,
    Disconnected,
}

mod edit;
mod grants;
use grants::Grant;
pub(super) use grants::{FilePermit, claim_command, file_permit};

pub(super) fn denied(reason: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::PermissionDenied, reason, false)
}

impl State {
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
        card: &ApprovalRequest,
        boundary: Boundary,
        simple: bool,
    ) -> (PermissionMode, piarc_policy::Ruling) {
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
            self.publish(&card.session_id, services);
        }
        let mode = self.mode;
        let matched = card.rule.as_ref().is_some_and(|rule| {
            self.rules.contains(rule)
                || settings
                    .get("/permissions/allow")
                    .and_then(Value::as_array)
                    .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(rule)))
        });
        (
            mode,
            piarc_policy::evaluate(mode, &card.tool, boundary, matched, simple),
        )
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
    async fn settings(&self, root: &Path) -> Result<Settings, ErrorObject> {
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
        let row = piarc_store::AuditEvent {
            at: now_ms(),
            kind: "permission".into(),
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
        let table = LayerTable::piarc(self.storage.dirs().data(), &root);
        let rule = answer.rule.clone();
        let directory = answer.directory.clone();
        let items = tokio::task::spawn_blocking(move || {
            let mut values = Vec::new();
            if let Some(dir) = &directory {
                values.push((Category::AdditionalDirectory, dir.as_str()));
            }
            if let Some(rule) = &rule {
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
        if let (Some(services), Ok(s)) = (&self.policy, self.session(id)) {
            lock(&s.files).discard_pending(None);
            lock(&s.policy).cancel(id, services, cause);
            lock(&s.uploads).cancel_writes(None);
        }
    }

    pub(crate) fn finish_tool(&self, id: &str, call: &str) {
        if let Ok(s) = self.session(id) {
            lock(&s.files).discard_pending(Some(call));
            lock(&s.policy).grants.remove(call);
            lock(&s.uploads).cancel_writes(Some(call));
        }
    }

    pub(crate) async fn set_initial_mode(
        &self,
        id: &str,
        explicit: Option<PermissionMode>,
    ) -> Result<(), ErrorObject> {
        let s = self.session(id)?;
        let services = self.services()?;
        let mut settings = services
            .trust
            .permission_settings(s.scope.root())
            .await
            .map_err(|e| e.to_error_object())?;
        let mode = |settings: &Settings| {
            piarc_policy::starting_mode(
                explicit,
                settings
                    .get("/permissions/defaultMode")
                    .and_then(Value::as_str),
            )
        };
        let initial = mode(&settings);
        settings.set_trust(piarc_config::TrustState::Untrusted);
        let mut state = lock(&s.policy);
        state.project_auto = initial == PermissionMode::AcceptEdits && mode(&settings) != initial;
        state.mode = initial;
        state.publish(id, services);
        Ok(())
    }

    pub(crate) fn changed_mode(&self, id: &str, mode: PermissionMode) -> Result<(), ErrorObject> {
        let s = self.session(id)?;
        let mut state = lock(&s.policy);
        state.project_auto = false;
        state.mode = mode;
        state.publish(id, self.services()?);
        Ok(())
    }

    fn services(&self) -> Result<&Services, ErrorObject> {
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
                if request.kind == ApprovalKind::Question
                    && answer.decision != ApprovalDecision::Deny
                {
                    return Err(denied("This client cannot answer questions."));
                }
                if answer.decision == ApprovalDecision::AllowAlways
                    && (request.protected_path == Some(true)
                        || (request.rule.is_none() && request.directory.is_none())
                        || (answer.directory.is_some() != request.directory.is_some())
                        || (answer.rule.is_some() != request.rule.is_some()))
                {
                    return Err(denied("This permission cannot be saved."));
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
        let generation = inputs::begin(s, p, peer).await?;
        let settings = services.settings(s.scope.root()).await?;
        let mut prepared = prepare(
            Arc::clone(s),
            p.clone(),
            &settings,
            peer.clone(),
            &self.exec,
        )
        .await?;
        let (mode, ruling) = prepared.decide(s, services, &settings, peer, &generation)?;
        let choice = if ruling.allow {
            None
        } else {
            prepared.add_preview(p).await?;
            wait_for_user(s, services, p, &prepared.card, peer, &generation).await?
        };
        let (answer, ack) = choice.unzip();
        let source = if answer.is_some() {
            "user"
        } else {
            "automatic"
        };
        let decision = answer.as_ref().map(|a| a.decision);
        let reason = match &answer {
            Some(a) if a.decision == ApprovalDecision::Deny => Some(refusal(
                &prepared,
                s.scope.case_insensitive(),
                a.feedback.as_deref(),
            )),
            None if !ruling.allow => Some(LOST.into()),
            _ => None,
        };
        let result = PolicyEvaluateResult {
            allowed: reason.is_none(),
            reason,
        };
        let detail = json!({"tool":p.tool,"toolCallId":p.tool_call_id,"arguments":argument_summary(p), "mode":mode,"step":ruling.step,
            "rule": if ruling.step=="exactRule" { audit_rule(&prepared.card) } else { None },
            "conclusion": if result.allowed {"allow"} else {"deny"}, "source":source});
        let commit = async {
            services
                .audit(&p.session_id, s.scope.root(), &detail)
                .await?;
            if let Some(answer) = answer.filter(|a| a.decision == ApprovalDecision::AllowAlways) {
                if generation.is_cancelled() || peer.is_closed() {
                    return Err(denied(LOST));
                }
                services.persist(s.scope.root(), &answer).await?;
            }
            if result.allowed {
                let mut state = lock(&s.policy);
                if generation.is_cancelled() || peer.is_closed() {
                    return Err(denied(LOST));
                }
                if decision == Some(ApprovalDecision::AllowSession)
                    && prepared.boundary != Boundary::Protected
                    && let Some(rule) = prepared.card.rule
                {
                    state.rules.insert(rule);
                }
                state.grants.insert(p.tool_call_id.clone(), prepared.grant);
            }
            Ok::<(), ErrorObject>(())
        }
        .await;
        if let Some(ack) = ack {
            let _ = ack.send(commit.clone());
        }
        commit?;
        to_value(&result)
    }
}

const LOST: &str = "Permission denied because the pending approval expired. Request a new approval before retrying.";

type Answered = (ApprovalAnswer, oneshot::Sender<Result<(), ErrorObject>>);

async fn wait_for_user(
    s: &SessionIo,
    services: &Services,
    p: &PolicyEvaluateParams,
    card: &ApprovalRequest,
    peer: &Peer,
    generation: &CancellationToken,
) -> Result<Option<Answered>, ErrorObject> {
    use piarc_protocol::policy::{PolicyPending, PolicyPendingParams};
    let (tx, rx) = oneshot::channel();
    {
        let mut state = lock(&s.policy);
        if generation.is_cancelled() || peer.is_closed() {
            return Err(denied(LOST));
        }
        if !state.ledger.insert(
            card.clone(),
            Pending {
                call: p.tool_call_id.clone(),
                reply: tx,
                peer: peer.clone(),
            },
        ) {
            return Err(denied("Duplicate approval request."));
        }
        state.publish(&p.session_id, services);
    }
    let pending = PolicyPendingParams {
        session_id: p.session_id.clone(),
        tool_call_id: p.tool_call_id.clone(),
    };
    let result = if peer.notify::<PolicyPending>(pending).await.is_ok() {
        tokio::select! {
            biased;
            ()=peer.closed()=>None,
            ()=generation.cancelled()=>None,
            reply=rx=>reply.ok(),
        }
    } else {
        None
    };
    if result.is_none() {
        let mut state = lock(&s.policy);
        if peer.is_closed() {
            state.expired.insert(p.tool_call_id.clone());
        }
        state.ledger.take_if(|r, _| r.request_id == card.request_id);
        state.publish(&p.session_id, services);
    }
    Ok(result)
}

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

fn audit_rule(card: &ApprovalRequest) -> Option<String> {
    let rule = card.rule.as_ref()?;
    if matches!(
        card.tool.as_str(),
        "Read" | "Edit" | "Write" | "Glob" | "Grep"
    ) {
        return Some(rule.clone());
    }
    // Exact command and extension rules can embed credentials. A digest identifies the
    // matching setting without copying its arguments into the audit database.
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(rule.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(format!("{}:sha256:{digest}", card.tool))
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
    simple: bool,
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
    ) -> Result<(PermissionMode, piarc_policy::Ruling), ErrorObject> {
        let (mode, ruling) = {
            let mut state = lock(&s.policy);
            if peer.is_closed() || generation.is_cancelled() {
                return Err(denied(LOST));
            }
            state.ruling(services, settings, &self.card, self.boundary, self.simple)
        };
        if ruling.step != "simpleCommand" {
            self.grant.utility = None;
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
                    file_preview(&tool, &input, &path, &label, &binding)
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
        rule: None,
        directory: None,
        protected_path: None,
    })
}

async fn prepare(
    s: Arc<SessionIo>,
    p: PolicyEvaluateParams,
    settings: &Settings,
    peer: Peer,
    exec: &exec::Exec,
) -> Result<Prepared, ErrorObject> {
    let utility = if p.tool == "Bash"
        && let Some(command) = p.input.get("command").and_then(Value::as_str)
        && piarc_policy::simple_paths(command).is_some()
    {
        exec.simple_utility(&s.scope, command).await
    } else {
        None
    };
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
        let mut card = new_request(&p, &peer)?;
        let mut grant = Grant::new(&p, peer);
        let mut preview = None;
        let mut boundary = Boundary::Inside;
        let mut simple = false;
        let field = |key: &str| p.input.get(key).and_then(Value::as_str);
        match p.tool.as_str() {
            "Bash" | "PowerShell" => {
                let cmd = field("command").ok_or_else(|| denied("The command text is missing."))?;
                let cwd = exec::launch_dir(&s, None)?.dir;
                if p.tool == "Bash" {
                    (simple, boundary) = command_boundary(&scope, cmd, &cwd)?;
                }
                card.command = Some(cmd.to_owned());
                card.rule = Some(piarc_policy::exact_rule(&p.tool, cmd));
                card.cwd = Some(display(&cwd));
                grant.cwd = Some(cwd);
                grant.command = Some(cmd.to_owned());
            }
            "Read" | "Glob" | "Grep" | "Write" | "Edit" => {
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
                grant.path = Some(target);
            }
            "AskUserQuestion" => card.kind = ApprovalKind::Question,
            _ => {
                card.command = Some(format!("{} {}", p.tool, Value::Object(p.input.clone())));
                card.rule = Some(piarc_policy::exact_rule(
                    &p.tool,
                    &Value::Object(p.input).to_string(),
                ));
            }
        }
        simple &= utility.is_some();
        grant.simple_command = simple;
        grant.utility = utility;
        card.protected_path = Some(boundary == Boundary::Protected);
        Ok(Prepared {
            card,
            boundary,
            simple,
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
        if dir.starts_with(scope.root()) && scope.key(&resolved) != scope.key(&lexical_dir(dir)) {
            continue;
        }
        match std::fs::metadata(&resolved) {
            Ok(meta) if meta.is_dir() => {
                scope = scope
                    .with_added_dir(&resolved)
                    .map_err(|e| e.to_error_object())?
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

fn lexical_dir(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            part => result.push(part.as_os_str()),
        }
    }
    result
}

fn prepare_file(
    scope: &Scope,
    p: &PolicyEvaluateParams,
    card: &mut ApprovalRequest,
) -> Result<(Boundary, PathBuf), ErrorObject> {
    let raw = p.input.get("path").and_then(Value::as_str).unwrap_or(".");
    let target = scope.locate(raw).map_err(|e| e.to_error_object())?;
    let label = scope.label(&target);
    let write = matches!(p.tool.as_str(), "Write" | "Edit");
    let boundary = path_boundary(scope, raw, write)?;
    card.kind = if boundary == Boundary::Outside {
        ApprovalKind::PermissionExpansion
    } else {
        ApprovalKind::FileChange
    };
    card.path = Some(display(&target));
    card.rule = Some(piarc_policy::exact_rule(&p.tool, &label));
    if boundary == Boundary::Outside {
        card.directory = if target.is_dir() {
            Some(display(&target))
        } else {
            target.parent().map(display)
        };
    }
    Ok((boundary, target))
}

fn file_preview(
    tool: &str,
    input: &serde_json::Map<String, Value>,
    target: &Path,
    label: &str,
    binding: &piarc_fs::DirectoryBinding,
) -> Result<piarc_protocol::diff::FileDiff, ErrorObject> {
    Ok(match tool {
        "Write" => {
            let new = input
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| denied("The proposed file content is missing."))?;
            let old = original_text(target, binding)?;
            piarc_diff::file_diff(label, old.as_deref(), new)
        }
        _ => {
            let edits = input
                .get("edits")
                .and_then(Value::as_array)
                .ok_or_else(|| denied("Missing proposed edits."))?;
            if let Some(old) = original_text(target, binding)?
                && let Some(new) = edit::proposed(
                    &old,
                    edits,
                    input.get("replaceAll").and_then(Value::as_bool) == Some(true),
                )
            {
                return Ok(piarc_diff::file_diff(label, Some(&old), &new));
            }
            // Invalid edits retain Pi's detailed matching error when the user permits the attempt.
            let mut before = Vec::new();
            let mut after = Vec::new();
            for edit in edits {
                before.push(
                    edit["oldText"]
                        .as_str()
                        .ok_or_else(|| denied("Missing original text."))?,
                );
                after.push(
                    edit["newText"]
                        .as_str()
                        .ok_or_else(|| denied("Missing replacement text."))?,
                );
            }
            piarc_diff::file_diff(label, Some(&before.join("\n")), &after.join("\n"))
        }
    })
}

fn original_text(
    target: &Path,
    binding: &piarc_fs::DirectoryBinding,
) -> Result<Option<String>, ErrorObject> {
    use std::io::Read as _;
    let file = match binding.open_file(target) {
        Ok(file) => file,
        Err(piarc_fs::Error::NotFound { .. }) => return Ok(None),
        Err(error) => return Err(denied(format!("Cannot inspect the file: {error}"))),
    };
    let metadata = file
        .metadata()
        .map_err(|e| denied(format!("Cannot inspect the file: {e}")))?;
    let max = piarc_protocol::fs::MAX_UPLOAD_BYTES;
    if !metadata.is_file() || metadata.len() > max {
        return Err(denied("This target cannot be previewed as a regular file."));
    }
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| denied(format!("Cannot preview the file: {e}")))?;
    if bytes.len() as u64 > max {
        return Err(denied("The target grew beyond the preview limit."));
    }
    Ok(Some(piarc_fs::encoding::decode(
        piarc_fs::encoding::detect(&bytes),
        &bytes,
    )))
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

fn command_boundary(scope: &Scope, cmd: &str, cwd: &Path) -> Result<(bool, Boundary), ErrorObject> {
    let Some(operands) = piarc_policy::simple_paths(cmd) else {
        return Ok((false, Boundary::Inside));
    };
    let mut targets: Vec<_> = operands.iter().map(|arg| cwd.join(arg)).collect();
    if matches!(cmd.split_ascii_whitespace().next(), Some("cp" | "mv")) {
        if targets[0].is_dir() {
            return Ok((false, Boundary::Inside));
        }
        if targets[1].is_dir()
            && let Some(name) = targets[0].file_name()
        {
            targets.push(targets[1].join(name));
        }
    }
    let mut boundary = Boundary::Inside;
    for target in targets {
        match path_boundary(scope, &display(&target), true)? {
            Boundary::Protected => return Ok((false, Boundary::Protected)),
            Boundary::Outside => boundary = Boundary::Outside,
            Boundary::Inside => {}
        }
    }
    Ok((boundary == Boundary::Inside, boundary))
}

#[cfg(test)]
mod tests;
