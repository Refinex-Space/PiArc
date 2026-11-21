//! Worktrees of sessions and subagents (T35, architecture sections 6.12 and 9.3).
//!
//! Every git operation goes through `piarc_git::worktree` with the commands' environment (the
//! user's login shell, so git finds its credentials helpers and filters) and the
//! process-tree spawner. The git program is looked up on that `PATH`, never inside the
//! workspace.
//!
//! Retention: archiving a session whose worktree still exists schedules its cleanup
//! [`WorktreeConfig::retention`] later (30 days). The sweep (at start and every
//! [`WorktreeConfig::sweep_interval`]) removes a due worktree that has no uncommitted changes
//! (its branch stays); one with changes is marked to wait for the user, who removes or keeps
//! it. A removal that fails leaves everything in place and is tried again by the next sweep,
//! never with force.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use piarc_git::Git;
use piarc_git::worktree::{self, Changes, Created};
use piarc_ports::Clock;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::storage::{Storage, now_ms};
use crate::tool_io::ToolIo;

/// Retention and timing of worktree cleanup.
#[derive(Clone)]
pub struct WorktreeConfig {
    /// How long an archived session's worktree is kept.
    pub retention: Duration,
    /// How often due worktrees are looked for.
    pub sweep_interval: Duration,
    /// Wall time in Unix ms (tests move it).
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// The sweep timer's clock (tests move it).
    pub clock: Arc<dyn Clock>,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        Self {
            retention: Duration::from_secs(30 * 24 * 60 * 60),
            sweep_interval: Duration::from_secs(6 * 60 * 60),
            now_ms: Arc::new(now_ms),
            clock: Arc::new(crate::clock::SystemClock),
        }
    }
}

impl std::fmt::Debug for WorktreeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorktreeConfig")
            .field("retention", &self.retention)
            .field("sweep_interval", &self.sweep_interval)
            .finish_non_exhaustive()
    }
}

/// What one sweep did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepReport {
    /// Sessions whose worktree was removed.
    pub removed: Vec<String>,
    /// Sessions whose worktree has changes and waits for the user.
    pub waiting: Vec<String>,
    /// Sessions whose worktree could not be inspected or removed (tried again later).
    pub failed: Vec<String>,
}

/// Worktree operations of Core. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Worktrees {
    storage: Storage,
    tool_io: ToolIo,
    config: WorktreeConfig,
}

impl Worktrees {
    pub fn new(storage: Storage, tool_io: ToolIo, config: WorktreeConfig) -> Self {
        Self {
            storage,
            tool_io,
            config,
        }
    }

    pub fn now(&self) -> i64 {
        (self.config.now_ms)()
    }

    /// When an archived session's worktree becomes due, archived now.
    pub fn cleanup_due(&self) -> i64 {
        let retention = i64::try_from(self.config.retention.as_millis()).unwrap_or(i64::MAX);
        self.now().saturating_add(retention)
    }

    /// The git runner for operations on `workspace`.
    async fn git(&self, workspace: &Path) -> Result<Git> {
        self.tool_io
            .git_runner(workspace)
            .await
            .map_err(|e| Error::feature(&e))
    }

    /// Creates worktree `name` of the repository at `workspace` (its top level) from `base`.
    pub async fn create(
        &self,
        workspace: &Path,
        name: &str,
        base: Option<&str>,
    ) -> Result<Created> {
        let git = self.git(workspace).await?;
        let created = worktree::create(&git, workspace, name, base)
            .await
            .map_err(|e| feature(&e))?;
        tracing::info!(target: "piarc_core::worktrees", path = %created.worktree.path.display(),
            branch = %created.worktree.branch, copied = created.copied.len(), "worktree created");
        Ok(created)
    }

    /// The local branches of the repository at `workspace` and the one checked out.
    pub async fn branches(&self, workspace: &Path) -> Result<(Option<String>, Vec<String>)> {
        let git = self.git(workspace).await?;
        let list = worktree::branches(&git, workspace)
            .await
            .map_err(|e| feature(&e))?;
        Ok((worktree::head_branch(workspace), list))
    }

