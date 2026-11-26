//! Branch operations of the branch popup: checkout (refusing, stashing around, or discarding
//! local changes in the way), create, rename, delete with what "Restore" needs, and tracking.
//! Names and revisions are checked by the caller (`crate::args`).

use piarc_protocol::git::{GitCheckoutMode, GitDeletedBranch};

use crate::exec::{ExecOptions, ExecOutput, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::repo::{Reader, Writer, failed};

/// The stash message of a smart checkout.
const STASH_PREFIX: &str = "piarc: checkout";

/// What a checkout did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutOutcome {
    /// Done.
    Done,
    /// Local changes to these files would be overwritten.
    LocalChanges(Vec<String>),
    /// These untracked files would be overwritten.
    Untracked(Vec<String>),
    /// The branch is checked out in another worktree (its path when git names it).
    InOtherWorktree(String),
    /// A smart checkout restored the changes with conflicts; the stash is kept.
    Conflicts {
        /// `stash@{0}` and its message.
        stash: String,
        /// The conflicted files.
        paths: Vec<String>,
    },
}

/// How `target` is checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Local(String),
    /// A remote-tracking branch: `(remote/name, name)`.
    Remote(String, String),
    Detached(String),
}

async fn exists(reader: &Reader, reference: &str) -> Result<bool, GitError> {
    Ok(reader
        .run(&["show-ref", "--verify", "--quiet", reference], ExecOptions::default())
        .await?
        .success())
}

async fn resolve(reader: &Reader, target: &str) -> Result<Target, GitError> {
    if exists(reader, &format!("refs/heads/{target}")).await? {
        return Ok(Target::Local(target.to_owned()));
    }
    if exists(reader, &format!("refs/remotes/{target}")).await?
        && let Some((_, name)) = target.split_once('/')
    {
        if exists(reader, &format!("refs/heads/{name}")).await? {
            return Ok(Target::Local(name.to_owned()));
        }
        return Ok(Target::Remote(target.to_owned(), name.to_owned()));
    }
    let commit = format!("{target}^{{commit}}");
    reader
        .ok(&["rev-parse", "--verify", "--quiet", "--end-of-options", &commit])
        .await?;
    Ok(Target::Detached(target.to_owned()))
}

fn switch_args(target: &Target, discard: bool) -> Vec<String> {
    let mut args = vec!["switch".to_owned()];
    if discard {
        args.push("--discard-changes".to_owned());
    }
    match target {
        Target::Local(name) => args.extend(["--no-guess".into(), name.clone()]),
        Target::Remote(full, name) => {
            args.extend(["--track".into(), "-c".into(), name.clone(), full.clone()]);
        }
        Target::Detached(rev) => args.extend(["--detach".into(), rev.clone()]),
    }
    args
}

/// The tab-indented file list after `header` in git's message.
#[must_use]
pub fn listed_after(stderr: &str, header: &str) -> Vec<String> {
    let mut lines = stderr.lines().skip_while(|l| !l.contains(header));
    lines.next();
    lines
        .take_while(|l| l.starts_with('\t') || l.starts_with("        "))
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect()
}

fn outcome_of(out: &ExecOutput) -> Option<CheckoutOutcome> {
    if out.success() {
        return Some(CheckoutOutcome::Done);
    }
    let stderr = &out.stderr;
    let local = listed_after(stderr, "would be overwritten by checkout:");
    if stderr.contains("Your local changes to the following files would be overwritten") {
        return Some(CheckoutOutcome::LocalChanges(local));
    }
    if stderr.contains("untracked working tree files would be overwritten") {
        return Some(CheckoutOutcome::Untracked(listed_after(
            stderr,
            "would be overwritten by checkout:",
        )));
    }
    if stderr.contains("is already checked out at") || stderr.contains("is already used by worktree")
    {
        let path = stderr
            .split('\'')
            .nth(3)
            .or_else(|| stderr.split('\'').nth(1))
            .unwrap_or_default()
            .to_owned();
        return Some(CheckoutOutcome::InOtherWorktree(path));
    }
    None
}

