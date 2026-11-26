//! G4 (design addendum 9.2): merging and rebasing onto a branch, the sides of a conflicted file
//! as the user sees them (git's "ours" and "theirs" swapped during a rebase), taking one side
//! whole, and interactive rebases written as a todo the sequence editor copies into place.
//! Values are checked by the caller (`args`); every revision goes after `--end-of-options`.

use std::path::Path;

use piarc_protocol::git::{
    GitConflictSides, GitMergeMode, GitRebaseAction, GitRebaseCommit, GitRebasePlan, GitRebaseStep,
    GitRepoState, GitSide,
};

use crate::diff::MAX_FILE_BYTES;
use crate::exec::{ExecOptions, WRITE_TIMEOUT};
use crate::git::GitError;
use crate::remote::RemoteOutcome;
use crate::repo::{Reader, Writer, failed};

/// The most commits an interactive rebase lists.
pub const MAX_PLAN: usize = 200;

/// Merges `branch` into the current branch.
///
/// # Errors
///
/// The runners' errors.
pub async fn merge(
    reader: &Reader,
    writer: &Writer,
    branch: &str,
    mode: GitMergeMode,
) -> Result<RemoteOutcome, GitError> {
    let mut args = vec!["-c", "core.editor=true", "merge", "--no-edit"];
    match mode {
        GitMergeMode::Ff => {}
        GitMergeMode::NoFf => args.push("--no-ff"),
        GitMergeMode::Squash => args.push("--squash"),
    }
    args.extend(["--end-of-options", branch]);
    finish(reader, writer, &args).await
}

/// Rebases the current branch onto `onto`.
///
/// # Errors
///
/// The runners' errors.
pub async fn rebase(
    reader: &Reader,
    writer: &Writer,
    onto: &str,
) -> Result<RemoteOutcome, GitError> {
    let args = ["-c", "core.editor=true", "rebase", "--end-of-options", onto];
    finish(reader, writer, &args).await
}

/// Runs a command that may stop with conflicts.
async fn finish(
    reader: &Reader,
    writer: &Writer,
    args: &[&str],
) -> Result<RemoteOutcome, GitError> {
    let out = writer
        .run(args, ExecOptions::timeout(WRITE_TIMEOUT))
        .await?;
    let words = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr)
        .trim()
        .to_owned();
    if out.success() {
        return Ok(RemoteOutcome::Done(words));
    }
    let conflicts = crate::branches::conflicted(reader).await?;
    if !conflicts.is_empty() {
        return Ok(RemoteOutcome::Conflict(conflicts));
    }
    Ok(RemoteOutcome::Failed(words))
}

/// The index stages of a conflicted `path`: (stage, mode, oid).
async fn stages(reader: &Reader, path: &str) -> Result<Vec<(u8, String, String)>, GitError> {
    let out = reader.ok(&["ls-files", "-u", "-z", "--", path]).await?;
    let mut found = Vec::new();
    for record in String::from_utf8_lossy(&out).split('\0') {
        let Some((meta, _)) = record.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split(' ').collect();
        if let [mode, oid, stage] = parts.as_slice()
            && let Ok(stage) = stage.parse::<u8>()
        {
            found.push((stage, (*mode).to_owned(), (*oid).to_owned()));
        }
    }
    Ok(found)
}

/// A blob's text; `Err(true)` when binary, `Err(false)` when too large.
async fn blob_text(reader: &Reader, oid: &str) -> Result<Result<String, bool>, GitError> {
    let out = reader
        .run(
            &["cat-file", "blob", oid],
            ExecOptions {
                stdout_limit: Some(MAX_FILE_BYTES),
                ..ExecOptions::default()
            },
        )
        .await?;
    if !out.success() {
        return Err(failed(&["cat-file"], &out));
    }
    if out.truncated {
        return Ok(Err(false));
    }
    if out.stdout.iter().take(8000).any(|&b| b == 0) {
        return Ok(Err(true));
    }
    Ok(Ok(String::from_utf8_lossy(&out.stdout).into_owned()))
}

