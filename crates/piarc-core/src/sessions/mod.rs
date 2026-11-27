//! Session orchestration (T14; architecture sections 3.2, 3.3, 7.2–7.6, ADR-0010).
//!
//! # Actors
//!
//! - [`Hub`]: the entry for Core's API. It routes each request to the actor that owns the
//!   state: a routing table (workspace path → actor, session id → actor) behind a mutex that is
//!   never held across an await.
//! - `WorkspaceActor` (one per open workspace, `workspace.rs`): owns the workspace's Agent
//!   Host supervisor. Opening the workspace starts the Agent Host at once (warm-up); when every
//!   session stayed idle for [`SessionsConfig::idle_timeout`] (30 minutes by default, measured on
//!   the injected clock) it shuts the process down, and starts it again and reopens the open
//!   sessions when one needs it. It also runs the workspace's settings watcher and the restart
//!   on trust changes. A separate consumer task drains the supervisor's events without ever
//!   waiting on slow work (I19): session notifications go to their session actor's mailbox.
//! - `SessionActor` (one per open session, `session.rs`): delivers the session's
//!   notifications to the client on the route `session/<id>` in `seq` order, backfilling a gap
//!   with `session/getEntries`; computes the session's status and unread flag; runs the
//!   client's requests as tasks so it never waits on the Agent Host itself.
//! - The snapshot task (`snapshot.rs`): `core/workspaces` and `core/sessions` with increasing
//!   revisions.
//!
//! # Cancellation (architecture section 7.2)
//!
//! Core's root token → a token per session → the session's running requests; closing a session
//! cancels its token. An interrupted turn also cancels the commands the session runs through
//! the tool I/O (`ToolIo::cancel_running`), and each command's own token kills its process.
//!
//! # Persistence
//!
//! Pi's JSONL files are the conversation (ADR-0011). Core's own state of a session (workspace,
//! last status, unread) goes into its `sessions` row once the index has it: after every turn the
//! index is synced incrementally and the row updated. After a restart the session list comes
//! from the index and `resume` reopens a session from its file.

mod browser;
mod browser_import;
mod create;
mod dev_servers;
mod diagnostics;
mod drafts;
mod git;
mod hooks;
mod inbound;
mod login;
mod mcp;
mod memory;
mod plugins;
mod project_files;
mod provider_settings;
mod removal;
mod session;
mod skills;
mod snapshot;
mod subagents;
mod tasks;
mod usage;
mod web_search;
mod workspace;
mod worktrees;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use piarc_host::HostConfig;
use piarc_ports::Clock;
use piarc_protocol::history::{HistoryParams, SessionHistory};
use piarc_protocol::session::SessionId;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::agent_host::AgentHostLaunch;
use crate::composer::attachments::{self, ATTACHMENTS_DIR};
use crate::composer::file_search::FileSearch;
use crate::error::{Error, Result};
use crate::events::EventSender;
use crate::secrets::SecretsService;
use crate::storage::Storage;
use crate::tool_io::ToolIo;
use crate::trust::TrustService;

pub use session::{CheckpointOp, ModelOp, Op, QueueOp};

/// Where a fork copies a session's conversation up to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkPoint {
    /// Up to this entry; the session's current position when `None`.
    Entry(Option<String>),
    /// Up to where this turn of the current branch started (T28, "branch from here").
    BeforeTurn(String),
}
pub(crate) use diagnostics::PreparedBundle;
pub(crate) use git::{Place, check_scope, session_base};
pub(crate) use snapshot::{SnapshotMsg, Snapshots};

pub use piarc_store::SessionPrefsChange;
pub use snapshot::{Activity, HostState, SessionStatus, SessionView, WorkspaceView, WorktreeView};
pub use worktrees::{MAX_SEARCH_SESSIONS, SEARCH_HITS_PER_SESSION, WorktreeRequest};

/// How long every session of a workspace stays idle before its Agent Host is stopped.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The most items one `transcript_window` returns.
pub const MAX_WINDOW: u64 = 1000;

/// Adjusts the supervisor settings of every Agent Host (tests shorten timeouts).
pub type HostTuning = Arc<dyn Fn(&mut HostConfig) + Send + Sync>;

