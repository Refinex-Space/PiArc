//! Fetch, pull and push for the sync bar (ADR-0085 rules 3 and 6), with git's progress,
//! push rejections and credential failures classified, and the operation in progress
//! continued, aborted or skipped.

use piarc_protocol::git::{GitPullMode, GitRepoState};

use crate::exec::{Cancel, ExecOptions, ExecOutput, NETWORK_TIMEOUT, Progress, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::repo::{Reader, Writer, failed};

/// What a remote operation came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteOutcome {
    /// Done; git's last words (redacted by the caller).
    Done(String),
    /// The remote refused the credentials or git needed to ask for them.
    Auth(String),
    /// The remote has commits the local branch lacks.
    Rejected(String),
    /// The lease failed: the remote moved since the last fetch.
    StaleLease(String),
    /// A hook (local or remote) refused.
    HookRejected(String),
    /// The branch has no upstream.
    NoUpstream,
    /// The branches diverged and no strategy is configured.
    ChoosePullMode,
    /// Stopped with conflicts.
    Conflict(Vec<String>),
    /// Anything else.
    Failed(String),
}

/// (phase, percent) of a progress line such as `Receiving objects:  45% (9/20)`.
#[must_use]
pub fn parse_progress(line: &str) -> Option<(String, Option<u64>)> {
    let line = line.trim().strip_prefix("remote:").map_or(line, str::trim);
    let (phase, rest) = line.split_once(':')?;
    let phase = phase.trim();
    if phase.is_empty() || phase.len() > 48 || !phase.chars().all(|c| c.is_alphabetic() || c == ' ')
    {
        return None;
    }
    let percent = rest
        .split_whitespace()
        .find_map(|w| w.strip_suffix('%'))
        .and_then(|n| n.parse().ok());
    Some((phase.to_owned(), percent))
}

fn network(progress: Option<Progress>, cancel: Cancel) -> ExecOptions {
    ExecOptions {
        timeout: Some(NETWORK_TIMEOUT),
        progress,
        cancel: Some(cancel),
        ..ExecOptions::default()
    }
}

fn words(out: &ExecOutput) -> String {
    format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr)
        .trim()
        .to_owned()
}

fn auth(out: &ExecOutput) -> bool {
    let lower = out.stderr.to_ascii_lowercase();
    [
        "permission denied (publickey",
        "authentication failed",
        "could not read username",
        "could not read password",
        "host key verification failed",
        "terminal prompts disabled",
        "invalid username or password",
        "returned error: 401",
        "returned error: 403",
    ]
    .iter()
    .any(|n| lower.contains(n))
}

/// Fetches every remote, pruning deleted branches.
///
/// # Errors
///
/// The writer's errors.
pub async fn fetch(
    writer: &Writer,
    progress: Option<Progress>,
    cancel: Cancel,
) -> Result<RemoteOutcome, GitError> {
    let out = writer
        .network(
            &["fetch", "--all", "--prune", "--progress"],
            network(progress, cancel),
        )
        .await?;
    Ok(if out.success() {
        RemoteOutcome::Done(words(&out))
    } else if auth(&out) {
        RemoteOutcome::Auth(words(&out))
    } else {
        RemoteOutcome::Failed(words(&out))
    })
}

/// Pulls into the current branch with `mode`.
///
/// # Errors
///
/// The runners' errors.
pub async fn pull(
    reader: &Reader,
    writer: &Writer,
    mode: GitPullMode,
    progress: Option<Progress>,
    cancel: Cancel,
) -> Result<RemoteOutcome, GitError> {
    let mut args = vec!["pull", "--progress"];
    match mode {
        GitPullMode::Config => {}
        GitPullMode::Merge => args.push("--no-rebase"),
        GitPullMode::Rebase => args.push("--rebase"),
        GitPullMode::FfOnly => args.push("--ff-only"),
    }
    let out = writer.network(&args, network(progress, cancel)).await?;
    if out.success() {
        return Ok(RemoteOutcome::Done(words(&out)));
    }
    let all = words(&out);
    let lower = all.to_ascii_lowercase();
    if lower.contains("there is no tracking information") {
        return Ok(RemoteOutcome::NoUpstream);
    }
    if lower.contains("need to specify how to reconcile divergent branches") {
        return Ok(RemoteOutcome::ChoosePullMode);
    }
    if auth(&out) {
        return Ok(RemoteOutcome::Auth(all));
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() || lower.contains("conflict") {
        return Ok(RemoteOutcome::Conflict(conflicts));
    }
    Ok(RemoteOutcome::Failed(all))
}

/// A push of `HEAD` to `remote`'s `branch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSpec {
    /// A configured remote.
    pub remote: String,
    /// The branch on the remote.
    pub branch: String,
    /// Record the upstream.
    pub set_upstream: bool,
    /// Force with this lease: the remote branch's expected commit (empty: it must not exist).
    pub lease: Option<String>,
}

/// The arguments of `spec`.
#[must_use]
pub fn push_args(spec: &PushSpec) -> Vec<String> {
    let mut args = vec!["push".to_owned(), "--porcelain".into(), "--progress".into()];
    if spec.set_upstream {
        args.push("--set-upstream".into());
    }
    if let Some(lease) = &spec.lease {
        args.push(format!(
            "--force-with-lease=refs/heads/{}:{lease}",
            spec.branch
        ));
        args.push("--force-if-includes".into());
    }
    args.push("--".into());
    args.push(spec.remote.clone());
    args.push(format!("HEAD:refs/heads/{}", spec.branch));
    args
}

