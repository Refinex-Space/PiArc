//! The user's Git operations (ADR-0085): values checked, then trust (rule 2), then busy
//! sessions for operations that rewrite files (rule 5), then the repository's write lock;
//! after each operation `core/git` tells clients of the same repository to refresh, and pushes,
//! force pushes, rollbacks, forced checkouts and branch deletions write an audit row (rule 6).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_git::branches::{self, CheckoutOutcome, DeleteOutcome};
use piarc_git::commit::{self, CommitOutcome};
use piarc_git::index::{self, HunkAction, HunkOutcome};
use piarc_git::remote::{self, PushSpec, RemoteOutcome, Sequencer};
use piarc_git::{Cancel, Git, GitError, Progress, Reader, Writer, args};
use piarc_protocol::git::{
    GitCheckoutMode, GitDescribe, GitDescription, GitEvent, GitFailure, GitFailureKind, GitHunkRef,
    GitOpResult, GitPushTarget, GitRequest,
};
use serde_json::{Value, json};

use super::restore::{self, Restore};
use crate::Result;
use crate::git::{clean, failure_of, is_protected, reply, reply_failure};
use crate::sessions::{Hub, Place};

/// One write request of one session.
pub(crate) struct Context<'a> {
    pub hub: &'a Hub,
    pub session: &'a str,
    pub place: &'a Place,
    pub reader: Reader,
    pub user: Git,
    pub cancel: Cancel,
    pub op_id: Option<String>,
}

/// The last progress event sent: when, the phase and the percent.
type Seen = (Option<Instant>, String, Option<u64>);

/// An operation's answer before it becomes a reply.
pub(super) type Answer = std::result::Result<GitOpResult, GitFailure>;

pub(super) fn fail(kind: GitFailureKind, message: impl Into<String>) -> Answer {
    Err(GitFailure::new(kind, clean(&message.into())))
}

pub(super) fn bad(error: &args::ArgError) -> GitFailure {
    GitFailure::new(GitFailureKind::Invalid, error.to_string())
}

