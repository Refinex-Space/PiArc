//! Entity snapshots (architecture section 7.6): the workspace list on `core/workspaces` and the
//! session list on `core/sessions`, each with its own `revision`.
//!
//! One task builds and sends every snapshot, so revisions go out strictly increasing and in
//! order: a client keeps the snapshot with the highest revision and drops older ones, and an
//! older snapshot can never arrive after a newer one of the same list. Changes that arrive
//! together are folded into one snapshot.
//!
//! Lists merge two sources: the database (recent workspaces, the session index) and the live
//! state the actors report (open workspaces and their Agent Host, open sessions, their status
//! and unread flag). Live state wins for the fields it has.

use std::collections::BTreeMap;

use piarc_protocol::policy::{ApprovalRequest, PermissionMode};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::storage::Storage;

/// Where a workspace's Agent Host stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostState {
    /// The workspace is not open.
    Closed,
    /// Starting, or reopening the sessions that were open.
    Starting,
    /// Connected and every open session restored.
    Ready,
    /// Stopped after every session stayed idle past the threshold; restarts on demand.
    Reclaimed,
    /// Restarting after a crash.
    Restarting,
    /// Could not be started, or failed too often.
    Unavailable,
}

/// A session's state as Core computes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// No turn running.
    Idle,
    /// A turn is running.
    Running,
    /// The last turn failed, or the session could not be opened or reopened.
    Error,
}

impl SessionStatus {
    /// The text stored in the `sessions` table.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Error => "error",
        }
    }
}

/// One workspace of `core/workspaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    /// Canonical path.
    pub path: String,
    /// Name to show.
    pub display_name: String,
    /// The repository's main checkout (the trust key).
    pub main_checkout: String,
    /// Whether it is open.
    pub open: bool,
    /// Its Agent Host.
    pub host: HostState,
    /// When it was last opened (Unix ms).
    pub last_opened_at: i64,
}

/// What an open session's actor reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveSession {
    pub id: String,
    pub workspace: String,
    pub cwd: String,
    pub status: SessionStatus,
    pub unread: bool,
    pub error: Option<String>,
    /// Metadata the client changed while the session is open; written to the index once it
    /// has the session's row.
    pub prefs: piarc_store::SessionPrefsChange,
    /// The first message sent in this session, for its title until the index has one (Pi
    /// writes the file only with the first reply).
    pub first_message: Option<String>,
}

/// One session of `core/sessions`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    /// Session id.
    pub id: String,
    /// The workspace it belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Its working directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Current permission mode.
    pub permission_mode: PermissionMode,
    /// Requests awaiting the user's answer, in arrival order.
    pub approvals: Vec<ApprovalRequest>,
    /// Number of pending approvals.
    pub pending_approvals: usize,
    /// Its name, else its first message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Core's state of it.
    pub status: SessionStatus,
    /// A turn completed since the client last showed it.
    pub unread: bool,
    /// Pinned to the top of its workspace.
    pub pinned: bool,
    /// Archived: hidden from the default list.
    pub archived: bool,
    /// Open in its workspace's Agent Host (or waiting for it).
    pub open: bool,
    /// `provider/id` of its model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Messages in its file.
    pub message_count: i64,
    /// Unix ms of its first entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Unix ms of its last entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// The session file it was forked from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    /// Why it is in error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(crate) enum SnapshotMsg {
    Workspace(WorkspaceView),
    Session(LiveSession),
    SessionClosed(String),
    Policy(String, PermissionMode, Vec<ApprovalRequest>),
    /// Read the database again (after an index sync or a write).
    Reload,
    /// Send both lists again (a client subscribed anew).
    Resend,
}

/// Sends changes to the snapshot task. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Snapshots {
    tx: mpsc::UnboundedSender<SnapshotMsg>,
}