/// Pushes `HEAD` as `spec` says.
///
/// # Errors
///
/// The writer's errors.
pub async fn push(
    writer: &Writer,
    spec: &PushSpec,
    progress: Option<Progress>,
    cancel: Cancel,
) -> Result<RemoteOutcome, GitError> {
    let args = push_args(spec);
    let out = writer.network(&args, network(progress, cancel)).await?;
    Ok(classify_push(&out))
}

/// The outcome of `push --porcelain`.
#[must_use]
pub fn classify_push(out: &ExecOutput) -> RemoteOutcome {
    let all = words(out);
    if out.success() {
        return RemoteOutcome::Done(all);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let rejected = stdout
        .lines()
        .find(|l| l.starts_with('!'))
        .unwrap_or_default();
    if rejected.contains("stale info") {
        RemoteOutcome::StaleLease(all)
    } else if rejected.contains("non-fast-forward") || rejected.contains("fetch first") {
        RemoteOutcome::Rejected(all)
    } else if rejected.contains("remote rejected") || out.stderr.contains("hook declined") {
        RemoteOutcome::HookRejected(all)
    } else if auth(out) {
        RemoteOutcome::Auth(all)
    } else if out.stderr.contains("pre-push") || out.stderr.contains("failed to push some refs") {
        RemoteOutcome::HookRejected(all)
    } else {
        RemoteOutcome::Failed(all)
    }
}

/// What to do with the operation in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sequencer {
    /// Continue it.
    Continue,
    /// Abort it.
    Abort,
    /// Skip the current commit (rebase only).
    Skip,
}

/// The command that does `action` for `state`; `None` when it does not apply.
#[must_use]
pub fn sequencer_args(state: &GitRepoState, action: Sequencer) -> Option<Vec<&'static str>> {
    let flag = match action {
        Sequencer::Continue => "--continue",
        Sequencer::Abort => "--abort",
        Sequencer::Skip => "--skip",
    };
    Some(match (state, action) {
        (GitRepoState::Rebasing { .. }, _) => vec!["rebase", flag],
        (GitRepoState::Merging { .. }, Sequencer::Continue) => vec!["commit", "--no-edit"],
        (GitRepoState::Merging { .. }, Sequencer::Abort) => vec!["merge", "--abort"],
        (GitRepoState::CherryPicking { .. }, Sequencer::Continue | Sequencer::Abort) => {
            vec!["cherry-pick", flag]
        }
        (GitRepoState::Reverting { .. }, Sequencer::Continue | Sequencer::Abort) => {
            vec!["revert", flag]
        }
        _ => return None,
    })
}

/// Continues, aborts or skips the operation in progress.
///
/// # Errors
///
/// The runners' errors; [`GitError::Failed`] when nothing is in progress.
pub async fn sequence(
    reader: &Reader,
    writer: &Writer,
    action: Sequencer,
) -> Result<RemoteOutcome, GitError> {
    let state = crate::status::repo_state(&reader.repo);
    let Some(args) = sequencer_args(&state, action) else {
        return Err(GitError::Failed {
            command: "sequence".into(),
            code: None,
            stderr: "no operation in progress".into(),
        });
    };
    let mut full = vec!["-c", "core.editor=true"];
    full.extend(&args);
    let out = writer
        .run(&full, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        return Ok(RemoteOutcome::Done(words(&out)));
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() {
        return Ok(RemoteOutcome::Conflict(conflicts));
    }
    Err(failed(&full, &out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (9/20), 1.2 MiB | 2.0 MiB/s"),
            Some(("Receiving objects".into(), Some(45)))
        );
        assert_eq!(
            parse_progress("remote: Counting objects: 100% (3/3), done."),
            Some(("Counting objects".into(), Some(100)))
        );
        assert_eq!(parse_progress("To /tmp/remote.git"), None);
    }

    #[test]
    fn push_arguments_use_a_lease_and_includes() {
        let args = push_args(&PushSpec {
            remote: "origin".into(),
            branch: "feature/x".into(),
            set_upstream: true,
            lease: Some("abc123".into()),
        });
        assert_eq!(
            args,
            [
                "push",
                "--porcelain",
                "--progress",
                "--set-upstream",
                "--force-with-lease=refs/heads/feature/x:abc123",
                "--force-if-includes",
                "--",
                "origin",
                "HEAD:refs/heads/feature/x"
            ]
        );
    }

    #[test]
    fn rejections() {
        let out = |stdout: &str, stderr: &str| ExecOutput {
            code: Some(1),
            stdout: stdout.as_bytes().to_vec(),
            truncated: false,
            stderr: stderr.into(),
        };
        assert!(matches!(
            classify_push(&out(
                "To r\n!\tHEAD:refs/heads/x\t[rejected] (non-fast-forward)\nDone",
                ""
            )),
            RemoteOutcome::Rejected(_)
        ));
        assert!(matches!(
            classify_push(&out(
                "To r\n!\tHEAD:refs/heads/x\t[rejected] (stale info)\nDone",
                ""
            )),
            RemoteOutcome::StaleLease(_)
        ));
        assert!(matches!(
            classify_push(&out("", "git@h: Permission denied (publickey).")),
            RemoteOutcome::Auth(_)
        ));
    }
}
