//! Finding files by glob pattern: `fs/glob`.
//!
//! Matches the behavior of `fd --glob --hidden` as Pi's native `find` tool runs it:
//!
//! - a pattern without `/` matches the entry's name at any depth; a pattern with `/` matches
//!   the path relative to the searched directory, prefixed with `**/` unless it starts with
//!   `**/` or `/` (an absolute pattern matches the absolute path);
//! - `*` does not cross `/`; an all-lowercase pattern matches case-insensitively (fd's smart
//!   case); on Windows `\` in the pattern is a separator, as Pi normalizes it;
//! - hidden entries are included, and `.gitignore` (also outside a Git repository, as Pi asks
//!   fd with `--no-require-git`), `.ignore`, `.fdignore`, `.git/info/exclude` and the global
//!   Git ignore file are honored;
//! - matching directories are listed too, with a trailing `/`.
//!
//! Results come in path order (fd's order is not deterministic). `exclude` patterns are
//! matched against the relative path; one ending in `/**` also prunes the directory itself.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use globset::{Glob, GlobBuilder, GlobMatcher, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use piarc_protocol::fs::FsGlobResult;

use crate::error::{Error, Result};
use crate::scope::{Scope, display};

/// Most matches one `fs/glob` returns.
pub const MAX_GLOB_MATCHES: u64 = 100_000;

/// What the pattern is matched against.
enum Target {
    Name,
    RelativePath,
    AbsolutePath,
}

/// Finds files and directories below `requested` whose name or path matches `pattern`.
///
/// # Errors
///
/// The directory is outside the scope, does not exist or is not a directory; a pattern does
/// not compile (`invalidParams`).
pub fn glob(
    scope: &Scope,
    requested: &str,
    pattern: &str,
    exclude: &[String],
    limit: Option<u64>,
) -> Result<FsGlobResult> {
    let root = scope.resolve(requested)?;
    let metadata = std::fs::metadata(&root).map_err(|e| Error::io(&root, e))?;
    if !metadata.is_dir() {
        return Err(Error::coded(&root, "ENOTDIR", "not a directory"));
    }
    let (matcher, target) = compile_pattern(pattern)?;
    let excluded = Arc::new(compile_exclusions(exclude)?);
    let limit = usize::try_from(limit.unwrap_or(MAX_GLOB_MATCHES).min(MAX_GLOB_MATCHES))
        .unwrap_or(usize::MAX);

    let mut walk = WalkBuilder::new(&root);
    walk.hidden(false)
        .require_git(false)
        .add_custom_ignore_filename(".fdignore")
        .sort_by_file_name(Ord::cmp);
    let prune_root = root.clone();
    let prune = Arc::clone(&excluded);
    walk.filter_entry(move |entry| {
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        !(is_dir && prune.dirs.is_match(relative(&prune_root, entry.path())))
    });

    let mut matches = Vec::new();
    let mut truncated = false;
    // Unreadable entries are skipped, as fd skips them.
    for entry in walk.build().filter_map(std::result::Result::ok) {
        if entry.depth() == 0 {
            continue;
        }
        let rel = relative(&root, entry.path());
        if excluded.paths.is_match(&rel) {
            continue;
        }
        let hit = match target {
            Target::Name => matcher.is_match(entry.file_name()),
            Target::RelativePath => matcher.is_match(&rel),
            Target::AbsolutePath => matcher.is_match(display(entry.path())),
        };
        if !hit {
            continue;
        }
        if matches.len() == limit {
            truncated = true;
            break;
        }
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        matches.push(if is_dir { format!("{rel}/") } else { rel });
    }
    Ok(FsGlobResult {
        path: display(&root),
        matches,
        truncated,
    })
}

/// Compiles the user's pattern with fd's rules.
fn compile_pattern(pattern: &str) -> Result<(GlobMatcher, Target)> {
    let pattern = if cfg!(windows) {
        pattern.replace('\\', "/")
    } else {
        pattern.to_owned()
    };
    let (effective, target) = if pattern.starts_with('/') {
        (pattern.clone(), Target::AbsolutePath)
    } else if pattern.contains('/') {
        let prefixed = if pattern.starts_with("**/") || pattern == "**" {
            pattern.clone()
        } else {
            format!("**/{pattern}")
        };
        (prefixed, Target::RelativePath)
    } else {
        (pattern.clone(), Target::Name)
    };
    let smart_case = pattern == pattern.to_lowercase();
    let glob = GlobBuilder::new(&effective)
        .literal_separator(true)
        .case_insensitive(smart_case)
        .build()
        .map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })?;
    Ok((glob.compile_matcher(), target))
}

