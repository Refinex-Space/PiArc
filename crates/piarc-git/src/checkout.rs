//! Which repository a directory belongs to, for project trust (architecture section 10.2):
//! all worktrees of a repository share one trust decision, keyed by the main checkout.
//!
//! Rules, from the directory upwards to the first `.git`:
//!
//! - `.git` is a directory: a normal repository; the main checkout is its parent.
//! - `.git` is a file (`gitdir: <dir>`) and `<dir>/commondir` exists: a linked worktree
//!   (`git worktree add`). `commondir` points at the main repository's git directory; the main
//!   checkout is that directory's parent when it is named `.git`, otherwise (a bare or
//!   separate git directory) the git directory itself is the key.
//! - `.git` is a file without `commondir`: a submodule (`gitdir` under the superproject's
//!   `.git/modules/`) or a repository with a separate git directory; it is its own project and
//!   the key is the directory holding the `.git` file.
//! - no `.git` up to the root: not a repository; the key is the directory itself.
//!
//! Every path is canonical: symbolic links resolved, case as stored on disk, and without the
//! Windows `\\?\` prefix.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// How the directory relates to git.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutKind {
    /// Inside a normal repository's working tree.
    Repository,
    /// Inside a linked worktree.
    LinkedWorktree,
    /// Inside a submodule or a repository whose git directory lives elsewhere.
    Independent,
    /// Not inside any repository.
    NotGit,
}

/// The result of [`resolve`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    /// The trust key: canonical path of the main checkout (see the module docs).
    pub main: PathBuf,
    /// The working tree root that contains the directory (the directory itself outside git).
    pub root: PathBuf,
    /// How it was found.
    pub kind: CheckoutKind,
}

/// Why resolution failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The directory, or a git file it refers to, cannot be read.
    #[error("{op} {}: {source}", path.display())]
    Io {
        /// What was being done.
        op: &'static str,
        /// The path involved.
        path: PathBuf,
        /// The operating system's error.
        source: io::Error,
    },
    /// A `.git` file does not have the `gitdir: <path>` form.
    #[error("{} is not a valid .git file", path.display())]
    MalformedGitFile {
        /// The file.
        path: PathBuf,
    },
}

/// Result type of this module.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The canonical form of `path`: absolute, symbolic links resolved, without `\\?\`.
///
/// # Errors
///
/// [`Error::Io`] when the path does not exist or cannot be resolved.
pub fn canonical(path: &Path) -> Result<PathBuf> {
    let resolved = fs::canonicalize(path).map_err(|source| Error::Io {
        op: "cannot resolve",
        path: path.to_owned(),
        source,
    })?;
    Ok(strip_verbatim(resolved))
}

/// Removes the Windows verbatim prefix: `\\?\C:\x` → `C:\x`, `\\?\UNC\host\share` →
/// `\\host\share`. Other paths are returned unchanged.
#[must_use]
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// Finds the main checkout of the repository `dir` belongs to (see the module docs).
///
/// # Errors
///
/// [`Error::Io`] when `dir` or a git file cannot be read; [`Error::MalformedGitFile`] for a
/// `.git` file without a `gitdir:` line.
pub fn resolve(dir: &Path) -> Result<Checkout> {
    let start = canonical(dir)?;
    let mut current = Some(start.as_path());
    while let Some(candidate) = current {
        let dot_git = candidate.join(".git");
        match fs::metadata(&dot_git) {
            Ok(meta) if meta.is_dir() => {
                return Ok(Checkout {
                    main: candidate.to_owned(),
                    root: candidate.to_owned(),
                    kind: CheckoutKind::Repository,
                });
            }
            Ok(meta) if meta.is_file() => return from_git_file(candidate, &dot_git),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(Error::Io {
                    op: "cannot inspect",
                    path: dot_git,
                    source,
                });
            }
        }
        current = candidate.parent();
    }
    Ok(Checkout {
        main: start.clone(),
        root: start,
        kind: CheckoutKind::NotGit,
    })
}

fn from_git_file(root: &Path, file: &Path) -> Result<Checkout> {
    let text = fs::read_to_string(file).map_err(|source| Error::Io {
        op: "cannot read",
        path: file.to_owned(),
        source,
    })?;
    let gitdir = text
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .ok_or_else(|| Error::MalformedGitFile {
            path: file.to_owned(),
        })?;
    let gitdir = canonical(&root.join(gitdir))?;
    let commondir_file = gitdir.join("commondir");
    let common = match fs::read_to_string(&commondir_file) {
        Ok(common) => common,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Checkout {
                main: root.to_owned(),
                root: root.to_owned(),
                kind: CheckoutKind::Independent,
            });
        }
        Err(source) => {
            return Err(Error::Io {
                op: "cannot read",
                path: commondir_file,
                source,
            });
        }
    };
    let common = canonical(&gitdir.join(common.trim()))?;
    // Git records the checkout on both sides. A moved checkout must be repaired
    // before it can share its main checkout's trust.
    let backlink = gitdir.join("gitdir");
    let registered = fs::read_to_string(&backlink).map_err(|source| Error::Io {
        op: "cannot read",
        path: backlink,
        source,
    })?;
    if gitdir.parent() != Some(common.join("worktrees").as_path())
        || canonical(&gitdir.join(registered.trim()))? != file
    {
        return Ok(Checkout {
            main: root.to_owned(),
            root: root.to_owned(),
            kind: CheckoutKind::Independent,
        });
    }
    let main = match (common.file_name(), common.parent()) {
        (Some(name), Some(parent)) if name == ".git" => parent.to_owned(),
        _ => common,
    };
    Ok(Checkout {
        main,
        root: root.to_owned(),
        kind: CheckoutKind::LinkedWorktree,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\work\repo")),
            PathBuf::from(r"C:\work\repo")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\Volume{x}\repo")),
            PathBuf::from(r"\\?\Volume{x}\repo")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/work/repo")),
            PathBuf::from("/work/repo")
        );
    }
}