    /// Uncommitted changes of the worktree at `path`.
    pub async fn changes(&self, workspace: &Path, path: &Path) -> Result<Changes> {
        let git = self.git(workspace).await?;
        worktree::changes(&git, path).await.map_err(|e| feature(&e))
    }

    /// Removes the worktree at `path` (forced: the user chose to discard its changes).
    pub async fn remove(&self, workspace: &Path, path: &Path, force: bool) -> Result<()> {
        let git = self.git(workspace).await?;
        worktree::remove(&git, workspace, path, force)
            .await
            .map_err(|e| feature(&e))?;
        tracing::info!(target: "piarc_core::worktrees", path = %path.display(), force, "worktree removed");
        Ok(())
    }

    /// Deletes `branch` when it still points at `tip` (a worktree that was never used).
    pub async fn delete_branch(&self, workspace: &Path, branch: &str, tip: &str) -> Result<bool> {
        let git = self.git(workspace).await?;
        worktree::delete_branch_at(&git, workspace, branch, tip)
            .await
            .map_err(|e| feature(&e))
    }

    /// Adds a removed worktree again on its branch.
    pub async fn restore(&self, workspace: &Path, path: &Path, branch: &str) -> Result<()> {
        let git = self.git(workspace).await?;
        worktree::restore(&git, workspace, path, branch)
            .await
            .map_err(|e| feature(&e))
    }

    /// Removes the due worktrees of archived sessions that have no changes; marks the others
    /// to wait for the user.
    pub async fn sweep(&self) -> SweepReport {
        let now = self.now();
        let mut report = SweepReport::default();
        let due = match self.storage.run(move |s| s.due_worktrees(now)).await {
            Ok(Ok(due)) => due,
            Ok(Err(error)) => {
                tracing::warn!(target: "piarc_core::worktrees", "cannot list due worktrees: {error}");
                return report;
            }
            Err(_) => return report,
        };
        for item in due {
            let path = PathBuf::from(&item.path);
            let workspace = item.workspace.as_ref().map_or_else(
                || path.parent().map(Path::to_path_buf).unwrap_or_default(),
                PathBuf::from,
            );
            match self.sweep_one(&item.session_id, &workspace, &path).await {
                Ok(true) => report.removed.push(item.session_id),
                Ok(false) => report.waiting.push(item.session_id),
                Err(error) => {
                    tracing::warn!(target: "piarc_core::worktrees", session = %item.session_id,
                        "worktree cleanup failed, kept in place: {error}");
                    report.failed.push(item.session_id);
                }
            }
        }
        report
    }

    /// Removes one due worktree when clean (true); marks it to wait when changed (false).
    async fn sweep_one(&self, id: &str, workspace: &Path, path: &Path) -> Result<bool> {
        let gone = std::fs::symlink_metadata(path).is_err();
        if !gone && !self.changes(workspace, path).await?.is_clean() {
            let key = id.to_owned();
            self.storage
                .run(move |s| s.set_worktree_cleanup(&key, None, true))
                .await??;
            return Ok(false);
        }
        // Without force: a change made since the check above makes git refuse.
        self.remove(workspace, path, false).await?;
        let (key, at) = (id.to_owned(), self.now());
        self.storage
            .run(move |s| s.set_worktree_removed(&key, Some(at)))
            .await??;
        Ok(true)
    }

    /// Sweeps now and every [`WorktreeConfig::sweep_interval`] until `cancel`; after a sweep
    /// that changed something, `changed` runs (the session list is sent again).
    pub fn spawn_sweeper(
        &self,
        handle: &tokio::runtime::Handle,
        cancel: CancellationToken,
        changed: impl Fn() + Send + 'static,
    ) {
        let this = self.clone();
        handle.spawn(async move {
            loop {
                let report = this.sweep().await;
                if !report.removed.is_empty() || !report.waiting.is_empty() {
                    tracing::info!(target: "piarc_core::worktrees", removed = report.removed.len(),
                        waiting = report.waiting.len(), "worktree cleanup");
                    changed();
                }
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = this.config.clock.sleep(this.config.sweep_interval) => {}
                }
            }
        });
    }
}

/// A worktree error as Core's error.
pub(crate) fn feature(error: &piarc_git::WorktreeError) -> Error {
    Error::feature(&error.to_error_object())
}
