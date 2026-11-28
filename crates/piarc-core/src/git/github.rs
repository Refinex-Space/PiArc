//! GitHub through the user's `gh` (ADR-0085 rule 9, design addendum 9.3): the current branch's
//! pull request, opening one after pushing the branch when needed, and merging one. The
//! repository comes from the branch's remote; only `github.com` and the user's `GH_HOST` are
//! used. Nothing here runs `gh` in an untrusted project.

use piarc_git::gh::{self, GhOutcome, GhRepo};
use piarc_git::{GitError, Reader, Writer, branches};
use piarc_protocol::git::{
    GitDescription, GitFailure, GitFailureKind, GitHubState, GitMergeMethod, GitOpResult,
    GitPullRequestStatus, GitPushTarget,
};
use serde_json::json;

use super::write::{Answer, Context};
use crate::git::clean;
use crate::sessions::{Hub, Place};

/// The command that signs `gh` in.
const SIGN_IN: &str = "gh auth login";

/// Where the current branch's pull request lives.
struct Target {
    gh: piarc_git::Git,
    repo: GhRepo,
    /// The branch on the remote (the upstream's name, else the local name).
    head: String,
    /// The remote.
    remote: String,
    /// The local branch.
    local: String,
}

/// The current branch's remote: its upstream's, else the only one, else `origin`.
async fn remote_of(
    reader: &Reader,
    local: &str,
) -> std::result::Result<Option<(String, String)>, GitError> {
    let remotes = piarc_git::refs::remotes(reader).await?;
    if let Some(upstream) = branches::upstream_of(reader, local).await?
        && let Some(remote) = remotes
            .iter()
            .find(|r| upstream.starts_with(&format!("{r}/")))
    {
        return Ok(Some((
            remote.clone(),
            upstream[remote.len() + 1..].to_owned(),
        )));
    }
    let remote = match remotes.as_slice() {
        [only] => Some(only.clone()),
        _ => remotes.iter().find(|r| r.as_str() == "origin").cloned(),
    };
    Ok(remote.map(|r| (r, local.to_owned())))
}

/// The target of the current branch, or why there is none.
async fn target(
    hub: &Hub,
    place: &Place,
    reader: &Reader,
) -> std::result::Result<std::result::Result<Target, GitHubState>, GitError> {
    if !hub.trusted(&place.project).await {
        return Ok(Err(GitHubState::Untrusted));
    }
    let Some(local) = piarc_git::worktree::head_branch(&reader.repo.root) else {
        return Ok(Err(GitHubState::NoRemote));
    };
    let Some((remote, head)) = remote_of(reader, &local).await? else {
        return Ok(Err(GitHubState::NoRemote));
    };
    let url = String::from_utf8_lossy(&reader.ok(&["remote", "get-url", &remote]).await?)
        .trim()
        .to_owned();
    // A remote elsewhere is told apart before `gh` is looked for: without `gh` it is not on
    // GitHub either, and nothing should ask to install it.
    let (gh, gh_host) = hub.gh_runner(&place.root).await;
    let Some(repo) = gh::repo_of(&url).filter(|r| gh::known_host(&r.host, gh_host.as_deref()))
    else {
        return Ok(Err(GitHubState::NotGithub));
    };
    let Some(gh) = gh else {
        return Ok(Err(GitHubState::Missing));
    };
    Ok(Ok(Target {
        gh,
        repo,
        head,
        remote,
        local,
    }))
}

fn not_ready(state: GitHubState) -> GitFailure {
    match state {
        GitHubState::Missing => GitFailure::of(GitFailureKind::GhMissing),
        GitHubState::Untrusted => GitFailure::of(GitFailureKind::Untrusted),
        GitHubState::NoRemote => GitFailure::of(GitFailureKind::NoUpstream),
        _ => GitFailure::of(GitFailureKind::NotGithub),
    }
}

fn gh_failure<T>(outcome: GhOutcome<T>) -> std::result::Result<T, GitFailure> {
    match outcome {
        GhOutcome::Done(value) => Ok(value),
        GhOutcome::Auth(words) => {
            let mut failure = GitFailure::new(GitFailureKind::Auth, clean(&words));
            failure.command = Some(SIGN_IN.to_owned());
            Err(failure)
        }
        GhOutcome::Failed(words) => Err(GitFailure::new(GitFailureKind::Failed, clean(&words))),
    }
}

impl Hub {
    /// The current branch's pull request (`pullRequest`).
    pub(crate) async fn pull_request_status(
        &self,
        place: &Place,
        reader: &Reader,
        cancel: piarc_git::Cancel,
    ) -> std::result::Result<std::result::Result<GitPullRequestStatus, GitFailure>, GitError> {
        let found = match target(self, place, reader).await? {
            Ok(found) => found,
            Err(state) => {
                return Ok(Ok(GitPullRequestStatus {
                    gh: state,
                    repo: None,
                    pr: None,
                    command: None,
                }));
            }
        };
        let viewed = gh::pr_view(
            &found.gh,
            &reader.repo.root,
            &found.repo,
            &found.head,
            cancel,
        )
        .await?;
        Ok(match viewed {
            GhOutcome::Auth(_) => Ok(GitPullRequestStatus {
                gh: GitHubState::Unauthenticated,
                repo: Some(found.repo.short()),
                pr: None,
                command: Some(SIGN_IN.to_owned()),
            }),
            other => gh_failure(other).map(|pr| GitPullRequestStatus {
                gh: GitHubState::Ready,
                repo: Some(found.repo.short()),
                pr,
                command: None,
            }),
        })
    }
}

