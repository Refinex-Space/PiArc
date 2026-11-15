//! Where a session may read and write: the path boundary of architecture section 6.1.2.
//!
//! A [`Scope`] holds a session's workspace root and working directory, both canonical. A
//! requested path is resolved in three steps:
//!
//! 1. relative paths are joined to the working directory;
//! 2. `.` and `..` are removed lexically (as Node's `path.resolve` does);
//! 3. symlinks are resolved for every component that exists, including dangling links, whose
//!    targets are followed as far as they exist; missing trailing components are appended.
//!
//! The result must lie inside the root (component-wise prefix), otherwise the operation fails
//! with [`Error::OutsideWorkspace`] before anything touches the target. Canonical paths carry
//! the on-disk spelling of existing components and the `\\?\` prefix on Windows on both sides
//! of the comparison, so case-insensitive volumes compare correctly; [`display`] strips the
//! prefix for messages and results.
//!
//! The check happens before the operation, not atomically with it: a symlink swapped in between
//! is not caught (T16 and the sandbox narrow this).

use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// How many symlinks one resolution follows before giving up (as `ELOOP`).
const MAX_SYMLINK_HOPS: u32 = 40;

/// A session's workspace root and working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    root: PathBuf,
    cwd: PathBuf,
}

impl Scope {
    /// A scope rooted at `root` with working directory `cwd`.
    ///
    /// # Errors
    ///
    /// Either directory cannot be canonicalized (for example it does not exist), or `cwd`
    /// lies outside `root`.
    pub fn new(root: &Path, cwd: &Path) -> Result<Self> {
        let root = std::fs::canonicalize(root).map_err(|e| Error::io(root, e))?;
        let canonical_cwd = std::fs::canonicalize(cwd).map_err(|e| Error::io(cwd, e))?;
        if !canonical_cwd.starts_with(&root) {
            return Err(Error::OutsideWorkspace {
                path: display(cwd),
                resolved: display(&canonical_cwd),
                root: display(&root),
            });
        }
        Ok(Self {
            root,
            cwd: canonical_cwd,
        })
    }

    /// The canonical workspace root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The canonical working directory.
    #[must_use]
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Resolves `requested` (absolute, or relative to the working directory) to a canonical
    /// path inside the root. The path need not exist.
    ///
    /// # Errors
    ///
    /// [`Error::OutsideWorkspace`] when it resolves outside the root; an I/O error when a
    /// component cannot be inspected (for example a symlink loop).
    pub fn resolve(&self, requested: &str) -> Result<PathBuf> {
        // Joined onto the cwd's usual spelling: below a `\\?\` prefix Windows would not treat
        // `/` as a separator.
        let joined = PathBuf::from(display(&self.cwd)).join(requested);
        let normalized = normalize(&joined);
        let resolved = canonicalize_lenient(&normalized, MAX_SYMLINK_HOPS)?;
        if resolved.starts_with(&self.root) {
            Ok(resolved)
        } else {
            Err(Error::OutsideWorkspace {
                path: requested.to_owned(),
                resolved: display(&resolved),
                root: display(&self.root),
            })
        }
    }
}

/// `path` in the platform's usual spelling: without the `\\?\` (or `\\?\UNC\`) prefix that
/// canonical Windows paths carry.
#[must_use]
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(local) = text.strip_prefix(r"\\?\") {
            return local.to_owned();
        }
    }
    text.into_owned()
}

/// Removes `.` and `..` components without touching the file system. `..` at the root stays
/// at the root.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // At the root (or a bare prefix) there is nothing to remove.
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalizes `path` whether or not it exists: the existing part is resolved by the
/// operating system, a dangling symlink is followed through its target, and missing trailing
/// components are appended unchanged. `path` must be absolute and normalized.
fn canonicalize_lenient(path: &Path, hops: u32) -> Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(canonical) => return Ok(canonical),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(Error::io(path, error)),
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        // The root itself does not exist: nothing to resolve.
        return Ok(path.to_path_buf());
    };
    let parent = canonicalize_lenient(parent, hops)?;
    let candidate = parent.join(name);
    match std::fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if hops == 0 {
                return Err(Error::coded(
                    &candidate,
                    "ELOOP",
                    "too many levels of symbolic links",
                ));
            }
            // A dangling link: where it points decides the boundary, not where it sits.
            let link = std::fs::read_link(&candidate).map_err(|e| Error::io(&candidate, e))?;
            let target = parent.join(link);
            canonicalize_lenient(&normalize(&target), hops - 1)
        }
        _ => Ok(candidate),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn resolves_relative_and_absolute_paths_inside_the_root() {
        let tree = TempTree::new("scope-inside");
        tree.dir("ws 工作区/src");
        let root = tree.path("ws 工作区");
        let scope = Scope::new(&root, &root.join("src")).expect("scope");
        let canonical_root = std::fs::canonicalize(&root).expect("canonical");
        assert_eq!(
            scope.resolve("新 文件.txt").expect("inside"),
            canonical_root.join("src").join("新 文件.txt")
        );
        assert_eq!(
            scope.resolve("../a/./b/../c.txt").expect("inside"),
            canonical_root.join("a").join("c.txt")
        );
        let absolute = root.join("src").to_string_lossy().into_owned();
        assert_eq!(
            scope.resolve(&absolute).expect("inside"),
            canonical_root.join("src")
        );
    }

    #[test]
    fn refuses_paths_that_leave_the_root() {
        let tree = TempTree::new("scope-outside");
        tree.dir("ws");
        tree.file("secret.txt", "s");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        for requested in [
            "../secret.txt".to_owned(),
            tree.path("secret.txt").to_string_lossy().into_owned(),
            "../../../../../../../../etc".to_owned(),
        ] {
            let error = scope.resolve(&requested).expect_err("outside");
            assert!(
                matches!(error, Error::OutsideWorkspace { .. }),
                "{requested}: {error}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks_including_dangling_ones() {
        let tree = TempTree::new("scope-links");
        tree.dir("ws/inner");
        tree.dir("outside");
        tree.file("outside/target.txt", "t");
        tree.symlink("../outside/target.txt", "ws/out-file");
        tree.symlink("../outside", "ws/out-dir");
        tree.symlink("../outside/not-yet.txt", "ws/dangling");
        tree.symlink("inner", "ws/in-dir");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        for requested in ["out-file", "out-dir/new.txt", "dangling"] {
            assert!(
                matches!(
                    scope.resolve(requested),
                    Err(Error::OutsideWorkspace { .. })
                ),
                "{requested}"
            );
        }
        let inner = std::fs::canonicalize(tree.path("ws/inner")).expect("canonical");
        assert_eq!(
            scope.resolve("in-dir/x.txt").expect("inside"),
            inner.join("x.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlink_loops() {
        let tree = TempTree::new("scope-loop");
        tree.dir("ws");
        tree.symlink("b", "ws/a");
        tree.symlink("a", "ws/b");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        let error = scope.resolve("a").expect_err("loop");
        assert_eq!(error.code(), Some("ELOOP"), "{error}");
    }

    #[test]
    fn a_working_directory_outside_the_root_is_refused() {
        let tree = TempTree::new("scope-cwd");
        tree.dir("ws");
        tree.dir("other");
        let error = Scope::new(&tree.path("ws"), &tree.path("other")).expect_err("outside");
        assert!(matches!(error, Error::OutsideWorkspace { .. }), "{error}");
    }
}
