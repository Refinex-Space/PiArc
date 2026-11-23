//! Subagent sessions in Core (T31, architecture section 6.4, ADR-0048).
//!
//! A subagent runs as a child session in the same Agent Host. Before it runs, the Agent Host
//! registers it (`subagent/start`): the child gets its own registration in [`ToolIo`] (its own
//! file state table, I73) with the parent's workspace root and working directory, and a
//! [`Link`] to its main session (the root of the tree). Through the link:
//!
//! - its calls are decided in a mode never looser than the main session's current mode
//!   ([`effective_mode`]): the definition's mode when it is stricter;
//! - "allow for this session" rules live in the main session and apply to the whole tree
//!   ([`rule_owner`]);
//! - its approval cards carry their origin ([`origin`]) and show in the main session's entry
//!   of the session list (`SnapshotMsg::Subagent`);
//! - its writes go to the main session's current turn's checkpoint, recorded with the
//!   subagent's id (`files.rs`);
//! - the main session's interrupt cancels the approvals and commands of the subagents it
//!   waits for (foreground runs, [`ToolIo::attached`]); background runs go on.
//!
//! A definition's `hooks` run as a source scoped to the child's session id while it runs;
//! a project definition's hooks only when the project is trusted. `subagent/finish`, or the
//! end of the connection, unregisters the child.
//!
//! Isolation (T35): a run with `isolation: worktree` gets a temporary worktree
//! `.piarc/worktrees/agent-<id>/` of its main session's workspace, starting at the parent's
//! current HEAD; the child's files are the worktree, its settings stay the workspace's. When the
//! run ends without uncommitted changes and without new commits, the worktree and its branch
//! are removed; otherwise both stay and `subagent/finish` names them.

use std::path::Path;
use std::sync::Arc;

use piarc_config::agents::{AgentDirs, is_project, load};
use piarc_config::executables::covered_by_trust;
use piarc_protocol::policy::{PermissionMode, PolicyEvaluateParams};
use piarc_protocol::subagent::{
    AgentWarning, AgentWarningKind, AgentsList, AgentsListParams, ApprovalOrigin,
    SubagentIsolation, SubagentLimits, SubagentStartParams, SubagentStartResult, SubagentWorktree,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Value, json};

use super::{SessionIo, ToolIo, lock, policy};
use crate::sessions::SnapshotMsg;

/// Default levels below the main session (architecture section 6.4).
pub const DEFAULT_MAX_DEPTH: u64 = 3;
/// Default subagents running at once per main session.
pub const DEFAULT_MAX_CONCURRENT: u64 = 8;

/// What a subagent's registration knows about where it belongs.
pub(super) struct Link {
    /// The main session: the root of the tree.
    pub root_id: String,
    pub root: Arc<SessionIo>,
    /// The session whose `Agent` call started it.
    pub parent_id: String,
    pub agent_type: String,
    pub description: Option<String>,
    /// The definition's mode (after the project restriction).
    pub mode: Option<PermissionMode>,
    /// Runs in the background, or below a run that does: the main session's interrupt does
    /// not stop it.
    pub detached: bool,
    /// Its temporary worktree (T35).
    pub worktree: Option<AgentWorktree>,
}

/// A subagent's temporary worktree (T35).
#[derive(Debug, Clone)]
pub(crate) struct AgentWorktree {
    /// The workspace whose repository holds it.
    pub project: std::path::PathBuf,
    pub path: std::path::PathBuf,
    pub branch: String,
    /// The commit it started at.
    pub base: String,
}

/// Strictness of a mode: a subagent's mode may only be as strict or stricter.
/// Auto mode (T46) runs everything Accept edits runs and more, below bypass.
fn rank(mode: PermissionMode) -> u8 {
    match mode {
        PermissionMode::BypassPermissions => 0,
        PermissionMode::Auto => 1,
        PermissionMode::AcceptEdits => 2,
        PermissionMode::Default => 3,
        PermissionMode::Plan => 4,
    }
}

/// The stricter of two modes.
#[must_use]
pub(crate) fn stricter(a: PermissionMode, b: PermissionMode) -> PermissionMode {
    if rank(a) >= rank(b) { a } else { b }
}

