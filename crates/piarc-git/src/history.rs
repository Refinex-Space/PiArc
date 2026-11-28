//! The log view (G3): pages of history with parents and references for the graph, one commit in
//! full, and the commit operations (tag, cherry-pick, revert, reset, undo the last commit).
//! Values are checked by the caller (`args`); every revision goes after `--end-of-options`.

use piarc_protocol::git::{
    GitCommitDetail, GitLog, GitLogCommit, GitLogRevs, GitRefKind, GitRefLabel, GitResetMode,
};

use crate::exec::{ExecOptions, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::remote::RemoteOutcome;
use crate::repo::{Reader, Writer, failed};

/// The most commits in one page.
pub const PAGE: u64 = 200;

/// The fields of one log record: id, parents, author, address, time, subject, decorations.
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D";

/// Parses `log -z --decorate=full` records of [`LOG_FORMAT`].
#[must_use]
pub fn parse_log(out: &[u8]) -> Vec<GitLogCommit> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            let f: Vec<&str> = record.splitn(7, '\u{1f}').collect();
            (f.len() == 7 && !f[0].is_empty()).then(|| GitLogCommit {
                sha: f[0].to_owned(),
                parents: f[1].split_whitespace().map(str::to_owned).collect(),
                author: f[2].to_owned(),
                email: f[3].to_owned(),
                time: f[4].parse().unwrap_or(0),
                subject: f[5].to_owned(),
                refs: parse_decorations(f[6]),
            })
        })
        .collect()
}

/// Parses `%D` under `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1,
/// refs/remotes/origin/main`. Remote `HEAD` pointers and the stash are left out.
#[must_use]
pub fn parse_decorations(text: &str) -> Vec<GitRefLabel> {
    let mut labels = Vec::new();
    for part in text.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        if let Some(branch) = part.strip_prefix("HEAD -> ") {
            if let Some(name) = branch.strip_prefix("refs/heads/") {
                labels.push(label(GitRefKind::Local, name, true));
            }
            continue;
        }
        if part == "HEAD" {
            labels.push(label(GitRefKind::Head, "HEAD", false));
        } else if let Some(name) = part.strip_prefix("tag: refs/tags/") {
            labels.push(label(GitRefKind::Tag, name, false));
        } else if let Some(name) = part.strip_prefix("refs/heads/") {
            labels.push(label(GitRefKind::Local, name, false));
        } else if let Some(name) = part.strip_prefix("refs/remotes/") {
            if !name.ends_with("/HEAD") {
                labels.push(label(GitRefKind::Remote, name, false));
            }
        } else if let Some(name) = part.strip_prefix("refs/tags/") {
            labels.push(label(GitRefKind::Tag, name, false));
        }
    }
    labels
}

fn label(kind: GitRefKind, name: &str, current: bool) -> GitRefLabel {
    GitRefLabel {
        kind,
        name: name.to_owned(),
        current: current.then_some(true),
    }
}

/// One page of `revs` (`name` of a `ref` checked by the caller), newest first in topological
/// order. `text` matches the message (any case) or, when it looks like one, an id prefix.
///
/// # Errors
///
/// The reader's errors.
pub async fn log(
    reader: &Reader,
    revs: &GitLogRevs,
    skip: u64,
    limit: u64,
    text: Option<&str>,
    author: Option<&str>,
) -> Result<GitLog, GitError> {
    if reader.repo_head().await?.is_none() && !matches!(revs, GitLogRevs::All) {
        return Ok(GitLog {
            commits: Vec::new(),
            more: false,
        });
    }
    let limit = limit.clamp(1, PAGE);
    let text = text.map(str::trim).filter(|t| !t.is_empty());
    let author = author.map(str::trim).filter(|t| !t.is_empty());
    let mut args: Vec<String> = [
        "log",
        "--no-show-signature",
        "-z",
        "--topo-order",
        "--decorate=full",
        LOG_FORMAT,
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(format!("--skip={skip}"));
    args.push(format!("--max-count={}", limit + 1));
    if text.is_some() || author.is_some() {
        args.extend(["--fixed-strings", "--regexp-ignore-case"].map(str::to_owned));
    }
    if let Some(text) = text {
        args.push(format!("--grep={text}"));
    }
    if let Some(author) = author {
        args.push(format!("--author={author}"));
    }
    match revs {
        GitLogRevs::Head => args.extend(["--end-of-options", "HEAD"].map(str::to_owned)),
        GitLogRevs::All => {
            args.extend(["--branches", "--remotes", "--tags"].map(str::to_owned));
            if reader.repo_head().await?.is_some() {
                args.extend(["--end-of-options", "HEAD"].map(str::to_owned));
            }
        }
        GitLogRevs::Ref { name } => {
            args.extend(["--end-of-options".to_owned(), name.clone()]);
        }
    }
    let out = reader.ok(&args).await?;
    let mut commits = parse_log(&out);
    // An id prefix is looked up once, on the first page, and shown first.
    if skip == 0
        && let Some(prefix) = text.filter(|t| t.len() >= 4 && crate::args::is_object_id(t))
        && let Some(found) = by_id(reader, prefix).await?
        && !commits.iter().any(|c| c.sha == found.sha)
    {
        commits.insert(0, found);
    }
    let more = commits.len() as u64 > limit;
    commits.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    Ok(GitLog { commits, more })
}

/// The commit an id prefix names, when it names exactly one.
async fn by_id(reader: &Reader, prefix: &str) -> Result<Option<GitLogCommit>, GitError> {
    let object = format!("{prefix}^{{commit}}");
    let found = reader
        .run(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &object,
            ],
            ExecOptions::default(),
        )
        .await?;
    if !found.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&found.stdout).trim().to_owned();
    let out = reader
        .ok(&[
            "log",
            "--no-show-signature",
            "-z",
            "--decorate=full",
            "--max-count=1",
            LOG_FORMAT,
            "--end-of-options",
            &sha,
        ])
        .await?;
    Ok(parse_log(&out).into_iter().next())
}

