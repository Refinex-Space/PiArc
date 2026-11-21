//! Telling the model which path the sandbox refused (T39, architecture section 6.10).
//!
//! Seatbelt refuses an operation with `EPERM`, which programs print as "Operation not
//! permitted" (bash, coreutils, git, Python's `PermissionError: [Errno 1]`, Node's `EPERM`)
//! next to the path they tried. [`file_denials`] reads those lines of a failed command's output,
//! takes the paths they name (quoted, or the field before the message) and keeps the ones the
//! command's policy actually forbids: outside every writable directory, below a protected
//! path, or inside a `denyRead` path. A path the policy allows was refused by something else
//! (file permissions, System Integrity Protection) and is not reported as the sandbox's.
//!
//! This reads output, not the kernel's log: a program that hides its error, or names no path,
//! gives nothing to report; the tool result then only says the command ran sandboxed.

use std::path::{Component, Path, PathBuf};

use crate::policy::{ResolvedPolicy, resolve_maybe_missing};

/// At most this many denials are reported for one command.
pub const MAX_DENIALS: usize = 10;

/// The message `EPERM` prints as, lower case.
const EPERM: &str = "operation not permitted";

/// What the sandbox refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Reading a `denyRead` path.
    Read,
    /// Writing outside the writable directories or below a protected path.
    Write,
}

/// One refused path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDenial {
    /// The path, absolute and with symbolic links resolved as far as it exists.
    pub path: PathBuf,
    /// What was refused.
    pub operation: Operation,
}

/// The paths of `output` (a command's output, run in `cwd`) the policy refused, in order of
/// appearance, without duplicates, at most [`MAX_DENIALS`].
#[must_use]
pub fn file_denials(output: &str, cwd: &Path, policy: &ResolvedPolicy) -> Vec<FileDenial> {
    let mut found: Vec<FileDenial> = Vec::new();
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains(EPERM) && !lower.contains("eperm") {
            continue;
        }
        for candidate in candidates(line) {
            let path = cwd.join(candidate);
            let Ok(path) = resolve_maybe_missing(&normalize(&path)) else {
                continue;
            };
            let Some(operation) = refused(policy, &path) else {
                continue;
            };
            if found.iter().all(|d| d.path != path) {
                found.push(FileDenial { path, operation });
            }
            if found.len() == MAX_DENIALS {
                return found;
            }
        }
    }
    found
}

/// What the policy forbids about `path`, if anything.
fn refused(policy: &ResolvedPolicy, path: &Path) -> Option<Operation> {
    if policy.deny_read.iter().any(|d| within(path, d)) {
        return Some(Operation::Read);
    }
    let Some(dir) = policy.writable.iter().find(|w| within(path, w)) else {
        return Some(Operation::Write);
    };
    let relative = strip(path, dir)?;
    protected(&relative, &policy.protected).then_some(Operation::Write)
}

/// The strings of `line` that may be the path it complains about.
fn candidates(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    for quote in ['\'', '"', '`'] {
        let parts: Vec<&str> = line.split(quote).collect();
        out.extend(
            parts
                .iter()
                .skip(1)
                .step_by(2)
                .take(parts.len().saturating_sub(1) / 2)
                .map(|s| (*s).to_owned()),
        );
    }
    let lower = line.to_ascii_lowercase();
    if let Some(at) = lower.find(EPERM) {
        let before = line[..at]
            .trim_end()
            .trim_end_matches(':')
            .trim_end_matches(',');
        let field = before.rsplit(": ").next().unwrap_or(before).trim();
        out.push(field.to_owned());
        if let Some(last) = field.split_whitespace().last()
            && last != field
        {
            out.push(last.to_owned());
        }
    }
    out.retain(|c| looks_like_path(c));
    out
}

fn looks_like_path(text: &str) -> bool {
    !text.is_empty()
        && text.len() < 4096
        && !text.contains('\n')
        && (text.contains('/') || text.starts_with('.') || text.starts_with('~'))
        && !text.contains("://")
}

/// `path` without `.` and `..`.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// Whether `path` is `dir` or below it, ignoring ASCII case (the default APFS volume is
/// case-insensitive, and so are Seatbelt's matches on it).
fn within(path: &Path, dir: &Path) -> bool {
    strip(path, dir).is_some()
}

