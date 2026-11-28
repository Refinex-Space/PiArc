//! The index for the commit view (ADR-0085 rule 4): staging and unstaging files, one file's
//! staged and unstaged diffs, and hunk operations whose patch is regenerated from git's own
//! bytes and applied only when the file and the index entry still match what was shown.

use std::path::Path;

use piarc_protocol::git::{GitFileStages, GitHunkRef, GitStage};
use sha2::{Digest, Sha256};

use crate::diff::{self, MAX_FILE_BYTES, ParsedFile};
use crate::exec::ExecOptions;
use crate::git::GitError;
use crate::repo::{Reader, Writer, failed};

/// The marker of a missing file or index entry.
pub const ABSENT: &str = "absent";

const DIFF: &[&str] = &[
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "-U3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/// Hex SHA-256 of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().fold(String::with_capacity(64), |mut out, b| {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// The bytes of `path` under `root` (a link's target for a symbolic link); `None` when absent.
#[must_use]
pub fn worktree_bytes(root: &Path, path: &str) -> Option<Vec<u8>> {
    let full = root.join(path);
    let meta = std::fs::symlink_metadata(&full).ok()?;
    if meta.file_type().is_symlink() {
        return std::fs::read_link(&full)
            .ok()
            .map(|t| t.to_string_lossy().into_owned().into_bytes());
    }
    if !meta.is_file() {
        return None;
    }
    std::fs::read(&full).ok()
}

/// SHA-256 of the file on disk, or [`ABSENT`].
#[must_use]
pub fn worktree_hash(root: &Path, path: &str) -> String {
    worktree_bytes(root, path).map_or_else(|| ABSENT.to_owned(), |b| sha256_hex(&b))
}

/// The stage-0 index entry of `path`: (mode, object id); `None` when not in the index or
/// conflicted.
///
/// # Errors
///
/// The reader's errors.
pub async fn index_entry(
    reader: &Reader,
    path: &str,
) -> Result<Option<(String, String)>, GitError> {
    let out = reader.ok(&["ls-files", "-s", "-z", "--", path]).await?;
    let text = String::from_utf8_lossy(&out);
    for record in text.split('\0').filter(|r| !r.is_empty()) {
        let Some((meta, _)) = record.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split(' ').collect();
        if parts.len() == 3 && parts[2] == "0" {
            return Ok(Some((parts[0].to_owned(), parts[1].to_owned())));
        }
    }
    Ok(None)
}

async fn side_patch(reader: &Reader, path: &str, stage: GitStage) -> Result<Vec<u8>, GitError> {
    let mut args: Vec<&str> = DIFF.to_vec();
    if stage == GitStage::Staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let out = reader
        .run(
            &args,
            ExecOptions {
                stdout_limit: Some(MAX_FILE_BYTES),
                ..ExecOptions::default()
            },
        )
        .await?;
    if !out.success() {
        return Err(failed(&args, &out));
    }
    Ok(out.stdout)
}

fn section(out: &[u8], path: &str) -> Option<ParsedFile> {
    diff::parse_patch(out)
        .into_iter()
        .find(|f| f.path() == Some(path))
}

async fn filtered(reader: &Reader, path: &str) -> Result<bool, GitError> {
    let out = reader
        .ok(&["check-attr", "-z", "filter", "--", path])
        .await?;
    let fields: Vec<String> = String::from_utf8_lossy(&out)
        .split('\0')
        .map(str::to_owned)
        .collect();
    Ok(fields
        .get(2)
        .is_some_and(|value| value != "unspecified" && value != "unset" && !value.is_empty()))
}

/// One file's staged and unstaged diffs with the values that name its hunks.
///
/// # Errors
///
/// The reader's errors.
pub async fn file_stages(reader: &Reader, path: &str) -> Result<GitFileStages, GitError> {
    let root = &reader.repo.root;
    let entry = index_entry(reader, path).await?;
    let staged_out = side_patch(reader, path, GitStage::Staged).await?;
    let staged = section(&staged_out, path);
    let (unstaged, untracked_diff) = if entry.is_some() {
        let out = side_patch(reader, path, GitStage::Unstaged).await?;
        (section(&out, path), None)
    } else if staged.is_none() {
        (None, diff::untracked_diff(root, path))
    } else {
        (None, None)
    };
    let binary = staged.as_ref().is_some_and(|f| f.binary)
        || unstaged.as_ref().is_some_and(|f| f.binary)
        || (entry.is_none() && staged.is_none() && untracked_diff.is_none());
    let hashes = |file: &Option<ParsedFile>| -> Vec<String> {
        file.as_ref()
            .map(|f| f.hunks.iter().map(|h| sha256_hex(&h.raw)).collect())
            .unwrap_or_default()
    };
    let to_diff = |file: &Option<ParsedFile>| {
        file.as_ref()
            .filter(|f| !f.binary)
            .map(|f| diff::file_diff(path, f, f.old_path.is_none()))
    };
    let only_mode = |file: &Option<ParsedFile>| file.as_ref().is_some_and(|f| f.hunks.is_empty());
    let hunk_actions = entry.is_some()
        && !binary
        && !filtered(reader, path).await?
        && !(only_mode(&staged) && only_mode(&unstaged));
    Ok(GitFileStages {
        path: path.to_owned(),
        staged: to_diff(&staged),
        unstaged: to_diff(&unstaged).or(untracked_diff),
        staged_hashes: hashes(&staged),
        hunk_hashes: hashes(&unstaged),
        worktree_hash: worktree_hash(root, path),
        index_oid: entry.map_or_else(|| ABSENT.to_owned(), |(_, oid)| oid),
        binary: binary.then_some(true),
        hunk_actions,
    })
}

/// What a hunk operation does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkAction {
    /// Stage an unstaged hunk.
    Stage,
    /// Unstage a staged hunk.
    Unstage,
    /// Undo an unstaged hunk in the working tree.
    Rollback,
}