impl Snapshots {
    pub fn spawn(handle: &tokio::runtime::Handle, events: EventSender, storage: Storage) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let task = SnapshotTask {
            rx,
            events,
            storage,
            workspaces: BTreeMap::new(),
            live: BTreeMap::new(),
            policies: BTreeMap::new(),
            recent: Vec::new(),
            indexed: Vec::new(),
            workspace_revision: 0,
            session_revision: 0,
        };
        handle.spawn(task.run());
        let snapshots = Self { tx };
        snapshots.send(SnapshotMsg::Reload);
        snapshots
    }

    pub fn send(&self, msg: SnapshotMsg) {
        // The task ends only when Core shuts down; nothing is left to tell then.
        let _ = self.tx.send(msg);
    }
}

struct SnapshotTask {
    rx: mpsc::UnboundedReceiver<SnapshotMsg>,
    events: EventSender,
    storage: Storage,
    /// Workspaces the actors reported, by path.
    workspaces: BTreeMap<String, WorkspaceView>,
    /// Open sessions, by id.
    live: BTreeMap<String, LiveSession>,
    policies: BTreeMap<String, (PermissionMode, Vec<ApprovalRequest>)>,
    recent: Vec<piarc_store::WorkspaceRecord>,
    indexed: Vec<piarc_store::SessionRecord>,
    workspace_revision: u64,
    session_revision: u64,
}

impl SnapshotTask {
    async fn run(mut self) {
        while let Some(first) = self.rx.recv().await {
            let mut batch = vec![first];
            while let Ok(more) = self.rx.try_recv() {
                batch.push(more);
            }
            let (mut workspaces, mut sessions, mut reload) = (false, false, false);
            for msg in batch {
                match msg {
                    SnapshotMsg::Workspace(view) => {
                        self.workspaces.insert(view.path.clone(), view);
                        workspaces = true;
                    }
                    SnapshotMsg::Session(live) => {
                        self.live.insert(live.id.clone(), live);
                        sessions = true;
                    }
                    SnapshotMsg::SessionClosed(id) => {
                        self.policies.remove(&id);
                        self.live.remove(&id);
                        sessions = true;
                    }
                    SnapshotMsg::Policy(id, mode, requests) => {
                        self.policies.insert(id, (mode, requests));
                        sessions = true;
                    }
                    SnapshotMsg::Reload => reload = true,
                    SnapshotMsg::Resend => (workspaces, sessions) = (true, true),
                }
            }
            if reload {
                self.reload().await;
                (workspaces, sessions) = (true, true);
            }
            if workspaces && !self.emit_workspaces().await {
                return;
            }
            if sessions && !self.emit_sessions().await {
                return;
            }
        }
    }

    async fn reload(&mut self) {
        match self
            .storage
            .run(|store| Ok::<_, piarc_store::Error>((store.workspaces()?, store.sessions()?)))
            .await
        {
            Ok(Ok((recent, indexed))) => {
                self.recent = recent;
                self.indexed = indexed;
            }
            Ok(Err(error)) => {
                tracing::warn!(target: "piarc_core::sessions", "cannot read the session index: {error}");
            }
            // The database closed: Core is shutting down.
            Err(_) => {}
        }
    }

    /// Sends the workspace list; false once the event queue is closed.
    async fn emit_workspaces(&mut self) -> bool {
        self.workspace_revision += 1;
        let mut list: BTreeMap<String, WorkspaceView> = self
            .recent
            .iter()
            .map(|record| {
                let view = WorkspaceView {
                    path: record.path.clone(),
                    display_name: record.display_name.clone(),
                    main_checkout: record.main_checkout.clone(),
                    open: false,
                    host: HostState::Closed,
                    last_opened_at: record.last_opened_at,
                };
                (record.path.clone(), view)
            })
            .collect();
        for (path, view) in &self.workspaces {
            list.insert(path.clone(), view.clone());
        }
        let mut workspaces: Vec<WorkspaceView> = list.into_values().collect();
        workspaces.sort_by_key(|w| std::cmp::Reverse(w.last_opened_at));
        let payload = serde_json::json!({
            "revision": self.workspace_revision,
            "workspaces": workspaces,
        });
        self.emit(RouteKey::workspaces(), &payload).await
    }