/// One commit in full; `None` when `sha` names none.
///
/// # Errors
///
/// The reader's errors.
pub async fn commit_detail(
    reader: &Reader,
    sha: &str,
) -> Result<Option<GitCommitDetail>, GitError> {
    let object = format!("{sha}^{{commit}}");
    let out = reader
        .run(
            &[
                "show",
                "-s",
                "--no-show-signature",
                "--decorate=full",
                "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%D%x00%B",
                "--end-of-options",
                &object,
            ],
            ExecOptions::default(),
        )
        .await?;
    if !out.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let f: Vec<&str> = text.splitn(10, '\0').collect();
    if f.len() < 10 {
        return Ok(None);
    }
    let sha = f[0].trim_start_matches('\n').to_owned();
    let in_head = is_ancestor(reader, &sha, "HEAD").await?;
    let pushed = match upstream(reader).await? {
        Some(upstream) => is_ancestor(reader, &sha, &upstream).await?,
        None => false,
    };
    Ok(Some(GitCommitDetail {
        parents: f[1].split_whitespace().map(str::to_owned).collect(),
        author: f[2].to_owned(),
        author_email: f[3].to_owned(),
        author_time: f[4].parse().unwrap_or(0),
        committer: f[5].to_owned(),
        committer_email: f[6].to_owned(),
        commit_time: f[7].parse().unwrap_or(0),
        refs: parse_decorations(f[8]),
        message: f[9].trim_end().to_owned(),
        sha,
        in_head,
        pushed,
    }))
}

