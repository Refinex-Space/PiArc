//! Where a session may read and write: the path boundary of architecture section 6.1.2.
//!
//! A [`Scope`] holds a session's workspace root, working directory, added directories and
//! read-only directories (the session's temporary directory), all canonical. A requested path
//! is located in three steps:
//!
//! 1. relative paths are joined to the working directory;
//! 2. `.` and `..` are removed lexically (as Node's `path.resolve` does);
//! 3. symlinks are resolved for every component that exists, including dangling links, whose
//!    targets are followed as far as they exist; missing trailing components are appended.
//!
//! [`Scope::check`] then decides the access (see [`crate::access`]): reading is allowed inside
//! the root, the added directories and the read-only directories; writing inside the root and
//! the added directories, except protected paths. Anything else is
//! [`Error::NeedsApproval`], before anything touches the target. [`Scope::resolve`] keeps the
//! plain boundary of commands (`exec/run`'s working directory): inside the root or an added
//! directory, else [`Error::OutsideWorkspace`].
//!
//! Canonical paths carry the on-disk spelling of existing components and the `\\?\` prefix on
//! Windows on both sides of the comparison, so case-insensitive volumes compare correctly;
//! [`display`] strips the prefix for messages and results. Whether the root's volume ignores
//! case is probed once ([`Scope::case_insensitive`]); [`Scope::key`] folds case on such volumes,
//! so the file state table finds a file under any spelling.
//!
//! The check happens before the operation, not atomically with it: a symlink swapped in between
//! is not caught (the sandbox narrows this for commands).

use std::io;
use std::path::{Component, Path, PathBuf};

use crate::access::{Access, ApprovalReason, protected_component};
use crate::error::{Error, Result};

/// How many symlinks one resolution follows before giving up (as `ELOOP`).
const MAX_SYMLINK_HOPS: u32 = 40;

/// A session's directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    root: PathBuf,
    cwd: PathBuf,
    /// Added directories: read and written like the root.
    extra: Vec<PathBuf>,
    /// Directories that are read without asking but never written (the session's temporary
    /// directory, where long tool results go).
    read_only: Vec<PathBuf>,
    case_insensitive: bool,
    approved: Option<(PathBuf, Access)>,
}

impl Scope {
    /// A scope rooted at `root` with working directory `cwd`.
    ///
    /// # Errors
    ///
    /// Either directory cannot be canonicalized (for example it does not exist), or `cwd`
    /// lies outside `root`.
    pub fn new(root: &Path, cwd: &Path) -> Result<Self> {
        let root = canonical_dir(root)?;
        let canonical_cwd = canonical_dir(cwd)?;
        if !canonical_cwd.starts_with(&root) {
            return Err(Error::OutsideWorkspace {
                path: display(cwd),
                resolved: display(&canonical_cwd),
                root: display(&root),
            });
        }
        let case_insensitive = probe_case_insensitive(&root);
        Ok(Self {
            root,
            cwd: canonical_cwd,
            extra: Vec::new(),
            read_only: Vec::new(),
            case_insensitive,
            approved: None,
        })
    }

    /// The scope with `dir` added: read and written like the workspace root.
    ///
    /// # Errors
    ///
    /// The directory cannot be canonicalized.
    pub fn with_added_dir(mut self, dir: &Path) -> Result<Self> {
        self.extra.push(canonical_dir(dir)?);
        Ok(self)
    }

    /// The scope with `dir` readable without asking, but not writable.
    ///
    /// # Errors
    ///
    /// The directory cannot be canonicalized.
    pub fn with_read_only_dir(mut self, dir: &Path) -> Result<Self> {
        self.read_only.push(canonical_dir(dir)?);
        Ok(self)
    }

