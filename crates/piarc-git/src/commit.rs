//! Committing the index from the commit view: identity check, the commit itself (message on
//! stdin, the user's hooks run), and the last commit for "Amend".

use piarc_protocol::git::GitLastCommit;

use crate::exec::{Cancel, ExecOptions, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::repo::{Reader, Writer};

/// The most bytes of a commit message.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// What a commit did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    /// The new commit and its subject; hook output when there was some.
    Committed {
        /// The new `HEAD`.
        head: String,
        /// Its subject.
        subject: String,
        /// What hooks printed.
        output: String,
    },
    /// `user.name` or `user.email` is not set.
    Identity,
    /// Nothing is staged.
    NothingToCommit,
    /// A hook refused, with what it printed.
    HookFailed(String),
    /// Another git holds the index lock.
    Locked,
    /// Anything else, with git's words.
    Failed(String),
}

/// Whether git can name the committer (`user.name` and `user.email`).
///
/// # Errors
///
/// The writer's errors.
pub async fn has_identity(writer: &Writer) -> Result<bool, GitError> {
    Ok(writer
        .run(&["var", "GIT_COMMITTER_IDENT"], ExecOptions::default())
        .await?
        .success())
}

/// Whether the index differs from `HEAD` (from the empty tree before the first commit).
///
/// # Errors
///
/// The reader's errors.
pub async fn has_staged(reader: &Reader) -> Result<bool, GitError> {
    let out = reader
        .run(
            &["diff", "--cached", "--quiet", "--no-ext-diff"],
            ExecOptions::default(),
        )
        .await?;
    Ok(out.code == Some(1))
}

/// Commits the index with `message`.
///
/// # Errors
///
/// The writer's errors.
pub async fn commit(
    writer: &Writer,
    message: &str,
    amend: bool,
    signoff: bool,
    cancel: Cancel,
) -> Result<CommitOutcome, GitError> {
    let mut args = vec!["commit", "--cleanup=strip", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if signoff {
        args.push("--signoff");
    }
    let out = writer
        .run(
            &args,
            ExecOptions {
                timeout: Some(WRITE_TIMEOUT),
                stdin: message.as_bytes().to_vec(),
                cancel: Some(cancel),
                ..ExecOptions::default()
            },
        )
        .await?;
    let printed = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    let printed = printed.trim().to_owned();
    if out.success() {
        let head = writer
            .run(&["rev-parse", "HEAD"], ExecOptions::default())
            .await?;
        let subject = writer
            .run(
                &["log", "-1", "--no-show-signature", "--format=%s"],
                ExecOptions::default(),
            )
            .await?;
        return Ok(CommitOutcome::Committed {
            head: String::from_utf8_lossy(&head.stdout).trim().to_owned(),
            subject: String::from_utf8_lossy(&subject.stdout).trim().to_owned(),
            output: hook_lines(&printed),
        });
    }
    let lower = printed.to_ascii_lowercase();
    if lower.contains("please tell me who you are") || lower.contains("unable to auto-detect email")
    {
        return Ok(CommitOutcome::Identity);
    }
    if lower.contains("nothing to commit") || lower.contains("no changes added to commit") {
        return Ok(CommitOutcome::NothingToCommit);
    }
    if lower.contains("aborting commit due to empty commit message") {
        return Ok(CommitOutcome::Failed(printed));
    }
    if lower.contains("index.lock") {
        return Ok(CommitOutcome::Locked);
    }
    if has_commit_hooks(writer).await? {
        return Ok(CommitOutcome::HookFailed(printed));
    }
    Ok(CommitOutcome::Failed(printed))
}

/// Output of a successful commit minus git's own summary lines.
fn hook_lines(printed: &str) -> String {
    printed
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with('[') || t.contains("file changed") || t.contains("files changed"))
                && !t.starts_with("create mode")
                && !t.starts_with("delete mode")
                && !t.starts_with("rename ")
                && !t.starts_with("mode change")
                && !t.starts_with("Date:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// Whether a hook that runs on commit exists (in `core.hooksPath` when set).
async fn has_commit_hooks(writer: &Writer) -> Result<bool, GitError> {
    let out = writer
        .run(
            &["rev-parse", "--git-path", "hooks"],
            ExecOptions::default(),
        )
        .await?;
    if !out.success() {
        return Ok(false);
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let dir = writer.repo.root.join(dir);
    Ok(["pre-commit", "prepare-commit-msg", "commit-msg"]
        .iter()
        .any(|hook| dir.join(hook).is_file()))
}

/// The last commit's message and whether the upstream has it.
///
/// # Errors
///
/// The reader's errors.
pub async fn last_commit(reader: &Reader) -> Result<GitLastCommit, GitError> {
    let message = reader
        .run(
            &["log", "-1", "--no-show-signature", "--format=%B"],
            ExecOptions::default(),
        )
        .await?;
    if !message.success() {
        return Ok(GitLastCommit {
            message: None,
            pushed: false,
        });
    }
    let pushed = reader
        .run(
            &["merge-base", "--is-ancestor", "HEAD", "@{upstream}"],
            ExecOptions::default(),
        )
        .await?
        .success();
    Ok(GitLastCommit {
        message: Some(
            String::from_utf8_lossy(&message.stdout)
                .trim_end()
                .to_owned(),
        ),
        pushed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_output_drops_git_summary() {
        let printed = "lint ok\n[main 1a2b3c4] feat: x\n 1 file changed, 2 insertions(+)\n create mode 100644 a.txt";
        assert_eq!(hook_lines(printed), "lint ok");
    }
}
