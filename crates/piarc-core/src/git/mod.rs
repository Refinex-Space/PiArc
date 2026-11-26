//! The Git panel in Core (ADR-0084, ADR-0085, ADR-0086): state shared by every session's
//! requests (one write lock per repository, cancellable operations, repositories seen by
//! `probe`), the user's Git settings, protected branches, and what of git's words reaches the
//! page (failure kinds, URL user info and escape sequences removed, redacted, cut).
//!
//! The requests themselves are answered by the session layer (`sessions/git.rs`), which knows
//! a session's file root, project, trust and running turns.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use piarc_git::{Cancel, GitError, Repo};
use piarc_protocol::git::{GitFailure, GitFailureKind, GitPullMode};
use serde::Serialize;
use serde_json::{Value, json};

mod message;
pub(crate) mod restore;
pub(crate) mod write;


/// The route of `core/git` events.
pub const GIT_ROUTE: &str = "core/git";

/// The most bytes of git's words a reply carries.
const MESSAGE_LIMIT: usize = 4 * 1024;

/// The longest operation id a client may name.
const MAX_OP_ID: usize = 128;

/// Shared by the panel's requests in one Core.
#[derive(Default)]
pub(crate) struct GitState {
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    ops: Mutex<HashMap<String, Cancel>>,
    repos: Mutex<HashMap<PathBuf, Repo>>,
    /// Rollbacks that can be undone.
    pub(crate) restores: restore::Restores,
}

fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Unregisters a cancellable operation when dropped.
pub(crate) struct OpRegistration<'a> {
    state: &'a GitState,
    id: Option<String>,
}

impl Drop for OpRegistration<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            guard(&self.state.ops).remove(id);
        }
    }
}

impl GitState {
    /// The write lock of the repository whose common git directory is `common` (ADR-0085
    /// rule 5).
    pub fn lock_for(&self, common: &Path) -> Arc<tokio::sync::Mutex<()>> {
        guard(&self.locks)
            .entry(common.to_owned())
            .or_default()
            .clone()
    }

    /// A cancel token for an operation, registered under `op_id` while the registration
    /// lives.
    pub fn begin(&self, op_id: Option<&str>) -> (Cancel, OpRegistration<'_>) {
        let cancel = Cancel::new();
        let id = op_id
            .filter(|id| !id.is_empty() && id.len() <= MAX_OP_ID)
            .map(str::to_owned);
        if let Some(id) = &id
            && let Some(previous) = guard(&self.ops).insert(id.clone(), cancel.clone())
        {
            previous.cancel();
        }
        (cancel, OpRegistration { state: self, id })
    }

    /// Cancels operation `op_id`; whether one was running.
    pub fn cancel(&self, op_id: &str) -> bool {
        guard(&self.ops).get(op_id).map(Cancel::cancel).is_some()
    }

    /// The repository last opened for file root `root`.
    pub fn cached_repo(&self, root: &Path) -> Option<Repo> {
        guard(&self.repos).get(root).cloned()
    }

    /// Remembers the repository of file root `root`.
    pub fn remember_repo(&self, root: &Path, repo: Repo) {
        let mut repos = guard(&self.repos);
        if repos.len() > 256 {
            repos.clear();
        }
        repos.insert(root.to_owned(), repo);
    }
}

/// The user's Git settings (user file and managed settings only; ADR-0085).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitSettings {
    /// Prefilled in new branch names.
    pub branch_prefix: String,
    /// Branch patterns (`*` wildcard) never force-pushed.
    pub protected: Vec<String>,
    /// Push with lease every time.
    pub always_force_push: bool,
    /// How pulls integrate.
    pub pull_mode: GitPullMode,
}

/// The protected branches when the user set none.
pub(crate) const DEFAULT_PROTECTED: &[&str] = &["main", "master"];

/// Reads the Git settings from merged settings, taking the user's file and managed settings
/// only (project files cannot loosen protection).
#[must_use]
pub(crate) fn settings_of(settings: &piarc_config::Settings) -> GitSettings {
    let text = |pointer: &str| {
        settings
            .user_value(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let protected = settings
        .user_value("/git/protectedBranches")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .take(32)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| DEFAULT_PROTECTED.iter().map(|&s| s.to_owned()).collect());
    let pull_mode = match text("/git/pullMode").as_deref() {
        Some("merge") => GitPullMode::Merge,
        Some("rebase") => GitPullMode::Rebase,
        Some("ffOnly") => GitPullMode::FfOnly,
        _ => GitPullMode::Config,
    };
    GitSettings {
        branch_prefix: text("/git/branchPrefix").unwrap_or_default(),
        protected,
        always_force_push: settings
            .user_value("/git/alwaysForcePush")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pull_mode,
    }
}

/// Whether `branch` matches one of `patterns` (`*` matches any run of characters).
#[must_use]
pub(crate) fn is_protected(branch: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| glob(p.as_bytes(), branch.as_bytes()))
}

fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => (0..=text.len()).any(|i| glob(rest, &text[i..])),
        Some((&c, rest)) => text.split_first().is_some_and(|(&t, tail)| t == c && glob(rest, tail)),
    }
}

/// git's words made safe to show: escape sequences and URL user info removed, redacted, cut.
#[must_use]
pub(crate) fn clean(text: &str) -> String {
    let plain = strip_escapes(text);
    let plain = strip_userinfo(&plain);
    let redacted = piarc_telemetry::redact::redact(&plain).text.into_owned();
    let trimmed = redacted.trim();
    if trimmed.len() <= MESSAGE_LIMIT {
        return trimmed.to_owned();
    }
    let mut cut = MESSAGE_LIMIT;
    while !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &trimmed[..cut])
}

/// Removes ANSI escape sequences and other control characters except line breaks and tabs.
fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // CSI: parameters and intermediates up to a final byte in `@`..`~`.
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else if c == '\n' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// `scheme://user:pass@host` and `scheme://token@host` become `scheme://host`.
fn strip_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (before, after) = rest.split_at(at + 3);
        out.push_str(before);
        let end = after
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(after.len());
        let authority = &after[..end];
        match authority.rfind('@') {
            Some(i) => out.push_str(&authority[i + 1..]),
            None => out.push_str(authority),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// The failure a git error stands for.
#[must_use]
pub(crate) fn failure_of(error: &GitError) -> GitFailure {
    match error {
        GitError::Spawn(e) if e.kind() == std::io::ErrorKind::NotFound => {
            GitFailure::of(GitFailureKind::GitMissing)
        }
        GitError::Spawn(e) | GitError::Wait(e) => {
            GitFailure::new(GitFailureKind::Failed, clean(&e.to_string()))
        }
        GitError::TimedOut { .. } => GitFailure::of(GitFailureKind::TimedOut),
        GitError::Cancelled { .. } => GitFailure::of(GitFailureKind::Cancelled),
        GitError::Failed { stderr, .. } => classify(stderr),
    }
}

/// The failure kind git's standard error points to.
#[must_use]
pub(crate) fn classify(stderr: &str) -> GitFailure {
    let lower = stderr.to_ascii_lowercase();
    let kind = if lower.contains("index.lock") || lower.contains(".lock': file exists") {
        GitFailureKind::Busy
    } else if is_auth_failure(&lower) {
        GitFailureKind::Auth
    } else {
        GitFailureKind::Failed
    };
    GitFailure::new(kind, clean(stderr))
}

/// Credential failures (publickey, authentication, missing username, host key, disabled
/// prompts): the panel offers to run the command in the terminal (ADR-0085 rule 3).
#[must_use]
pub(crate) fn is_auth_failure(lower: &str) -> bool {
    [
        "permission denied (publickey",
        "authentication failed",
        "could not read username",
        "could not read password",
        "host key verification failed",
        "terminal prompts disabled",
        "invalid username or password",
        "access denied",
        "403 forbidden",
        "returned error: 401",
        "returned error: 403",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// `{ "result": value }`.
pub(crate) fn reply<T: Serialize>(value: &T) -> crate::Result<Value> {
    Ok(json!({ "result": value }))
}

/// `{ "failure": failure }`.
pub(crate) fn reply_failure(failure: GitFailure) -> crate::Result<Value> {
    Ok(json!({ "failure": failure }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_patterns_match_whole_names() {
        let patterns = vec!["main".to_owned(), "release/*".to_owned()];
        assert!(is_protected("main", &patterns));
        assert!(is_protected("release/1.0", &patterns));
        assert!(!is_protected("mainline", &patterns));
        assert!(!is_protected("feature/main", &patterns));
    }

    #[test]
    fn git_words_lose_tokens_escapes_and_user_info() {
        let text = "\u{1b}[31mfatal:\u{1b}[0m could not push to https://user:hunter22@host/x.git\n\
remote: https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b";
        let out = clean(text);
        assert!(!out.contains("hunter22"), "{out}");
        assert!(!out.contains("ghp_"), "{out}");
        assert!(!out.contains('\u{1b}'), "{out}");
        assert!(out.contains("https://host/x.git"), "{out}");
        assert!(out.contains("https://github.com/a/b"), "{out}");
    }

    #[test]
    fn stderr_classes() {
        assert_eq!(
            classify("fatal: Unable to create '/r/.git/index.lock': File exists.").kind,
            GitFailureKind::Busy
        );
        assert_eq!(
            classify("git@github.com: Permission denied (publickey).").kind,
            GitFailureKind::Auth
        );
        assert_eq!(classify("fatal: bad revision").kind, GitFailureKind::Failed);
    }

    #[test]
    fn operations_cancel_by_id() {
        let state = GitState::default();
        let (cancel, registration) = state.begin(Some("op-1"));
        assert!(state.cancel("op-1"));
        assert!(cancel.is_cancelled());
        drop(registration);
        assert!(!state.cancel("op-1"));
    }
}