struct Exclusions {
    /// Matched against every entry's relative path.
    paths: GlobSet,
    /// `x/**` patterns without the `/**`: directories to skip entirely.
    dirs: GlobSet,
}

fn compile_exclusions(exclude: &[String]) -> Result<Exclusions> {
    let mut paths = GlobSetBuilder::new();
    let mut dirs = GlobSetBuilder::new();
    for pattern in exclude {
        paths.add(exclusion_glob(pattern)?);
        if let Some(dir) = pattern.strip_suffix("/**") {
            dirs.add(exclusion_glob(dir)?);
        }
    }
    let build = |builder: GlobSetBuilder| {
        builder.build().map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })
    };
    Ok(Exclusions {
        paths: build(paths)?,
        dirs: build(dirs)?,
    })
}

fn exclusion_glob(pattern: &str) -> Result<Glob> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })
}

/// `path` relative to `root`, with `/` separators.
pub(crate) fn relative(root: &Path, path: &Path) -> String {
    let rel: PathBuf = path.strip_prefix(root).unwrap_or(path).to_path_buf();
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn tree(name: &str) -> (TempTree, Scope) {
        let tree = TempTree::new(name);
        tree.file("ws/.gitignore", "ignored/\n*.log\n");
        tree.file("ws/top.ts", "");
        tree.file("ws/src/a.ts", "");
        tree.file("ws/src/sub/B.TS", "");
        tree.file("ws/src/中文 名.ts", "");
        tree.file("ws/ignored/c.ts", "");
        tree.file("ws/debug.log", "");
        tree.file("ws/.hidden/d.ts", "");
        tree.file("ws/node_modules/m/x.ts", "");
        let scope = Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope");
        (tree, scope)
    }

    #[test]
    fn matches_names_at_any_depth_with_smart_case_and_gitignore() {
        let (_tree, scope) = tree("glob-matches_names_at_any");
        let found = glob(&scope, ".", "*.ts", &[], None).expect("glob");
        assert_eq!(
            found.matches,
            [
                ".hidden/d.ts",
                "node_modules/m/x.ts",
                "src/a.ts",
                "src/sub/B.TS",
                "src/中文 名.ts",
                "top.ts"
            ]
        );
        assert!(!found.truncated);
        let upper = glob(&scope, ".", "*.TS", &[], None).expect("glob");
        assert_eq!(upper.matches, ["src/sub/B.TS"]);
    }

    #[test]
    fn path_patterns_match_relative_paths_and_list_directories() {
        let (_tree, scope) = tree("glob-path_patterns_match_");
        let found = glob(&scope, ".", "src/**", &[], None).expect("glob");
        assert_eq!(
            found.matches,
            ["src/a.ts", "src/sub/", "src/sub/B.TS", "src/中文 名.ts"]
        );
        let dirs = glob(&scope, ".", "src", &[], None).expect("glob");
        assert_eq!(dirs.matches, ["src/"]);
    }

    #[test]
    fn exclusions_and_limits_apply() {
        let (_tree, scope) = tree("glob-exclusions_and_limit");
        let exclude = ["**/node_modules/**".to_owned(), "**/.git/**".to_owned()];
        let found = glob(&scope, ".", "*.ts", &exclude, Some(2)).expect("glob");
        assert_eq!(found.matches, [".hidden/d.ts", "src/a.ts"]);
        assert!(found.truncated);
        let all = glob(&scope, "src", "*.ts", &exclude, None).expect("glob");
        assert_eq!(all.matches, ["a.ts", "sub/B.TS", "中文 名.ts"]);
    }

    #[test]
    fn refuses_files_and_bad_patterns() {
        let (_tree, scope) = tree("glob-refuses_files_and_ba");
        let error = glob(&scope, "top.ts", "*", &[], None).expect_err("file");
        assert_eq!(error.code(), Some("ENOTDIR"));
        assert!(matches!(
            glob(&scope, ".", "[", &[], None),
            Err(Error::InvalidPattern { .. })
        ));
    }
}
