//! Extension packages from git (T40, ADR-0058): a clone pinned to one commit, and an explicit
//! update that moves it to the remote's current commit. Where the clone goes and what the
//! package contains are `piarc-core`'s and `piarc-config`'s.

use std::path::Path;

use crate::git::{Git, GitError};

/// Clones `url` into `dir` (which must not exist; its parent must) and detaches it at the
/// commit checked out; returns that commit.
///
/// The URL goes after `--`, so it is never read as an option.
///
/// # Errors
///
/// Git's errors; `dir` is removed again when a step after the clone fails.
pub async fn clone_pinned(git: &Git, url: &str, dir: &Path) -> Result<String, GitError> {
    let parent = dir.parent().unwrap_or(dir);
    let target = dir.as_os_str().to_owned();
    git.ok(
        parent,
        &[
            "clone".into(),
            "--quiet".into(),
            "--".into(),
            std::ffi::OsString::from(url),
            target,
        ],
    )
    .await?;
    match pin(git, dir, "HEAD").await {
        Ok(commit) => Ok(commit),
        Err(error) => {
            let _ = std::fs::remove_dir_all(dir);
            Err(error)
        }
    }
}

/// Fetches the remote of the clone at `dir` and detaches it at the remote's default branch;
/// returns `(previous commit, new commit)`.
///
/// # Errors
///
/// Git's errors; the checkout stays at the previous commit when the fetch fails.
pub async fn update_pinned(git: &Git, dir: &Path) -> Result<(String, String), GitError> {
    let previous = commit_of(git, dir, "HEAD").await?;
    git.ok(dir, &["fetch", "--quiet", "origin"]).await?;
    // The remote's default branch: `origin/HEAD` when the clone recorded it.
    let target = match commit_of(git, dir, "origin/HEAD").await {
        Ok(commit) => commit,
        Err(_) => commit_of(git, dir, "FETCH_HEAD").await?,
    };
    pin(git, dir, &target).await?;
    Ok((previous, target))
}

async fn commit_of(git: &Git, dir: &Path, rev: &str) -> Result<String, GitError> {
    let spec = format!("{rev}^{{commit}}");
    let out = git
        .ok(dir, &["rev-parse", "--verify", "--end-of-options", &spec])
        .await?;
    Ok(String::from_utf8_lossy(&out).trim().to_owned())
}

async fn pin(git: &Git, dir: &Path, rev: &str) -> Result<String, GitError> {
    let commit = commit_of(git, dir, rev).await?;
    git.ok(dir, &["checkout", "--quiet", "--detach", &commit])
        .await?;
    Ok(commit)
}
