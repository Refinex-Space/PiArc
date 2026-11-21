//! PiArc's worktrees (T35, architecture section 6.12).
//!
//! - A session's worktree lives at `<repository>/.piarc/worktrees/<name>/` on a new branch
//!   `piarc/<name>` (see [`branch_name`]); a subagent's temporary one is named
//!   `agent-<id>`. Names are 1–64 of `[A-Za-z0-9._-]`, starting with a letter or digit.
//! - Ignored files listed by the repository's `.worktreeinclude` (gitignore syntax) are copied
//!   into a new worktree ([`copy_included`]): only files that git ignores, only regular files,
//!   never anything below `.piarc/worktrees/`.
//! - Removing a worktree deletes its directory and git's record of it; its branch stays.
//!   Without `force`, git refuses a worktree with uncommitted changes, so a check made earlier
//!   cannot race with an edit made since.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorKind, ErrorObject};

use crate::git::{Git, GitError};

/// The directory below a repository's root that holds PiArc's worktrees.
pub const WORKTREES_DIR: [&str; 2] = [".piarc", "worktrees"];

/// What `.gitignore` gets so that worktrees stay out of the repository's status.
pub const IGNORE_LINE: &str = ".piarc/worktrees/";

/// The branch namespace of PiArc's worktrees.
pub const BRANCH_PREFIX: &str = "piarc/";

/// Names of subagents' temporary worktrees start with it.
pub const AGENT_PREFIX: &str = "agent-";

/// The longest worktree name.
pub const MAX_NAME_CHARS: usize = 64;

/// The file listing the ignored files a new worktree gets a copy of.
pub const INCLUDE_FILE: &str = ".worktreeinclude";

/// How many paths [`changes`] reports at most.
pub const MAX_LISTED_CHANGES: usize = 50;

/// Paths per `git check-ignore` call.
const CHECK_BATCH: usize = 200;

/// Why a worktree operation failed.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    /// Running git failed.
    #[error(transparent)]
    Git(#[from] GitError),
    /// The name is not allowed.
    #[error("invalid worktree name {name:?}: {reason}")]
    InvalidName {
        /// The name given.
        name: String,
        /// What is wrong with it.
        reason: &'static str,
    },
    /// The directory is not the top level of a git working tree.
    #[error("{} is not the top level of a git working tree", path.display())]
    NotTopLevel {
        /// The directory.
        path: PathBuf,
    },
    /// The base names no commit.
    #[error("{base:?} names no commit in this repository")]
    UnknownBase {
        /// The base given.
        base: String,
    },
    /// A worktree of that name exists already.
    #[error("{} exists already", path.display())]
    Exists {
        /// Its directory.
        path: PathBuf,
    },
    /// A file operation failed.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The path involved.
        path: PathBuf,
        /// The operating system's error.
        source: std::io::Error,
    },
}

impl WorktreeError {
    /// The protocol's error kind.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::InvalidName { .. }
            | Self::NotTopLevel { .. }
            | Self::UnknownBase { .. }
            | Self::Exists { .. } => ErrorKind::InvalidParams,
            Self::Git(GitError::TimedOut { .. }) => ErrorKind::Timeout,
            Self::Git(_) | Self::Io { .. } => ErrorKind::IoError,
        }
    }

    /// Whether trying again may succeed.
    #[must_use]
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Git(GitError::TimedOut { .. }))
    }

    /// As the protocol's error.
    #[must_use]
    pub fn to_error_object(&self) -> ErrorObject {
        ErrorObject::new(self.kind(), self.to_string(), self.retryable())
    }
}

fn io<'a>(op: &'static str, path: &'a Path) -> impl FnOnce(std::io::Error) -> WorktreeError + 'a {
    move |source| WorktreeError::Io {
        op,
        path: path.to_owned(),
        source,
    }
}

/// A worktree PiArc created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    /// Its name (the directory's name).
    pub name: String,
    /// Its directory (canonical).
    pub path: PathBuf,
    /// The branch created for it.
    pub branch: String,
    /// The commit it started from.
    pub base: String,
}

/// What [`create`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    /// The new worktree.
    pub worktree: Worktree,
    /// Paths (relative, `/`-separated) copied because `.worktreeinclude` lists them.
    pub copied: Vec<String>,
    /// Whether the repository ignores `.piarc/worktrees/` (otherwise the user is told).
    pub ignored: bool,
}

/// Uncommitted changes of a worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    /// The first [`MAX_LISTED_CHANGES`] changed paths, as git prints them.
    pub files: Vec<String>,
    /// How many paths changed in all.
    pub total: usize,
}

impl Changes {
    /// No uncommitted change.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.total == 0
    }
}

