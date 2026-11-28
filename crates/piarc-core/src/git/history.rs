//! G3 operations of the Git panel (design addendum 9.1): tags, cherry-pick, revert, reset and
//! undoing the last commit, stashes, and deleting or restoring a remote branch. They run inside
//! `write.rs`'s checks (trust, busy sessions, the repository lock); this module adds the values'
//! checks, the stale guards (the `HEAD` or stash a dialog showed must still be there) and the
//! facts of their native confirmations.

use piarc_git::remote::{self, RemoteOutcome};
use piarc_git::stash::{self, ApplyOutcome};
use piarc_git::{GitError, Writer, args, history};
use piarc_protocol::git::{
    GitDeletedRemoteBranch, GitDescribe, GitDescription, GitFailure, GitFailureKind, GitOpResult,
    GitRequest, GitResetMode,
};
use serde_json::json;

use super::write::{Answer, Context, bad, fail, remote_answer};
use crate::git::is_protected;

/// The most bytes of a tag annotation or stash message.
const MAX_NOTE: usize = 64 * 1024;

fn stale(what: &str) -> Answer {
    Err(GitFailure::new(GitFailureKind::Stale, what))
}

impl Context<'_> {
    /// Runs a G3 request; anything else is invalid here.
    pub(super) async fn history(
        &self,
        writer: &Writer,
        request: GitRequest,
    ) -> std::result::Result<Answer, GitError> {
        match request {
            GitRequest::CreateTag { name, sha, message } => {
                history::create_tag(writer, &name, &sha, message.as_deref()).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::CherryPick { sha } => self.pick(writer, &sha, false).await,
            GitRequest::Revert { sha } => self.pick(writer, &sha, true).await,
            GitRequest::Reset { sha, mode, expect } => {
                self.reset(writer, &sha, mode, &expect).await
            }
            GitRequest::UndoCommit { expect } => self.undo_commit(writer, &expect).await,
            GitRequest::StashPush {
                message,
                include_untracked,
            } => {
                let message = message.as_deref().map(str::trim).filter(|m| !m.is_empty());
                let saved = stash::push(writer, message, include_untracked == Some(true)).await?;
                self.hub.forget_root(&self.reader.repo.root);
                Ok(if saved {
                    Ok(GitOpResult::default())
                } else {
                    fail(GitFailureKind::Invalid, "no local changes to stash")
                })
            }
            GitRequest::StashApply { index, oid, pop } => {
                self.stash_apply(writer, index, &oid, pop == Some(true))
                    .await
            }
            GitRequest::StashDrop { index, oid } => {
                if !self.stash_is(index, &oid).await? {
                    return Ok(stale("the stash list changed"));
                }
                stash::drop(writer, index).await?;
                self.audit("stashDrop", json!({ "index": index, "oid": oid }))
                    .await;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::StashBranch { index, oid, name } => {
                if !self.stash_is(index, &oid).await? {
                    return Ok(stale("the stash list changed"));
                }
                let outcome = stash::branch(&self.reader, writer, index, &name).await?;
                self.hub.forget_root(&self.reader.repo.root);
                Ok(remote_answer(outcome, ""))
            }
            GitRequest::DeleteRemoteBranch {
                remote,
                branch,
                expect,
            } => self.delete_remote(writer, &remote, &branch, expect).await,
            GitRequest::RestoreRemoteBranch {
                remote,
                branch,
                oid,
            } => {
                let remotes = piarc_git::refs::remotes(&self.reader).await?;
                if let Err(e) = args::check_remote(&remote, &remotes) {
                    return Ok(Err(bad(&e)));
                }
                let outcome =
                    remote::restore_branch(writer, &remote, &branch, &oid, self.cancel.clone())
                        .await?;
                let command = format!("git push {remote} {oid}:refs/heads/{branch}");
                Ok(remote_answer(outcome, &command))
            }
            other => self.merging(writer, other).await,
        }
    }

    async fn pick(
        &self,
        writer: &Writer,
        sha: &str,
        revert: bool,
    ) -> std::result::Result<Answer, GitError> {
        let outcome = history::pick(&self.reader, writer, sha, revert).await?;
        self.hub.forget_root(&self.reader.repo.root);
        Ok(remote_answer(outcome, ""))
    }

    async fn reset(
        &self,
        writer: &Writer,
        sha: &str,
        mode: GitResetMode,
        expect: &str,
    ) -> std::result::Result<Answer, GitError> {
        let head = self.reader.repo_head().await?;
        if head.as_deref() != Some(expect) {
            return Ok(stale("HEAD moved"));
        }
        let (leaving, _) = history::leaving(&self.reader, sha).await?;
        history::reset(writer, sha, mode).await?;
        if mode != GitResetMode::Soft {
            self.hub.forget_root(&self.reader.repo.root);
        }
        self.audit(
            "reset",
            json!({ "mode": mode, "from": expect, "to": sha, "leaving": leaving }),
        )
        .await;
        Ok(Ok(GitOpResult {
            head: Some(sha.to_owned()),
            ..GitOpResult::default()
        }))
    }

    async fn undo_commit(
        &self,
        writer: &Writer,
        expect: &str,
    ) -> std::result::Result<Answer, GitError> {
        let head = self.reader.repo_head().await?;
        if head.as_deref() != Some(expect) {
            return Ok(stale("HEAD moved"));
        }
        let parent = format!("{expect}~1");
        let Some(parent) = self.reader.resolve(&parent).await? else {
            return Ok(fail(
                GitFailureKind::Invalid,
                "the first commit cannot be undone",
            ));
        };
        history::reset(writer, &parent, GitResetMode::Soft).await?;
        self.audit("undoCommit", json!({ "from": expect, "to": parent }))
            .await;
        Ok(Ok(GitOpResult {
            head: Some(parent),
            ..GitOpResult::default()
        }))
    }

    /// Whether `stash@{index}` still names `oid`.
    async fn stash_is(&self, index: u64, oid: &str) -> std::result::Result<bool, GitError> {
        Ok(stash::oid_at(&self.reader, index).await?.as_deref() == Some(oid))
    }

    async fn stash_apply(
        &self,
        writer: &Writer,
        index: u64,
        oid: &str,
        pop: bool,
    ) -> std::result::Result<Answer, GitError> {
        if !self.stash_is(index, oid).await? {
            return Ok(stale("the stash list changed"));
        }
        let outcome = stash::apply(&self.reader, writer, index, pop).await?;
        self.hub.forget_root(&self.reader.repo.root);
        Ok(match outcome {
            ApplyOutcome::Done => Ok(GitOpResult::default()),
            ApplyOutcome::Conflict(paths) => Ok(GitOpResult {
                conflicts: paths,
                stash_kept: Some(true),
                ..GitOpResult::default()
            }),
            ApplyOutcome::Failed(words) => fail(GitFailureKind::LocalChanges, words),
        })
    }

    async fn delete_remote(
        &self,
        writer: &Writer,
        remote: &str,
        branch: &str,
        expect: Option<String>,
    ) -> std::result::Result<Answer, GitError> {
        let remotes = piarc_git::refs::remotes(&self.reader).await?;
        if let Err(e) = args::check_remote(remote, &remotes) {
            return Ok(Err(bad(&e)));
        }
        let settings = self.hub.git_settings(&self.place.project).await;
        if is_protected(branch, &settings.protected) {
            return Ok(Err(GitFailure::of(GitFailureKind::Protected)));
        }
        let lease = match expect {
            Some(oid) => Some(oid),
            None => self.reader.tracking_oid(remote, branch).await?,
        };
        let outcome = remote::delete_branch(
            writer,
            remote,
            branch,
            lease.as_deref(),
            self.cancel.clone(),
        )
        .await?;
        let done = matches!(outcome, RemoteOutcome::Done(_));
        self.audit(
            "deleteRemoteBranch",
            json!({ "remote": remote, "branch": branch, "oid": lease, "ok": done }),
        )
        .await;
        let command = format!("git push {remote} --delete {branch}");
        Ok(match remote_answer(outcome, &command) {
            Ok(result) => Ok(GitOpResult {
                deleted_remote: lease.map(|oid| GitDeletedRemoteBranch {
                    remote: remote.to_owned(),
                    branch: branch.to_owned(),
                    oid,
                }),
                ..result
            }),
            Err(failure) => Err(failure),
        })
    }

    /// The facts of the G3 native confirmations.
    pub(super) async fn describe_history(
        &self,
        action: GitDescribe,
    ) -> std::result::Result<GitDescription, GitError> {
        let mut description = GitDescription::default();
        match action {
            GitDescribe::Reset { sha, mode } => {
                let (leaving, pushed) = history::leaving(&self.reader, &sha).await?;
                description.leaving = Some(leaving);
                description.pushed = Some(pushed);
                description.local_oid = self.reader.repo_head().await?;
                if mode == GitResetMode::Hard {
                    description.paths = self.reader.changed_tracked().await?;
                }
                description.branch = piarc_git::worktree::head_branch(&self.reader.repo.root);
            }
            GitDescribe::StashDrop { index, oid } => {
                let list = stash::list(&self.reader).await?;
                match list.entries.into_iter().find(|e| e.index == index) {
                    Some(entry) if entry.oid == oid => {
                        description.message = Some(entry.message);
                        description.branch = entry.branch;
                        description.local_oid = Some(entry.oid);
                    }
                    _ => {
                        description.refused = Some(GitFailure::new(
                            GitFailureKind::Stale,
                            "the stash list changed",
                        ));
                    }
                }
            }
            GitDescribe::DeleteRemoteBranch { remote, branch } => {
                let protected = self.hub.git_settings(&self.place.project).await.protected;
                if is_protected(&branch, &protected) {
                    description.refused = Some(GitFailure::of(GitFailureKind::Protected));
                }
                description.remote_oid = self.reader.tracking_oid(&remote, &branch).await?;
                description.branch = Some(branch);
                description.remote = Some(remote);
            }
            _ => {}
        }
        Ok(description)
    }
}

/// G3 operations that change the working tree a running session may be using.
pub(super) fn rewrites_files(request: &GitRequest) -> bool {
    match request {
        GitRequest::CherryPick { .. }
        | GitRequest::Revert { .. }
        | GitRequest::StashPush { .. }
        | GitRequest::StashApply { .. }
        | GitRequest::StashBranch { .. } => true,
        GitRequest::Reset { mode, .. } => *mode != GitResetMode::Soft,
        _ => false,
    }
}

fn full_id(sha: &str) -> std::result::Result<(), GitFailure> {
    if args::is_object_id(sha) && sha.len() >= 40 {
        Ok(())
    } else {
        Err(GitFailure::new(
            GitFailureKind::Invalid,
            "not a full commit id",
        ))
    }
}

fn note(text: &str) -> std::result::Result<(), GitFailure> {
    if text.len() > MAX_NOTE || text.contains('\0') {
        Err(GitFailure::new(GitFailureKind::Invalid, "message too long"))
    } else {
        Ok(())
    }
}

/// Checks the values of a G3 write request before git sees them.
pub(super) fn check(request: &GitRequest) -> std::result::Result<(), GitFailure> {
    let branch = |name: &str| args::check_branch_name(name).map_err(|e| bad(&e));
    let remote_name = |name: &str| {
        if name.is_empty() || name.starts_with('-') || name.contains([':', '/', '\\']) {
            Err(GitFailure::new(
                GitFailureKind::Invalid,
                "not a remote name",
            ))
        } else {
            Ok(())
        }
    };
    match request {
        GitRequest::CreateTag { name, sha, message } => {
            branch(name)?;
            full_id(sha)?;
            message.as_deref().map_or(Ok(()), note)
        }
        GitRequest::CherryPick { sha } | GitRequest::Revert { sha } => full_id(sha),
        GitRequest::Reset { sha, expect, .. } => full_id(sha).and_then(|()| full_id(expect)),
        GitRequest::UndoCommit { expect } => full_id(expect),
        GitRequest::StashPush { message, .. } => message.as_deref().map_or(Ok(()), note),
        GitRequest::StashApply { oid, .. } | GitRequest::StashDrop { oid, .. } => full_id(oid),
        GitRequest::StashBranch { oid, name, .. } => full_id(oid).and_then(|()| branch(name)),
        GitRequest::DeleteRemoteBranch {
            remote,
            branch: b,
            expect,
        } => {
            remote_name(remote)?;
            branch(b)?;
            expect.as_deref().map_or(Ok(()), full_id)
        }
        GitRequest::RestoreRemoteBranch {
            remote,
            branch: b,
            oid,
        } => {
            remote_name(remote)?;
            branch(b)?;
            full_id(oid)
        }
        other => super::merging::check(other),
    }
}

/// Checks the values of a G3 description request.
pub(super) fn check_describe(action: &GitDescribe) -> std::result::Result<(), GitFailure> {
    match action {
        GitDescribe::Reset { sha, .. } | GitDescribe::StashDrop { oid: sha, .. } => full_id(sha),
        GitDescribe::DeleteRemoteBranch { remote, branch } => {
            if remote.is_empty() || remote.starts_with('-') || remote.contains([':', '/', '\\']) {
                return Err(GitFailure::new(
                    GitFailureKind::Invalid,
                    "not a remote name",
                ));
            }
            args::check_branch_name(branch).map_err(|e| bad(&e))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_like_values_never_reach_git() {
        let sha = "a".repeat(40);
        let refused = [
            GitRequest::CreateTag {
                name: "--force".into(),
                sha: sha.clone(),
                message: None,
            },
            GitRequest::CherryPick {
                sha: "--abort".into(),
            },
            GitRequest::Reset {
                sha: "HEAD~1".into(),
                mode: GitResetMode::Hard,
                expect: sha.clone(),
            },
            GitRequest::StashBranch {
                index: 0,
                oid: sha.clone(),
                name: "-b".into(),
            },
            GitRequest::DeleteRemoteBranch {
                remote: "--upload-pack=x".into(),
                branch: "topic".into(),
                expect: None,
            },
            GitRequest::DeleteRemoteBranch {
                remote: "https://evil.example/x".into(),
                branch: "topic".into(),
                expect: None,
            },
            GitRequest::RestoreRemoteBranch {
                remote: "origin".into(),
                branch: "topic".into(),
                oid: "HEAD".into(),
            },
        ];
        for request in &refused {
            assert!(check(request).is_err(), "{request:?}");
        }
        assert!(
            check(&GitRequest::Reset {
                sha: sha.clone(),
                mode: GitResetMode::Hard,
                expect: sha,
            })
            .is_ok()
        );
    }

    #[test]
    fn a_soft_reset_leaves_the_working_tree_alone() {
        let sha = "a".repeat(40);
        let reset = |mode| GitRequest::Reset {
            sha: sha.clone(),
            mode,
            expect: sha.clone(),
        };
        assert!(!rewrites_files(&reset(GitResetMode::Soft)));
        assert!(rewrites_files(&reset(GitResetMode::Hard)));
        assert!(rewrites_files(&GitRequest::StashPush {
            message: None,
            include_untracked: None,
        }));
    }
}
