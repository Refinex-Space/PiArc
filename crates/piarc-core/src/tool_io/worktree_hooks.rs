//! Worktree hooks and directory ownership (ADR-0068). Settings come from the main checkout.
//! A hook-reported directory must be newly created below the workspace's managed directory.
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Weak};

use piarc_git::worktree::{self, Created, Worktree};
use piarc_hooks::HookEvent;
use piarc_protocol::ErrorKind;
use piarc_store::HookWorktree;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::ToolIo;
use crate::error::{Error, Result};
use crate::hooks::{Facts, Request};
use crate::sessions::path_text;

fn refused(message: impl Into<String>) -> Error {
    Error::Feature {
        kind: ErrorKind::PermissionDenied,
        retryable: false,
        message: message.into(),
        details: None,
    }
}

fn entries(base: &Path) -> Result<HashSet<OsString>> {
    match std::fs::read_dir(base) {
        Ok(dir) => dir
            .map(|entry| entry.map(|e| e.file_name()))
            .collect::<std::io::Result<_>>()
            .map_err(|e| refused(format!("Cannot inspect worktree directory: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashSet::new()),
        Err(e) => Err(refused(format!("Cannot inspect worktree directory: {e}"))),
    }
}

fn bound(workspace: &Path, path: &Path) -> Result<(piarc_fs::DirectoryBinding, String)> {
    let full = piarc_git::canonical(path).map_err(|e| refused(e.to_string()))?;
    if full != path || worktree::containing(workspace, path).as_deref() != Some(path) {
        return Err(refused(
            "Worktree hook directory must be a direct, non-link child of .piarc/worktrees",
        ));
    }
    // DirectoryBinding works with the platform's native canonical spelling.
    let native = std::fs::canonicalize(&full).map_err(|e| refused(e.to_string()))?;
    let directory = piarc_fs::DirectoryBinding::existing_directory(&native)
        .map_err(|e| refused(e.to_string()))?;
    let (device, inode) = directory.identity();
    Ok((directory, format!("{device}:{inode}")))
}

impl ToolIo {
    /// Hooks of one workspace can return the same path. Other workspaces may proceed independently.
    async fn lock_worktrees(&self, project: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let lifecycle = {
            let mut locks = super::lock(&self.worktree_lifecycle);
            locks.retain(|_, weak| weak.strong_count() > 0);
            locks
                .get(project)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let mutex = Arc::new(tokio::sync::Mutex::new(()));
                    locks.insert(project.to_owned(), Arc::downgrade(&mutex));
                    mutex
                })
        };
        lifecycle.lock_owned().await
    }

    fn worktree_facts(&self, id: &str, project: &Path, parent: Option<&super::SessionIo>) -> Facts {
        if let Some(parent) = parent {
            let mut facts = self.session_facts(parent, id, CancellationToken::new());
            facts.cwd = project.to_owned();
            return facts;
        }
        Facts {
            session_id: id.into(),
            main_session_id: id.into(),
            agent: None,
            root: project.into(),
            cwd: project.into(),
            tmp_dir: self.config.data_dir.join("sessions").join(id).join("tmp"),
            mode: None,
            fold_case: cfg!(windows),
            cancel: CancellationToken::new(),
        }
    }

    fn worktree_request(event: HookEvent, fields: Value) -> Request {
        Request {
            event,
            subject: None,
            fields: fields.as_object().cloned().unwrap_or_default(),
            tool: None,
        }
    }

    pub(crate) async fn offers_hook_worktree(&self, project: &Path) -> bool {
        let Some(hooks) = self.hook_service() else {
            return false;
        };
        let facts = self.worktree_facts("", project, None);
        hooks
            .plan(
                &facts,
                &Self::worktree_request(HookEvent::WorktreeCreate, json!({})),
            )
            .await
            .is_some()
    }

    pub(crate) async fn hook_owner(&self, path: &Path) -> Result<Option<HookWorktree>> {
        let Some(service) = &self.policy else {
            return Ok(None);
        };
        let key = path_text(path);
        Ok(service
            .storage
            .run(move |s| s.hook_worktree(&key))
            .await??)
    }

    pub(crate) fn verify_hook_worktree(
        project: &Path,
        path: &Path,
        owner: &HookWorktree,
    ) -> Result<()> {
        let (_, identity) = bound(project, path)?;
        if identity != owner.identity {
            return Err(refused("Hook worktree directory identity changed"));
        }
        Ok(())
    }

    pub(crate) async fn make_worktree(
        &self,
        id: &str,
        project: &Path,
        name: &str,
        base: Option<&str>,
        parent_id: Option<&str>,
        restoring: Option<&Path>,
    ) -> Result<Created> {
        worktree::check_name(name).map_err(|e| crate::worktrees::feature(&e))?;
        let _guard = self.lock_worktrees(project).await;
        let parent = parent_id.and_then(|p| self.session(p).ok());
        let facts = self.worktree_facts(parent_id.unwrap_or(id), project, parent.as_deref());
        let request =
            Self::worktree_request(HookEvent::WorktreeCreate, json!({"name":name,"base":base}));
        if let Some(hooks) = self.hook_service()
            && let Some(plan) = hooks.plan(&facts, &request).await
        {
            let native = std::fs::canonicalize(project).map_err(|e| refused(e.to_string()))?;
            let base = worktree::worktrees_dir(&native);
            let parent =
                piarc_fs::DirectoryBinding::capture(&base).map_err(|e| refused(e.to_string()))?;
            let existing = entries(&base)?;
            let answer = hooks
                .execute(&facts, &request, plan, self.exec.hook_launch().await)
                .await;
            if let Some(reason) = answer.decision.block {
                return Err(refused(reason));
            }
            parent.verify().map_err(|e| refused(e.to_string()))?;
            let raw = answer
                .decision
                .worktree_path
                .ok_or_else(|| refused("WorktreeCreate returned no path"))?;
            let path = project.join(raw);
            let (binding, identity) = bound(project, &path)?;
            if path.file_name().is_none_or(|n| existing.contains(n))
                || restoring.is_some_and(|p| p != path)
            {
                return Err(refused(
                    "WorktreeCreate returned an existing directory or changed the restored path",
                ));
            }
            return self
                .record_created_worktree(id, project, name, path, &binding, identity)
                .await;
        }
        if restoring.is_some() {
            return Err(refused(
                "The trusted WorktreeCreate hook is no longer available",
            ));
        }
        let git = self
            .git_runner(project)
            .await
            .map_err(|e| Error::feature(&e))?;
        if self
            .hook_owner(&worktree::worktrees_dir(project).join(name))
            .await?
            .is_some()
        {
            return Err(refused(
                "The worktree name is reserved by a hook-created session",
            ));
        }
        worktree::create(&git, project, name, base)
            .await
            .map_err(|e| crate::worktrees::feature(&e))
    }

    async fn record_created_worktree(
        &self,
        id: &str,
        project: &Path,
        name: &str,
        path: std::path::PathBuf,
        binding: &piarc_fs::DirectoryBinding,
        identity: String,
    ) -> Result<Created> {
        let services = self.policy.as_ref().ok_or(Error::NoDataDirectory)?;
        let key = path_text(&path);
        let owner = HookWorktree {
            workspace: path_text(project),
            session_id: id.into(),
            name: name.into(),
            identity,
        };
        if !services
            .storage
            .run(move |s| s.register_hook_worktree(&key, &owner))
            .await??
        {
            return Err(refused("Another session owns the worktree"));
        }
        binding.verify().map_err(|e| refused(e.to_string()))?;
        let linked = Self::linked_worktree(project, &path);
        let branch = linked
            .then(|| worktree::head_branch(&path))
            .flatten()
            .unwrap_or_default();
        let base = if linked {
            let git = self
                .git_runner(project)
                .await
                .map_err(|e| Error::feature(&e))?;
            worktree::head(&git, &path)
                .await
                .map_err(|e| crate::worktrees::feature(&e))?
        } else {
            String::new()
        };
        Ok(Created {
            worktree: Worktree {
                name: name.into(),
                path,
                branch,
                base,
            },
            copied: vec![],
            ignored: true,
        })
    }

    pub(crate) fn linked_worktree(project: &Path, path: &Path) -> bool {
        matches!(piarc_git::resolve(path), Ok(c) if c.kind == piarc_git::CheckoutKind::LinkedWorktree && c.root == path &&
            piarc_git::resolve(project).is_ok_and(|w| w.main == c.main))
    }

    /// Returns true when the registered hook owns removal. A refused hook never falls back to Git.
    pub(crate) async fn remove_hook_worktree(
        &self,
        session_id: &str,
        project: &Path,
        path: &Path,
        discard: bool,
        release: bool,
    ) -> Result<bool> {
        let _guard = self.lock_worktrees(project).await;
        let Some(owner) = self.hook_owner(path).await? else {
            return Ok(false);
        };
        if owner.workspace != path_text(project) || owner.session_id != session_id {
            return Err(refused("Worktree belongs to another session or workspace"));
        }
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The hook already removed it; a previous run may have failed to mark the session.
                if release {
                    self.release_worktree_owner(path, &owner.session_id).await?;
                }
                return Ok(true);
            }
            Err(e) => return Err(refused(format!("Cannot inspect hook worktree: {e}"))),
            Ok(_) => {}
        }
        let (binding, identity) = bound(project, path)?;
        if owner.identity != identity {
            return Err(refused("Hook worktree directory identity changed"));
        }
        if !discard {
            if !Self::linked_worktree(project, path) {
                return Err(refused(
                    "Confirm removal of the hook directory whose changes cannot be inspected",
                ));
            }
            let git = self
                .git_runner(project)
                .await
                .map_err(|e| Error::feature(&e))?;
            if !worktree::changes(&git, path)
                .await
                .map_err(|e| crate::worktrees::feature(&e))?
                .is_clean()
            {
                return Err(refused("The worktree has uncommitted changes"));
            }
        }
        let facts = self.worktree_facts(&owner.session_id, project, None);
        let request = Self::worktree_request(
            HookEvent::WorktreeRemove,
            json!({"worktree_path":path_text(path)}),
        );
        let hooks = self
            .hook_service()
            .ok_or_else(|| refused("No trusted WorktreeRemove hook"))?;
        let plan = hooks
            .plan(&facts, &request)
            .await
            .ok_or_else(|| refused("No trusted WorktreeRemove hook"))?;
        let launch = self.exec.hook_launch().await;
        binding.verify().map_err(|e| refused(e.to_string()))?;
        drop(binding);
        let answer = hooks.execute(&facts, &request, plan, launch).await;
        if let Some(reason) = answer.decision.block {
            return Err(refused(reason));
        }
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                return Err(refused(
                    "WorktreeRemove did not remove the registered directory",
                ));
            }
        }
        if release {
            self.release_worktree_owner(path, &owner.session_id).await?;
        }
        Ok(true)
    }

    async fn release_worktree_owner(&self, path: &Path, session: &str) -> Result<()> {
        let storage = &self.policy.as_ref().ok_or(Error::NoDataDirectory)?.storage;
        let key = path_text(path);
        let session = session.to_owned();
        storage
            .run(move |s| s.release_hook_worktree(&key, &session))
            .await??;
        Ok(())
    }
}
