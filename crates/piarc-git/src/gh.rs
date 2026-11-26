//! GitHub through the user's own `gh` (ADR-0085 rule 9, design addendum 9.3): the repository a
//! remote URL names, the current branch's pull request, creating one, and merging one. Only the
//! subcommands below are ever built (`pr view`, `pr create`, `pr merge`); `--repo` comes from the
//! remote, values are attached to their flags (`--title=…`), and the body goes through stdin.

use std::path::Path;

use piarc_protocol::git::{GitChecks, GitMergeMethod, GitPrState, GitPullRequest};
use serde_json::Value;

use crate::exec::{Cancel, ExecOptions, NETWORK_TIMEOUT};
use crate::git::{Git, GitError};

/// The program's name on the `PATH`.
#[must_use]
pub fn program_name() -> &'static str {
    if cfg!(windows) { "gh.exe" } else { "gh" }
}

/// Where `gh` is: the first absolute `PATH` directory outside `exclude` that has it.
#[must_use]
pub fn find(path: &std::ffi::OsStr, exclude: Option<&Path>) -> Option<std::path::PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .filter_map(|dir| crate::canonical(&dir.join(program_name())).ok())
        .find(|p| p.is_file() && exclude.is_none_or(|root| !p.starts_with(root)))
}

/// A repository on a GitHub host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhRepo {
    /// `github.com`, or an Enterprise host.
    pub host: String,
    /// The owner.
    pub owner: String,
    /// The repository.
    pub name: String,
}

impl GhRepo {
    /// `HOST/OWNER/REPO`, as `--repo` takes it.
    #[must_use]
    pub fn spec(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.name)
    }

    /// `OWNER/REPO`.
    #[must_use]
    pub fn short(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

fn plain(part: &str) -> bool {
    !part.is_empty()
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !part.starts_with('-')
        && part != "."
        && part != ".."
}

/// The repository a remote URL names (`https://host/owner/name(.git)`,
/// `git@host:owner/name(.git)`, `ssh://git@host[:port]/owner/name(.git)`); `None` for other
/// shapes. User info is never kept.
#[must_use]
pub fn repo_of(url: &str) -> Option<GhRepo> {
    let url = url.trim();
    let (host, path) = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        (host.to_owned(), path.to_owned())
    } else {
        let (user_host, path) = url.split_once(':')?;
        let host = user_host.rsplit('@').next()?;
        if host.contains('/') {
            return None;
        }
        (host.to_owned(), path.to_owned())
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let host = host.to_ascii_lowercase();
    (plain(&host) && plain(owner) && plain(name) && !name.contains('/')).then(|| GhRepo {
        host,
        owner: owner.to_owned(),
        name: name.to_owned(),
    })
}

/// Whether `host` is one `gh` is used for: `github.com`, or the user's `GH_HOST`.
#[must_use]
pub fn known_host(host: &str, gh_host: Option<&str>) -> bool {
    host == "github.com" || gh_host.is_some_and(|h| h.eq_ignore_ascii_case(host))
}

/// What a `gh` run came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhOutcome<T> {
    /// It worked.
    Done(T),
    /// `gh` is not signed in to the host (its words).
    Auth(String),
    /// Anything else (its words).
    Failed(String),
}

fn options(stdin: Vec<u8>, cancel: Cancel) -> ExecOptions {
    ExecOptions {
        timeout: Some(NETWORK_TIMEOUT.min(std::time::Duration::from_mins(2))),
        stdin,
        cancel: Some(cancel),
        ..ExecOptions::default()
    }
}

fn words(out: &crate::exec::ExecOutput) -> String {
    format!("{}\n{}", out.stderr, String::from_utf8_lossy(&out.stdout))
        .trim()
        .to_owned()
}

fn is_auth(words: &str) -> bool {
    let lower = words.to_ascii_lowercase();
    lower.contains("gh auth login")
        || lower.contains("not logged into")
        || lower.contains("authentication required")
        || lower.contains("http 401")
        || lower.contains("bad credentials")
}

const PR_FIELDS: &str = "number,title,state,isDraft,url,baseRefName,headRefName,reviewDecision,mergeable,statusCheckRollup";

/// The pull request of `branch` in `repo`; `Done(None)` when it has none.
///
/// # Errors
///
/// The runner's errors.
pub async fn pr_view(
    gh: &Git,
    cwd: &Path,
    repo: &GhRepo,
    branch: &str,
    cancel: Cancel,
) -> Result<GhOutcome<Option<GitPullRequest>>, GitError> {
    let repo_flag = format!("--repo={}", repo.spec());
    let json = format!("--json={PR_FIELDS}");
    let args = ["pr", "view", &repo_flag, &json, "--", branch];
    let out = gh.exec(cwd, &args, options(Vec::new(), cancel)).await?;
    let said = words(&out);
    if !out.success() {
        if said.to_ascii_lowercase().contains("no pull requests found") {
            return Ok(GhOutcome::Done(None));
        }
        return Ok(if is_auth(&said) {
            GhOutcome::Auth(said)
        } else {
            GhOutcome::Failed(said)
        });
    }
    let value: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    Ok(GhOutcome::Done(pull_request_of(&value)))
}