/// Whether `state` swaps git's sides for the user: a rebase replays the user's commits onto the
/// other branch, so "ours" there is the other branch.
#[must_use]
pub fn swapped(state: &GitRepoState) -> bool {
    matches!(state, GitRepoState::Rebasing { .. })
}

/// The base and both sides of a conflicted `path`, with labels for the user's side and the
/// incoming one.
///
/// # Errors
///
/// The reader's errors.
pub async fn conflict_sides(
    reader: &Reader,
    path: &str,
    yours_label: String,
    theirs_label: String,
) -> Result<GitConflictSides, GitError> {
    let state = crate::status::repo_state(&reader.repo);
    let swap = swapped(&state);
    let mut sides = GitConflictSides {
        path: path.to_owned(),
        base: None,
        yours: None,
        theirs: None,
        result: None,
        result_hash: crate::index::worktree_hash(&reader.repo.root, path),
        yours_label,
        theirs_label,
        binary: None,
        too_large: None,
    };
    for (stage, _, oid) in stages(reader, path).await? {
        let text = match blob_text(reader, &oid).await? {
            Ok(text) => Some(text),
            Err(binary) => {
                if binary {
                    sides.binary = Some(true);
                } else {
                    sides.too_large = Some(true);
                }
                None
            }
        };
        let slot = match (stage, swap) {
            (1, _) => &mut sides.base,
            (2, false) | (3, true) => &mut sides.yours,
            _ => &mut sides.theirs,
        };
        *slot = text;
    }
    match crate::index::worktree_bytes(&reader.repo.root, path) {
        Some(bytes) if bytes.len() > MAX_FILE_BYTES => sides.too_large = Some(true),
        Some(bytes) if bytes.iter().take(8000).any(|&b| b == 0) => sides.binary = Some(true),
        Some(bytes) => sides.result = Some(String::from_utf8_lossy(&bytes).into_owned()),
        None => {}
    }
    Ok(sides)
}

/// Resolves `path` by taking `side` whole: its content when it has the file, else the file's
/// removal; then marks it resolved.
///
/// # Errors
///
/// The runners' errors.
pub async fn take_side(
    reader: &Reader,
    writer: &Writer,
    path: &str,
    side: GitSide,
) -> Result<(), GitError> {
    let swap = swapped(&crate::status::repo_state(&reader.repo));
    let git_side = match (side, swap) {
        (GitSide::Yours, false) | (GitSide::Theirs, true) => 2,
        _ => 3,
    };
    let present = stages(reader, path)
        .await?
        .iter()
        .any(|(stage, _, _)| *stage == git_side);
    let flag = if git_side == 2 { "--ours" } else { "--theirs" };
    let steps: Vec<Vec<&str>> = if present {
        vec![vec!["checkout", flag, "--", path], vec!["add", "--", path]]
    } else {
        vec![vec!["rm", "-q", "--", path]]
    };
    for args in steps {
        let out = writer
            .run(&args, ExecOptions::timeout(WRITE_TIMEOUT))
            .await?;
        if !out.success() {
            return Err(failed(&args, &out));
        }
    }
    Ok(())
}