    /// Authorizes exactly one resolved path for this copy of the scope. Callers keep it
    /// only for the low-level operation belonging to the approved tool call.
    #[must_use]
    pub fn for_approved_path(mut self, canonical: PathBuf, access: Access) -> Self {
        self.approved = Some((canonical, access));
        self
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

    /// Whether the root's volume ignores case (macOS and Windows by default).
    #[must_use]
    pub fn case_insensitive(&self) -> bool {
        self.case_insensitive
    }

    /// Locates `requested` (absolute, or relative to the working directory) as a canonical
    /// path, wherever it is. The path need not exist.
    ///
    /// # Errors
    ///
    /// A component cannot be inspected (for example a symlink loop).
    pub fn locate(&self, requested: &str) -> Result<PathBuf> {
        // Joined onto the cwd's usual spelling: below a `\\?\` prefix Windows would not treat
        // `/` as a separator.
        let joined = PathBuf::from(display(&self.cwd)).join(requested);
        canonicalize_lenient(&normalize(&joined), MAX_SYMLINK_HOPS)
    }

    /// Resolves `requested` to a canonical path inside the root or an added directory (the
    /// boundary of a command's working directory). The path need not exist.
    ///
    /// # Errors
    ///
    /// [`Error::OutsideWorkspace`] when it resolves elsewhere; an I/O error when a component
    /// cannot be inspected (for example a symlink loop).
    pub fn resolve(&self, requested: &str) -> Result<PathBuf> {
        let resolved = self.locate(requested)?;
        if self.writable_root_of(&resolved).is_some() {
            Ok(resolved)
        } else {
            Err(Error::OutsideWorkspace {
                path: requested.to_owned(),
                resolved: display(&resolved),
                root: display(&self.root),
            })
        }
    }

    /// Resolves `requested` for `access`: the canonical path when the session may do it
    /// without asking.
    ///
    /// # Errors
    ///
    /// [`Error::NeedsApproval`] for a path outside the session's directories, or a write to a
    /// protected path; an I/O error when a component cannot be inspected.
    pub fn check(&self, requested: &str, access: Access) -> Result<PathBuf> {
        let resolved = self.locate(requested)?;
        if let Some((path, allowed)) = &self.approved {
            return if path == &resolved && *allowed == access {
                Ok(resolved)
            } else {
                Err(Error::ApprovalMismatch {
                    path: display(&resolved),
                })
            };
        }
        let needs = |reason| Error::NeedsApproval {
            path: display(&resolved),
            access,
            reason,
        };
        let Some(root) = self.writable_root_of(&resolved) else {
            let readable = access == Access::Read
                && self.read_only.iter().any(|dir| resolved.starts_with(dir));
            return if readable {
                Ok(resolved)
            } else {
                Err(needs(ApprovalReason::OutsideWorkspace {
                    allowed: self.writable_roots().map(|d| display(d)).collect(),
                }))
            };
        };
        if access == Access::Write {
            let relative = resolved.strip_prefix(root).unwrap_or(&resolved);
            if let Some(name) = protected_component(relative, self.case_insensitive) {
                return Err(needs(ApprovalReason::ProtectedPath { name }));
            }
        }
        Ok(resolved)
    }

    /// The file state table's key of a canonical `path`: its usual spelling, case-folded on a
    /// case-insensitive volume.
    #[must_use]
    pub fn key(&self, path: &Path) -> String {
        let text = display(path);
        if self.case_insensitive {
            text.to_lowercase()
        } else {
            text
        }
    }

    /// How diffs name a canonical `path`: relative to the workspace root with `/`, absolute
    /// outside it.
    #[must_use]
    pub fn label(&self, path: &Path) -> String {
        match path.strip_prefix(&self.root) {
            Ok(relative) => relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            Err(_) => display(path),
        }
    }

    fn writable_roots(&self) -> impl Iterator<Item = &PathBuf> {
        std::iter::once(&self.root).chain(&self.extra)
    }

    fn writable_root_of(&self, path: &Path) -> Option<&Path> {
        self.writable_roots()
            .find(|root| path.starts_with(root))
            .map(PathBuf::as_path)
    }
}

fn canonical_dir(dir: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(dir).map_err(|e| Error::io(dir, e))
}

/// Whether the volume of the existing directory `dir` ignores case: the deepest component with
/// an ASCII letter, spelled with its letters' case swapped, names the same directory.
fn probe_case_insensitive(dir: &Path) -> bool {
    for path in dir.ancestors() {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let swapped: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            })
            .collect();
        if swapped != name {
            return match (
                std::fs::canonicalize(path.with_file_name(&swapped)),
                std::fs::canonicalize(path),
            ) {
                (Ok(other), Ok(this)) => other == this,
                _ => false,
            };
        }
    }
    // No letter anywhere in the path: assume the platforms' defaults.
    cfg!(any(windows, target_os = "macos"))
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
    fn checks_reads_and_writes_against_the_session_directories() {
        let tree = TempTree::new("scope-access");
        tree.dir("ws/src");
        tree.dir("added");
        tree.dir("tmp/tool-results");
        tree.dir("elsewhere");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws"))
            .and_then(|s| s.with_added_dir(&tree.path("added")))
            .and_then(|s| s.with_read_only_dir(&tree.path("tmp")))
            .expect("scope");
        let added = tree.path("added/x.txt").to_string_lossy().into_owned();
        let spilled = tree
            .path("tmp/tool-results/r.txt")
            .to_string_lossy()
            .into_owned();
        let elsewhere = tree.path("elsewhere/y.txt").to_string_lossy().into_owned();
        assert!(scope.check("src/a.ts", Access::Write).is_ok());
        assert!(scope.check(&added, Access::Write).is_ok());
        assert!(scope.check(&spilled, Access::Read).is_ok());
        for (path, access) in [
            (spilled.as_str(), Access::Write),
            (elsewhere.as_str(), Access::Read),
            ("../elsewhere/y.txt", Access::Write),
        ] {
            let error = scope.check(path, access).expect_err("needs approval");
            assert!(
                matches!(
                    &error,
                    Error::NeedsApproval {
                        reason: ApprovalReason::OutsideWorkspace { .. },
                        ..
                    }
                ),
                "{path}: {error}"
            );
        }
        // The command boundary covers added directories, not read-only ones.
        assert!(scope.resolve(&added).is_ok());
        assert!(matches!(
            scope.resolve(&spilled),
            Err(Error::OutsideWorkspace { .. })
        ));
    }

    #[test]
    fn protected_paths_need_approval_to_be_written_but_not_read() {
        let tree = TempTree::new("scope-protected");
        tree.dir("ws/.git");
        tree.dir("ws/sub/.claude");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        for (path, name) in [
            (".git/config", ".git/"),
            ("sub/.claude/settings.json", ".claude/"),
            (".piarc/settings.json", ".piarc/"),
            (".pi/extensions/x.ts", ".pi/"),
            (".zshrc", ".zshrc"),
            ("deep/dir/.bashrc", ".bashrc"),
        ] {
            match scope.check(path, Access::Write) {
                Err(Error::NeedsApproval {
                    reason: ApprovalReason::ProtectedPath { name: found },
                    ..
                }) => assert_eq!(found, name, "{path}"),
                other => panic!("{path}: {other:?}"),
            }
            assert!(scope.check(path, Access::Read).is_ok(), "{path}");
        }
        for path in [
            ".gitignore",
            ".github/workflows/ci.yml",
            "pi/x",
            "bashrc.md",
        ] {
            assert!(scope.check(path, Access::Write).is_ok(), "{path}");
        }
    }

    #[test]
    fn keys_fold_case_on_case_insensitive_volumes() {
        let tree = TempTree::new("scope-case");
        tree.file("ws/Readme.MD", "x");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        let a = scope.check("Readme.MD", Access::Read).expect("found");
        let b = scope.check("README.md", Access::Read).expect("found");
        if scope.case_insensitive() {
            assert_eq!(scope.key(&a), scope.key(&b));
            // Existing components carry their on-disk spelling.
            assert_eq!(a, b);
        } else {
            assert_ne!(scope.key(&a), scope.key(&b));
        }
        assert_eq!(scope.label(&a), "Readme.MD");
        if cfg!(any(windows, target_os = "macos")) {
            // The development machines and CI runners use the default volumes.
            assert!(scope.case_insensitive());
        }
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