/// The result of a hunk operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HunkOutcome {
    /// Applied.
    Applied,
    /// The file, the index or the hunk changed since it was shown.
    Stale,
}

/// Applies one hunk the client named, regenerating its patch from git first.
///
/// # Errors
///
/// The runners' errors.
pub async fn apply_hunk(
    reader: &Reader,
    writer: &Writer,
    hunk: &GitHunkRef,
    action: HunkAction,
) -> Result<HunkOutcome, GitError> {
    let wanted = if action == HunkAction::Unstage {
        GitStage::Staged
    } else {
        GitStage::Unstaged
    };
    if hunk.stage != wanted || worktree_hash(&reader.repo.root, &hunk.path) != hunk.worktree_hash {
        return Ok(HunkOutcome::Stale);
    }
    let entry = index_entry(reader, &hunk.path).await?;
    if entry.as_ref().map_or(ABSENT, |(_, oid)| oid.as_str()) != hunk.index_oid {
        return Ok(HunkOutcome::Stale);
    }
    let out = side_patch(reader, &hunk.path, wanted).await?;
    let Some(file) = section(&out, &hunk.path) else {
        return Ok(HunkOutcome::Stale);
    };
    let picked = usize::try_from(hunk.index)
        .ok()
        .and_then(|i| file.hunks.get(i))
        .filter(|h| sha256_hex(&h.raw) == hunk.hash);
    let Some(picked) = picked else {
        return Ok(HunkOutcome::Stale);
    };
    let mut patch = file.header.clone();
    patch.extend_from_slice(&picked.raw);
    let args: &[&str] = match action {
        HunkAction::Stage => &["apply", "--cached", "--whitespace=nowarn", "-"],
        HunkAction::Unstage => &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        HunkAction::Rollback => &["apply", "--reverse", "--whitespace=nowarn", "-"],
    };
    let result = writer
        .run(
            args,
            ExecOptions {
                stdin: patch,
                ..ExecOptions::default()
            },
        )
        .await?;
    if result.success() {
        Ok(HunkOutcome::Applied)
    } else if result.stderr.contains("does not apply") || result.stderr.contains("patch failed") {
        Ok(HunkOutcome::Stale)
    } else {
        Err(failed(args, &result))
    }
}

/// `paths` as NUL-separated stdin for `--pathspec-from-file=- --pathspec-file-nul`.
fn pathspecs(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path.as_bytes());
        out.push(0);
    }
    out
}

/// Runs `args` with `paths` given as NUL-separated pathspecs on stdin.
///
/// # Errors
///
/// The writer's errors.
pub async fn with_paths(writer: &Writer, args: &[&str], paths: &[String]) -> Result<(), GitError> {
    let mut full: Vec<&str> = args.to_vec();
    full.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let out = writer
        .run(
            &full,
            ExecOptions {
                stdin: pathspecs(paths),
                ..ExecOptions::default()
            },
        )
        .await?;
    if out.success() {
        Ok(())
    } else {
        Err(failed(&full, &out))
    }
}

/// Stages `paths` (new, changed and deleted files alike).
///
/// # Errors
///
/// The writer's errors.
pub async fn stage(writer: &Writer, paths: &[String]) -> Result<(), GitError> {
    with_paths(writer, &["add", "-A"], paths).await
}

/// Unstages `paths`; `unborn` (no commit yet) removes them from the index instead.
///
/// # Errors
///
/// The writer's errors.
pub async fn unstage(writer: &Writer, paths: &[String], unborn: bool) -> Result<(), GitError> {
    if unborn {
        with_paths(
            writer,
            &["rm", "--cached", "-r", "--quiet", "--ignore-unmatch"],
            paths,
        )
        .await
    } else {
        with_paths(writer, &["restore", "--staged"], paths).await
    }
}

/// Marks conflicted `paths` resolved (`add -A`: a deletion stays a deletion).
///
/// # Errors
///
/// The writer's errors.
pub async fn mark_resolved(writer: &Writer, paths: &[String]) -> Result<(), GitError> {
    stage(writer, paths).await
}

/// Puts an index entry back (undo of a rollback).
///
/// # Errors
///
/// The writer's errors.
pub async fn set_index_entry(
    writer: &Writer,
    path: &str,
    entry: Option<(&str, &str)>,
) -> Result<(), GitError> {
    let out = match entry {
        Some((mode, oid)) => {
            let info = format!("{mode},{oid},{path}");
            writer
                .run(
                    &["update-index", "--add", "--cacheinfo", &info],
                    ExecOptions::default(),
                )
                .await?
        }
        None => {
            writer
                .run(
                    &["rm", "--cached", "--quiet", "--ignore-unmatch", "--", path],
                    ExecOptions::default(),
                )
                .await?
        }
    };
    if out.success() {
        Ok(())
    } else {
        Err(failed(&["update-index"], &out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_hex_sha256() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