/// Checks a worktree name (see the module docs).
///
/// # Errors
///
/// [`WorktreeError::InvalidName`] with the reason.
pub fn check_name(name: &str) -> Result<(), WorktreeError> {
    let invalid = |reason| {
        Err(WorktreeError::InvalidName {
            name: name.to_owned(),
            reason,
        })
    };
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return invalid("must be 1 to 64 characters");
    }
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return invalid("must start with a letter or digit");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return invalid("may only contain letters, digits, '.', '_' and '-'");
    }
    if name.contains("..") || name.ends_with('.') || name.ends_with(".lock") {
        return invalid("is not a valid branch name");
    }
    Ok(())
}

/// The branch of worktree `name`: `piarc/<name>`.
#[must_use]
pub fn branch_name(name: &str) -> String {
    format!("{BRANCH_PREFIX}{name}")
}

/// `<repository>/.piarc/worktrees/`.
#[must_use]
pub fn worktrees_dir(repository: &Path) -> PathBuf {
    WORKTREES_DIR
        .iter()
        .fold(repository.to_owned(), |p, c| p.join(c))
}

/// The PiArc worktree directory that `path` lies in (or is), when `path` is below
/// `<workspace>/.piarc/worktrees/<name>/`. Both paths are compared as given: canonical ones.
#[must_use]
pub fn containing(workspace: &Path, path: &Path) -> Option<PathBuf> {
    let base = worktrees_dir(workspace);
    let name = path.strip_prefix(&base).ok()?.components().next()?;
    match name {
        std::path::Component::Normal(name) if check_name(&name.to_string_lossy()).is_ok() => {
            Some(base.join(name))
        }
        _ => None,
    }
}

/// The branch checked out in the working tree at `dir`, read from git's files without a
/// process; `None` when its HEAD is detached or cannot be read.
#[must_use]
pub fn head_branch(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        dir.join(target)
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_owned)
}

/// The commit `rev` names in the repository at `repository`.
///
/// # Errors
///
/// [`WorktreeError::UnknownBase`] when it names none; git's errors.
pub async fn resolve_commit(
    git: &Git,
    repository: &Path,
    rev: &str,
) -> Result<String, WorktreeError> {
    let spec = format!("{rev}^{{commit}}");
    let args = [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        &spec,
    ];
    let output = git.run(repository, &args).await?;
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.code == Some(0) && !sha.is_empty() {
        Ok(sha)
    } else {
        Err(WorktreeError::UnknownBase { base: rev.into() })
    }
}

/// The local branches of the repository at `repository`, sorted by name.
///
/// # Errors
///
/// Git's errors (for example, not a repository).
pub async fn branches(git: &Git, repository: &Path) -> Result<Vec<String>, WorktreeError> {
    let args = ["for-each-ref", "--format=%(refname:short)", "refs/heads/"];
    let out = git.ok(repository, &args).await?;
    let mut names: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    names.sort();
    Ok(names)
}

/// The commit checked out in the working tree at `dir`.
///
/// # Errors
///
/// Git's errors.
pub async fn head(git: &Git, dir: &Path) -> Result<String, WorktreeError> {
    let out = git.ok(dir, &["rev-parse", "--verify", "HEAD"]).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_owned())
}

/// Creates worktree `name` of the repository whose top level is `repository`, on the new
/// branch `piarc/<name>` starting at `base` (the current HEAD by default), and copies the
/// files `.worktreeinclude` lists from `repository` into it.
///
/// # Errors
///
/// [`WorktreeError::InvalidName`], [`WorktreeError::NotTopLevel`] (also for a directory that
/// is not in git), [`WorktreeError::UnknownBase`], [`WorktreeError::Exists`]; git's and the
/// file system's errors (the worktree is removed again when copying fails).
pub async fn create(
    git: &Git,
    repository: &Path,
    name: &str,
    base: Option<&str>,
) -> Result<Created, WorktreeError> {
    check_name(name)?;
    check_top_level(git, repository).await?;
    let base = resolve_commit(git, repository, base.unwrap_or("HEAD")).await?;
    let dir = worktrees_dir(repository);
    let path = dir.join(name);
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(WorktreeError::Exists { path });
    }
    std::fs::create_dir_all(&dir).map_err(io("cannot create", &dir))?;
    let branch = branch_name(name);
    let mut args: Vec<OsString> = vec!["worktree".into(), "add".into(), "-q".into(), "-b".into()];
    args.extend([
        branch.clone().into(),
        path.clone().into(),
        base.clone().into(),
    ]);
    git.ok(repository, &args).await?;
    let path = crate::canonical(&path).map_err(|e| WorktreeError::Io {
        op: "cannot resolve",
        path: path.clone(),
        source: std::io::Error::other(e),
    })?;
    let copied = match copy_included(git, repository, &path).await {
        Ok(copied) => copied,
        Err(error) => {
            let _ = remove(git, repository, &path, true).await;
            return Err(error);
        }
    };
    let ignored = is_ignored(git, repository, &format!("{IGNORE_LINE}{name}/")).await?;
    Ok(Created {
        worktree: Worktree {
            name: name.into(),
            path,
            branch,
            base,
        },
        copied,
        ignored,
    })
}