/// Settings of the session layer.
#[derive(Clone)]
pub struct SessionsConfig {
    /// How Agent Hosts start; without it workspaces cannot open.
    pub launch: Option<AgentHostLaunch>,
    /// Idle time after which a workspace's Agent Host is stopped.
    pub idle_timeout: Duration,
    /// The clock of the idle timer.
    pub clock: Arc<dyn Clock>,
    /// Supervisor settings adjustments, applied to every start.
    pub tune_host: Option<HostTuning>,
}

impl std::fmt::Debug for SessionsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionsConfig")
            .field("launch", &self.launch)
            .field("idle_timeout", &self.idle_timeout)
            .finish_non_exhaustive()
    }
}

impl Default for SessionsConfig {
    fn default() -> Self {
        Self {
            launch: None,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            clock: Arc::new(crate::clock::SystemClock),
            tune_host: None,
        }
    }
}

impl PartialEq for SessionsConfig {
    fn eq(&self, other: &Self) -> bool {
        self.launch == other.launch && self.idle_timeout == other.idle_timeout
    }
}

impl Eq for SessionsConfig {}

/// What every actor shares.
#[doc(hidden)]
pub(crate) struct Ctx {
    pub handle: Handle,
    pub events: EventSender,
    pub storage: Storage,
    pub trust: TrustService,
    pub secrets: SecretsService,
    pub catalog_network: Arc<std::sync::atomic::AtomicBool>,
    /// Per-model settings and the auxiliary model (T29), read at every handshake.
    pub model_preferences: Arc<Mutex<piarc_protocol::models::ModelPreferences>>,
    /// The provider sign-in in progress (T29).
    pub logins: Arc<login::Logins>,
    pub provider_writer: tokio::sync::Mutex<()>,
    pub tool_io: ToolIo,
    pub config: SessionsConfig,
    pub snapshots: Snapshots,
    pub cancel: CancellationToken,
    pub files: FileSearch,
    /// Worktrees of sessions (T35).
    pub worktrees: crate::worktrees::Worktrees,
    /// The diagnostic bundle the client previewed (T45).
    pub diagnostics: diagnostics::PreparedBundle,
    /// The Agent Hosts' proxy (ADR-0082).
    pub proxy: Arc<crate::network::Proxy>,
    /// The Git panel's locks and operations (ADR-0085).
    pub git: Arc<crate::git::GitState>,
    /// The built-in browser's partition proxies (ADR-0088).
    pub browser: Arc<crate::browser::BrowserProxies>,
    /// Chrome sign-in import (ADR-0090).
    pub chrome: crate::browser::import::ChromeImports,
}

/// The entry of the session layer. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Hub {
    ctx: Arc<Ctx>,
    routes: Arc<Mutex<Routes>>,
}

#[derive(Default)]
struct Routes {
    project_searches: HashMap<(String, String), CancellationToken>,
    workspaces: HashMap<PathBuf, workspace::WorkspaceHandle>,
    sessions: HashMap<String, session::SessionHandle>,
    closed: bool,
    /// Trust changes so far, and the latest ones (I80): a workspace that was still opening
    /// when one came is not in `workspaces` yet and catches up after it is registered.
    trust_epoch: u64,
    trust_changes: std::collections::VecDeque<(u64, PathBuf)>,
    /// Workspaces being removed from the list, with how many removals run: they do not open
    /// meanwhile (a client reopening the session that just closed would list them again).
    removing: HashMap<PathBuf, usize>,
}

/// Trust changes remembered for workspaces that were opening (far more than can overlap).
const TRUST_CHANGES_KEPT: usize = 64;

