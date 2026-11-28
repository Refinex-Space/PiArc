//! Which Claude Code rule files a scan includes. Unconditional rules always; a rule with
//! `paths:` when it was delivered earlier in the session (the Host names it) or one of the
//! files just read or written matches its globs relative to the workspace root.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use piarc_config::rules::{PathMatcher, parse, relative_to, rule_files};
use piarc_fs::{DirectoryBinding, Scope, display};

/// The Host's view of the session for one scan.
#[derive(Debug, Clone, Default)]
pub(in crate::tool_io) struct RuleQuery {
    /// Files read or written since the previous scan (absolute paths).
    pub(in crate::tool_io) files: Vec<PathBuf>,
    /// Conditional rules already delivered (their memory file paths).
    pub(in crate::tool_io) active: Vec<String>,
}

#[derive(Default)]
pub(super) struct Selection {
    /// Included rule sources and their globs.
    pub(super) globs: HashMap<PathBuf, Option<Vec<String>>>,
    /// Some conditional rule was left out.
    pub(super) inactive: bool,
}

impl Selection {
    /// Appends the included rules of `dir` to `out`.
    pub(super) fn add(
        &mut self,
        scope: &Scope,
        dir: &Path,
        query: &RuleQuery,
        out: &mut Vec<PathBuf>,
    ) -> io::Result<()> {
        for file in rule_files(dir)? {
            let Some(target) = locate(scope, &file) else {
                continue;
            };
            let paths = match frontmatter(&target)? {
                None => None,
                Some(globs) => match included(scope, &target, &globs, query) {
                    Some(true) => Some(globs),
                    Some(false) => {
                        self.inactive = true;
                        continue;
                    }
                    // Invalid or empty `paths:`: the rule can never load.
                    None => continue,
                },
            };
            self.globs.insert(file.clone(), paths);
            out.push(file);
        }
        Ok(())
    }
}

fn locate(scope: &Scope, file: &Path) -> Option<PathBuf> {
    scope.locate(&display(file)).ok()
}

/// The `paths:` globs of a rule file; `None` for an unconditional (or unreadable) rule.
fn frontmatter(target: &Path) -> io::Result<Option<Vec<String>>> {
    let binding = DirectoryBinding::capture(target).map_err(io::Error::other)?;
    Ok(super::read_limited(target, &binding)?.and_then(|text| parse(&text).paths))
}

/// `None` when the rule can never load (no globs, or an invalid one).
fn included(scope: &Scope, target: &Path, globs: &[String], query: &RuleQuery) -> Option<bool> {
    if globs.is_empty() {
        return None;
    }
    let matcher = match PathMatcher::new(globs) {
        Ok(matcher) => matcher,
        Err(reason) => {
            let shown = display(target);
            tracing::warn!(target: "piarc_core", path = %shown, "Rule with invalid paths: {reason}");
            return None;
        }
    };
    if query.active.iter().any(|p| *p == display(target)) {
        return Some(true);
    }
    Some(query.files.iter().any(|file| {
        relative_to(scope.root(), &on_disk(file)).is_some_and(|relative| matcher.matches(&relative))
    }))
}

/// The Host resolves paths against the session cwd: compare on-disk spellings, by the
/// nearest existing ancestor for a file that is gone.
fn on_disk(file: &Path) -> PathBuf {
    for ancestor in file.ancestors() {
        if let Ok(real) = ancestor.canonicalize() {
            return match file.strip_prefix(ancestor) {
                Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
                _ => real,
            };
        }
    }
    file.to_owned()
}