/// Checks out `target` (a local or remote branch, a tag or a commit).
///
/// # Errors
///
/// The runners' errors; [`GitError::Failed`] for other refusals.
pub async fn checkout(
    reader: &Reader,
    writer: &Writer,
    target: &str,
    mode: GitCheckoutMode,
) -> Result<CheckoutOutcome, GitError> {
    let resolved = resolve(reader, target).await?;
    let options = || ExecOptions::timeout(WRITE_TIMEOUT);
    if mode == GitCheckoutMode::Smart {
        return smart(reader, writer, &resolved, target).await;
    }
    let args = switch_args(&resolved, mode == GitCheckoutMode::Force);
    let out = writer.run(&args, options()).await?;
    outcome_of(&out).ok_or_else(|| failed(&args, &out))
}

async fn stash_top(reader: &Reader) -> Result<Option<String>, GitError> {
    let out = reader
        .run(&["rev-parse", "--verify", "--quiet", "refs/stash"], ExecOptions::default())
        .await?;
    Ok(out
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()))
}

async fn smart(
    reader: &Reader,
    writer: &Writer,
    target: &Target,
    shown: &str,
) -> Result<CheckoutOutcome, GitError> {
    let from = crate::worktree::head_branch(&reader.repo.root).unwrap_or_else(|| "HEAD".into());
    let message = format!("{STASH_PREFIX} {from} → {shown}");
    let before = stash_top(reader).await?;
    let push = writer
        .run(&["stash", "push", "-m", &message], ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if !push.success() {
        return Err(failed(&["stash"], &push));
    }
    let stashed = stash_top(reader).await? != before;
    let args = switch_args(target, false);
    let out = writer.run(&args, ExecOptions::timeout(WRITE_TIMEOUT)).await?;
    if !out.success() {
        if stashed {
            let _ = writer
                .run(&["stash", "pop", "--index"], ExecOptions::timeout(WRITE_TIMEOUT))
                .await;
        }
        return outcome_of(&out).ok_or_else(|| failed(&args, &out));
    }
    if !stashed {
        return Ok(CheckoutOutcome::Done);
    }
    let pop = writer
        .run(&["stash", "pop"], ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if pop.success() {
        return Ok(CheckoutOutcome::Done);
    }
    let paths = conflicted(reader).await?;
    Ok(CheckoutOutcome::Conflicts {
        stash: format!("stash@{{0}} ({message})"),
        paths,
    })
}

/// The unmerged paths.
///
/// # Errors
///
/// The reader's errors.
pub async fn conflicted(reader: &Reader) -> Result<Vec<String>, GitError> {
    let out = reader
        .ok(&["diff", "--name-only", "-z", "--diff-filter=U", "--no-ext-diff"])
        .await?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect())
}

async fn run_ok(writer: &Writer, args: &[&str]) -> Result<(), GitError> {
    let out = writer.run(args, ExecOptions::timeout(WRITE_TIMEOUT)).await?;
    if out.success() {
        Ok(())
    } else {
        Err(failed(args, &out))
    }
}

/// Creates branch `name` at `start` (`HEAD` when absent), checking it out when asked.
///
/// # Errors
///
/// The writer's errors.
pub async fn create(
    writer: &Writer,
    name: &str,
    start: Option<&str>,
    checkout: bool,
) -> Result<(), GitError> {
    let mut args = if checkout {
        vec!["switch", "-c", name]
    } else {
        vec!["branch", "--end-of-options", name]
    };
    args.extend(start);
    run_ok(writer, &args).await
}

/// Renames local branch `from` to `to`.
///
/// # Errors
///
/// The writer's errors.
pub async fn rename(writer: &Writer, from: &str, to: &str) -> Result<(), GitError> {
    run_ok(writer, &["branch", "-m", "--end-of-options", from, to]).await
}

/// What deleting a branch did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteOutcome {
    /// Deleted; what "Restore" needs.
    Deleted(GitDeletedBranch),
    /// Not fully merged: deleting needs force.
    NotMerged,
}