fn strip(path: &Path, dir: &Path) -> Option<Vec<String>> {
    let mut path = path.components();
    for part in dir.components() {
        let next = path.next()?;
        if !next
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&part.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    Some(
        path.map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect(),
    )
}

/// Whether the components `relative` (below a writable directory) are at or below one of the
/// protected patterns, matched at any depth (`*` one component, `**` one or more).
fn protected(relative: &[String], patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        let parts: Vec<&str> = pattern.split('/').collect();
        (0..relative.len()).any(|start| matches_prefix(&relative[start..], &parts))
    })
}

/// Whether `parts` matches the start of `components`.
fn matches_prefix(components: &[String], parts: &[&str]) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return true;
    };
    match *first {
        "**" => (1..=components.len()).any(|n| matches_prefix(&components[n..], rest)),
        "*" => !components.is_empty() && matches_prefix(&components[1..], rest),
        literal => components.first().is_some_and(|c| {
            c.eq_ignore_ascii_case(literal) && matches_prefix(&components[1..], rest)
        }),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::policy::PROTECTED_PATHS;

    fn policy() -> ResolvedPolicy {
        ResolvedPolicy {
            writable: vec![PathBuf::from("/ws"), PathBuf::from("/data/s1/tmp")],
            session_tmp: PathBuf::from("/data/s1/tmp"),
            deny_read: vec![PathBuf::from("/nohome/u/.ssh")],
            protected: PROTECTED_PATHS.iter().map(|&p| p.to_owned()).collect(),
        }
    }

    fn found(output: &str) -> Vec<(String, Operation)> {
        file_denials(output, Path::new("/ws/sub"), &policy())
            .into_iter()
            .map(|d| (d.path.to_string_lossy().into_owned(), d.operation))
            .collect()
    }

    #[test]
    fn common_error_messages_name_the_refused_path() {
        let output = "\
touch: /outside/a.txt: Operation not permitted
/bin/bash: line 1: ../../outside/b.txt: Operation not permitted
cat: /nohome/u/.ssh/id_ed25519: Operation not permitted
PermissionError: [Errno 1] Operation not permitted: '/nohome/u/elsewhere.txt'
Error: EPERM: operation not permitted, open '/ws/.git/hooks/pre-commit'
error: could not lock config file .git/config: Operation not permitted
mkdir: /ws/sub/ok: Operation not permitted
";
        assert_eq!(
            found(output),
            [
                ("/outside/a.txt".to_owned(), Operation::Write),
                ("/outside/b.txt".to_owned(), Operation::Write),
                ("/nohome/u/.ssh/id_ed25519".to_owned(), Operation::Read),
                ("/nohome/u/elsewhere.txt".to_owned(), Operation::Write),
                ("/ws/.git/hooks/pre-commit".to_owned(), Operation::Write),
                ("/ws/sub/.git/config".to_owned(), Operation::Write),
            ]
        );
    }

    #[test]
    fn paths_the_policy_allows_and_other_lines_are_not_reported() {
        assert!(found("mkdir: /ws/sub/ok: Operation not permitted\n").is_empty());
        assert!(found("cat: /outside/x: No such file or directory\n").is_empty());
        assert!(found("curl: (56) CONNECT tunnel failed, response 403\n").is_empty());
    }

    #[test]
    fn protected_patterns_match_at_any_depth() {
        let patterns: Vec<String> = PROTECTED_PATHS.iter().map(|&p| p.to_owned()).collect();
        let parts = |p: &str| p.split('/').map(str::to_owned).collect::<Vec<_>>();
        assert!(protected(&parts("a/.claude/settings.json"), &patterns));
        assert!(protected(
            &parts(".git/modules/x/y/hooks/pre-push"),
            &patterns
        ));
        assert!(protected(
            &parts(".git/worktrees/w/config.worktree"),
            &patterns
        ));
        assert!(protected(&parts(".CLAUDE"), &patterns));
        assert!(!protected(&parts(".git/objects/ab"), &patterns));
        assert!(!protected(&parts("src/main.rs"), &patterns));
    }
}