/// Whether `ancestor` is reachable from `descendant`.
///
/// # Errors
///
/// The reader's errors.
pub async fn is_ancestor(
    reader: &Reader,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, GitError> {
    let out = reader
        .run(
            &[
                "merge-base",
                "--is-ancestor",
                "--end-of-options",
                ancestor,
                descendant,
            ],
            ExecOptions::default(),
        )
        .await?;
    Ok(out.success())
}

/// The current branch's upstream as a full ref name; `None` without one.
///
/// # Errors
///
/// The reader's errors.
pub async fn upstream(reader: &Reader) -> Result<Option<String>, GitError> {
    let out = reader
        .run(
            &[
                "rev-parse",
                "--symbolic-full-name",
                "--verify",
                "--quiet",
                "@{upstream}",
            ],
            ExecOptions::default(),
        )
        .await?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    Ok((out.success() && !name.is_empty()).then_some(name))
}

/// What a reset of the current branch to `sha` takes off it: the commits leaving, and how many
/// of them the upstream has.
///
/// # Errors
///
/// The reader's errors.
pub async fn leaving(reader: &Reader, sha: &str) -> Result<(u64, u64), GitError> {
    let not_sha = format!("^{sha}");
    let mut revs = vec!["HEAD".to_owned(), not_sha];
    let total = count(reader, &revs).await?;
    let pushed = match upstream(reader).await? {
        // The leaving commits the upstream has: all of them minus those only HEAD has.
        Some(upstream) => {
            revs.push(format!("^{upstream}"));
            total.saturating_sub(count(reader, &revs).await?)
        }
        None => 0,
    };
    Ok((total, pushed))
}

/// `rev-list --count <revs>`.
async fn count(reader: &Reader, revs: &[String]) -> Result<u64, GitError> {
    let mut args = vec!["rev-list", "--count", "--end-of-options"];
    args.extend(revs.iter().map(String::as_str));
    let out = reader.ok(&args).await?;
    Ok(String::from_utf8_lossy(&out).trim().parse().unwrap_or(0))
}

/// Tags `sha` as `name`, annotated with `message` when given.
///
/// # Errors
///
/// The writer's errors; [`GitError::Failed`] when the tag exists.
pub async fn create_tag(
    writer: &Writer,
    name: &str,
    sha: &str,
    message: Option<&str>,
) -> Result<(), GitError> {
    let mut args: Vec<&str> = vec!["tag"];
    let mut stdin = Vec::new();
    if let Some(message) = message {
        args.extend(["-a", "-F", "-"]);
        stdin = message.as_bytes().to_vec();
    }
    args.extend(["--end-of-options", name, sha]);
    let out = writer
        .run(
            &args,
            ExecOptions {
                timeout: Some(WRITE_TIMEOUT),
                stdin,
                ..ExecOptions::default()
            },
        )
        .await?;
    if out.success() {
        Ok(())
    } else {
        Err(failed(&args, &out))
    }
}

/// Applies (`cherry-pick`) or inverts (`revert`) one commit; a conflict leaves the operation
/// in progress.
///
/// # Errors
///
/// The runners' errors.
pub async fn pick(
    reader: &Reader,
    writer: &Writer,
    sha: &str,
    revert: bool,
) -> Result<RemoteOutcome, GitError> {
    let args = [
        "-c",
        "core.editor=true",
        if revert { "revert" } else { "cherry-pick" },
        "--no-edit",
        "--end-of-options",
        sha,
    ];
    let out = writer
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        return Ok(RemoteOutcome::Done(out.stderr.clone()));
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() {
        return Ok(RemoteOutcome::Conflict(conflicts));
    }
    // Local changes in the way, an empty pick, a merge commit: git's words say which.
    let words = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    // A pick that changes nothing stops with the operation in progress: nothing to keep.
    if !revert && words.contains("is now empty") {
        let abort = ["cherry-pick", "--abort"];
        writer
            .run(&abort, ExecOptions::timeout(WRITE_TIMEOUT))
            .await?;
    }
    Ok(RemoteOutcome::Failed(words.trim().to_owned()))
}

/// Moves the current branch to `sha` with `mode`.
///
/// # Errors
///
/// The writer's errors; [`GitError::Failed`] when `keep` would lose a local change.
pub async fn reset(writer: &Writer, sha: &str, mode: GitResetMode) -> Result<(), GitError> {
    let flag = match mode {
        GitResetMode::Soft => "--soft",
        GitResetMode::Mixed => "--mixed",
        GitResetMode::Hard => "--hard",
        GitResetMode::Keep => "--keep",
    };
    let args = ["reset", "--quiet", flag, "--end-of-options", sha];
    let out = writer
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        Ok(())
    } else {
        Err(failed(&args, &out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_carry_parents_and_references() {
        let out = b"aaaa\x1fbbbb cccc\x1fAda\x1fada@example.invalid\x1f1700000000\x1fMerge x\x1fHEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0\0\nbbbb\x1f\x1f\xe7\x8e\x8b\x1fw@example.invalid\x1f1700000100\x1ffirst\x1f\0";
        let rows = parse_log(out);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].parents, ["bbbb", "cccc"]);
        assert_eq!(
            rows[0].refs,
            [
                label(GitRefKind::Local, "main", true),
                label(GitRefKind::Remote, "origin/main", false),
                label(GitRefKind::Tag, "v1.0", false),
            ]
        );
        assert!(rows[1].parents.is_empty());
        assert_eq!(rows[1].author, "王");
        assert!(rows[1].refs.is_empty());
    }

    #[test]
    fn a_detached_head_is_its_own_label() {
        assert_eq!(
            parse_decorations("HEAD, refs/heads/feature/x"),
            [
                label(GitRefKind::Head, "HEAD", false),
                label(GitRefKind::Local, "feature/x", false),
            ]
        );
        assert!(parse_decorations("refs/stash").is_empty());
    }
}
