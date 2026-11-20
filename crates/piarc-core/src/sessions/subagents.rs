//! The client's view of subagents (T31): the types a workspace offers (`resources/listAgents`),
//! stopping a run (`subagent/stop`) and a subagent's transcript, which is read through its
//! parent: a child shares its parent's workspace and working directory, and is not in the
//! session list.

use std::path::PathBuf;

use piarc_protocol::history::{HistoryParams, SessionHistory};
use piarc_protocol::session::SessionId;
use piarc_protocol::subagent::{
    ResourcesListAgents, ResourcesListAgentsParams, SubagentStop, SubagentStopParams,
};
use serde_json::Value;

use super::{Hub, MAX_WINDOW, check_session_id, host_error};
use crate::error::{Error, Result};

impl Hub {
    /// The subagent types of `workspace` (from `cwd`, the workspace root when absent), with
    /// the model each resolves to.
    pub async fn list_agents(&self, workspace: PathBuf, cwd: Option<PathBuf>) -> Result<Value> {
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let cwd = cwd.map(|c| c.to_string_lossy().into_owned());
        let list = supervisor
            .call::<ResourcesListAgents>(ResourcesListAgentsParams { cwd })
            .await
            .map_err(host_error)?;
        serde_json::to_value(list).map_err(|e| Error::Internal {
            reason: format!("cannot encode the agent list: {e}"),
        })
    }

    /// Stops subagent `child` of session `parent`; answers whether it was still running.
    pub async fn stop_subagent(&self, parent: String, child: String) -> Result<Value> {
        check_session_id(&parent)?;
        check_session_id(&child)?;
        let (workspace, _) = self.location(&parent).await?;
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let result = supervisor
            .call::<SubagentStop>(SubagentStopParams { session_id: child })
            .await
            .map_err(host_error)?;
        serde_json::to_value(result).map_err(|e| Error::Internal {
            reason: format!("cannot encode the answer: {e}"),
        })
    }

    /// A window of subagent `child`'s transcript; `parent` is the session whose card shows it.
    pub async fn subagent_transcript(
        &self,
        parent: String,
        child: String,
        start: Option<u64>,
        limit: u64,
    ) -> Result<Value> {
        check_session_id(&parent)?;
        check_session_id(&child)?;
        if limit == 0 || limit > MAX_WINDOW {
            return Err(Error::InvalidArgument {
                field: "limit",
                reason: format!("must be between 1 and {MAX_WINDOW}"),
            });
        }
        let (workspace, cwd) = self.location(&parent).await?;
        let handle = self.workspace(workspace).await?;
        let supervisor = handle.acquire().await?;
        let window = supervisor
            .call::<SessionHistory>(HistoryParams {
                session_id: SessionId(child),
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

    /// The workspace and working directory of an open or indexed session.
    async fn location(&self, id: &str) -> Result<(PathBuf, PathBuf)> {
        match self.live(id) {
            Some(live) => Ok((live.workspace.clone(), live.cwd.clone())),
            None => self.indexed_location(id).await,
        }
    }
}
