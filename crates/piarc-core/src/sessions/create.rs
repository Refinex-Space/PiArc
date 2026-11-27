//! Creating a session (T14), in a worktree of its own when asked (T35).

use std::path::PathBuf;

use piarc_protocol::session::ModelRef;
use serde_json::Value;

use super::{Hub, WorktreeRequest, canonical_dir, lock, new_session_id, path_text, session};
use crate::error::{Error, Result};

impl Hub {
    /// Creates a session in `workspace` (opened when it is not), working in `cwd` (the
    /// workspace itself by default), or in a new worktree of the workspace's repository (T35).
    pub async fn create_session(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
        worktree: Option<WorktreeRequest>,
    ) -> Result<Value> {
        self.create_session_as(workspace, cwd, model, mode, worktree, false)
            .await
    }

    /// [`Self::create_session`], as a draft when `draft` (listed as one until its first input).
    pub(super) async fn create_session_as(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
        worktree: Option<WorktreeRequest>,
        draft: bool,
    ) -> Result<Value> {
        let started = std::time::Instant::now();
        let workspace = self.workspace_opened_by_user(workspace).await?;
        tracing::debug!(target: "piarc_core::sessions", draft,
            workspace_ms = started.elapsed().as_millis(), "workspace ready for a new session");
        let id = new_session_id()?;
        let (cwd, created) = match (cwd, worktree) {
            (Some(_), Some(_)) => {
                return Err(Error::InvalidArgument {
                    field: "worktree",
                    reason: "a worktree session works in its worktree; give no cwd".into(),
                });
            }
            (None, Some(request)) => {
                let created = self.create_worktree(&workspace.path, &id, request).await?;
                (created.worktree.path.clone(), Some(created))
            }
            (Some(cwd), None) => (canonical_dir(cwd, "cwd").await?, None),
            (None, None) => (workspace.path.clone(), None),
        };
        if !cwd.starts_with(&workspace.path) {
            return Err(Error::InvalidArgument {
                field: "cwd",
                reason: "must be inside the workspace".into(),
            });
        }
        let spawned =
            session::SessionHandle::spawn_as(&self.ctx, &workspace, id.clone(), cwd, draft);
        let opened = match spawned {
            Ok(handle) => match self.register(handle.clone()) {
                Ok(()) => match handle.create(model, mode).await {
                    Ok(opened) => Ok(opened),
                    Err(error) => {
                        lock(&self.routes).sessions.remove(&id);
                        // Nothing to close when the create never reached the Agent Host.
                        let _ = handle.close().await;
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match (opened, created) {
            (Ok(opened), None) => Ok(opened),
            (Ok(mut opened), Some(created)) => {
                if let Value::Object(map) = &mut opened {
                    let tree = &created.worktree;
                    map.insert(
                        "worktree".into(),
                        serde_json::json!({
                            "name": tree.name,
                            "path": path_text(&tree.path),
                            "branch": tree.branch,
                            "base": tree.base,
                            "copied": created.copied,
                            "ignored": created.ignored,
                        }),
                    );
                }
                Ok(opened)
            }
            (Err(error), Some(created)) => {
                self.discard_worktree(&id, &workspace.path, &created).await;
                Err(error)
            }
            (Err(error), None) => Err(error),
        }
    }
}