/// The commits an interactive rebase from `from` lists: `from` to `HEAD` on the first-parent
/// chain, oldest first, and the commit they go onto (`None` from the root).
///
/// # Errors
///
/// The reader's errors.
pub async fn rebase_plan(reader: &Reader, from: &str) -> Result<Option<GitRebasePlan>, GitError> {
    let Some(head) = reader.repo_head().await? else {
        return Ok(None);
    };
    if !crate::history::is_ancestor(reader, from, "HEAD").await? {
        return Ok(None);
    }
    let base = reader.resolve(&format!("{from}~1")).await?;
    let range = match &base {
        Some(base) => format!("{base}..HEAD"),
        None => "HEAD".to_owned(),
    };
    let max = format!("--max-count={}", MAX_PLAN + 1);
    let out = reader
        .ok(&[
            "log",
            "--no-show-signature",
            "-z",
            "--first-parent",
            "--reverse",
            &max,
            "--format=%H%x1f%P%x1f%B",
            "--end-of-options",
            &range,
        ])
        .await?;
    let upstream = crate::history::upstream(reader).await?;
    let mut commits = Vec::new();
    for record in String::from_utf8_lossy(&out).split('\0') {
        let record = record.trim_start_matches('\n');
        let f: Vec<&str> = record.splitn(3, '\u{1f}').collect();
        let [sha, parents, message] = f.as_slice() else {
            continue;
        };
        let pushed = match &upstream {
            Some(upstream) => crate::history::is_ancestor(reader, sha, upstream).await?,
            None => false,
        };
        let message = message.trim_end().to_owned();
        commits.push(GitRebaseCommit {
            sha: (*sha).to_owned(),
            subject: message.lines().next().unwrap_or_default().to_owned(),
            merge: (parents.split_whitespace().count() > 1).then_some(true),
            pushed: pushed.then_some(true),
            message,
        });
    }
    if commits.len() > MAX_PLAN {
        return Ok(None);
    }
    Ok(Some(GitRebasePlan {
        base,
        head,
        commits,
    }))
}

/// A path as a single-quoted shell word for the todo's `exec` lines and the sequence editor
/// (`/` separators: Git for Windows runs them in its own `sh`).
#[must_use]
pub fn shell_word(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The todo of `steps`; `message_file(i)` names the file holding step `i`'s new message.
#[must_use]
pub fn todo(steps: &[GitRebaseStep], message_file: &dyn Fn(usize) -> String) -> String {
    let mut lines = String::new();
    for (i, step) in steps.iter().enumerate() {
        let verb = match step.action {
            GitRebaseAction::Pick | GitRebaseAction::Reword => "pick",
            GitRebaseAction::Squash => "squash",
            GitRebaseAction::Fixup => "fixup",
            GitRebaseAction::Drop => "drop",
        };
        lines.push_str(&format!("{verb} {}\n", step.sha));
        if step.action == GitRebaseAction::Reword {
            lines.push_str(&format!(
                "exec git commit --amend --only --allow-empty --cleanup=strip --no-verify -F {}\n",
                message_file(i)
            ));
        }
    }
    lines
}

/// Runs an interactive rebase onto `base` (the root when `None`) with `todo_file` copied over
/// git's todo by the sequence editor.
///
/// # Errors
///
/// The runners' errors.
pub async fn rebase_interactive(
    reader: &Reader,
    writer: &Writer,
    base: Option<&str>,
    todo_file: &Path,
) -> Result<RemoteOutcome, GitError> {
    let editor = format!("cp {}", shell_word(todo_file));
    let writer = writer.with_env("GIT_SEQUENCE_EDITOR", &editor);
    let mut args = vec![
        "-c",
        "core.editor=true",
        "-c",
        "rebase.autoSquash=false",
        "rebase",
        "-i",
    ];
    match base {
        Some(base) => args.extend(["--end-of-options", base]),
        None => args.push("--root"),
    }
    finish(reader, &writer, &args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todos_turn_rewords_into_amends() {
        let step = |sha: &str, action| GitRebaseStep {
            sha: sha.into(),
            action,
            message: None,
        };
        let text = todo(
            &[
                step("aaa", GitRebaseAction::Reword),
                step("bbb", GitRebaseAction::Fixup),
                step("ccc", GitRebaseAction::Drop),
            ],
            &|i| format!("'/tmp/m{i}'"),
        );
        assert_eq!(
            text,
            "pick aaa\nexec git commit --amend --only --allow-empty --cleanup=strip --no-verify -F '/tmp/m0'\nfixup bbb\ndrop ccc\n"
        );
    }

    #[test]
    fn shell_words_quote_spaces_and_quotes() {
        assert_eq!(
            shell_word(Path::new("/data dir/it's/todo")),
            "'/data dir/it'\\''s/todo'"
        );
    }
}