/// Deletes local branch `name` (`force`: even when not fully merged).
///
/// # Errors
///
/// The runners' errors.
pub async fn delete(
    reader: &Reader,
    writer: &Writer,
    name: &str,
    force: bool,
) -> Result<DeleteOutcome, GitError> {
    let reference = format!("refs/heads/{name}");
    let oid = String::from_utf8_lossy(&reader.ok(&["rev-parse", "--verify", &reference]).await?)
        .trim()
        .to_owned();
    let upstream = upstream_of(reader, name).await?;
    let flag = if force { "-D" } else { "-d" };
    let out = writer
        .run(&["branch", flag, "--end-of-options", name], ExecOptions::default())
        .await?;
    if !out.success() {
        if out.stderr.contains("not fully merged") {
            return Ok(DeleteOutcome::NotMerged);
        }
        return Err(failed(&["branch"], &out));
    }
    Ok(DeleteOutcome::Deleted(GitDeletedBranch {
        name: name.to_owned(),
        oid,
        upstream,
    }))
}

/// The upstream of local branch `name` (`origin/x`).
///
/// # Errors
///
/// The reader's errors.
pub async fn upstream_of(reader: &Reader, name: &str) -> Result<Option<String>, GitError> {
    // `@{upstream}` takes the short name; `--verify` makes rev-parse honor `--end-of-options`.
    let spec = format!("{name}@{{upstream}}");
    let out = reader
        .run(
            &["rev-parse", "--abbrev-ref", "--verify", "--quiet", "--end-of-options", &spec],
            ExecOptions::default(),
        )
        .await?;
    Ok(out
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|u| !u.is_empty()))
}

/// Commits branch `name` has that neither `HEAD` nor its upstream has.
///
/// # Errors
///
/// The reader's errors.
pub async fn unmerged_count(reader: &Reader, name: &str) -> Result<u64, GitError> {
    let reference = format!("refs/heads/{name}");
    let mut args = vec![
        "rev-list".to_owned(),
        "--count".to_owned(),
        reference,
        "--not".to_owned(),
        "HEAD".to_owned(),
    ];
    if let Some(up) = upstream_of(reader, name).await? {
        args.push(format!("refs/remotes/{up}"));
    }
    let out = reader.ok(&args).await?;
    Ok(String::from_utf8_lossy(&out).trim().parse().unwrap_or(0))
}

/// Recreates branch `name` at `oid`, with its upstream.
///
/// # Errors
///
/// The writer's errors.
pub async fn restore(
    writer: &Writer,
    name: &str,
    oid: &str,
    upstream: Option<&str>,
) -> Result<(), GitError> {
    run_ok(writer, &["branch", "--end-of-options", name, oid]).await?;
    if let Some(up) = upstream {
        set_upstream(writer, name, Some(up)).await?;
    }
    Ok(())
}

/// Sets (or unsets) the upstream of local branch `branch`.
///
/// # Errors
///
/// The writer's errors.
pub async fn set_upstream(
    writer: &Writer,
    branch: &str,
    upstream: Option<&str>,
) -> Result<(), GitError> {
    match upstream {
        Some(up) => {
            let flag = format!("--set-upstream-to={up}");
            run_ok(writer, &["branch", &flag, "--end-of-options", branch]).await
        }
        None => run_ok(writer, &["branch", "--unset-upstream", "--end-of-options", branch]).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overwritten_file_lists() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\
\ta.txt\n\tdir/b.txt\nPlease commit your changes or stash them before you switch branches.\nAborting";
        assert_eq!(
            listed_after(stderr, "would be overwritten by checkout:"),
            ["a.txt", "dir/b.txt"]
        );
    }
}