async fn check_top_level(git: &Git, repository: &Path) -> Result<(), WorktreeError> {
    let not_top = || WorktreeError::NotTopLevel {
        path: repository.to_owned(),
    };
    let output = git
        .run(repository, &["rev-parse", "--show-toplevel"])
        .await?;
    if output.code != Some(0) {
        return Err(not_top());
    }
    let shown = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let same = match (crate::canonical(&shown), crate::canonical(repository)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same { Ok(()) } else { Err(not_top()) }
}

/// Whether git ignores `relative` (`/`-separated, relative to `repository`).
///
/// # Errors
///
/// Git's errors other than "not ignored".
pub async fn is_ignored(
    git: &Git,
    repository: &Path,
    relative: &str,
) -> Result<bool, WorktreeError> {
    let output = git
        .run(repository, &["check-ignore", "-q", "--", relative])
        .await?;
    match output.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        code => Err(WorktreeError::Git(GitError::Failed {
            command: "check-ignore".into(),
            code,
            stderr: output.stderr,
        })),
    }
}

/// Appends [`IGNORE_LINE`] to `<repository>/.gitignore` (created when missing), unless a line
/// already says so. Returns whether the file changed.
///
/// # Errors
///
/// The file cannot be read or written.
pub fn add_ignore_line(repository: &Path) -> Result<bool, WorktreeError> {
    let file = repository.join(".gitignore");
    let existing = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(io("cannot read", &file)(e)),
    };
    let text = String::from_utf8_lossy(&existing);
    let present = text.lines().any(|l| {
        let l = l.trim();
        l == IGNORE_LINE || l == "/.piarc/worktrees/" || l == ".piarc/worktrees"
    });
    if present {
        return Ok(false);
    }
    let crlf = text.contains("\r\n");
    let newline = if crlf { "\r\n" } else { "\n" };
    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        addition.push_str(newline);
    }
    addition.push_str(IGNORE_LINE);
    addition.push_str(newline);
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(io("cannot open", &file))?;
    handle
        .write_all(addition.as_bytes())
        .map_err(io("cannot write", &file))?;
    Ok(true)
}

/// Copies into the worktree at `to` the files of `from` (a working tree of the same
/// repository) that `<from>/.worktreeinclude` lists and git ignores. Returns the copied paths.
///
/// # Errors
///
/// Git's errors; a file cannot be copied.
pub async fn copy_included(
    git: &Git,
    from: &Path,
    to: &Path,
) -> Result<Vec<String>, WorktreeError> {
    let include = from.join(INCLUDE_FILE);
    if !include.is_file() {
        return Ok(Vec::new());
    }
    let mut exclude_from = OsString::from("--exclude-from=");
    exclude_from.push(include.as_os_str());
    let args: Vec<OsString> = vec![
        "ls-files".into(),
        "-z".into(),
        "--others".into(),
        "--ignored".into(),
        exclude_from,
    ];
    let listed = git.ok(from, &args).await?;
    let candidates: Vec<String> = split_nul(&listed)
        .into_iter()
        .filter(|p| !p.starts_with(IGNORE_LINE) && p != INCLUDE_FILE)
        .collect();
    let mut copied = Vec::new();
    for batch in candidates.chunks(CHECK_BATCH) {
        let mut input = Vec::new();
        for path in batch {
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        let args = ["check-ignore", "-z", "--stdin"];
        let output = git.run_with_input(from, &args, input).await?;
        if !matches!(output.code, Some(0 | 1)) {
            return Err(WorktreeError::Git(GitError::Failed {
                command: "check-ignore".into(),
                code: output.code,
                stderr: output.stderr,
            }));
        }
        for relative in split_nul(&output.stdout) {
            if copy_one(from, to, &relative)? {
                copied.push(relative);
            }
        }
    }
    copied.sort();
    Ok(copied)
}

/// Copies one regular file; links and other kinds are skipped, an existing target is kept.
fn copy_one(from: &Path, to: &Path, relative: &str) -> Result<bool, WorktreeError> {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return Ok(false);
    }
    let source = parts.iter().fold(from.to_owned(), |p, c| p.join(c));
    let target = parts.iter().fold(to.to_owned(), |p, c| p.join(c));
    let meta = std::fs::symlink_metadata(&source).map_err(io("cannot inspect", &source))?;
    if !meta.is_file() || std::fs::symlink_metadata(&target).is_ok() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(io("cannot create", parent))?;
    }
    std::fs::copy(&source, &target).map_err(io("cannot copy", &source))?;
    Ok(true)
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .filter_map(|p| std::str::from_utf8(p).ok().map(str::to_owned))
        .collect()
}

