//! The session layer's worktree and search requests (T35, architecture sections 6.12, 9.2,
//! 9.3): branches for the new-session form, a session worktree's changes before archiving,
//! removing or keeping it, restoring a removed one when its session reopens, the `.gitignore`
//! line, and full-text search over the index.

use std::path::{Path, PathBuf};

use piarc_git::worktree::Created;
use serde_json::{Value, json};

use super::{Hub, canonical_dir, check_session_id, lock, path_text, session_not_found, snapshot};
use crate::error::{Error, Result};

/// What the new-session form asks for (T35).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorktreeRequest {
    /// The worktree's name; the session id's first eight characters when absent.
    pub name: Option<String>,
    /// The branch or commit it starts from; the workspace's HEAD when absent.
    pub base: Option<String>,
}

/// The most results of one search.
pub const MAX_SEARCH_SESSIONS: usize = 50;
/// Hits listed per session.
pub const SEARCH_HITS_PER_SESSION: usize = 5;

impl Hub {
    /// Creates the worktree of new session `id` in `workspace`.
    pub(super) async fn create_worktree(
        &self,
        workspace: &Path,
        id: &str,
        request: WorktreeRequest,
    ) -> Result<Created> {
        let name = request
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| id.chars().take(8).collect());
        self.ctx
            .worktrees
            .create(id, workspace, &name, request.base.as_deref())
            .await
    }

    /// The session could not be created: its new worktree and branch go again.
    pub(super) async fn discard_worktree(&self, id: &str, workspace: &Path, created: &Created) {
        let tree = &created.worktree;
        match self
            .ctx
            .tool_io
            .remove_hook_worktree(id, workspace, &tree.path, false, true)
            .await
        {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(target: "piarc_core::worktrees", %error, "creation failed; hook directory retained");
                return;
            }
        }
        if let Err(error) = self
            .ctx
            .worktrees
            .remove(id, workspace, &tree.path, false)
            .await
        {
            tracing::warn!(target: "piarc_core::worktrees", "cannot remove {}: {error}", tree.path.display());
            return;
        }
        if let Err(error) = self
            .ctx
            .worktrees
            .delete_branch(workspace, &tree.branch, &tree.base)
            .await
        {
            tracing::warn!(target: "piarc_core::worktrees", "cannot delete {}: {error}", tree.branch);
        }
    }

    /// A known workspace's canonical path.
    async fn known_workspace(&self, path: PathBuf) -> Result<PathBuf> {
        let path = canonical_dir(path, "workspace").await?;
        let key = path_text(&path);
        let known = self
            .ctx
            .storage
            .run(|store| store.workspaces())
            .await??
            .iter()
            .any(|w| w.path == key);
        if known {
            Ok(path)
        } else {
            Err(Error::InvalidArgument {
                field: "workspace",
                reason: "is not an opened workspace".into(),
            })
        }
    }

    /// The local branches of `workspace`'s repository and the one checked out, for the
    /// new-session form; `{ repository: false }` outside git.
    pub async fn worktree_branches(&self, workspace: PathBuf) -> Result<Value> {
        let workspace = self.known_workspace(workspace).await?;
        let checkout = {
            let dir = workspace.clone();
            tokio::task::spawn_blocking(move || piarc_git::resolve(&dir))
                .await
                .map_err(|e| Error::Internal {
                    reason: e.to_string(),
                })?
        };
        let top = matches!(&checkout, Ok(c) if c.kind != piarc_git::CheckoutKind::NotGit
            && c.root == workspace);
        if !top {
            let hook = self.ctx.tool_io.offers_hook_worktree(&workspace).await;
            return Ok(json!({ "repository": false, "hook": hook }));
        }
        let (current, branches) = self.ctx.worktrees.branches(&workspace).await?;
        Ok(json!({ "repository": true, "current": current, "branches": branches }))
    }

    /// Appends `.piarc/worktrees/` to `workspace`'s `.gitignore` (the user agreed).
    pub async fn ignore_worktrees(&self, workspace: PathBuf) -> Result<Value> {
        let workspace = self.known_workspace(workspace).await?;
        let changed =
            tokio::task::spawn_blocking(move || piarc_git::worktree::add_ignore_line(&workspace))
                .await
                .map_err(|e| Error::Internal {
                    reason: e.to_string(),
                })?
                .map_err(|e| crate::worktrees::feature(&e))?;
        Ok(json!({ "changed": changed }))
    }

    /// Session `id`'s worktree record, with its workspace.
    async fn worktree_of(&self, id: &str) -> Result<(PathBuf, piarc_store::WorktreeRecord)> {
        check_session_id(id)?;
        let key = id.to_owned();
        let record = self
            .ctx
            .storage
            .run(move |store| store.session(&key))
            .await??
            .ok_or_else(|| session_not_found(id))?;
        let worktree = record.worktree.ok_or_else(|| Error::InvalidArgument {
            field: "sessionId",
            reason: "the session has no worktree".into(),
        })?;
        let workspace = record
            .workspace_path
            .map(PathBuf::from)
            .ok_or_else(|| session_not_found(id))?;
        Ok((workspace, worktree))
    }

    /// The uncommitted changes of session `id`'s worktree (asked before archiving it).
    pub async fn session_worktree_status(&self, id: String) -> Result<Value> {
        let (workspace, tree) = match self.live_worktree(&id) {
            Some(found) => found,
            None => {
                let (workspace, record) = self.worktree_of(&id).await?;
                (workspace, PathBuf::from(record.path))
            }
        };
        let exists = std::fs::symlink_metadata(&tree).is_ok();
        let changes = if exists {
            self.ctx.worktrees.changes(&workspace, &tree).await?
        } else {
            Some(piarc_git::worktree::Changes::default())
        };
        Ok(json!({
            "path": path_text(&tree),
            "branch": piarc_git::worktree::head_branch(&tree),
            "exists": exists,
            "changes": changes.as_ref().map(|c| c.total),
            "files": changes.map(|c| c.files).unwrap_or_default(),
        }))
    }

    /// An open session's workspace and worktree.
    fn live_worktree(&self, id: &str) -> Option<(PathBuf, PathBuf)> {
        let live = lock(&self.routes).sessions.get(id).cloned()?;
        piarc_git::worktree::containing(&live.workspace, &live.cwd)
            .map(|tree| (live.workspace, tree))
    }

    /// Removes closed session `id`'s worktree now; `discard` also throws its uncommitted
    /// changes away (the user chose to). The branch stays.
    pub async fn remove_session_worktree(&self, id: String, discard: bool) -> Result<Value> {
        if lock(&self.routes).sessions.contains_key(&id) {
            return Err(Error::Feature {
                kind: piarc_protocol::ErrorKind::SessionBusy,
                retryable: false,
                message: "close or archive the session before removing its worktree".into(),
                details: None,
            });
        }
        let (workspace, record) = self.worktree_of(&id).await?;
        let path = PathBuf::from(&record.path);
        self.ctx
            .worktrees
            .remove(&id, &workspace, &path, discard)
            .await?;
        let (key, at) = (id, self.ctx.worktrees.now());
        self.ctx
            .storage
            .run(move |s| s.set_worktree_removed(&key, Some(at)))
            .await??;
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        Ok(Value::Null)
    }

    /// Keeps archived session `id`'s worktree for another retention period (the cleanup found
    /// changes and the user kept them).
    pub async fn keep_session_worktree(&self, id: String) -> Result<Value> {
        self.worktree_of(&id).await?;
        let due = self.ctx.worktrees.cleanup_due();
        self.ctx
            .storage
            .run(move |s| s.set_worktree_cleanup(&id, Some(due), false))
            .await??;
        self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        Ok(Value::Null)
    }

    /// Archiving schedules the worktree's cleanup; restoring cancels it.
    pub(super) async fn archived_worktree(&self, id: &str, archived: bool) -> Result<()> {
        let at = archived.then(|| self.ctx.worktrees.cleanup_due());
        let key = id.to_owned();
        self.ctx
            .storage
            .run(move |s| {
                let removed = s
                    .session(&key)?
                    .and_then(|r| r.worktree)
                    .is_none_or(|w| w.removed_at.is_some());
                if removed {
                    Ok(false)
                } else {
                    s.set_worktree_cleanup(&key, at, false)
                }
            })
            .await??;
        Ok(())
    }

    /// Before session `id` reopens: a worktree removed by the cleanup is added again on its
    /// branch.
    pub(super) async fn restore_worktree(&self, id: &str) -> Result<()> {
        let key = id.to_owned();
        let record = self
            .ctx
            .storage
            .run(move |store| store.session(&key))
            .await??;
        let Some(record) = record else {
            return Ok(());
        };
        let (Some(tree), Some(workspace)) = (record.worktree, record.workspace_path) else {
            return Ok(());
        };
        let path = PathBuf::from(&tree.path);
        if let Some(owner) = self.ctx.tool_io.hook_owner(&path).await? {
            if owner.session_id != id || owner.workspace != workspace {
                return Err(Error::InvalidArgument {
                    field: "worktree",
                    reason: "worktree ownership does not match the session".into(),
                });
            }
            let workspace = Path::new(&workspace);
            if tree.removed_at.is_none()
                || path.try_exists().map_err(|e| Error::Internal {
                    reason: e.to_string(),
                })?
            {
                return crate::tool_io::ToolIo::verify_hook_worktree(workspace, &path, &owner);
            }
            self.ctx
                .tool_io
                .make_worktree(
                    id,
                    workspace,
                    &owner.name,
                    tree.branch.as_deref(),
                    None,
                    Some(&path),
                )
                .await?;
            let key = id.to_owned();
            self.ctx
                .storage
                .run(move |s| s.set_worktree_removed(&key, None))
                .await??;
            return Ok(());
        }
        if tree.removed_at.is_none() || std::fs::symlink_metadata(&path).is_ok() {
            return Ok(());
        }
        let branch = tree.branch.ok_or_else(|| Error::Feature {
            kind: piarc_protocol::ErrorKind::NotFound,
            retryable: false,
            message: format!("the branch of {} is unknown", tree.path),
            details: None,
        })?;
        self.ctx
            .worktrees
            .restore(Path::new(&workspace), &path, &branch)
            .await?;
        let key = id.to_owned();
        self.ctx
            .storage
            .run(move |s| s.set_worktree_removed(&key, None))
            .await??;
        Ok(())
    }

    /// Sessions whose messages contain every term of `query` (T35): grouped, with snippets.
    pub async fn search_sessions(&self, query: String) -> Result<Value> {
        let found = self
            .ctx
            .storage
            .run(move |store| {
                let groups =
                    store.search_sessions(&query, MAX_SEARCH_SESSIONS, SEARCH_HITS_PER_SESSION)?;
                let mut results = Vec::with_capacity(groups.len());
                for group in groups {
                    let Some(record) = store.session(&group.session_id)? else {
                        continue;
                    };
                    let hits: Vec<Value> = group
                        .hits
                        .iter()
                        .map(|hit| {
                            json!({
                                "entryId": hit.entry_id,
                                "role": hit.role,
                                "at": hit.at,
                                "snippet": hit.snippet,
                                "highlights": hit.highlights.iter().map(|(s, e)| [s, e]).collect::<Vec<_>>(),
                            })
                        })
                        .collect();
                    results.push(json!({
                        "sessionId": group.session_id,
                        "title": record.title(),
                        "workspace": record.workspace_path.clone().or_else(|| record.meta.cwd.clone()),
                        "archived": record.archived,
                        "updatedAt": record.meta.updated_at,
                        "total": group.total,
                        "hits": hits,
                    }));
                }
                Ok::<_, piarc_store::Error>(results)
            })
            .await??;
        Ok(json!({ "results": found }))
    }

    /// Runs one worktree cleanup now (the sweep the timer runs): `{ removed, waiting, failed }`
    /// session ids.
    pub async fn sweep_worktrees(&self) -> Value {
        let report = self.ctx.worktrees.sweep().await;
        if !report.removed.is_empty() || !report.waiting.is_empty() {
            self.ctx.snapshots.send(snapshot::SnapshotMsg::Reload);
        }
        json!({ "removed": report.removed, "waiting": report.waiting, "failed": report.failed })
    }

    /// Running sessions and background tasks now (quitting asks first when there are some).
    pub fn running_work(&self) -> Value {
        let sessions = self.ctx.snapshots.activity().running;
        json!({ "sessions": sessions, "tasks": self.ctx.tool_io.tasks().running() })
    }
}