/// The checkouts whose trust changed after `epoch`.
fn trust_changes_since(
    changes: &std::collections::VecDeque<(u64, PathBuf)>,
    epoch: u64,
) -> Vec<PathBuf> {
    changes
        .iter()
        .filter(|(at, _)| *at > epoch)
        .map(|(_, checkout)| checkout.clone())
        .collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Hub {
    pub fn new(ctx: Ctx) -> Self {
        Self {
            ctx: Arc::new(ctx),
            routes: Arc::default(),
        }
    }

    /// Opens `path` (an existing directory) as a workspace and waits until its Agent Host is
    /// ready: connected, and the sessions that were open reopened.
    pub async fn open_workspace(&self, path: PathBuf) -> Result<WorkspaceView> {
        let workspace = self.workspace_opened_by_user(path).await?;
        workspace.acquire().await?;
        Ok(workspace.view().await)
    }

    /// Closes every session of the workspace and stops its Agent Host.
    pub async fn close_workspace(&self, path: PathBuf) -> Result<()> {
        let path = canonical_dir(path, "path").await?;
        self.close_open_workspace(path).await;
        Ok(())
    }

    /// Closes the sessions and the Agent Host of open workspace `path` (canonical).
    async fn close_open_workspace(&self, path: PathBuf) {
        let removed = lock(&self.routes).workspaces.remove(&path);
        let Some(workspace) = removed else {
            return;
        };
        let sessions: Vec<session::SessionHandle> = {
            let mut routes = lock(&self.routes);
            let ids: Vec<String> = routes
                .sessions
                .values()
                .filter(|s| s.workspace == path)
                .map(|s| s.id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| routes.sessions.remove(id))
                .collect()
        };
        for session in sessions {
            // A session that fails to close is gone with the Agent Host anyway.
            let _ = session.close().await;
        }
        workspace.close().await;
    }

    /// The configuration diagnostics of a workspace (T24).
    pub async fn config_diagnostics(&self, workspace: Option<PathBuf>) -> Result<Value> {
        let target = crate::config_diagnostics::target(&self.ctx.storage, workspace).await?;
        // The packages as the workspace sees them (T41); a failure only leaves them out.
        let packages = match &target {
            Some(dir) => self.plugins().list(Some(dir)).await.ok(),
            None => None,
        };
        crate::config_diagnostics::report_with(
            &self.ctx.storage,
            &self.ctx.trust,
            target,
            packages.as_ref(),
        )
        .await
    }

    /// The permission settings page's view of a workspace's rules (T23).
    pub async fn permission_view(&self, workspace: Option<PathBuf>) -> Result<Value> {
        self.ctx
            .tool_io
            .permission_view(workspace)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// Change one rule from the permission settings page.
    pub async fn update_permission_rule(&self, change_json: String) -> Result<Value> {
        let change = serde_json::from_str(&change_json).map_err(|e| Error::InvalidArgument {
            field: "change",
            reason: format!("invalid rule change: {e}"),
        })?;
        self.ctx
            .tool_io
            .update_permission_rule(change)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// The sandbox settings page's view of a workspace (T39).
    pub async fn sandbox_settings(&self, workspace: Option<PathBuf>) -> Result<Value> {
        self.ctx
            .tool_io
            .sandbox_view(workspace)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// Writes the user's sandbox values from the settings page (T39) and answers the view.
    pub async fn set_sandbox_settings(
        &self,
        workspace: Option<PathBuf>,
        change_json: String,
    ) -> Result<Value> {
        let change = serde_json::from_str(&change_json).map_err(|e| Error::InvalidArgument {
            field: "change",
            reason: format!("invalid sandbox settings: {e}"),
        })?;
        self.ctx
            .tool_io
            .set_sandbox_settings(workspace, change)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// Permission audit events for the settings page.
    pub async fn audit_events(&self, query_json: String) -> Result<Value> {
        let query = serde_json::from_str(&query_json).map_err(|e| Error::InvalidArgument {
            field: "query",
            reason: format!("invalid audit query: {e}"),
        })?;
        self.ctx
            .tool_io
            .audit_events(query)
            .await
            .map_err(|e| Error::feature(&e))
    }

    pub async fn answer_approval(
        &self,
        answer: piarc_protocol::policy::ApprovalAnswer,
    ) -> Result<Value> {
        self.ctx
            .tool_io
            .answer_approval(answer)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// Reopens a session from its file, opening its workspace when needed.
    pub async fn resume_session(&self, id: String) -> Result<Value> {
        check_session_id(&id)?;
        if let Some(live) = self.live(&id) {
            return live.info().await;
        }
        let (workspace, cwd) = self.indexed_location(&id).await?;
        let workspace = self.workspace(workspace).await?;
        self.restore_worktree(&id).await?;
        let handle = session::SessionHandle::spawn(&self.ctx, &workspace, id.clone(), cwd)?;
        self.register(handle.clone())?;
        match handle.resume().await {
            Ok(opened) => Ok(opened),
            Err(error) => {
                lock(&self.routes).sessions.remove(&id);
                let _ = handle.close().await;
                Err(error)
            }
        }
    }

    /// Opens a copy of session `id`'s conversation (up to `at`) as a new session.
    pub async fn fork_session(&self, id: String, at: ForkPoint) -> Result<Value> {
        check_session_id(&id)?;
        let (workspace, cwd) = match self.live(&id) {
            Some(live) => (live.workspace.clone(), live.cwd.clone()),
            None => self.indexed_location(&id).await?,
        };
        let workspace = self.workspace(workspace).await?;
        let opened = workspace.fork(&id, &cwd, at).await?;
        let new_id = opened.session_id.0;
        let handle = session::SessionHandle::spawn(&self.ctx, &workspace, new_id, cwd)?;
        self.register(handle.clone())?;
        handle.adopt(opened.permission_mode).await
    }

    /// Closes an open session: it leaves the Agent Host and the session list's open ones.
    pub async fn close_session(&self, id: String) -> Result<Value> {
        check_session_id(&id)?;
        let removed = lock(&self.routes).sessions.remove(&id);
        match removed {
            Some(session) => session.close().await,
            None => Err(session_not_found(&id)),
        }
    }

    /// Runs `op` on open session `id`; an input's mentions and attachments are checked first.
    pub async fn op(&self, id: String, op: Op) -> Result<Value> {
        check_session_id(&id)?;
        if let Op::Prompt(input) | Op::Steer(input) | Op::FollowUp(input) = &op {
            input.check(&self.attachments_dir(&id))?;
        }
        match self.live(&id) {
            Some(session) => session.op(op).await,
            None => Err(session_not_found(&id)),
        }
    }

    /// Stores an attachment for open session `id` (`<data>/sessions/<id>/attachments/`) and
    /// describes it for the input that will carry it.
    pub async fn store_attachment(
        &self,
        id: String,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        check_session_id(&id)?;
        if self.live(&id).is_none() {
            return Err(session_not_found(&id));
        }
        let dir = self.attachments_dir(&id);
        let stored = tokio::task::spawn_blocking(move || {
            attachments::store(&dir, &name, &mime_type, &bytes)
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("storing an attachment failed: {e}"),
        })??;
        serde_json::to_value(stored).map_err(|e| Error::Internal {
            reason: format!("cannot encode the attachment: {e}"),
        })
    }

    /// Searches the files below `root` (a directory inside a workspace Core knows) for an `@`
    /// mention; a newer search with the same `search_id` cancels this one.
    pub async fn search_files(
        &self,
        search_id: String,
        root: PathBuf,
        query: String,
        limit: usize,
    ) -> Result<Value> {
        let root = canonical_dir(root, "root").await?;
        let known = self
            .ctx
            .storage
            .run(|store| store.workspaces())
            .await??
            .iter()
            .any(|workspace| root.starts_with(&workspace.path));
        if !known {
            return Err(Error::InvalidArgument {
                field: "root",
                reason: "must be inside a workspace".into(),
            });
        }
        self.ctx.files.search(search_id, root, query, limit).await
    }

    /// Stops file search `search_id`.
    pub fn cancel_file_search(&self, search_id: &str) {
        self.ctx.files.cancel(search_id);
    }

    /// `<data>/sessions/<id>/attachments/`.
    fn attachments_dir(&self, id: &str) -> PathBuf {
        self.ctx
            .storage
            .dirs()
            .sessions()
            .join(id)
            .join(ATTACHMENTS_DIR)
    }

    /// Items of a session's persisted conversation (open or not): `start .. start + limit`,
    /// the last `limit` when `start` is `None`.
    pub async fn transcript_window(
        &self,
        id: String,
        start: Option<u64>,
        limit: u64,
    ) -> Result<Value> {
        check_session_id(&id)?;
        if limit == 0 || limit > MAX_WINDOW {
            return Err(Error::InvalidArgument {
                field: "limit",
                reason: format!("must be between 1 and {MAX_WINDOW}"),
            });
        }
        let (workspace, cwd) = match self.live(&id) {
            Some(live) => (live.workspace.clone(), live.cwd.clone()),
            None => self.indexed_location(&id).await?,
        };
        let workspace = self.workspace(workspace).await?;
        let supervisor = workspace.acquire().await?;
        let window = supervisor
            .call::<SessionHistory>(HistoryParams {
                session_id: SessionId(id),
                cwd: cwd.to_string_lossy().into_owned(),
                start,
                limit,
            })
            .await
            .map_err(host_error)?;
        serde_json::to_value(window).map_err(|e| Error::Internal {
            reason: format!("cannot encode the window: {e}"),
        })
    }

    /// Clears the unread flag of a session (the client showed it).
    pub async fn mark_read(&self, id: String) -> Result<()> {
        check_session_id(&id)?;
        if let Some(session) = self.live(&id) {
            return session.op(Op::MarkRead).await.map(|_| ());
        }
        let storage = self.ctx.storage.clone();
        storage
            .run(move |store| {
                let record = store.session(&id)?;
                if let Some(record) = record {
                    let workspace = record
                        .workspace_path
                        .or(record.meta.cwd)
                        .unwrap_or_default();
                    let status = record.status.unwrap_or_else(|| "idle".into());
                    store.set_session_state(&id, &workspace, &status, false)?;
                }
                Ok::<_, piarc_store::Error>(())
            })
            .await??;
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        Ok(())
    }

    /// Changes Core's metadata of session `id` (title, pinned, archived). Archiving closes the
    /// session when it is open and removes its temporary directory (architecture section 9.3).
    pub async fn set_prefs(
        &self,
        id: String,
        change: piarc_store::SessionPrefsChange,
    ) -> Result<()> {
        check_session_id(&id)?;
        if let Some(Some(title)) = &change.custom_title {
            check_title(title)?;
        }
        let archiving = change.archived == Some(true);
        if archiving {
            // Its background tasks stop before their output is cleared (T32).
            self.ctx.tool_io.tasks().session_removed(&id, false).await;
        }
        if let Some(session) = self.live(&id) {
            session.op(Op::Prefs(change.clone())).await?;
            if !archiving {
                return Ok(());
            }
            // The actor stores the change with its next index sync; a closed session has none.
            let removed = lock(&self.routes).sessions.remove(&id);
            if let Some(session) = removed {
                let hold = self.ctx.tool_io.session_hold(&id);
                session.close().await?;
                // Its directory goes below: wait until nothing in Core holds it (W2).
                hold.released().await;
            }
        }
        let key = id.clone();
        let archived = change.archived;
        let stored = self
            .ctx
            .storage
            .run(move |store| store.set_session_prefs(&key, &change))
            .await??;
        if let Some(archived) = archived {
            self.archived_worktree(&id, archived).await?;
        }
        if archiving {
            remove_path(
                self.ctx.storage.dirs().sessions().join(&id),
                clear_generated_files,
            )
            .await?;
        }
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        if stored || archiving {
            Ok(())
        } else {
            Err(session_not_found(&id))
        }
    }

    /// Deletes session `id` (architecture section 9.3): closes it when open, so its Agent Host
    /// stops writing the file, then removes its Pi session file, its temporary directory and
    /// its index rows.
    pub async fn delete_session(&self, id: String) -> Result<()> {
        check_session_id(&id)?;
        self.ctx.tool_io.tasks().session_removed(&id, true).await;
        let removed = lock(&self.routes).sessions.remove(&id);
        let was_open = removed.is_some();
        if let Some(session) = removed {
            let hold = self.ctx.tool_io.session_hold(&id);
            session.close().await?;
            // Its directory goes below: wait until nothing in Core holds it (W2).
            hold.released().await;
        }
        let key = id.clone();
        let record = self
            .ctx
            .storage
            .run(move |store| store.session(&key))
            .await??;
        if record.is_none() && !was_open {
            return Err(session_not_found(&id));
        }
        if let Some(record) = record {
            let pi_sessions = self.ctx.storage.dirs().pi_sessions();
            let file = PathBuf::from(&record.file_path);
            // The index only holds files under `pi/sessions/`; anything else is not ours to delete.
            if !file.starts_with(&pi_sessions) {
                return Err(Error::Internal {
                    reason: format!("{} is outside the session directory", file.display()),
                });
            }
            remove_path(file, |path| std::fs::remove_file(path)).await?;
        }
        // A side chat can incur usage before Pi writes the parent's first JSONL.
        let key = id.clone();
        self.ctx
            .storage
            .run(move |store| store.remove_session(&key))
            .await??;
        self.remove_session_dir(&id).await?;
        // Its snapshots go with it; their objects with the next collection.
        let key = id.clone();
        self.ctx
            .storage
            .run(move |store| store.delete_session_checkpoints(&key))
            .await??;
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        tracing::info!(target: "piarc_core::sessions", session = %id, "session deleted");
        Ok(())
    }

    /// Removes `<data>/sessions/<id>/` (tool output, blobs, the session's temporary files).
    async fn remove_session_dir(&self, id: &str) -> Result<()> {
        remove_path(self.ctx.storage.dirs().sessions().join(id), |path| {
            std::fs::remove_dir_all(path)
        })
        .await
    }

    /// The trust decision of the project at `checkout` changed: its open workspaces restart
    /// their Agent Host. Returns once every workspace marked its host as restarting, so
    /// requests made after this wait for the new process.
    pub async fn trust_changed(&self, checkout: &Path) {
        let workspaces: Vec<workspace::WorkspaceHandle> = {
            let mut routes = lock(&self.routes);
            routes.trust_epoch += 1;
            let epoch = routes.trust_epoch;
            routes.trust_changes.push_back((epoch, checkout.to_owned()));
            while routes.trust_changes.len() > TRUST_CHANGES_KEPT {
                routes.trust_changes.pop_front();
            }
            routes.workspaces.values().cloned().collect()
        };
        for workspace in workspaces {
            workspace.trust_changed(checkout.to_owned()).await;
        }
    }

    /// The proxy may have changed (the system's, or the user's choice): when the effective one
    /// did, the open workspaces restart their Agent Host with it once idle (ADR-0082).
    pub fn refresh_network(&self) {
        let data = self.ctx.storage.dirs().data().to_owned();
        if !self.ctx.proxy.refresh(&data) {
            return;
        }
        let workspaces: Vec<workspace::WorkspaceHandle> =
            lock(&self.routes).workspaces.values().cloned().collect();
        for workspace in workspaces {
            workspace.network_changed();
        }
    }

    /// The Agent Hosts' proxy state.
    pub fn proxy(&self) -> Arc<crate::network::Proxy> {
        Arc::clone(&self.ctx.proxy)
    }

    /// Reads the lists from the database again and sends them (after an index sync).
    pub fn reload_snapshots(&self) {
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
    }

    /// Sends the snapshots again (a client subscribed or reloaded).
    pub fn resend_snapshots(&self) {
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Resend);
        self.ctx.tool_io.tasks().republish();
    }

    /// Ordered shutdown: refuses new workspaces and sessions, then stops every Agent Host
    /// (`host/shutdown`, which closes their sessions) and waits for them.
    pub async fn shutdown(&self) {
        // Background tasks end with PiArc and are recorded as interrupted (T32).
        self.ctx.tool_io.tasks().shutdown().await;
        let workspaces: Vec<workspace::WorkspaceHandle> = {
            let mut routes = lock(&self.routes);
            routes.closed = true;
            routes.sessions.clear();
            routes.workspaces.drain().map(|(_, w)| w).collect()
        };
        for workspace in workspaces {
            workspace.close().await;
        }
        self.ctx.cancel.cancel();
        // Await the separately supervised settings Host's credential flush and shutdown.
        drop(self.ctx.provider_writer.lock().await);
    }

    fn live(&self, id: &str) -> Option<session::SessionHandle> {
        lock(&self.routes).sessions.get(id).cloned()
    }

    fn register(&self, handle: session::SessionHandle) -> Result<()> {
        let mut routes = lock(&self.routes);
        if routes.closed {
            return Err(Error::ShuttingDown);
        }
        routes.sessions.insert(handle.id.clone(), handle);
        Ok(())
    }

    /// The open workspace at `path`, opening it (and starting its Agent Host) when needed.
    async fn workspace(&self, path: PathBuf) -> Result<workspace::WorkspaceHandle> {
        self.workspace_with(path, false).await
    }

    /// [`Self::workspace`] for the user's own open (the folder, or a session started in it):
    /// a workspace removed from the list is listed again.
    async fn workspace_opened_by_user(&self, path: PathBuf) -> Result<workspace::WorkspaceHandle> {
        self.workspace_with(path, true).await
    }

    /// The open workspace at `path`, opened when needed. A workspace removed from the list
    /// opens only when `restore` (other requests, such as a window resuming a session it still
    /// shows, are refused).
    async fn workspace_with(
        &self,
        path: PathBuf,
        restore: bool,
    ) -> Result<workspace::WorkspaceHandle> {
        // Register a new workspace before a simultaneous settings update enumerates Hosts.
        // Its handshake and any subsequent reload then observe the same committed preference.
        let _provider_writer = self.ctx.provider_writer.lock().await;
        self.recover_provider_settings().await?;
        let path = canonical_dir(path, "workspace").await?;
        {
            let routes = lock(&self.routes);
            if routes.removing.contains_key(&path) {
                return Err(being_removed());
            }
            if let Some(open) = routes.workspaces.get(&path).cloned() {
                return Ok(open);
            }
        }
        let epoch = lock(&self.routes).trust_epoch;
        let opened = workspace::WorkspaceHandle::open(&self.ctx, path.clone(), restore).await?;
        // Another request may have opened it meanwhile (keep the first), or Core began to shut
        // down: the new one is closed again.
        let kept: Result<(Option<workspace::WorkspaceHandle>, Vec<PathBuf>)> = {
            let mut routes = lock(&self.routes);
            if routes.closed {
                Err(Error::ShuttingDown)
            } else if routes.removing.contains_key(&path) {
                Err(being_removed())
            } else if let Some(first) = routes.workspaces.get(&path).cloned() {
                Ok((Some(first), Vec::new()))
            } else {
                routes.workspaces.insert(path, opened.clone());
                Ok((None, trust_changes_since(&routes.trust_changes, epoch)))
            }
        };
        match kept {
            Ok((None, missed)) => {
                // Trust changed while it was opening (I80): its Agent Host may have asked
                // before the change; the actor restarts it when the checkout is its own.
                for checkout in missed {
                    opened.trust_changed(checkout).await;
                }
                Ok(opened)
            }
            Ok((Some(first), _)) => {
                opened.close().await;
                Ok(first)
            }
            Err(error) => {
                opened.close().await;
                Err(error)
            }
        }
    }

    /// Workspace and working directory of a session known to the index.
    async fn indexed_location(&self, id: &str) -> Result<(PathBuf, PathBuf)> {
        let key = id.to_owned();
        let record = self
            .ctx
            .storage
            .run(move |store| store.session(&key))
            .await??;
        let Some(record) = record else {
            return Err(session_not_found(id));
        };
        let Some(cwd) = record.meta.cwd.clone() else {
            return Err(session_not_found(id));
        };
        let workspace = record.workspace_path.unwrap_or_else(|| cwd.clone());
        Ok((PathBuf::from(workspace), PathBuf::from(cwd)))
    }
}

/// Removes generated files while keeping the attachments referenced by the Pi session file.
fn clear_generated_files(path: &Path) -> std::io::Result<()> {
    use std::io::ErrorKind;
    if !std::fs::symlink_metadata(path)?.is_dir() {
        return std::fs::remove_file(path);
    }
    let mut retained = false;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            std::fs::remove_file(entry.path())?;
        } else if entry.file_name() == ATTACHMENTS_DIR {
            match std::fs::remove_dir(entry.path()) {
                Err(e) if e.kind() == ErrorKind::DirectoryNotEmpty => retained = true,
                other => other?,
            }
        } else {
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    if !retained {
        std::fs::remove_dir(path)?;
    }
    Ok(())
}

/// Removes a path on the blocking pool; a missing one is fine.
async fn remove_path(path: PathBuf, remove: fn(&Path) -> std::io::Result<()>) -> Result<()> {
    let shown = path.display().to_string();
    let removed = tokio::task::spawn_blocking(move || {
        let result = remove(&path);
        match result {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    })
    .await
    .map_err(|e| Error::Internal {
        reason: format!("a removal task failed: {e}"),
    })?;
    removed.map_err(|e| Error::Feature {
        kind: piarc_protocol::ErrorKind::IoError,
        retryable: true,
        message: format!("cannot remove {shown}: {e}"),
        details: None,
    })
}

/// The longest title a user can give a session, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// A user title: 1 to 200 characters after trimming, no control characters.
fn check_title(title: &str) -> Result<()> {
    let count = title.chars().count();
    let valid = count > 0
        && count <= MAX_TITLE_CHARS
        && title.trim() == title
        && !title.chars().any(char::is_control);
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidArgument {
            field: "title",
            reason: format!(
                "must be 1 to {MAX_TITLE_CHARS} characters without surrounding spaces or control characters"
            ),
        })
    }
}

/// The canonical spelling of an existing directory.
async fn canonical_dir(path: PathBuf, field: &'static str) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::InvalidArgument {
            field,
            reason: "must be an absolute path".into(),
        });
    }
    let resolved = tokio::task::spawn_blocking(move || {
        let canonical = std::fs::canonicalize(&path)?;
        if canonical.is_dir() {
            Ok(strip_verbatim(canonical))
        } else {
            Err(std::io::Error::other("not a directory"))
        }
    })
    .await
    .map_err(|e| Error::Internal {
        reason: format!("resolving a path failed: {e}"),
    })?;
    resolved.map_err(|e| Error::InvalidArgument {
        field,
        reason: format!("must be an existing directory ({e})"),
    })
}

/// `\\?\C:\x` → `C:\x` on Windows: Node and the tools take plain paths.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) if cfg!(windows) && !plain.starts_with("UNC") => PathBuf::from(plain),
        _ => path,
    }
}