/// The uncommitted changes of the working tree at `dir`: modified, staged, deleted and
/// untracked files (ignored files are not changes).
///
/// # Errors
///
/// Git's errors.
pub async fn changes(git: &Git, dir: &Path) -> Result<Changes, WorktreeError> {
    let args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ];
    let out = git.ok(dir, &args).await?;
    let mut files = Vec::new();
    let mut total = 0;
    let mut entries = out.split(|b| *b == 0).filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let text = String::from_utf8_lossy(entry);
        let (status, path) = text.split_at(text.len().min(3));
        // A rename or copy is followed by its source path.
        if status.starts_with(['R', 'C']) {
            entries.next();
        }
        total += 1;
        if files.len() < MAX_LISTED_CHANGES {
            files.push(path.to_owned());
        }
    }
    Ok(Changes { files, total })
}

/// Removes the worktree at `path` (its directory and git's record); its branch stays. Without
/// `force` git refuses a worktree with uncommitted changes. A directory that is gone already
/// only has git's record pruned.
///
/// # Errors
///
/// Git's errors; nothing is retried with force.
pub async fn remove(
    git: &Git,
    repository: &Path,
    path: &Path,
    force: bool,
) -> Result<(), WorktreeError> {
    if std::fs::symlink_metadata(path).is_err() {
        git.ok(repository, &["worktree", "prune"]).await?;
        return Ok(());
    }
    let mut args: Vec<OsString> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(path.into());
    git.ok(repository, &args).await?;
    Ok(())
}

/// Deletes branch `branch` when it still points at `tip` (a subagent's untouched branch);
/// leaves it otherwise. Returns whether it was deleted.
///
/// # Errors
///
/// Git's errors other than "the branch moved".
pub async fn delete_branch_at(
    git: &Git,
    repository: &Path,
    branch: &str,
    tip: &str,
) -> Result<bool, WorktreeError> {
    let reference = format!("refs/heads/{branch}");
    let output = git
        .run(repository, &["update-ref", "-d", &reference, tip])
        .await?;
    Ok(output.code == Some(0))
}

/// Adds the worktree at `path` again on its existing `branch` (an archived session's worktree
/// that was cleaned up, reopened).
///
/// # Errors
///
/// Git's errors (for example, the branch is gone or checked out elsewhere).
pub async fn restore(
    git: &Git,
    repository: &Path,
    path: &Path,
    branch: &str,
) -> Result<(), WorktreeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io("cannot create", parent))?;
    }
    let args: Vec<OsString> = vec![
        "worktree".into(),
        "add".into(),
        "-q".into(),
        path.into(),
        branch.into(),
    ];
    git.ok(repository, &args).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        for good in [
            "a",
            "feature-1",
            "agent-0a1b2c3d",
            "v1.2_x",
            &"x".repeat(64),
        ] {
            check_name(good).unwrap_or_else(|e| panic!("{good}: {e}"));
        }
        for bad in [
            "",
            "-a",
            ".a",
            "a/b",
            "a b",
            "名字",
            "a..b",
            "a.",
            "a.lock",
            &"x".repeat(65),
        ] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn containing_finds_the_worktree_directory() {
        let ws = Path::new("/work/repo");
        let dir = ws.join(".piarc").join("worktrees").join("one");
        assert_eq!(containing(ws, &dir), Some(dir.clone()));
        assert_eq!(containing(ws, &dir.join("src")), Some(dir.clone()));
        assert_eq!(containing(ws, ws), None);
        assert_eq!(containing(ws, &ws.join(".piarc")), None);
        assert_eq!(containing(ws, &ws.join(".piarc").join("worktrees")), None);
    }

    #[test]
    fn ignore_line_is_appended_once() {
        let dir = std::env::temp_dir().join(format!("piarc-git ignore 中 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join(".gitignore"), "target\r\n.env").expect("write");
        assert!(add_ignore_line(&dir).expect("append"));
        assert!(!add_ignore_line(&dir).expect("again"));
        let text = std::fs::read_to_string(dir.join(".gitignore")).expect("read");
        assert_eq!(text, "target\r\n.env\r\n.piarc/worktrees/\r\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
