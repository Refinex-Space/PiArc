//! What a session may do without asking (architecture section 6.1.2, "路径边界" and "受保护路径").
//!
//! Reading needs approval outside the session's directories; writing needs it there too, and
//! for protected paths inside them:
//!
//! - any component named `.git`, `.piarc`, `.claude` or `.pi` (version control and the agents'
//!   own configuration);
//! - shell configuration files, by file name ([`SHELL_CONFIG_FILES`]);
//! - project files that name programs to run ([`PROTECTED_FILES`]: `.mcp.json`).
//!
//! On case-insensitive volumes the names match in any case. This crate only marks such
//! operations ([`crate::Error::NeedsApproval`]); deciding them is the caller's (Core's
//! adjudication, approvals from T20 on).

use std::fmt;
use std::path::Path;

/// Directories whose content is never written without asking.
pub const PROTECTED_DIRS: [&str; 4] = [".git", ".piarc", ".claude", ".pi"];

/// Project files that name programs to run: the project's MCP servers (R4 M3; the sandbox
/// protects the same file).
pub const PROTECTED_FILES: [&str; 1] = [".mcp.json"];

/// Files a shell or terminal runs at startup: writing one changes every later command.
pub const SHELL_CONFIG_FILES: [&str; 17] = [
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
    ".cshrc",
    ".tcshrc",
    ".login",
    ".logout",
    "config.fish",
    "profile.ps1",
    "Microsoft.PowerShell_profile.ps1",
];

/// Reading or writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Access {
    /// Reading content or metadata, listing, searching.
    Read,
    /// Creating, replacing or appending to a file; creating a directory.
    Write,
}

impl Access {
    /// The wire name (`read`, `write`).
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

impl fmt::Display for Access {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Read => "Reading",
            Self::Write => "Writing",
        })
    }
}

/// Why an operation needs the user's approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalReason {
    /// The path is outside the session's directories.
    OutsideWorkspace {
        /// The directories the session may use (workspace root first).
        allowed: Vec<String>,
    },
    /// The path is protected: `name` is the protected directory (with a trailing `/`) or file.
    ProtectedPath {
        /// For example `.git/` or `.zshrc`.
        name: String,
    },
}

impl ApprovalReason {
    /// The wire name (`outsideWorkspace`, `protectedPath`).
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::OutsideWorkspace { .. } => "outsideWorkspace",
            Self::ProtectedPath { .. } => "protectedPath",
        }
    }
}

impl fmt::Display for ApprovalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutsideWorkspace { allowed } => write!(
                f,
                "it is outside the session's directories ({})",
                allowed.join(", ")
            ),
            Self::ProtectedPath { name } => write!(f, "{name} is a protected path"),
        }
    }
}

/// The protected directory (as `name/`) or file that `relative` (a path inside one of the
/// session's directories) runs through, if any.
#[must_use]
pub fn protected_component(relative: &Path, case_insensitive: bool) -> Option<String> {
    let same = |a: &str, b: &str| {
        if case_insensitive {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let components: Vec<_> = relative
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    for (index, component) in components.iter().enumerate() {
        if let Some(dir) = PROTECTED_DIRS.iter().find(|d| same(component, d)) {
            return Some(format!("{dir}/"));
        }
        let last = index + 1 == components.len();
        if last
            && let Some(file) = SHELL_CONFIG_FILES
                .iter()
                .chain(PROTECTED_FILES.iter())
                .find(|f| same(component, f))
        {
            return Some((*file).to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_names_match_whole_components() {
        let check = |p: &str| protected_component(Path::new(p), false);
        assert_eq!(check(".git/hooks/pre-commit").as_deref(), Some(".git/"));
        assert_eq!(check("a/.pi").as_deref(), Some(".pi/"));
        assert_eq!(check("home/.zprofile").as_deref(), Some(".zprofile"));
        assert_eq!(check(".gitattributes"), None);
        assert_eq!(check(".zshrc.d/plugin.zsh"), None);
        // A directory named like a shell file is not one.
        assert_eq!(check(".profile/notes.txt"), None);
        assert_eq!(check(".GIT/config"), None);
        // R4 M3: the project's MCP servers, as in the sandbox's protected paths.
        assert_eq!(check(".mcp.json").as_deref(), Some(".mcp.json"));
        assert_eq!(check(".mcp.json.bak"), None);
        assert_eq!(
            protected_component(Path::new(".GIT/config"), true).as_deref(),
            Some(".git/")
        );
    }
}
