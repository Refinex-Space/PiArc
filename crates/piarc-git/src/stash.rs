//! Stashes (G3): the list, and pushing, applying, popping, dropping and branching from one.
//! An operation on an existing stash names its position and the commit the page showed; the
//! position must still name that commit, so a stash pushed or dropped meanwhile is not touched.

use piarc_protocol::git::{GitStashEntry, GitStashes};

use crate::exec::{ExecOptions, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::remote::RemoteOutcome;
use crate::repo::{Reader, Writer, failed};

/// The most stashes listed.
pub const MAX_STASHES: usize = 500;

/// Parses `stash list -z --format=%gd%x1f%H%x1f%gs%x1f%ct`.
#[must_use]
pub fn parse_stashes(out: &[u8]) -> Vec<GitStashEntry> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            let f: Vec<&str> = record.splitn(4, '\u{1f}').collect();
            if f.len() != 4 {
                return None;
            }
            let index = f[0]
                .strip_prefix("stash@{")
                .and_then(|rest| rest.strip_suffix('}'))
                .and_then(|n| n.parse().ok())?;
            let (branch, message) = split_subject(f[2]);
            Some(GitStashEntry {
                index,
                oid: f[1].to_owned(),
                message,
                branch,
                time: f[3].parse().unwrap_or(0),
            })
        })
        .take(MAX_STASHES)
        .collect()
}

/// `On main: message` and `WIP on main: abc1234 subject` give the branch and the message.
fn split_subject(subject: &str) -> (Option<String>, String) {
    let rest = subject
        .strip_prefix("WIP on ")
        .or_else(|| subject.strip_prefix("On "));
    match rest.and_then(|r| r.split_once(": ")) {
        Some((branch, message)) if branch != "(no branch)" => {
            (Some(branch.to_owned()), message.to_owned())
        }
        Some((_, message)) => (None, message.to_owned()),
        None => (None, subject.to_owned()),
    }
}

/// The stashes, newest first.
///
/// # Errors
///
/// The reader's errors.
pub async fn list(reader: &Reader) -> Result<GitStashes, GitError> {
    let out = reader
        .ok(&["stash", "list", "-z", "--format=%gd%x1f%H%x1f%gs%x1f%ct"])
        .await?;
    Ok(GitStashes {
        entries: parse_stashes(&out),
    })
}

/// The commit `stash@{index}` names; `None` when there is no such stash.
///
/// # Errors
///
/// The reader's errors.
pub async fn oid_at(reader: &Reader, index: u64) -> Result<Option<String>, GitError> {
    let name = format!("stash@{{{index}}}");
    let out = reader
        .run(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &name,
            ],
            ExecOptions::default(),
        )
        .await?;
    Ok(out
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()))
}

/// Stashes the local changes (untracked files too with `untracked`); `false` when there was
/// nothing to stash.
///
/// # Errors
///
/// The writer's errors.
pub async fn push(
    writer: &Writer,
    message: Option<&str>,
    untracked: bool,
) -> Result<bool, GitError> {
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = message {
        args.extend(["-m", message]);
    }
    let out = writer
        .with_pathspec_magic()
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if !out.success() {
        return Err(failed(&args, &out));
    }
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    Ok(!said.contains("No local changes to save"))
}

/// What applying a stash did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Applied (and dropped, for a pop).
    Done,
    /// Applied with conflicts; git kept the stash.
    Conflict(Vec<String>),
    /// Refused (local changes in the way); git's words.
    Failed(String),
}

/// Applies `stash@{index}`, dropping it afterwards with `pop`. The caller checked the oid.
///
/// # Errors
///
/// The runners' errors.
pub async fn apply(
    reader: &Reader,
    writer: &Writer,
    index: u64,
    pop: bool,
) -> Result<ApplyOutcome, GitError> {
    let name = format!("stash@{{{index}}}");
    let args = ["stash", if pop { "pop" } else { "apply" }, &name];
    let out = writer
        .with_pathspec_magic()
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        return Ok(ApplyOutcome::Done);
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() {
        return Ok(ApplyOutcome::Conflict(conflicts));
    }
    Ok(ApplyOutcome::Failed(
        format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr)
            .trim()
            .to_owned(),
    ))
}

/// Drops `stash@{index}`. The caller checked the oid.
///
/// # Errors
///
/// The writer's errors.
pub async fn drop(writer: &Writer, index: u64) -> Result<(), GitError> {
    let name = format!("stash@{{{index}}}");
    let args = ["stash", "drop", "--quiet", &name];
    let out = writer
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        Ok(())
    } else {
        Err(failed(&args, &out))
    }
}

/// Creates branch `name` at the stash's base, checks it out, applies the stash and drops it.
/// The caller checked the oid and the name.
///
/// # Errors
///
/// The runners' errors.
pub async fn branch(
    reader: &Reader,
    writer: &Writer,
    index: u64,
    name: &str,
) -> Result<RemoteOutcome, GitError> {
    let stash = format!("stash@{{{index}}}");
    let args = ["stash", "branch", name, &stash];
    let out = writer
        .with_pathspec_magic()
        .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    if out.success() {
        return Ok(RemoteOutcome::Done(String::new()));
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() {
        return Ok(RemoteOutcome::Conflict(conflicts));
    }
    Err(failed(&args, &out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_records() {
        let out = b"stash@{0}\x1faaaa\x1fOn feature/x: \xe5\x8d\x8a\xe6\x88\x90\xe5\x93\x81\x1f1700000000\0\nstash@{1}\x1fbbbb\x1fWIP on main: abc1234 subject\x1f1600000000\0stash@{2}\x1fcccc\x1fWIP on (no branch): 1234567 x\x1f1\0";
        let stashes = parse_stashes(out);
        assert_eq!(stashes.len(), 3);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].branch.as_deref(), Some("feature/x"));
        assert_eq!(stashes[0].message, "半成品");
        assert_eq!(stashes[1].branch.as_deref(), Some("main"));
        assert_eq!(stashes[1].message, "abc1234 subject");
        assert_eq!(stashes[2].branch, None);
    }
}
