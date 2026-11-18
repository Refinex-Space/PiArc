//! Fuzzy file matching for `@` mentions in the composer (architecture section 8.2, ADR-0030).
//!
//! [`list_files`] walks a directory with the same ignore rules as [`crate::glob()`]
//! (`.gitignore` also outside a Git repository, `.ignore`, `.fdignore`, Git's exclude files;
//! hidden files included, `.git` itself skipped) and returns the files' paths relative to it,
//! `/`-separated, up to a cap. [`rank`] scores those paths against a query: the query's
//! characters must appear in order, case-insensitively; matches in the file name, at word
//! starts and in runs score higher, long spans and long paths lower. Both check a cancellation
//! callback so a newer query can stop an older one.

use std::path::Path;

use ignore::WalkBuilder;

use crate::error::{Error, Result};
use crate::scope::Scope;

/// Files [`list_files`] collects at most; a larger tree is searched in its first part.
pub const MAX_LISTED_FILES: usize = 200_000;

/// How often (in entries) the walk and the ranking check for cancellation.
const CANCEL_CHECK_EVERY: usize = 512;

/// The files below a directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileList {
    /// Relative paths with `/` separators, in walk order.
    pub files: Vec<String>,
    /// Whether the walk stopped at [`MAX_LISTED_FILES`].
    pub truncated: bool,
}

/// A file that matches a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMatch {
    /// The path relative to the searched directory, `/`-separated.
    pub path: String,
    /// Higher is better.
    pub score: i64,
    /// Character positions (in `char`s of `path`) the query matched, for highlighting.
    pub positions: Vec<usize>,
}

/// The files below the scope's working directory, honoring ignore files.
///
/// # Errors
///
/// The directory cannot be read ([`Error::Io`]); the search was cancelled (`ECANCELED`).
pub fn list_files(scope: &Scope, cancelled: &dyn Fn() -> bool) -> Result<FileList> {
    let root = scope.check(&scope.cwd().to_string_lossy(), crate::access::Access::Read)?;
    let mut walk = WalkBuilder::new(&root);
    walk.hidden(false)
        .require_git(false)
        .add_custom_ignore_filename(".fdignore")
        .filter_entry(|entry| entry.file_name() != ".git");
    let mut files = Vec::new();
    let mut truncated = false;
    for (seen, entry) in walk.build().filter_map(std::result::Result::ok).enumerate() {
        if seen % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return Err(cancelled_error(&root));
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() == MAX_LISTED_FILES {
            truncated = true;
            break;
        }
        files.push(relative(&root, entry.path()));
    }
    Ok(FileList { files, truncated })
}