/// A random UUID (v4): Pi accepts it as a session id.
pub(crate) fn new_session_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Internal {
        reason: format!("no randomness for a session id: {e}"),
    })?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// Session ids as Pi accepts them.
pub(crate) fn check_session_id(id: &str) -> Result<()> {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    let valid = id.len() <= 128
        && edge(id.chars().next())
        && edge(id.chars().last())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidArgument {
            field: "sessionId",
            reason: "must be 1 to 128 letters, digits, '.', '_' or '-', starting and ending with \
                     a letter or digit"
                .into(),
        })
    }
}

fn session_not_found(id: &str) -> Error {
    Error::Feature {
        kind: piarc_protocol::ErrorKind::SessionNotFound,
        retryable: false,
        message: format!("no session {id}"),
        details: Some(serde_json::json!({ "sessionId": id }).to_string()),
    }
}

/// A supervisor error as Core's error, keeping its kind.
pub(crate) fn host_error(error: piarc_host::Error) -> Error {
    Error::feature(&error.to_error_object())
}

/// A path as text for the client and the database.
/// A workspace asked for while it is being removed from the list.
fn being_removed() -> Error {
    Error::InvalidArgument {
        field: "workspace",
        reason: "is being removed from the list".into(),
    }
}

pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_opening_sees_the_trust_changes_after_it_started() {
        let changes: std::collections::VecDeque<(u64, PathBuf)> = [
            (1, PathBuf::from("/a")),
            (2, PathBuf::from("/b")),
            (3, PathBuf::from("/a")),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            trust_changes_since(&changes, 1),
            [PathBuf::from("/b"), PathBuf::from("/a")]
        );
        assert!(trust_changes_since(&changes, 3).is_empty());
    }

    #[test]
    fn session_ids_follow_pis_rule() {
        let id = new_session_id().expect("random");
        assert_eq!(id.len(), 36);
        check_session_id(&id).expect("a generated id is valid");
        for bad in ["", "-a", "a-", "a/b", "a b", &"x".repeat(129)] {
            assert!(check_session_id(bad).is_err(), "{bad:?}");
        }
    }
}