/// A `gh pr view --json` object as a [`GitPullRequest`].
#[must_use]
pub fn pull_request_of(value: &Value) -> Option<GitPullRequest> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let state = match value.get("state").and_then(Value::as_str)? {
        "MERGED" => GitPrState::Merged,
        "CLOSED" => GitPrState::Closed,
        _ => GitPrState::Open,
    };
    let mut checks = GitChecks::default();
    for check in value
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let word = |key: &str| check.get(key).and_then(Value::as_str).unwrap_or_default();
        // A check run has a status and, once completed, a conclusion; a status context has a
        // state.
        let outcome = match (word("status"), word("conclusion"), word("state")) {
            (_, "SUCCESS" | "NEUTRAL" | "SKIPPED", _) | (_, _, "SUCCESS") => 0,
            (
                _,
                "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE",
                _,
            )
            | (_, _, "FAILURE" | "ERROR") => 1,
            _ => 2,
        };
        match outcome {
            0 => checks.passed += 1,
            1 => checks.failed += 1,
            _ => checks.pending += 1,
        }
    }
    Some(GitPullRequest {
        number: value.get("number").and_then(Value::as_u64)?,
        title: text("title").unwrap_or_default(),
        state,
        draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        url: text("url").unwrap_or_default(),
        base: text("baseRefName").unwrap_or_default(),
        head: text("headRefName").unwrap_or_default(),
        review_decision: text("reviewDecision").filter(|s| !s.is_empty()),
        checks,
        mergeable: text("mergeable").filter(|s| !s.is_empty()),
    })
}

/// A new pull request from `head` into `base` (both already on the remote); its page.
///
/// # Errors
///
/// The runner's errors.
#[expect(
    clippy::too_many_arguments,
    reason = "each is one field of the pull request"
)]
pub async fn pr_create(
    gh: &Git,
    cwd: &Path,
    repo: &GhRepo,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    cancel: Cancel,
) -> Result<GhOutcome<String>, GitError> {
    let flags = [
        format!("--repo={}", repo.spec()),
        format!("--base={base}"),
        format!("--head={head}"),
        format!("--title={title}"),
        "--body-file=-".to_owned(),
    ];
    let mut args: Vec<&str> = vec!["pr", "create"];
    args.extend(flags.iter().map(String::as_str));
    if draft {
        args.push("--draft");
    }
    let out = gh
        .exec(cwd, &args, options(body.as_bytes().to_vec(), cancel))
        .await?;
    let said = words(&out);
    if !out.success() {
        return Ok(if is_auth(&said) {
            GhOutcome::Auth(said)
        } else {
            GhOutcome::Failed(said)
        });
    }
    let url = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("https://"))
        .unwrap_or_default()
        .to_owned();
    Ok(GhOutcome::Done(url))
}

/// Merges pull request `number` of `repo` with `method`.
///
/// # Errors
///
/// The runner's errors.
pub async fn pr_merge(
    gh: &Git,
    cwd: &Path,
    repo: &GhRepo,
    number: u64,
    method: GitMergeMethod,
    cancel: Cancel,
) -> Result<GhOutcome<()>, GitError> {
    let repo_flag = format!("--repo={}", repo.spec());
    let number = number.to_string();
    let how = match method {
        GitMergeMethod::Merge => "--merge",
        GitMergeMethod::Squash => "--squash",
        GitMergeMethod::Rebase => "--rebase",
    };
    let args = ["pr", "merge", &repo_flag, how, "--", &number];
    let out = gh.exec(cwd, &args, options(Vec::new(), cancel)).await?;
    let said = words(&out);
    Ok(if out.success() {
        GhOutcome::Done(())
    } else if is_auth(&said) {
        GhOutcome::Auth(said)
    } else {
        GhOutcome::Failed(said)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls_name_repositories_without_user_info() {
        let repo = |host: &str| GhRepo {
            host: host.into(),
            owner: "octo".into(),
            name: "app".into(),
        };
        assert_eq!(
            repo_of("https://github.com/octo/app.git"),
            Some(repo("github.com"))
        );
        assert_eq!(
            repo_of("https://user:token@github.com/octo/app"),
            Some(repo("github.com"))
        );
        assert_eq!(
            repo_of("git@github.com:octo/app.git"),
            Some(repo("github.com"))
        );
        assert_eq!(
            repo_of("ssh://git@GHE.example.com:2222/octo/app.git"),
            Some(repo("ghe.example.com"))
        );
        for bad in [
            "/srv/git/app.git",
            "file:///srv/app.git",
            "https://github.com/octo",
            "https://github.com/octo/app/extra",
            "git@github.com:--upload-pack=x/app",
        ] {
            assert_eq!(repo_of(bad), None, "{bad}");
        }
        assert_eq!(repo("github.com").spec(), "github.com/octo/app");
    }

    #[test]
    fn pull_requests_summarise_their_checks() {
        let value = serde_json::json!({
            "number": 12,
            "title": "Add login",
            "state": "OPEN",
            "isDraft": true,
            "url": "https://github.com/octo/app/pull/12",
            "baseRefName": "main",
            "headRefName": "feature/login",
            "reviewDecision": "",
            "mergeable": "MERGEABLE",
            "statusCheckRollup": [
                { "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "status": "COMPLETED", "conclusion": "FAILURE" },
                { "status": "IN_PROGRESS", "conclusion": "" },
                { "state": "PENDING" },
                { "state": "SUCCESS" }
            ]
        });
        let pr = pull_request_of(&value).expect("pr");
        assert_eq!(pr.number, 12);
        assert!(pr.draft);
        assert_eq!(pr.review_decision, None);
        assert_eq!(
            pr.checks,
            GitChecks {
                passed: 2,
                failed: 1,
                pending: 2
            }
        );
    }
}
