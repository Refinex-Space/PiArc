//! What the Git panel lets reach git's command line (ADR-0085 rule 4): branch names, revisions,
//! paths and remotes are checked before any process starts, so a value from the page cannot
//! become an option (`--upload-pack=…`), a URL or a path outside the repository.

/// A value the panel refuses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgError {
    /// Not a valid branch name.
    #[error("not a valid branch name: {0}")]
    BranchName(String),
    /// Not an acceptable revision.
    #[error("not an acceptable revision: {0}")]
    Revision(String),
    /// Not a path inside the repository.
    #[error("not a path inside the repository: {0}")]
    Path(String),
    /// Not a configured remote.
    #[error("not a configured remote: {0}")]
    Remote(String),
}

/// The most bytes of a name, revision or message line the panel passes.
const MAX_NAME: usize = 255;
/// The most bytes of a path.
const MAX_PATH: usize = 4096;

/// A branch name git accepts as `refs/heads/<name>`, not starting with `-` and not `HEAD`.
///
/// # Errors
///
/// [`ArgError::BranchName`].
pub fn check_branch_name(name: &str) -> Result<(), ArgError> {
    let bad = || Err(ArgError::BranchName(name.to_owned()));
    if name.is_empty() || name.len() > MAX_NAME || name.starts_with('-') || name == "HEAD" {
        return bad();
    }
    if !refname_ok(name) {
        return bad();
    }
    Ok(())
}

/// A revision the panel may name: a branch, `remote/branch`, a tag or a commit id. Not an
/// option, no whitespace or control characters, no revision syntax beyond plain names.
///
/// # Errors
///
/// [`ArgError::Revision`].
pub fn check_revision(rev: &str) -> Result<(), ArgError> {
    let bad = || Err(ArgError::Revision(rev.to_owned()));
    if rev.is_empty() || rev.len() > MAX_NAME || rev.starts_with('-') {
        return bad();
    }
    if rev == "HEAD" || is_object_id(rev) {
        return Ok(());
    }
    if !refname_ok(rev) {
        return bad();
    }
    Ok(())
}

/// A full or abbreviated object id (4–64 lowercase hex digits).
#[must_use]
pub fn is_object_id(value: &str) -> bool {
    (4..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A path relative to the repository's top level, with `/` separators, staying inside it.
///
/// # Errors
///
/// [`ArgError::Path`].
pub fn check_path(path: &str) -> Result<(), ArgError> {
    let bad = || Err(ArgError::Path(path.to_owned()));
    if path.is_empty() || path.len() > MAX_PATH || path.contains('\0') || path.contains('\\') {
        return bad();
    }
    if path.starts_with('/') || has_drive(path) {
        return bad();
    }
    // `.git` in any case: the repository's own files (and a submodule's) are never the panel's
    // to roll back, stage or read (a rollback of `.git/config` would delete it).
    if path.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
    }) {
        return bad();
    }
    Ok(())
}

/// One of `configured`: a remote's name, never a URL.
///
/// # Errors
///
/// [`ArgError::Remote`].
pub fn check_remote(name: &str, configured: &[String]) -> Result<(), ArgError> {
    if name.starts_with('-') || !configured.iter().any(|remote| remote == name) {
        return Err(ArgError::Remote(name.to_owned()));
    }
    Ok(())
}

fn has_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// `git check-ref-format`'s rules for one ref name (without the `refs/heads/` prefix).
fn refname_ok(name: &str) -> bool {
    if name == "@" || name.starts_with('/') || name.ends_with('/') || name.ends_with('.') {
        return false;
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return false;
    }
    let forbidden = |c: char| {
        c.is_ascii_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    };
    if name.chars().any(forbidden) {
        return false;
    }
    name.split('/')
        .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_follow_git_rules() {
        for good in ["main", "feature/登录", "fix-1.2", "a/b/c", "user@host"] {
            assert!(check_branch_name(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "-x",
            "--upload-pack=evil",
            "HEAD",
            "a..b",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "/a",
            "a/",
            "a//b",
            "a.",
            ".a",
            "a/.b",
            "a.lock",
            "a@{1}",
            "@",
            "a\u{7}",
        ] {
            assert!(check_branch_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn revisions_allow_names_and_ids_only() {
        for good in ["HEAD", "origin/main", "v1.0", "0123abcd", "refs/tags/v1"] {
            assert!(check_revision(good).is_ok(), "{good}");
        }
        for bad in ["-n", "--exec=x", "HEAD~1", "a@{u}", "main:file", "a b", ""] {
            assert!(check_revision(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn paths_stay_inside_the_repository() {
        for good in [
            "a.txt",
            "dir/中文 文件.md",
            "-leading-dash",
            ":magic",
            ".gitignore",
            ".github/workflows/ci.yml",
            "docs/.git-notes",
        ] {
            assert!(check_path(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "C:/x",
            "../x",
            "a/../../x",
            "a//b",
            "./a",
            "a\\b",
            "a\0b",
            // The repository's own files (a rollback would delete `.git/config`), in any case
            // (case-insensitive file systems) and in submodules.
            ".git",
            ".git/config",
            ".GIT/hooks/pre-commit",
            "vendor/lib/.git/config",
        ] {
            assert!(check_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn remotes_must_be_configured_names() {
        let configured = vec!["origin".to_owned(), "upstream".to_owned()];
        assert!(check_remote("origin", &configured).is_ok());
        assert!(check_remote("https://evil.example/x.git", &configured).is_err());
        assert!(check_remote("--upload-pack=x", &configured).is_err());
    }
}
