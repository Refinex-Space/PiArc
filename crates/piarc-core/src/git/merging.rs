//! G4 operations of the Git panel (design addendum 9.2): merge and rebase onto a branch,
//! resolving a conflicted file by taking a side or by writing the merge view's result, and
//! interactive rebases. They run inside `write.rs`'s checks (trust, busy sessions, the
//! repository lock). A saved result is written only over the file the merge view read; an
//! interactive rebase only when `HEAD` and its commits are those the dialog listed. Its todo
//! and messages live in `<data>/tmp/git/<repository>/` until the rebase is over.

use std::collections::HashSet;
use std::path::PathBuf;

use piarc_checkpoint::hash_of;
use piarc_git::merge;
use piarc_git::{GitError, Writer, args, index};
use piarc_protocol::git::{
    GitConflictSides, GitFailure, GitFailureKind, GitOpResult, GitRebaseAction, GitRebaseStep,
    GitRepoState, GitRequest,
};
use serde_json::json;

use super::write::{Answer, Context, bad, fail, remote_answer};

/// The most bytes of a saved merge result (the merge view's limit).
const MAX_RESULT: usize = piarc_git::diff::MAX_FILE_BYTES;
/// The most bytes of one reworded message.
const MAX_MESSAGE: usize = 64 * 1024;