/// The mode a subagent's call is decided in now.
pub(super) fn effective_mode(link: &Link) -> PermissionMode {
    let root = lock(&link.root.policy).mode();
    link.mode.map_or(root, |mode| stricter(mode, root))
}

/// The mode session `s`'s calls are decided in now: a subagent's follows its main session.
pub(super) fn current_mode(s: &SessionIo) -> PermissionMode {
    s.subagent
        .as_ref()
        .map_or_else(|| lock(&s.policy).mode(), effective_mode)
}

/// Before a subagent's call is decided: its mode follows the main session's, and the call's
/// claimed origin must be the registered one.
pub(super) fn prepare_call(s: &SessionIo, p: &PolicyEvaluateParams) -> Result<(), ErrorObject> {
    let Some(link) = &s.subagent else {
        return Ok(());
    };
    if p.parent_session_id
        .as_ref()
        .is_some_and(|parent| *parent != link.parent_id)
        || p.agent_type
            .as_ref()
            .is_some_and(|kind| *kind != link.agent_type)
    {
        return Err(policy::denied(
            "The call's subagent does not match its registration.",
        ));
    }
    let mode = effective_mode(link);
    lock(&s.policy).follow_mode(mode);
    Ok(())
}

/// The session whose "allow for this session" rules apply: the main session of a subagent.
pub(super) fn rule_owner(s: &SessionIo) -> &SessionIo {
    s.subagent.as_ref().map_or(s, |link| &link.root)
}

/// The origin a subagent's card shows.
pub(super) fn origin(s: &SessionIo, session_id: &str) -> Option<ApprovalOrigin> {
    s.subagent.as_ref().map(|link| ApprovalOrigin {
        session_id: session_id.to_owned(),
        parent_session_id: link.parent_id.clone(),
        agent_type: link.agent_type.clone(),
        description: link.description.clone(),
    })
}

/// Adds a subagent's origin to an audit row.
pub(super) fn annotate(detail: &mut Value, s: &SessionIo) {
    if let (Some(link), Value::Object(map)) = (&s.subagent, detail) {
        map.insert(
            "subagent".into(),
            json!({"rootSessionId": link.root_id, "parentSessionId": link.parent_id,
                "agentType": link.agent_type}),
        );
    }
}

/// Where a write goes: the main session and its turn for a subagent (with the subagent's id),
/// the session itself otherwise.
pub(super) fn checkpoint_owner<'s>(
    s: &'s SessionIo,
    session_id: &'s str,
) -> (&'s str, &'s SessionIo, Option<&'s str>) {
    match &s.subagent {
        Some(link) => (&link.root_id, &link.root, Some(session_id)),
        None => (session_id, s, None),
    }
}

fn invalid(message: impl Into<String>) -> ErrorObject {
    ErrorObject::new(ErrorKind::InvalidParams, message, false)
}

impl ToolIo {
    /// `agents/list`: the definitions found from `p.cwd`, with `Agent(<name>)` deny rules and
    /// the limits applied.
    pub(crate) async fn agents_list(
        &self,
        workspace: &Path,
        p: AgentsListParams,
    ) -> Result<Value, ErrorObject> {
        let cwd = Path::new(&p.cwd).to_owned();
        if !cwd.starts_with(workspace) {
            return Err(invalid("agents/list: cwd must be inside the workspace"));
        }
        let services = self.services()?;
        let settings = services.settings(workspace).await?;
        let loaded = self.definitions_in(&cwd, &settings).await?;
        let rules = policy::workspace_rules(&settings, workspace);
        let denied = |name: &str| policy::denies_agent(&rules, name);
        let project_trusted = settings.trust().is_trusted();
        let has_inline = loaded.definitions.iter().any(|d| !d.mcp_inline.is_empty());
        let expansion = if has_inline {
            self.expansion_environment().await
        } else {
            Vec::new()
        };
        // The MCP policy (T47) applies to inline servers too: a denied server cannot come back
        // as part of a definition, and managed-mcp.json leaves only the managed servers.
        let lookup = crate::mcp::lookup_in(&expansion);
        let mcp_policy = piarc_config::mcp::policy::McpPolicy::from_settings(
            &settings,
            self.managed().snapshot().mcp.is_some(),
            &lookup,
        );
        let mut agents = Vec::with_capacity(loaded.definitions.len());
        for definition in loaded.definitions {
            let mut agent = definition.view;
            agent.denied = denied(&agent.name);
            // Inline MCP servers (T36): a project definition's wait for the project's trust.
            let source = agent.path.clone().unwrap_or_default();
            // A worktree's copy or a directory above the root is not covered (R4 E1).
            let trusted = !is_project(agent.source)
                || (project_trusted && covered_by_trust(workspace, Path::new(&source)));
            agent.mcp_inline = crate::mcp::inline_servers(
                &source,
                &definition.mcp_inline,
                trusted,
                &expansion,
                Some(&mcp_policy),
            );
            agents.push(agent);
        }
        let list = AgentsList {
            agents,
            issues: loaded.issues,
            limits: limits(&settings),
            denied_built_in: p.built_in.into_iter().filter(|n| denied(n)).collect(),
            aliases: aliases(&settings),
        };
        super::to_value(&list)
    }

