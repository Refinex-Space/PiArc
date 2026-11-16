//! What a sandboxed command may touch, and the path normalization behind it.

use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// Paths no sandboxed command may write, matched at any depth below every writable directory
/// (architecture section 6.10).
///
/// The list is narrower than the file tools' protected paths (section 6.1.2): `.git/` as a
/// whole stays writable so `git add` and `git commit` work, and only what makes git run code
/// or change behaviour later is protected. Each entry is `/`-separated; `*` matches one path
/// component and `**` one or more. Protected directories are protected with everything below.
///
/// | Entry | Why |
/// |---|---|
/// | `.git/hooks`, `.git/modules/**/hooks` | hooks run on later git commands, outside the sandbox |
/// | `.git/config`, `.git/config.worktree`, `.git/modules/**/config`, `.git/worktrees/*/config.worktree` | `core.hooksPath`, `core.fsmonitor`, aliases and filters run code |
/// | `.piarc`, `.claude`, `.pi` | PiArc, Claude Code and Pi project settings: permission rules, hooks, extensions |
/// | `.mcp.json` | MCP servers start as processes outside the sandbox |
/// | `.vscode`, `.idea` | editor tasks and settings that run code |
/// | `.gitconfig` | a git configuration file |
/// | `.bashrc`, `.bash_profile`, `.bash_login`, `.bash_logout`, `.profile`, `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin`, `.zlogout` | shell configuration files run by later shells |
///
/// Consequence: `git init`, `git clone` and `git config` (which write `.git/config` or
/// `.git/hooks`) fail inside the sandbox; `git status`, `add`, `commit`, `log`, `diff` work.
pub const PROTECTED_PATHS: &[&str] = &[
    ".git/hooks",
    ".git/config",
    ".git/config.worktree",
    ".git/modules/**/hooks",
    ".git/modules/**/config",
    ".git/worktrees/*/config.worktree",
    ".piarc",
    ".claude",
    ".pi",
    ".mcp.json",
    ".vscode",
    ".idea",
    ".gitconfig",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".zlogout",
];

/// The sandbox of one session, as Core describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPolicy {
    /// The workspace root: writable.
    pub workspace_root: PathBuf,
    /// The session's temporary directory: writable, `TMPDIR` and the package caches.
    pub session_tmp: PathBuf,
    /// Directories added to the session: writable.
    pub extra_dirs: Vec<PathBuf>,
    /// Paths nothing in the sandbox may read (for example `~/.ssh`); they need not exist.
    pub deny_read: Vec<PathBuf>,
    /// Paths nobody may write below any writable directory, in [`PROTECTED_PATHS`] syntax.
    pub protected: Vec<String>,
}

impl SandboxPolicy {
    /// A policy with the default [`PROTECTED_PATHS`], no extra directories and no `denyRead`.
    #[must_use]
    pub fn new(workspace_root: PathBuf, session_tmp: PathBuf) -> Self {
        Self {
            workspace_root,
            session_tmp,
            extra_dirs: Vec::new(),
            deny_read: Vec::new(),
            protected: PROTECTED_PATHS.iter().map(|&p| p.to_owned()).collect(),
        }
    }

    /// The policy with every path absolute, normalized and with symlinks resolved, which is
    /// how Seatbelt sees the paths a command touches.
    ///
    /// # Errors
    ///
    /// A path is relative, a writable directory does not exist, or a path is not UTF-8.
    pub fn resolve(&self) -> Result<ResolvedPolicy> {
        let session_tmp = resolve_existing(&self.session_tmp)?;
        let mut writable = vec![resolve_existing(&self.workspace_root)?];
        for dir in std::iter::once(session_tmp.clone()).chain(
            self.extra_dirs
                .iter()
                .map(|dir| resolve_existing(dir))
                .collect::<Result<Vec<_>>>()?,
        ) {
            if !writable.contains(&dir) {
                writable.push(dir);
            }
        }
        let mut deny_read = Vec::new();
        for path in &self.deny_read {
            let path = resolve_maybe_missing(path)?;
            if !deny_read.contains(&path) {
                deny_read.push(path);
            }
        }
        Ok(ResolvedPolicy {
            writable,
            session_tmp,
            deny_read,
            protected: self.protected.clone(),
        })
    }
}

/// A [`SandboxPolicy`] with canonical paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPolicy {
    /// Writable directories: the workspace root, the session's temporary directory, then the
    /// extra directories, without duplicates.
    pub writable: Vec<PathBuf>,
    /// The session's temporary directory (also in `writable`).
    pub session_tmp: PathBuf,
    /// Unreadable paths.
    pub deny_read: Vec<PathBuf>,
    /// Protected path patterns.
    pub protected: Vec<String>,
}

/// The canonical form of an existing directory.
fn resolve_existing(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::NotAbsolute {
            path: path.to_path_buf(),
        });
    }
    let resolved = std::fs::canonicalize(path).map_err(|source| Error::Resolve {
        path: path.to_path_buf(),
        source,
    })?;
    utf8(resolved)
}

/// The canonical form of a path that may not exist: the longest existing ancestor resolved,
/// the rest appended after removing `.` and `..` lexically.
fn resolve_maybe_missing(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::NotAbsolute {
            path: path.to_path_buf(),
        });
    }
    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                lexical.pop();
            }
            Component::CurDir => {}
            other => lexical.push(other),
        }
    }
    let mut existing = lexical.as_path();
    let mut rest = Vec::new();
    let base = loop {
        match std::fs::canonicalize(existing) {
            Ok(base) => break base,
            Err(source) => {
                let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
                    return Err(Error::Resolve {
                        path: path.to_path_buf(),
                        source,
                    });
                };
                rest.push(name);
                existing = parent;
            }
        }
    };
    utf8(
        rest.into_iter()
            .rev()
            .fold(base, |dir, name| dir.join(name)),
    )
}

fn utf8(path: PathBuf) -> Result<PathBuf> {
    if path.to_str().is_some() {
        Ok(path)
    } else {
        Err(Error::NotUtf8 { path })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-sandbox-policy-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::canonicalize(dir).expect("canonical temp dir")
    }

    #[test]
    fn writable_directories_are_canonical_and_unique() {
        let base = temp("unique");
        let ws = base.join("工作 区");
        std::fs::create_dir_all(ws.join("sub")).expect("dirs");
        let mut policy = SandboxPolicy::new(ws.join("sub").join(".."), base.clone());
        policy.extra_dirs.push(ws.clone());
        let resolved = policy.resolve().expect("resolves");
        assert_eq!(resolved.writable, vec![ws, base.clone()]);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_resolve_to_their_targets() {
        let base = temp("links");
        std::fs::create_dir_all(base.join("real")).expect("dir");
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).expect("link");
        let mut policy = SandboxPolicy::new(base.join("link"), base.clone());
        policy
            .deny_read
            .push(base.join("link").join("missing").join("..").join("secret"));
        let resolved = policy.resolve().expect("resolves");
        assert_eq!(resolved.writable[0], base.join("real"));
        assert_eq!(resolved.deny_read, vec![base.join("real").join("secret")]);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn missing_or_relative_directories_are_rejected() {
        let base = temp("missing");
        let missing = SandboxPolicy::new(base.join("nope"), base.clone()).resolve();
        assert!(matches!(missing, Err(Error::Resolve { .. })), "{missing:?}");
        let relative = SandboxPolicy::new(PathBuf::from("rel"), base.clone()).resolve();
        assert!(
            matches!(relative, Err(Error::NotAbsolute { .. })),
            "{relative:?}"
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }
}