impl Context<'_> {
    /// Runs `request`.
    pub(crate) async fn run(self, request: GitRequest) -> Result<Value> {
        if let Err(failure) = check(&request) {
            return reply_failure(failure);
        }
        match request {
            GitRequest::Describe { action } => match self.describe(action).await {
                Ok(description) => reply(&description),
                Err(error) => reply_failure(failure_of(&error)),
            },
            GitRequest::CommitMessage {
                language,
                instructions,
                amend,
            } => {
                // The staged changes leave the machine: a trusted project only (ADR-0086).
                if !self.hub.trusted(&self.place.project).await {
                    return reply_failure(GitFailure::of(GitFailureKind::Untrusted));
                }
                super::message::generate(&self, language, &instructions, amend == Some(true)).await
            }
            other => self.write(other).await,
        }
    }

    async fn write(self, request: GitRequest) -> Result<Value> {
        if !self.hub.trusted(&self.place.project).await {
            return reply_failure(GitFailure::of(GitFailureKind::Untrusted));
        }
        if rewrites_files(&request) {
            let busy = self.hub.busy_sessions(&self.place.root);
            if !busy.is_empty() {
                let mut failure = GitFailure::of(GitFailureKind::SessionBusy);
                failure.sessions = busy;
                return reply_failure(failure);
            }
        }
        let lock = self.hub.git_state().lock_for(&self.reader.repo.common_dir);
        // An automatic fetch (H5) never waits for another operation and never prompts.
        let background = matches!(
            request,
            GitRequest::Fetch {
                background: Some(true)
            }
        );
        let _held = if background {
            let Ok(held) = lock.try_lock() else {
                return reply(&GitOpResult {
                    skipped: Some(true),
                    ..GitOpResult::default()
                });
            };
            held
        } else {
            lock.lock().await
        };
        let user = if background {
            self.user.clone().with_env("GCM_INTERACTIVE", "never")
        } else {
            self.user.clone()
        };
        let writer = Writer::new(user, self.reader.repo.clone());
        let answer = match self.perform(&writer, request).await {
            Ok(answer) => answer,
            Err(error) => Err(failure_of(&error)),
        };
        self.hub.git_changed(&self.reader.repo.root);
        match answer {
            Ok(result) => reply(&result),
            Err(failure) => reply_failure(failure),
        }
    }

    async fn perform(
        &self,
        writer: &Writer,
        request: GitRequest,
    ) -> std::result::Result<Answer, GitError> {
        match request {
            GitRequest::Stage { paths } => {
                retry(|| index::stage(writer, &paths)).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::Unstage { paths } => {
                let unborn = self.reader.repo_head().await?.is_none();
                retry(|| index::unstage(writer, &paths, unborn)).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::MarkResolved { paths } => {
                retry(|| index::mark_resolved(writer, &paths)).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::StageHunk { hunk } => self.hunk(writer, &hunk, HunkAction::Stage).await,
            GitRequest::UnstageHunk { hunk } => self.hunk(writer, &hunk, HunkAction::Unstage).await,
            GitRequest::RollbackHunk { hunk } => self.rollback_hunk(writer, &hunk).await,
            GitRequest::Rollback { paths } => self.rollback(writer, &paths).await,
            GitRequest::UndoRollback { restore_id } => self.undo(writer, &restore_id).await,
            GitRequest::Commit {
                message,
                amend,
                signoff,
            } => {
                self.commit(writer, &message, amend == Some(true), signoff == Some(true))
                    .await
            }
            GitRequest::Checkout { target, mode } => {
                self.checkout(writer, &target, mode.unwrap_or_default())
                    .await
            }
            other => self.branch_or_remote(writer, other).await,
        }
    }

    async fn branch_or_remote(
        &self,
        writer: &Writer,
        request: GitRequest,
    ) -> std::result::Result<Answer, GitError> {
        match request {
            GitRequest::CreateBranch {
                name,
                start,
                checkout,
            } => {
                branches::create(writer, &name, start.as_deref(), checkout == Some(true)).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::RenameBranch { from, to } => {
                branches::rename(writer, &from, &to).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::DeleteBranch { name, force } => {
                self.delete(writer, &name, force == Some(true)).await
            }
            GitRequest::RestoreBranch {
                name,
                oid,
                upstream,
            } => {
                branches::restore(writer, &name, &oid, upstream.as_deref()).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::SetUpstream { branch, upstream } => {
                branches::set_upstream(writer, &branch, upstream.as_deref()).await?;
                Ok(Ok(GitOpResult::default()))
            }
            GitRequest::Fetch { .. } => {
                let outcome = remote::fetch(writer, self.progress(), self.cancel.clone()).await?;
                Ok(remote_answer(outcome, "git fetch --all --prune"))
            }
            GitRequest::Pull { mode } => {
                let mode = match mode {
                    Some(mode) => mode,
                    None => self.hub.git_settings(&self.place.project).await.pull_mode,
                };
                let outcome = remote::pull(
                    &self.reader,
                    writer,
                    mode,
                    self.progress(),
                    self.cancel.clone(),
                )
                .await?;
                self.hub.forget_root(&self.reader.repo.root);
                Ok(remote_answer(outcome, "git pull"))
            }
            GitRequest::Push {
                target,
                force,
                expect,
            } => self.push(writer, target, force == Some(true), expect).await,
            GitRequest::Continue => self.sequence(writer, Sequencer::Continue).await,
            GitRequest::Abort => self.sequence(writer, Sequencer::Abort).await,
            GitRequest::Skip => self.sequence(writer, Sequencer::Skip).await,
            other => self.history(writer, other).await,
        }
    }

    async fn hunk(
        &self,
        writer: &Writer,
        hunk: &GitHunkRef,
        action: HunkAction,
    ) -> std::result::Result<Answer, GitError> {
        match index::apply_hunk(&self.reader, writer, hunk, action).await? {
            HunkOutcome::Applied => Ok(Ok(GitOpResult::default())),
            HunkOutcome::Stale => Ok(Err(GitFailure::of(GitFailureKind::Stale))),
        }
    }

    async fn rollback_hunk(
        &self,
        writer: &Writer,
        hunk: &GitHunkRef,
    ) -> std::result::Result<Answer, GitError> {
        let Some(store) = self.hub.snapshot_store() else {
            return Ok(fail(GitFailureKind::Failed, "checkpoints are not open"));
        };
        let root = self.reader.repo.root.clone();
        let mut files =
            restore::snapshot(&self.reader, &store, std::slice::from_ref(&hunk.path)).await?;
        if index::apply_hunk(&self.reader, writer, hunk, HunkAction::Rollback).await?
            == HunkOutcome::Stale
        {
            return Ok(Err(GitFailure::of(GitFailureKind::Stale)));
        }
        restore::settle(&root, &mut files);
        self.hub.forget_paths(&[root.join(&hunk.path)]);
        let id = self.keep(files);
        self.audit("rollback", json!({ "paths": 1, "hunk": true }))
            .await;
        Ok(Ok(GitOpResult {
            restore_id: Some(id),
            ..GitOpResult::default()
        }))
    }

    async fn rollback(
        &self,
        writer: &Writer,
        paths: &[String],
    ) -> std::result::Result<Answer, GitError> {
        let Some(store) = self.hub.snapshot_store() else {
            return Ok(fail(GitFailureKind::Failed, "checkpoints are not open"));
        };
        let root = self.reader.repo.root.clone();
        let mut files = restore::snapshot(&self.reader, &store, paths).await?;
        let in_head = self.reader.in_head(paths).await?;
        let (tracked, other): (Vec<String>, Vec<String>) =
            paths.iter().cloned().partition(|p| in_head.contains(p));
        if !tracked.is_empty() {
            retry(|| {
                index::with_paths(
                    writer,
                    &["restore", "--source=HEAD", "--staged", "--worktree"],
                    &tracked,
                )
            })
            .await?;
        }
        if !other.is_empty() {
            retry(|| index::unstage(writer, &other, true)).await?;
            for path in &other {
                match std::fs::remove_file(root.join(path)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(GitError::Wait(e)),
                }
            }
        }
        restore::settle(&root, &mut files);
        let touched: Vec<PathBuf> = paths.iter().map(|p| root.join(p)).collect();
        self.hub.forget_paths(&touched);
        let id = self.keep(files);
        self.audit("rollback", json!({ "paths": paths.len() }))
            .await;
        Ok(Ok(GitOpResult {
            restore_id: Some(id),
            ..GitOpResult::default()
        }))
    }

    fn keep(&self, files: Vec<restore::RestoredFile>) -> String {
        self.hub.git_state().restores.insert(Restore {
            session: self.session.to_owned(),
            root: self.reader.repo.root.clone(),
            files,
        })
    }

    async fn undo(&self, writer: &Writer, id: &str) -> std::result::Result<Answer, GitError> {
        let (Some(record), Some(store)) = (
            self.hub.git_state().restores.take(id, self.session),
            self.hub.snapshot_store(),
        ) else {
            return Ok(fail(
                GitFailureKind::Stale,
                "this rollback can no longer be undone",
            ));
        };
        // Nothing is written back unless every file still holds what the rollback left; the
        // record stays for another try (SPEC B1.6).
        let changed: Vec<String> = record
            .files
            .iter()
            .filter(|file| !restore::unchanged_since(&record.root, file))
            .map(|file| file.path.clone())
            .collect();
        if !changed.is_empty() {
            self.hub.git_state().restores.put_back(id, record);
            let mut failure = GitFailure::of(GitFailureKind::Stale);
            failure.paths = changed;
            return Ok(Err(failure));
        }
        let mut changed = Vec::new();
        for file in &record.files {
            let session = self.session.to_owned();
            let hub = self.hub;
            let put_back = |path: &Path, expected: Option<[u8; 32]>, content: Option<&[u8]>| {
                hub.put_back(&session, path, expected, content)
            };
            match restore::write_back(&record.root, &store, file, &put_back) {
                Ok(true) => restore::restore_entry(writer, file).await?,
                Ok(false) => changed.push(file.path.clone()),
                Err(reason) => return Ok(fail(GitFailureKind::Failed, reason)),
            }
        }
        let touched: Vec<PathBuf> = record
            .files
            .iter()
            .map(|f| record.root.join(&f.path))
            .collect();
        self.hub.forget_paths(&touched);
        if changed.is_empty() {
            Ok(Ok(GitOpResult::default()))
        } else {
            let mut failure = GitFailure::of(GitFailureKind::Stale);
            failure.paths = changed;
            Ok(Err(failure))
        }
    }

    async fn commit(
        &self,
        writer: &Writer,
        message: &str,
        amend: bool,
        signoff: bool,
    ) -> std::result::Result<Answer, GitError> {
        if !commit::has_identity(writer).await? {
            return Ok(Err(identity_failure()));
        }
        if !amend && !commit::has_staged(&self.reader).await? {
            return Ok(Err(GitFailure::of(GitFailureKind::NothingToCommit)));
        }
        // Another git holding the index lock gets the same two retries as the index writes.
        let mut tries = 0;
        let outcome = loop {
            let outcome =
                commit::commit(writer, message, amend, signoff, self.cancel.clone()).await?;
            if !matches!(outcome, CommitOutcome::Locked) || tries == 2 {
                break outcome;
            }
            tries += 1;
            tokio::time::sleep(Duration::from_millis(300)).await;
        };
        Ok(match outcome {
            CommitOutcome::Committed {
                head,
                subject,
                output,
            } => Ok(GitOpResult {
                head: Some(head),
                subject: Some(subject),
                output: Some(clean(&output)).filter(|o| !o.is_empty()),
                ..GitOpResult::default()
            }),
            CommitOutcome::Identity => Err(identity_failure()),
            CommitOutcome::Locked => Err(GitFailure::of(GitFailureKind::Busy)),
            CommitOutcome::NothingToCommit => Err(GitFailure::of(GitFailureKind::NothingToCommit)),
            CommitOutcome::HookFailed(out) => fail(GitFailureKind::HookFailed, out),
            CommitOutcome::Failed(out) => fail(GitFailureKind::Failed, out),
        })
    }

    async fn checkout(
        &self,
        writer: &Writer,
        target: &str,
        mode: GitCheckoutMode,
    ) -> std::result::Result<Answer, GitError> {
        let outcome = branches::checkout(&self.reader, writer, target, mode).await?;
        self.hub.forget_root(&self.reader.repo.root);
        if mode == GitCheckoutMode::Force {
            self.audit("forceCheckout", json!({ "target": target }))
                .await;
        }
        let with_paths = |kind, paths: Vec<String>| {
            let mut failure = GitFailure::of(kind);
            failure.paths = paths;
            Err(failure)
        };
        Ok(match outcome {
            CheckoutOutcome::Done => Ok(GitOpResult::default()),
            CheckoutOutcome::LocalChanges(paths) => with_paths(GitFailureKind::LocalChanges, paths),
            CheckoutOutcome::Untracked(paths) => {
                with_paths(GitFailureKind::UntrackedOverwritten, paths)
            }
            CheckoutOutcome::InOtherWorktree(path) => fail(GitFailureKind::InOtherWorktree, path),
            CheckoutOutcome::Conflicts { stash, paths } => Ok(GitOpResult {
                kept_stash: Some(stash),
                conflicts: paths,
                ..GitOpResult::default()
            }),
        })
    }

    async fn delete(
        &self,
        writer: &Writer,
        name: &str,
        force: bool,
    ) -> std::result::Result<Answer, GitError> {
        if piarc_git::worktree::head_branch(&self.reader.repo.root).as_deref() == Some(name) {
            return Ok(fail(
                GitFailureKind::Invalid,
                "the current branch cannot be deleted",
            ));
        }
        match branches::delete(&self.reader, writer, name, force).await? {
            DeleteOutcome::NotMerged => Ok(Err(GitFailure::of(GitFailureKind::NotMerged))),
            DeleteOutcome::Deleted(deleted) => {
                self.audit(
                    "deleteBranch",
                    json!({ "branch": name, "oid": deleted.oid, "force": force }),
                )
                .await;
                Ok(Ok(GitOpResult {
                    deleted: Some(deleted),
                    ..GitOpResult::default()
                }))
            }
        }
    }

    async fn sequence(
        &self,
        writer: &Writer,
        action: Sequencer,
    ) -> std::result::Result<Answer, GitError> {
        let outcome = remote::sequence(&self.reader, writer, action).await?;
        self.hub.forget_root(&self.reader.repo.root);
        Ok(remote_answer(outcome, ""))
    }

    /// Where a push of the current branch goes: the first push's target, else the upstream.
    async fn push_spec(
        &self,
        target: Option<GitPushTarget>,
    ) -> std::result::Result<std::result::Result<(String, PushSpec), GitFailure>, GitError> {
        let Some(local) = piarc_git::worktree::head_branch(&self.reader.repo.root) else {
            return Ok(Err(GitFailure::new(
                GitFailureKind::Invalid,
                "HEAD is detached",
            )));
        };
        if let Some(target) = target {
            return Ok(Ok((
                local,
                PushSpec {
                    remote: target.remote,
                    branch: target.branch,
                    set_upstream: true,
                    lease: None,
                },
            )));
        }
        let remotes = piarc_git::refs::remotes(&self.reader).await?;
        let Some(upstream) = branches::upstream_of(&self.reader, &local).await? else {
            return Ok(Err(GitFailure::of(GitFailureKind::NoUpstream)));
        };
        let Some(remote) = remotes
            .iter()
            .find(|r| upstream.starts_with(&format!("{r}/")))
            .cloned()
        else {
            return Ok(Err(GitFailure::of(GitFailureKind::NoUpstream)));
        };
        let branch = upstream[remote.len() + 1..].to_owned();
        Ok(Ok((
            local,
            PushSpec {
                remote,
                branch,
                set_upstream: false,
                lease: None,
            },
        )))
    }

    async fn push(
        &self,
        writer: &Writer,
        target: Option<GitPushTarget>,
        force: bool,
        expect: Option<String>,
    ) -> std::result::Result<Answer, GitError> {
        let (local, mut spec) = match self.push_spec(target).await? {
            Ok(found) => found,
            Err(failure) => return Ok(Err(failure)),
        };
        let remotes = piarc_git::refs::remotes(&self.reader).await?;
        if let Err(e) = args::check_remote(&spec.remote, &remotes) {
            return Ok(Err(bad(&e)));
        }
        let settings = self.hub.git_settings(&self.place.project).await;
        let protected = is_protected(&local, &settings.protected)
            || is_protected(&spec.branch, &settings.protected);
        // An explicit force push of a protected branch is refused; "always force push" leaves
        // protected branches to plain pushes (SPEC A8.2, B4.3).
        if force && protected {
            return Ok(Err(GitFailure::of(GitFailureKind::Protected)));
        }
        let forced = force || (settings.always_force_push && !protected);
        if forced {
            let lease = match expect {
                Some(oid) => oid,
                None => self
                    .reader
                    .tracking_oid(&spec.remote, &spec.branch)
                    .await?
                    .unwrap_or_default(),
            };
            spec.lease = Some(lease);
        }
        let outcome = remote::push(writer, &spec, self.progress(), self.cancel.clone()).await?;
        let command = format!("git push {} HEAD:refs/heads/{}", spec.remote, spec.branch);
        let done = matches!(outcome, RemoteOutcome::Done(_));
        self.audit(
            if forced { "forcePush" } else { "push" },
            json!({ "remote": spec.remote, "branch": spec.branch, "lease": spec.lease, "ok": done }),
        )
        .await;
        Ok(remote_answer(outcome, &command))
    }

    async fn describe(&self, action: GitDescribe) -> std::result::Result<GitDescription, GitError> {
        let mut description = GitDescription::default();
        match action {
            GitDescribe::Rollback { paths } => description.paths = paths,
            GitDescribe::RollbackHunk { hunk } => description.paths = vec![hunk.path],
            GitDescribe::DeleteBranch { name } => {
                description.unmerged = Some(branches::unmerged_count(&self.reader, &name).await?);
                description.branch = Some(name);
            }
            GitDescribe::ForceCheckout { target } => {
                description.paths = self.reader.changed_tracked().await?;
                description.branch = Some(target);
            }
            GitDescribe::Reset { .. }
            | GitDescribe::StashDrop { .. }
            | GitDescribe::DeleteRemoteBranch { .. } => {
                return self.describe_history(action).await;
            }
            GitDescribe::ForcePush { target } => match self.push_spec(target).await? {
                Err(failure) => description.refused = Some(failure),
                Ok((local, spec)) => {
                    let protected = self.hub.git_settings(&self.place.project).await.protected;
                    if is_protected(&local, &protected) || is_protected(&spec.branch, &protected) {
                        description.refused = Some(GitFailure::of(GitFailureKind::Protected));
                    }
                    description.remote_oid =
                        self.reader.tracking_oid(&spec.remote, &spec.branch).await?;
                    description.local_oid = self.reader.repo_head().await?;
                    description.branch = Some(spec.branch);
                    description.remote = Some(spec.remote);
                }
            },
        }
        Ok(description)
    }

    /// Progress events of this operation on `core/git`, at most ten a second.
    pub(super) fn progress(&self) -> Option<Progress> {
        let op_id = self.op_id.clone()?;
        let hub = self.hub.clone();
        let session = self.session.to_owned();
        let last: Arc<Mutex<Seen>> = Arc::default();
        Some(Arc::new(move |line: &str| {
            let Some((phase, percent)) = remote::parse_progress(line) else {
                return;
            };
            let mut seen = last
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let quiet = seen
                .0
                .is_some_and(|t| t.elapsed() < Duration::from_millis(100));
            if quiet && seen.1 == phase && percent != Some(100) {
                return;
            }
            *seen = (Some(Instant::now()), phase.clone(), percent);
            hub.git_event(&GitEvent::Progress {
                session_id: session.clone(),
                op_id: op_id.clone(),
                phase,
                percent,
            });
        }))
    }

    pub(super) async fn audit(&self, action: &str, detail: Value) {
        let mut detail = detail;
        if let Some(object) = detail.as_object_mut() {
            object.insert("action".into(), Value::String(action.to_owned()));
            object.insert(
                "repository".into(),
                Value::String(piarc_fs::display(&self.reader.repo.root)),
            );
        }
        self.hub
            .audit_git(self.session, &self.place.project, detail)
            .await;
    }
}

/// A remote outcome as an answer; `command` is offered after a credential failure.
pub(super) fn remote_answer(outcome: RemoteOutcome, command: &str) -> Answer {
    match outcome {
        RemoteOutcome::Done(_) => Ok(GitOpResult::default()),
        RemoteOutcome::Conflict(paths) => Ok(GitOpResult {
            conflicts: paths,
            ..GitOpResult::default()
        }),
        RemoteOutcome::Auth(words) => {
            let mut failure = GitFailure::new(GitFailureKind::Auth, clean(&words));
            failure.command = Some(command.to_owned()).filter(|c| !c.is_empty());
            Err(failure)
        }
        RemoteOutcome::Rejected(words) => fail(GitFailureKind::Rejected, words),
        RemoteOutcome::StaleLease(words) => fail(GitFailureKind::StaleLease, words),
        RemoteOutcome::HookRejected(words) => fail(GitFailureKind::HookFailed, words),
        RemoteOutcome::NoUpstream => Err(GitFailure::of(GitFailureKind::NoUpstream)),
        RemoteOutcome::ChoosePullMode => Err(GitFailure::of(GitFailureKind::ChoosePullMode)),
        RemoteOutcome::Failed(words) => fail(GitFailureKind::Failed, words),
    }
}

/// Retries a write twice when another git process holds the index lock (ADR-0085 rule 5).
async fn retry<F, Fut>(mut run: F) -> std::result::Result<(), GitError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<(), GitError>>,
{
    let mut tries = 0;
    loop {
        match run().await {
            Err(GitError::Failed { stderr, .. }) if stderr.contains("index.lock") && tries < 2 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            other => return other,
        }
    }
}

/// No committer identity: the commands to set one, for the user to complete in a terminal.
fn identity_failure() -> GitFailure {
    let mut failure = GitFailure::of(GitFailureKind::Identity);
    failure.command = Some(
        "git config user.name \"Your Name\" && git config user.email \"you@example.com\""
            .to_owned(),
    );
    failure
}

/// Operations that rewrite files a running session may be working on.
fn rewrites_files(request: &GitRequest) -> bool {
    matches!(
        request,
        GitRequest::Checkout { .. }
            | GitRequest::Pull { .. }
            | GitRequest::Rollback { .. }
            | GitRequest::RollbackHunk { .. }
            | GitRequest::UndoRollback { .. }
            | GitRequest::Continue
            | GitRequest::Abort
            | GitRequest::Skip
            | GitRequest::CreateBranch {
                checkout: Some(true),
                start: Some(_),
                ..
            }
    ) || super::history::rewrites_files(request)
}

/// A push's target and expected remote object.
fn check_push(
    target: Option<&GitPushTarget>,
    expect: Option<&str>,
) -> std::result::Result<(), GitFailure> {
    if let Some(t) = target {
        args::check_branch_name(&t.branch).map_err(|e| bad(&e))?;
        if t.remote.starts_with('-') || t.remote.contains([':', '/', '\\']) {
            return Err(GitFailure::new(
                GitFailureKind::Invalid,
                "not a remote name",
            ));
        }
    }
    match expect {
        Some(oid) if !args::is_object_id(oid) => {
            Err(GitFailure::new(GitFailureKind::Invalid, "not an object id"))
        }
        _ => Ok(()),
    }
}

/// Commit instructions: at most 8,192 characters, as the settings page and the main process
/// count them.
fn check_instructions(instructions: &str) -> std::result::Result<(), GitFailure> {
    if instructions.chars().count() > 8 * 1024 {
        return Err(GitFailure::new(
            GitFailureKind::Invalid,
            "instructions are too long",
        ));
    }
    Ok(())
}

/// Checks every value a write request passes to git.
fn check(request: &GitRequest) -> std::result::Result<(), GitFailure> {
    let path = |p: &String| args::check_path(p).map_err(|e| bad(&e));
    let paths = |list: &[String]| {
        if list.is_empty() || list.len() > 10_000 {
            return Err(GitFailure::new(
                GitFailureKind::Invalid,
                "no or too many paths",
            ));
        }
        list.iter().try_for_each(path)
    };
    let branch = |name: &str| args::check_branch_name(name).map_err(|e| bad(&e));
    let rev = |name: &str| args::check_revision(name).map_err(|e| bad(&e));
    let hunk = |h: &GitHunkRef| path(&h.path);
    match request {
        GitRequest::Stage { paths: list }
        | GitRequest::Unstage { paths: list }
        | GitRequest::Rollback { paths: list }
        | GitRequest::MarkResolved { paths: list } => paths(list),
        GitRequest::StageHunk { hunk: h }
        | GitRequest::UnstageHunk { hunk: h }
        | GitRequest::RollbackHunk { hunk: h } => hunk(h),
        GitRequest::Commit { message, .. } => {
            if message.trim().is_empty() || message.len() > commit::MAX_MESSAGE {
                Err(GitFailure::new(
                    GitFailureKind::Invalid,
                    "empty or overlong message",
                ))
            } else {
                Ok(())
            }
        }
        GitRequest::Checkout { target, .. } => rev(target),
        GitRequest::CreateBranch { name, start, .. } => {
            branch(name)?;
            start.as_deref().map_or(Ok(()), rev)
        }
        GitRequest::RenameBranch { from, to } => branch(from).and_then(|()| branch(to)),
        GitRequest::DeleteBranch { name, .. } => branch(name),
        GitRequest::RestoreBranch {
            name,
            oid,
            upstream,
        } => {
            branch(name)?;
            if !args::is_object_id(oid) {
                return Err(GitFailure::new(GitFailureKind::Invalid, "not an object id"));
            }
            upstream.as_deref().map_or(Ok(()), rev)
        }
        GitRequest::SetUpstream {
            branch: b,
            upstream,
        } => {
            branch(b)?;
            upstream.as_deref().map_or(Ok(()), rev)
        }
        GitRequest::Push { target, expect, .. } => check_push(target.as_ref(), expect.as_deref()),
        GitRequest::CommitMessage { instructions, .. } => check_instructions(instructions),
        GitRequest::Describe { action } => match action {
            GitDescribe::Rollback { paths: list } => paths(list),
            GitDescribe::RollbackHunk { hunk: h } => hunk(h),
            GitDescribe::DeleteBranch { name } => branch(name),
            GitDescribe::ForceCheckout { target } => rev(target),
            GitDescribe::ForcePush { target } => {
                target.as_ref().map_or(Ok(()), |t| branch(&t.branch))
            }
            other => super::history::check_describe(other),
        },
        other => super::history::check(other),
    }
}

#[cfg(test)]
mod tests {
    use piarc_protocol::git::{GitLanguage, GitRequest};

    use super::check;

    fn message(instructions: String) -> GitRequest {
        GitRequest::CommitMessage {
            language: GitLanguage::SimplifiedChinese,
            instructions,
            amend: None,
        }
    }

    /// The settings page and the main process count characters; so does Core (8,192).
    #[test]
    fn instructions_are_limited_in_characters_not_bytes() {
        assert!(check(&message("中".repeat(8 * 1024))).is_ok());
        assert!(check(&message("中".repeat(8 * 1024 + 1))).is_err());
        assert!(check(&message("a".repeat(8 * 1024 + 1))).is_err());
    }
}