impl Context<'_> {
    /// Pushes the current branch when its remote lacks commits, then opens a pull request.
    pub(super) async fn create_pull_request(
        &self,
        writer: &Writer,
        title: &str,
        body: &str,
        base: &str,
        draft: bool,
    ) -> std::result::Result<Answer, GitError> {
        let found = match target(self.hub, self.place, &self.reader).await? {
            Ok(found) => found,
            Err(state) => return Ok(Err(not_ready(state))),
        };
        let upstream = branches::upstream_of(&self.reader, &found.local).await?;
        let pushed = match &upstream {
            None => Some(GitPushTarget {
                remote: found.remote.clone(),
                branch: found.head.clone(),
            }),
            Some(upstream) => {
                let range = format!("{upstream}..HEAD");
                let ahead = self
                    .reader
                    .ok(&["rev-list", "--count", "--end-of-options", &range])
                    .await?;
                let ahead: u64 = String::from_utf8_lossy(&ahead).trim().parse().unwrap_or(0);
                (ahead > 0).then(|| GitPushTarget {
                    remote: found.remote.clone(),
                    branch: found.head.clone(),
                })
            }
        };
        if let Some(target) = pushed {
            let first = upstream.is_none();
            if let Err(failure) = self
                .push(writer, first.then_some(target), false, None)
                .await?
            {
                return Ok(Err(failure));
            }
        }
        let created = gh::pr_create(
            &found.gh,
            &self.reader.repo.root,
            &found.repo,
            base,
            &found.head,
            title,
            body,
            draft,
            self.cancel.clone(),
        )
        .await?;
        let ok = matches!(created, GhOutcome::Done(_));
        self.audit(
            "createPullRequest",
            json!({ "repo": found.repo.short(), "base": base, "head": found.head, "draft": draft, "ok": ok }),
        )
        .await;
        Ok(gh_failure(created).map(|url| GitOpResult {
            url: Some(url),
            ..GitOpResult::default()
        }))
    }

    /// Merges pull request `number` on GitHub.
    pub(super) async fn merge_pull_request(
        &self,
        number: u64,
        method: GitMergeMethod,
    ) -> std::result::Result<Answer, GitError> {
        let found = match target(self.hub, self.place, &self.reader).await? {
            Ok(found) => found,
            Err(state) => return Ok(Err(not_ready(state))),
        };
        let merged = gh::pr_merge(
            &found.gh,
            &self.reader.repo.root,
            &found.repo,
            number,
            method,
            self.cancel.clone(),
        )
        .await?;
        let ok = matches!(merged, GhOutcome::Done(()));
        self.audit(
            "mergePullRequest",
            json!({ "repo": found.repo.short(), "number": number, "method": method, "ok": ok }),
        )
        .await;
        Ok(gh_failure(merged).map(|()| GitOpResult::default()))
    }

    /// The facts the merge confirmation shows: the pull request's title and base.
    pub(super) async fn describe_merge(
        &self,
        number: u64,
    ) -> std::result::Result<GitDescription, GitError> {
        let mut description = GitDescription::default();
        let status = self
            .hub
            .pull_request_status(self.place, &self.reader, self.cancel.clone())
            .await?;
        match status {
            Ok(GitPullRequestStatus {
                pr: Some(pr), repo, ..
            }) if pr.number == number => {
                description.message = Some(pr.title);
                description.branch = Some(pr.base);
                description.remote = repo;
            }
            Ok(_) => {
                description.refused = Some(GitFailure::new(
                    GitFailureKind::Stale,
                    "the branch's pull request changed",
                ));
            }
            Err(failure) => description.refused = Some(failure),
        }
        Ok(description)
    }
}

/// A pull request's title (one line, 1–256 characters), body (at most 64 KiB) and base branch.
fn check_pull_request(title: &str, body: &str, base: &str) -> std::result::Result<(), GitFailure> {
    let length = title.trim().chars().count();
    if length == 0 || length > 256 || title.chars().any(char::is_control) {
        return Err(GitFailure::new(
            GitFailureKind::Invalid,
            "the title must be one line",
        ));
    }
    if body.len() > 64 * 1024 || body.contains('\0') {
        return Err(GitFailure::new(
            GitFailureKind::Invalid,
            "the body is too long",
        ));
    }
    piarc_git::args::check_branch_name(base).map_err(|e| super::write::bad(&e))
}

/// Checks the values of a G5 request before git or `gh` sees them.
pub(super) fn check(
    request: &piarc_protocol::git::GitRequest,
) -> std::result::Result<(), GitFailure> {
    use piarc_protocol::git::GitRequest;
    let rev = |r: &str| piarc_git::args::check_revision(r).map_err(|e| super::write::bad(&e));
    match request {
        GitRequest::PrDescription {
            instructions, base, ..
        } => {
            super::write::check_instructions(instructions)?;
            base.as_deref().map_or(Ok(()), rev)
        }
        GitRequest::Review { scope, .. } => crate::sessions::check_scope(scope),
        GitRequest::CreatePullRequest {
            title, body, base, ..
        } => check_pull_request(title, body, base),
        GitRequest::MergePullRequest { number, .. } => {
            if *number == 0 {
                Err(GitFailure::new(
                    GitFailureKind::Invalid,
                    "no such pull request",
                ))
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}