    /// Sends the session list; false once the event queue is closed.
    async fn emit_sessions(&mut self) -> bool {
        self.session_revision += 1;
        let mut list: Vec<SessionView> = self
            .indexed
            .iter()
            .map(|record| {
                let mut view = indexed_view(record);
                if let Some(live) = self.live.get(&record.id) {
                    let derived = record
                        .meta
                        .name
                        .as_ref()
                        .or(record.meta.first_message.as_ref());
                    apply_live(&mut view, live, derived);
                }
                view
            })
            .collect();
        for live in self.live.values() {
            if !self.indexed.iter().any(|record| record.id == live.id) {
                let mut view = empty_view(&live.id);
                apply_live(&mut view, live, None);
                list.push(view);
            }
        }
        for view in &mut list {
            if let Some((mode, requests)) = self.policies.get(&view.id) {
                view.permission_mode = *mode;
                view.pending_approvals = requests.len();
                view.approvals.clone_from(requests);
            }
        }
        let payload = serde_json::json!({
            "revision": self.session_revision,
            "sessions": list,
        });
        self.emit(RouteKey::sessions(), &payload).await
    }

    async fn emit(&self, route: RouteKey, payload: &serde_json::Value) -> bool {
        match Event::from_json(route, payload) {
            Ok(event) => self.events.send(event).await.is_ok(),
            Err(error) => {
                tracing::error!(target: "piarc_core::sessions", "cannot encode a snapshot: {error}");
                true
            }
        }
    }
}

fn indexed_view(record: &piarc_store::SessionRecord) -> SessionView {
    let meta = &record.meta;
    SessionView {
        id: record.id.clone(),
        workspace: record.workspace_path.clone().or_else(|| meta.cwd.clone()),
        cwd: meta.cwd.clone(),
        title: record.title().map(str::to_owned),
        status: if record.status.as_deref() == Some("error") {
            SessionStatus::Error
        } else {
            SessionStatus::Idle
        },
        unread: record.unread,
        pinned: record.pinned,
        archived: record.archived,
        open: false,
        permission_mode: PermissionMode::Default,
        approvals: Vec::new(),
        pending_approvals: 0,
        model: meta
            .model_provider
            .as_ref()
            .zip(meta.model_id.as_ref())
            .map(|(provider, id)| format!("{provider}/{id}")),
        message_count: meta.message_count,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        parent_session: meta.parent_session.clone(),
        error: record.index_error.clone(),
    }
}

fn empty_view(id: &str) -> SessionView {
    SessionView {
        id: id.to_owned(),
        workspace: None,
        cwd: None,
        title: None,
        status: SessionStatus::Idle,
        unread: false,
        pinned: false,
        archived: false,
        open: true,
        permission_mode: PermissionMode::Default,
        approvals: Vec::new(),
        pending_approvals: 0,
        model: None,
        message_count: 0,
        created_at: None,
        updated_at: None,
        parent_session: None,
        error: None,
    }
}

/// Live state over the indexed view; `derived` is the title without the user's (to show when
/// the user removes theirs).
fn apply_live(view: &mut SessionView, live: &LiveSession, derived: Option<&String>) {
    view.workspace = Some(live.workspace.clone());
    view.cwd = Some(live.cwd.clone());
    view.status = live.status;
    view.unread = live.unread;
    view.open = true;
    view.error.clone_from(&live.error);
    if view.title.is_none() {
        view.title.clone_from(&live.first_message);
    }
    if let Some(title) = &live.prefs.custom_title {
        view.title = title
            .clone()
            .or_else(|| derived.cloned())
            .or_else(|| live.first_message.clone());
    }
    if let Some(pinned) = live.prefs.pinned {
        view.pinned = pinned;
    }
    if let Some(archived) = live.prefs.archived {
        view.archived = archived;
    }
}