    /// `subagent/start`: registers the child session of `p.parent_session_id`.
    pub(crate) async fn start_subagent(
        &self,
        p: SubagentStartParams,
    ) -> Result<SubagentStartResult, ErrorObject> {
        super::check_session_id(&p.session_id)?;
        if lock(&self.sessions).contains_key(&p.session_id) {
            return Err(invalid(format!(
                "session {} is already registered",
                p.session_id
            )));
        }
        let parent = self.session(&p.parent_session_id)?;
        let services = self.services()?;
        let (root_id, root, detached) = match &parent.subagent {
            Some(link) => (link.root_id.clone(), Arc::clone(&link.root), link.detached),
            None => (p.parent_session_id.clone(), Arc::clone(&parent), false),
        };
        let workspace = parent.project().to_path_buf();
        let loaded = self
            .definitions_from(parent.scope.cwd(), parent.project())
            .await?;
        let definition = loaded.get(&p.agent_type);
        let mut warnings: Vec<AgentWarning> = Vec::new();
        if let Some(definition) = definition {
            warnings.extend(
                self.scope_definition_hooks(&p.session_id, definition, &workspace)
                    .await,
            );
        }
        let (worktree, files, cwd) = self.child_place(&p, &parent).await?;
        let link = Link {
            root_id: root_id.clone(),
            root,
            parent_id: p.parent_session_id.clone(),
            agent_type: p.agent_type.clone(),
            description: p.description.clone(),
            mode: definition.and_then(|d| d.view.permission_mode),
            detached: detached || p.background,
            worktree: worktree.clone(),
        };
        let mode = effective_mode(&link);
        if let Some(asked) = link.mode
            && asked != mode
        {
            warnings.push(AgentWarning {
                kind: AgentWarningKind::ModeClamped,
                field: Some("permissionMode".into()),
                value: Some(mode_name(asked).into()),
                task: None,
            });
        }
        let opened = self
            .open_linked(&p.session_id, &workspace, &files, &cwd, link)
            .and_then(|()| {
                lock(&self.session(&p.session_id)?.policy).follow_mode(mode);
                if p.background {
                    self.register_background(&p, &root_id, &workspace, &cwd)?;
                }
                Ok(())
            });
        if let Err(error) = opened {
            self.finish_subagent(&p.session_id);
            self.settle_worktree(worktree).await;
            return Err(error);
        }
        services
            .snapshots
            .send(SnapshotMsg::Subagent(p.session_id, Some(root_id)));
        Ok(SubagentStartResult {
            permission_mode: mode,
            warnings,
            cwd: worktree.as_ref().map(|_| piarc_fs::display(&cwd)),
            worktree: worktree.map(|tree| SubagentWorktree {
                path: piarc_fs::display(&tree.path),
                branch: tree.branch,
            }),
        })
    }

    /// The definitions found from `cwd`, with those of `project`'s extension packages (T40).
    async fn definitions_from(
        &self,
        cwd: &Path,
        project: &Path,
    ) -> Result<piarc_config::agents::LoadedAgents, ErrorObject> {
        let settings = self.services()?.settings(project).await?;
        self.definitions_in(cwd, &settings).await
    }