/// The best `limit` matches of `query` among `files`, best first. An empty query lists the
/// shortest paths first.
///
/// # Errors
///
/// The search was cancelled (`ECANCELED`).
pub fn rank(
    files: &[String],
    query: &str,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<FileMatch>> {
    let needle: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    let mut matches = Vec::new();
    for (index, path) in files.iter().enumerate() {
        if index % CANCEL_CHECK_EVERY == 0 && cancelled() {
            return Err(cancelled_error(Path::new(".")));
        }
        if let Some(found) = score(path, &needle) {
            matches.push(found);
        }
    }
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    matches.truncate(limit);
    Ok(matches)
}

/// Scores one path; `None` when the query's characters do not all appear in order.
fn score(path: &str, needle: &[char]) -> Option<FileMatch> {
    let chars: Vec<char> = path.chars().collect();
    let lower: Vec<char> = chars
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let length_penalty = i64::try_from(chars.len()).unwrap_or(i64::MAX) / 4;
    if needle.is_empty() {
        return Some(FileMatch {
            path: path.to_owned(),
            score: -length_penalty,
            positions: Vec::new(),
        });
    }
    let name_start = chars.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    // Prefer a match inside the file name; fall back to the whole path.
    let positions =
        subsequence(&lower, needle, name_start).or_else(|| subsequence(&lower, needle, 0))?;
    let mut total = 0_i64;
    let mut previous: Option<usize> = None;
    for &at in &positions {
        total += 16;
        if previous.is_some_and(|p| p + 1 == at) {
            total += 12;
        }
        if is_word_start(&chars, at) {
            total += 10;
        }
        if at >= name_start {
            total += 6;
        }
        previous = Some(at);
    }
    let (first, last) = (positions[0], positions[positions.len() - 1]);
    let span = i64::try_from(last - first + 1 - positions.len()).unwrap_or(i64::MAX);
    total -= span.min(64);
    let name: String = lower[name_start..].iter().collect();
    let query: String = needle.iter().collect();
    if name == query || name.split('.').next() == Some(query.as_str()) {
        total += 200;
    } else if name.starts_with(&query) {
        total += 80;
    }
    Some(FileMatch {
        path: path.to_owned(),
        score: total - length_penalty,
        positions,
    })
}

/// Where `needle` occurs in order in `haystack[from..]`: the leftmost match, tightened from its
/// end backwards to the shortest span.
fn subsequence(haystack: &[char], needle: &[char], from: usize) -> Option<Vec<usize>> {
    let mut at = from;
    let mut end = None;
    for (i, wanted) in needle.iter().enumerate() {
        let found = haystack[at..].iter().position(|c| c == wanted)? + at;
        if i == needle.len() - 1 {
            end = Some(found);
        }
        at = found + 1;
    }
    let mut positions = vec![0; needle.len()];
    let mut cursor = end? + 1;
    for (slot, wanted) in needle.iter().enumerate().rev() {
        let found = haystack[from..cursor].iter().rposition(|c| c == wanted)? + from;
        positions[slot] = found;
        cursor = found;
    }
    Some(positions)
}

fn is_word_start(chars: &[char], at: usize) -> bool {
    match at.checked_sub(1).and_then(|i| chars.get(i)) {
        None => true,
        Some(before) => {
            matches!(before, '/' | '_' | '-' | '.' | ' ')
                || (before.is_lowercase() && chars[at].is_uppercase())
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn cancelled_error(path: &Path) -> Error {
    Error::coded(path, "ECANCELED", "the search was cancelled")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn never() -> bool {
        false
    }

    fn paths(found: &[FileMatch]) -> Vec<&str> {
        found.iter().map(|m| m.path.as_str()).collect()
    }

    #[test]
    fn lists_files_honoring_ignore_files_outside_a_repository() {
        let tree = TempTree::new("fuzzy-list");
        tree.file(".gitignore", "target/\n*.log\n");
        tree.file("src/main.rs", "");
        tree.file("src/中文 名.ts", "");
        tree.file("target/debug/out.rs", "");
        tree.file("debug.log", "");
        tree.file(".github/workflows/ci.yml", "");
        tree.file(".git/HEAD", "ref: x");
        let root = tree.path("");
        let scope = Scope::new(&root, &root).expect("scope");
        let mut listed = list_files(&scope, &never).expect("listed").files;
        listed.sort();
        assert_eq!(
            listed,
            [
                ".github/workflows/ci.yml",
                ".gitignore",
                "src/main.rs",
                "src/中文 名.ts"
            ]
        );
    }

    #[test]
    fn ranks_file_name_matches_and_word_starts_first() {
        let files: Vec<String> = [
            "apps/desktop/src/main/main.ts",
            "apps/desktop/src/renderer/main.tsx",
            "docs/maintenance.md",
            "crates/piarc-core/src/sessions/mod.rs",
            "src/composer/MentionPlugin.ts",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let found = rank(&files, "main", 10, &never).expect("ranked");
        assert_eq!(
            paths(&found)[..2],
            [
                "apps/desktop/src/main/main.ts",
                "apps/desktop/src/renderer/main.tsx"
            ]
        );
        assert!(!paths(&found).contains(&"crates/piarc-core/src/sessions/mod.rs"));
        let found = rank(&files, "mPlug", 10, &never).expect("ranked");
        assert_eq!(paths(&found), ["src/composer/MentionPlugin.ts"]);
        assert_eq!(found[0].positions.len(), 5);
        let found = rank(&files, "sesmod", 10, &never).expect("ranked");
        assert_eq!(paths(&found), ["crates/piarc-core/src/sessions/mod.rs"]);
    }

    #[test]
    fn caps_the_results_and_lists_short_paths_for_an_empty_query() {
        let files: Vec<String> = (0..30)
            .map(|i| format!("{}/f{i}.rs", "d".repeat(i % 5 + 1)))
            .collect();
        let found = rank(&files, "", 7, &never).expect("ranked");
        assert_eq!(found.len(), 7);
        assert!(found.windows(2).all(|w| w[0].path.len() <= w[1].path.len()));
        assert_eq!(rank(&files, "f", 3, &never).expect("ranked").len(), 3);
    }

    #[test]
    fn stops_when_cancelled() {
        let files: Vec<String> = (0..10).map(|i| format!("f{i}")).collect();
        let error = rank(&files, "f", 5, &|| true).expect_err("cancelled");
        assert!(error.to_string().contains("cancelled"), "{error}");
    }
}