impl Context<'_> {
    /// Runs a G4 request; anything else is invalid here.
    pub(super) async fn merging(
        &self,
        writer: &Writer,
        request: GitRequest,
    ) -> std::result::Result<Answer, GitError> {
        let answer = match request {
            GitRequest::Merge { branch, mode } => {
                let outcome = merge::merge(&self.reader, writer, &branch, mode).await?;
                self.audit("merge", json!({ "branch": branch, "mode": mode }))
                    .await;
                remote_answer(outcome, "")
            }
            GitRequest::Rebase { onto } => {
                let outcome = merge::rebase(&self.reader, writer, &onto).await?;
                self.audit("rebase", json!({ "onto": onto })).await;
                remote_answer(outcome, "")
            }
            GitRequest::ResolveConflict { path, take } => {
                merge::take_side(&self.reader, writer, &path, take).await?;
                Ok(GitOpResult::default())
            }
            GitRequest::SaveResolution {
                path,
                content,
                expect,
            } => self.save(writer, &path, &content, &expect).await?,
            GitRequest::RebaseInteractive { base, head, steps } => {
                self.rebase_interactive(writer, base.as_deref(), &head, &steps)
                    .await?
            }
            _ => Err(GitFailure::of(GitFailureKind::Invalid)),
        };
        self.hub.forget_root(&self.reader.repo.root);
        Ok(answer)
    }

    async fn save(
        &self,
        writer: &Writer,
        path: &str,
        content: &str,
        expect: &str,
    ) -> std::result::Result<Answer, GitError> {
        let root = &self.reader.repo.root;
        let current = index::worktree_bytes(root, path);
        let hash = current
            .as_deref()
            .map_or_else(|| index::ABSENT.to_owned(), index::sha256_hex);
        if hash != expect {
            return Ok(fail(
                GitFailureKind::Stale,
                "the file changed since it was read",
            ));
        }
        let full = root.join(path);
        let expected = current.as_deref().map(hash_of);
        let written =
            match self
                .hub
                .put_back(self.session, &full, expected, Some(content.as_bytes()))
            {
                Some(result) => result,
                None => std::fs::write(&full, content).map_err(|e| e.to_string()),
            };
        if let Err(reason) = written {
            return Ok(fail(GitFailureKind::Failed, reason));
        }
        index::stage(writer, &[path.to_owned()]).await?;
        Ok(Ok(GitOpResult::default()))
    }

    async fn rebase_interactive(
        &self,
        writer: &Writer,
        base: Option<&str>,
        head: &str,
        steps: &[GitRebaseStep],
    ) -> std::result::Result<Answer, GitError> {
        if self.reader.repo_head().await?.as_deref() != Some(head) {
            return Ok(fail(GitFailureKind::Stale, "HEAD moved"));
        }
        let listed = self.listed(base).await?;
        let given: HashSet<&str> = steps.iter().map(|s| s.sha.as_str()).collect();
        if given.len() != steps.len()
            || listed.len() != given.len()
            || !listed.iter().all(|sha| given.contains(sha.as_str()))
        {
            return Ok(fail(
                GitFailureKind::Stale,
                "the commits changed since the plan was read",
            ));
        }
        let dir = self.rebase_dir();
        let _ = std::fs::remove_dir_all(&dir);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return Ok(fail(GitFailureKind::Failed, e.to_string()));
        }
        for (i, step) in steps.iter().enumerate() {
            if let Some(message) = &step.message
                && let Err(e) = std::fs::write(dir.join(format!("message-{i}")), message)
            {
                return Ok(fail(GitFailureKind::Failed, e.to_string()));
            }
        }
        let todo = merge::todo(steps, &|i| {
            merge::shell_word(&dir.join(format!("message-{i}")))
        });
        let todo_file = dir.join("todo");
        if let Err(e) = std::fs::write(&todo_file, todo) {
            return Ok(fail(GitFailureKind::Failed, e.to_string()));
        }
        let outcome = merge::rebase_interactive(&self.reader, writer, base, &todo_file).await?;
        self.audit(
            "rebaseInteractive",
            json!({ "base": base, "from": head, "steps": steps.len() }),
        )
        .await;
        self.tidy_rebase();
        Ok(remote_answer(outcome, ""))
    }

    /// The commits of `base..HEAD` on the first-parent chain (all of `HEAD` without a base).
    async fn listed(&self, base: Option<&str>) -> std::result::Result<Vec<String>, GitError> {
        let range = base.map_or_else(|| "HEAD".to_owned(), |b| format!("{b}..HEAD"));
        let out = self
            .reader
            .ok(&["rev-list", "--first-parent", "--end-of-options", &range])
            .await?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// This repository's directory of interactive-rebase files.
    fn rebase_dir(&self) -> PathBuf {
        let key = index::sha256_hex(self.reader.repo.common_dir.to_string_lossy().as_bytes());
        self.hub.git_temp_dir().join(&key[..16])
    }

    /// Removes the todo and messages once no rebase is in progress.
    pub(super) fn tidy_rebase(&self) {
        let state = piarc_git::status::repo_state(&self.reader.repo);
        if !matches!(state, GitRepoState::Rebasing { .. }) {
            let _ = std::fs::remove_dir_all(self.rebase_dir());
        }
    }
}

/// The sides of a conflicted file, labelled from the operation in progress.
pub(crate) async fn conflict_sides(
    reader: &piarc_git::Reader,
    path: &str,
) -> std::result::Result<GitConflictSides, GitError> {
    let branch =
        piarc_git::worktree::head_branch(&reader.repo.root).unwrap_or_else(|| "HEAD".to_owned());
    let (yours, theirs) = match piarc_git::status::repo_state(&reader.repo) {
        GitRepoState::Merging { source } => (branch, source.unwrap_or_else(|| "MERGE_HEAD".into())),
        GitRepoState::Rebasing {
            branch: rebased,
            onto,
            ..
        } => (
            rebased.unwrap_or(branch),
            onto.unwrap_or_else(|| "onto".into()),
        ),
        GitRepoState::CherryPicking { commit } | GitRepoState::Reverting { commit } => {
            (branch, commit.unwrap_or_default())
        }
        GitRepoState::Clean => (branch, "stash".to_owned()),
    };
    merge::conflict_sides(reader, path, yours, theirs).await
}