    /// The definitions found from `cwd` under `settings` (its packages' come last).
    async fn definitions_in(
        &self,
        cwd: &Path,
        settings: &piarc_config::Settings,
    ) -> Result<piarc_config::agents::LoadedAgents, ErrorObject> {
        let dirs = self.services()?.storage.dirs().clone();
        let lookup = cwd.to_path_buf();
        let packages = settings.packages().active.clone();
        tokio::task::spawn_blocking(move || {
            load(&AgentDirs {
                cwd: &lookup,
                data: Some(dirs.data()),
                home: dirs.home(),
                packages: &packages,
            })
        })
        .await
        .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))
    }

    /// The child's worktree (isolation), files and working directory: its worktree at the same
    /// place below it as the parent's directory, or the parent's own.
    async fn child_place(
        &self,
        p: &SubagentStartParams,
        parent: &SessionIo,
    ) -> Result<
        (
            Option<AgentWorktree>,
            std::path::PathBuf,
            std::path::PathBuf,
        ),
        ErrorObject,
    > {
        let parent_cwd = parent.scope.cwd();
        match p.isolation {
            Some(SubagentIsolation::Worktree) => {
                let tree = self.agent_worktree(&p.session_id, parent).await?;
                // The canonical root carries Windows' `\\?\` prefix and the cwd does not (W3).
                let root = piarc_git::strip_verbatim(parent.scope.root().to_path_buf());
                let below = parent_cwd
                    .strip_prefix(parent.scope.root())
                    .or_else(|_| parent_cwd.strip_prefix(&root))
                    .unwrap_or(Path::new(""));
                let (files, cwd) = (tree.path.clone(), tree.path.join(below));
                Ok((Some(tree), files, cwd))
            }
            None => Ok((
                None,
                parent.scope.root().to_path_buf(),
                parent_cwd.to_path_buf(),
            )),
        }
    }

    /// Creates the temporary worktree of subagent `id` from `parent`'s HEAD (T35).
    async fn agent_worktree(
        &self,
        id: &str,
        parent: &SessionIo,
    ) -> Result<AgentWorktree, ErrorObject> {
        // Git cannot take a verbatim `\\?\C:\…` path: it becomes `//?/C:/…` (W3).
        let project = piarc_git::strip_verbatim(parent.project().to_path_buf());
        let git = self.git_runner(&project).await?;
        let base = piarc_git::worktree::head(&git, parent.scope.root())
            .await
            .map_err(|e| e.to_error_object())?;
        let short: String = id
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(8)
            .collect();
        let name = format!("{}{short}", piarc_git::worktree::AGENT_PREFIX);
        let created = piarc_git::worktree::create(&git, &project, &name, Some(&base))
            .await
            .map_err(|e| e.to_error_object())?;
        tracing::info!(target: "piarc_core::worktrees", session = %id,
            path = %created.worktree.path.display(), "subagent worktree created");
        Ok(AgentWorktree {
            project,
            path: created.worktree.path,
            branch: created.worktree.branch,
            base: created.worktree.base,
        })
    }

    /// The temporary worktree of registered subagent `id`.
    pub(crate) fn subagent_worktree(&self, id: &str) -> Option<AgentWorktree> {
        lock(&self.sessions)
            .get(id)
            .and_then(|s| s.subagent.as_ref())
            .and_then(|link| link.worktree.clone())
    }

    /// A run ended: its untouched worktree is removed with its branch; one with changes or
    /// commits stays and is returned. When it cannot be inspected, it stays.
    pub(crate) async fn settle_worktree(
        &self,
        worktree: Option<AgentWorktree>,
    ) -> Option<SubagentWorktree> {
        let tree = worktree?;
        let kept = SubagentWorktree {
            path: piarc_fs::display(&tree.path),
            branch: tree.branch.clone(),
        };
        let git = self.git_runner(&tree.project).await.ok()?;
        let untouched = async {
            let clean = piarc_git::worktree::changes(&git, &tree.path)
                .await?
                .is_clean();
            let head = piarc_git::worktree::head(&git, &tree.path).await?;
            Ok::<_, piarc_git::WorktreeError>(clean && head == tree.base)
        };
        match untouched.await {
            Ok(true) => {}
            Ok(false) => return Some(kept),
            Err(error) => {
                tracing::warn!(target: "piarc_core::worktrees", "cannot inspect {}: {error}", kept.path);
                return Some(kept);
            }
        }
        // Without force: a change made since the check keeps it.
        if let Err(error) =
            piarc_git::worktree::remove(&git, &tree.project, &tree.path, false).await
        {
            tracing::warn!(target: "piarc_core::worktrees", "cannot remove {}: {error}", kept.path);
            return Some(kept);
        }
        if let Err(error) =
            piarc_git::worktree::delete_branch_at(&git, &tree.project, &tree.branch, &tree.base)
                .await
        {
            tracing::warn!(target: "piarc_core::worktrees", "cannot delete {}: {error}", tree.branch);
        }
        tracing::info!(target: "piarc_core::worktrees", path = %kept.path, "untouched subagent worktree removed");
        None
    }

    /// A background run is a task of its main session (T32, ADR-0049 rule 5).
    fn register_background(
        &self,
        p: &SubagentStartParams,
        root_id: &str,
        workspace: &Path,
        cwd: &Path,
    ) -> Result<(), ErrorObject> {
        self.tasks.register_subagent(crate::tasks::NewSubagent {
            child_session_id: p.session_id.clone(),
            session_id: p.parent_session_id.clone(),
            owner_session_id: root_id.to_owned(),
            workspace: piarc_fs::display(workspace),
            agent_type: p.agent_type.clone(),
            title: p
                .description
                .clone()
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| p.agent_type.clone()),
            cwd: piarc_fs::display(cwd),
            tool_call_id: p.tool_call_id.clone(),
        })
    }

    /// Runs a definition's hooks for the child while it runs; a project definition's only when
    /// the project is trusted (otherwise the warning).
    async fn scope_definition_hooks(
        &self,
        id: &str,
        definition: &piarc_config::agents::Definition,
        workspace: &Path,
    ) -> Option<AgentWarning> {
        let hooks = definition.hooks.as_ref()?;
        let services = self.services().ok()?;
        let file = definition.view.path.as_deref().unwrap_or_default();
        let trusted = !is_project(definition.view.source)
            || (covered_by_trust(workspace, Path::new(file))
                && services
                    .trust
                    .permission_settings(workspace)
                    .await
                    .is_ok_and(|s| s.trust().is_trusted()));
        if !trusted {
            return Some(AgentWarning {
                kind: AgentWarningKind::HooksUntrusted,
                field: Some("hooks".into()),
                value: None,
                task: None,
            });
        }
        if let Some(service) = &services.hooks {
            service.scope_hooks(
                id,
                definition.view.path.as_deref().map(Path::new),
                hooks.clone(),
            );
        }
        None
    }

    /// Unregisters subagent `id` (its run ended, or its connection did); false when it was not
    /// a registered subagent.
    pub(crate) fn finish_subagent(&self, id: &str) -> bool {
        let registered = lock(&self.sessions)
            .get(id)
            .is_some_and(|s| s.subagent.is_some());
        if !registered {
            return false;
        }
        // Without `subagent/finish` first (its connection ended), a background run was
        // interrupted; after it, the task already ended and this changes nothing.
        self.tasks.subagent_ended(id, None);
        // Its Monitors follow it (R4 S4); its background commands go on, like a closed
        // session's.
        self.tasks.session_closed(id);
        self.close_session(id);
        if let Ok(services) = self.services() {
            if let Some(hooks) = &services.hooks {
                hooks.unscope_hooks(id);
            }
            services
                .snapshots
                .send(SnapshotMsg::Subagent(id.to_owned(), None));
        }
        true
    }

    /// The subagents a main session's interrupt reaches: registered under `root`, not running
    /// in the background.
    pub(super) fn attached(&self, root: &str) -> Vec<String> {
        lock(&self.sessions)
            .iter()
            .filter(|(_, s)| {
                s.subagent
                    .as_ref()
                    .is_some_and(|l| l.root_id == root && !l.detached)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// The parent's session, for the inbound handler's "is it ours" check.
#[must_use]
pub(crate) fn parent_of(params: &serde_json::Map<String, Value>) -> Option<&str> {
    params.get("parentSessionId").and_then(Value::as_str)
}

impl ToolIo {
    /// Answers `agents/list` for `workspace`'s Agent Host.
    pub(crate) async fn agents_request(
        &self,
        workspace: &Path,
        params: serde_json::Map<String, Value>,
    ) -> Result<Value, ErrorObject> {
        let p: AgentsListParams = super::parse("agents/list", params)?;
        self.agents_list(workspace, p).await
    }

    /// Answers `subagent/start`; the caller checked that the parent is its workspace's.
    pub(crate) async fn start_request(
        &self,
        params: serde_json::Map<String, Value>,
    ) -> Result<(String, Value), ErrorObject> {
        let p: SubagentStartParams = super::parse("subagent/start", params)?;
        let id = p.session_id.clone();
        let result = self.start_subagent(p).await?;
        Ok((id, super::to_value(&result)?))
    }

    /// Answers `subagent/finish`: unregisters the child, indexes its file (Pi has written it by
    /// now) and records its state under `workspace`.
    pub(crate) async fn finish_request(
        &self,
        workspace: &Path,
        params: serde_json::Map<String, Value>,
    ) -> Result<Value, ErrorObject> {
        let p: piarc_protocol::subagent::SubagentFinishParams =
            super::parse("subagent/finish", params)?;
        self.tasks.subagent_ended(&p.session_id, Some(p.status));
        let worktree = self.subagent_worktree(&p.session_id);
        self.finish_subagent(&p.session_id);
        let worktree = self.settle_worktree(worktree).await;
        let status = match p.status {
            piarc_protocol::subagent::SubagentStatus::Failed => "error",
            _ => "idle",
        };
        self.index_subagent(&p.session_id, workspace, status).await;
        super::to_value(&piarc_protocol::subagent::SubagentFinishResult { worktree })
    }

    /// Writes a finished subagent's row (its workspace, so its transcript can be read later).
    /// A failure only means the card cannot show its transcript until the next sync.
    pub(crate) async fn index_subagent(&self, id: &str, workspace: &Path, status: &str) {
        let Ok(services) = self.services() else {
            return;
        };
        let storage = services.storage.clone();
        if let Err(error) = storage.sync_sessions().await {
            tracing::warn!(target: "piarc_core::sessions", "indexing subagent {id} failed: {error}");
        }
        let (key, workspace, status) = (
            id.to_owned(),
            piarc_fs::display(workspace),
            status.to_owned(),
        );
        if let Err(error) = storage
            .run(move |store| store.set_session_state(&key, &workspace, &status, false))
            .await
        {
            tracing::warn!(target: "piarc_core::sessions", "recording subagent {id} failed: {error}");
        }
        services.snapshots.send(SnapshotMsg::Reload);
    }
}

/// `subagents.maxDepth` and `subagents.maxConcurrent`, at least 1.
fn limits(settings: &piarc_config::Settings) -> SubagentLimits {
    let number = |pointer: &str, default: u64| {
        settings
            .get(pointer)
            .and_then(Value::as_u64)
            .filter(|n| *n >= 1)
            .unwrap_or(default)
    };
    SubagentLimits {
        max_depth: number("/subagents/maxDepth", DEFAULT_MAX_DEPTH),
        max_concurrent: number("/subagents/maxConcurrent", DEFAULT_MAX_CONCURRENT),
    }
}

/// The merged `modelAliases` table (user and workspace files).
fn aliases(
    settings: &piarc_config::Settings,
) -> std::collections::BTreeMap<piarc_protocol::models::ModelAlias, String> {
    let Some(Value::Object(table)) = settings.get("/modelAliases") else {
        return std::collections::BTreeMap::new();
    };
    table
        .iter()
        .filter_map(|(alias, target)| {
            let alias = serde_json::from_value(Value::String(alias.clone())).ok()?;
            let target = target.as_str()?.trim();
            (!target.is_empty()).then(|| (alias, target.to_owned()))
        })
        .collect()
}

/// A model setting with an alias resolved through the merged table (`haiku` follows `fast`,
/// `sonnet` `balanced`, `opus` `strong`); `None` for an alias that is not set. Other values
/// pass through for the Agent Host to look up.
pub(crate) fn resolve_model_setting(
    value: &str,
    settings: &piarc_config::Settings,
) -> Option<String> {
    use piarc_protocol::models::ModelAlias;
    let Ok(alias) = serde_json::from_value::<ModelAlias>(Value::String(value.to_owned())) else {
        return Some(value.to_owned());
    };
    alias.target(&aliases(settings)).map(str::to_owned)
}

fn mode_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Plan => "plan",
        PermissionMode::BypassPermissions => "bypassPermissions",
        PermissionMode::Auto => "auto",
    }
}

#[cfg(test)]
mod tests;
