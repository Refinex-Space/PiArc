//! T28's session requests (ADR-0044): the rewind preview, a rewind (files first, then the
//! conversation), undoing a rewind, the Changes panel and switching branches.
//!
//! A rewind stops when a file fails and leaves the conversation where it was; the report says
//! what happened to each file and how to undo the ones that changed. The conversation moves in
//! the Agent Host (`session/rewind`, `session/switchBranch`), which reopens the session on its
//! new branch; Core then forgets what the session read (the model no longer sees those reads),
//! takes the branch's permission mode and tells the client to reload the transcript
//! (`session/branchChanged`).

use std::time::Duration;

use piarc_protocol::checkpoint::{
    RewindMode, RewindReport, RewindRequest, RewoundConversation, SessionRewind,
    SessionRewindParams, SessionRewound, SessionSwitchBranch, SessionSwitchBranchParams,
};
use piarc_protocol::method::RequestMethod;
use piarc_protocol::turn::TurnId;
use serde_json::{Value, json};

use super::{Request, to_value};
use crate::error::{Error, Result};
use crate::events::Event;
use crate::route::RouteKey;
use crate::sessions::host_error;

/// How long moving the conversation may take: a summary waits for a model response, and the
/// session reopens with its MCP servers.
const MOVE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A checkpoint request on an open session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointOp {
    /// What rewinding the files to before this turn would do.
    Preview(String),
    /// Rewinds.
    Rewind(RewindRequest),
    /// Undoes the files of a rewind.
    Undo(String),
    /// The session's changes, or one file's.
    Changes(Option<String>),
    /// Discards a file's change or one hunk of it.
    Discard(piarc_protocol::checkpoint::DiscardRequest),
    /// Continues the conversation on another branch, from its last entry.
    SwitchBranch(String),
}

impl CheckpointOp {
    /// Whether the session must be idle: rewinds and branch switches change what a running
    /// turn works on.
    #[must_use]
    pub fn needs_idle(&self) -> bool {
        matches!(
            self,
            Self::Rewind(_) | Self::Undo(_) | Self::SwitchBranch(_)
        )
    }
}

fn feature(error: &piarc_protocol::ErrorObject) -> Error {
    Error::feature(error)
}

impl Request {
    pub(super) async fn checkpoint(&self, op: CheckpointOp) -> Result<Value> {
        let id = self.id.0.as_str();
        match op {
            CheckpointOp::Preview(turn) => self
                .tool_io
                .rewind_preview(id, &turn)
                .await
                .map(to_value)
                .map_err(|e| feature(&e)),
            CheckpointOp::Rewind(request) => self.rewind(request).await.map(to_value),
            CheckpointOp::Undo(restore_id) => self
                .tool_io
                .undo_rewind(id, &restore_id)
                .await
                .map(to_value)
                .map_err(|e| feature(&e)),
            CheckpointOp::Changes(path) => self
                .tool_io
                .changes(id, path)
                .await
                .map(to_value)
                .map_err(|e| feature(&e)),
            CheckpointOp::Discard(request) => self
                .tool_io
                .discard(id, request)
                .await
                .map(to_value)
                .map_err(|e| feature(&e)),
            CheckpointOp::SwitchBranch(entry_id) => {
                let params = SessionSwitchBranchParams {
                    session_id: self.id.clone(),
                    entry_id,
                };
                self.move_conversation::<SessionSwitchBranch>(params)
                    .await
                    .map(to_value)
            }
        }
    }

    async fn rewind(&self, request: RewindRequest) -> Result<RewindReport> {
        let mut report = if request.scope.restores_code() {
            self.tool_io
                .rewind_code(&self.id.0, &request.turn_id.0, request.choices.clone())
                .await
                .map_err(|e| feature(&e))?
        } else {
            RewindReport {
                files: Vec::new(),
                restore_id: None,
                completed: true,
                conversation: None,
                error: None,
            }
        };
        let Some(mode) = request.scope.conversation().filter(|_| report.completed) else {
            return Ok(report);
        };
        let params = SessionRewindParams {
            session_id: self.id.clone(),
            turn_id: TurnId(request.turn_id.0.clone()),
            mode,
        };
        match self.move_conversation::<SessionRewind>(params).await {
            Ok(rewound) => {
                report.conversation = Some(RewoundConversation {
                    text: rewound.text.filter(|_| mode == RewindMode::Branch),
                });
            }
            Err(error) => {
                report.completed = false;
                report.error = Some(format!("The conversation could not be rewound: {error}"));
            }
        }
        Ok(report)
    }

    async fn move_conversation<M>(&self, params: M::Params) -> Result<SessionRewound>
    where
        M: RequestMethod<Result = SessionRewound>,
    {
        let supervisor = self.ws.acquire().await?;
        let rewound = supervisor
            .session_call_within::<M>(&self.id, params, MOVE_TIMEOUT)
            .await
            .map_err(host_error)?;
        self.tool_io.reset_file_states(&self.id.0);
        self.tool_io
            .set_initial_mode(&self.id.0, rewound.permission_mode)
            .await
            .map_err(|e| feature(&e))?;
        self.branch_changed().await;
        Ok(rewound)
    }

    /// Tells the client the conversation is on another branch: it reloads the transcript.
    async fn branch_changed(&self) {
        let payload = json!({
            "method": "session/branchChanged",
            "params": { "sessionId": self.id.0 },
        });
        match RouteKey::session(&self.id.0).and_then(|route| Event::from_json(route, &payload)) {
            Ok(event) => {
                // Fails only when Core shuts down; the rewind's result stands.
                let _ = self.events.send(event).await;
            }
            Err(error) => {
                tracing::error!(target: "piarc_core::sessions", session = %self.id.0, "cannot announce the branch change: {error}");
            }
        }
    }
}