/// G4 operations that change the working tree a running session may be using.
pub(super) fn rewrites_files(request: &GitRequest) -> bool {
    matches!(
        request,
        GitRequest::Merge { .. }
            | GitRequest::Rebase { .. }
            | GitRequest::ResolveConflict { .. }
            | GitRequest::SaveResolution { .. }
            | GitRequest::RebaseInteractive { .. }
    )
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

/// An interactive rebase's steps: 1 to 200 distinct commits, a message for each reword, and no
/// squash or fixup before the first kept commit.
fn check_steps(steps: &[GitRebaseStep]) -> std::result::Result<(), GitFailure> {
    let invalid = |why: &str| Err(GitFailure::new(GitFailureKind::Invalid, why));
    if steps.is_empty() || steps.len() > merge::MAX_PLAN {
        return invalid("no or too many steps");
    }
    let mut kept = false;
    for step in steps {
        full_id(&step.sha)?;
        match step.action {
            GitRebaseAction::Squash | GitRebaseAction::Fixup if !kept => {
                return invalid("nothing to fold into");
            }
            GitRebaseAction::Reword => {
                let message = step.message.as_deref().unwrap_or_default();
                if message.trim().is_empty()
                    || message.len() > MAX_MESSAGE
                    || message.contains('\0')
                {
                    return invalid("a reword needs a message");
                }
                kept = true;
            }
            GitRebaseAction::Pick => kept = true,
            _ => {}
        }
    }
    Ok(())
}

/// Checks the values of a G4 write request before git sees them.
pub(super) fn check(request: &GitRequest) -> std::result::Result<(), GitFailure> {
    let path = |p: &str| args::check_path(p).map_err(|e| bad(&e));
    let rev = |r: &str| args::check_revision(r).map_err(|e| bad(&e));
    match request {
        GitRequest::Merge { branch, .. } => rev(branch),
        GitRequest::Rebase { onto } => rev(onto),
        GitRequest::ResolveConflict { path: p, .. } => path(p),
        GitRequest::SaveResolution {
            path: p,
            content,
            expect,
        } => {
            path(p)?;
            if content.len() > MAX_RESULT {
                return Err(GitFailure::new(
                    GitFailureKind::Invalid,
                    "the result is too large",
                ));
            }
            if expect != index::ABSENT && !(expect.len() == 64 && args::is_object_id(expect)) {
                return Err(GitFailure::new(GitFailureKind::Invalid, "not a file hash"));
            }
            Ok(())
        }
        GitRequest::RebaseInteractive { base, head, steps } => {
            base.as_deref().map_or(Ok(()), full_id)?;
            full_id(head)?;
            check_steps(steps)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: GitRebaseAction, message: Option<&str>) -> GitRebaseStep {
        GitRebaseStep {
            sha: "a".repeat(40),
            action,
            message: message.map(str::to_owned),
        }
    }

    #[test]
    fn steps_need_a_kept_commit_first_and_messages_for_rewords() {
        assert!(check_steps(&[step(GitRebaseAction::Fixup, None)]).is_err());
        assert!(check_steps(&[step(GitRebaseAction::Reword, Some("  "))]).is_err());
        assert!(check_steps(&[]).is_err());
        assert!(
            check_steps(&[
                step(GitRebaseAction::Drop, None),
                step(GitRebaseAction::Pick, None),
                step(GitRebaseAction::Squash, None),
            ])
            .is_ok()
        );
    }

    #[test]
    fn option_like_branches_and_paths_never_reach_git() {
        let refused = [
            GitRequest::Merge {
                branch: "--strategy=ours".into(),
                mode: piarc_protocol::git::GitMergeMode::Ff,
            },
            GitRequest::Rebase {
                onto: "--exec=sh".into(),
            },
            GitRequest::SaveResolution {
                path: "../outside".into(),
                content: String::new(),
                expect: index::ABSENT.into(),
            },
            GitRequest::SaveResolution {
                path: "a.txt".into(),
                content: String::new(),
                expect: "HEAD".into(),
            },
        ];
        for request in &refused {
            assert!(check(request).is_err(), "{request:?}");
        }
    }
}
