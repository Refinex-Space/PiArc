//! Claude Code rules (`.claude/rules/**/*.md` in the workspace root, `~/.claude/rules/`):
//! which files exist, their `paths:` frontmatter and whether a workspace file matches it.
//! Reading the files and delivering them is Core's (`tool_io::memory_reader`), through the
//! same directory bindings as memory files.
//!
//! - Discovery follows symbolic links to files and directories; a directory reached twice
//!   (a link cycle) is listed once. Hidden entries are skipped.
//! - A rule without `paths:` (or with frontmatter that cannot be parsed) is unconditional.
//! - `paths:` is a YAML list of globs or one string (comma-separated globs are split).
//!   Globs follow gitignore rules relative to the workspace root (`*.ts` matches at any
//!   depth, `src/` matches everything below `src`, `{a,b}` alternates); on Windows the
//!   comparison ignores case.

use std::collections::BTreeSet;
use std::io;
use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;

/// The rules directory below `.claude/`.
pub const RULES_DIR: &str = "rules";

/// A parsed rule file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    /// The globs of `paths:`; `None` for an unconditional rule.
    pub paths: Option<Vec<String>>,
    /// The text after the frontmatter (the whole file when there is none).
    pub body: String,
}

#[derive(Deserialize)]
struct Frontmatter {
    #[serde(default)]
    paths: Option<Paths>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Paths {
    One(String),
    Many(Vec<String>),
}

/// Splits the frontmatter off `text`. Frontmatter that is not valid YAML leaves the file as
/// it is: an unconditional rule with its whole text.
#[must_use]
pub fn parse(text: &str) -> Rule {
    let unconditional = || Rule {
        paths: None,
        body: text.to_owned(),
    };
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return unconditional();
    };
    let Some((yaml, body)) = split_closing(rest) else {
        return unconditional();
    };
    let Ok(front) = serde_saphyr::from_str::<Option<Frontmatter>>(yaml) else {
        return unconditional();
    };
    let paths = front.and_then(|f| f.paths).map(|p| match p {
        Paths::One(text) => text
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        Paths::Many(list) => list
            .into_iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>(),
    });
    Rule {
        // `paths: []` names no file: such a rule never loads, as in Claude Code.
        paths,
        body: body.to_owned(),
    }
}

fn split_closing(rest: &str) -> Option<(&str, &str)> {
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    (rest[offset..].trim_end() == "---").then(|| (&rest[..offset], ""))
}

/// Matches workspace-relative paths against a rule's globs.
#[derive(Debug, Clone)]
pub struct PathMatcher {
    globs: Gitignore,
}

impl PathMatcher {
    /// Compiles `globs`.
    ///
    /// # Errors
    ///
    /// The first glob that is not a valid gitignore pattern.
    pub fn new(globs: &[String]) -> Result<Self, String> {
        let mut builder = GitignoreBuilder::new("");
        builder
            .case_insensitive(cfg!(windows))
            .map_err(|e| e.to_string())?;
        for glob in globs {
            builder
                .add_line(None, glob)
                .map_err(|e| format!("invalid glob {glob:?}: {e}"))?;
        }
        let globs = builder.build().map_err(|e| e.to_string())?;
        Ok(Self { globs })
    }

    /// Whether `relative` (a file below the workspace root, `/`-separated) matches; a match
    /// of one of its directories counts.
    #[must_use]
    pub fn matches(&self, relative: &str) -> bool {
        let relative = relative.trim_start_matches('/');
        !relative.is_empty()
            && self
                .globs
                .matched_path_or_any_parents(relative, false)
                .is_ignore()
    }
}

/// `path` relative to `root`, `/`-separated, when it is below `root`. Both are compared by
/// component after removing `.` and resolving `..` lexically; on Windows case and the
/// `\\?\` prefix are ignored.
#[must_use]
pub fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let root = normalize(root);
    let path = normalize(path);
    if path.len() <= root.len() {
        return None;
    }
    let same = |a: &String, b: &String| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b) || a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };
    root.iter()
        .zip(&path)
        .all(|(a, b)| same(a, b))
        .then(|| path[root.len()..].join("/"))
}

fn normalize(path: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                let text = prefix.as_os_str().to_string_lossy();
                out.push(text.trim_start_matches(r"\\?\").to_owned());
            }
            Component::RootDir => out.push(String::new()),
            Component::CurDir => {}
            Component::ParentDir => {
                if out.len() > 1 {
                    out.pop();
                }
            }
            Component::Normal(name) => out.push(name.to_string_lossy().into_owned()),
        }
    }
    out
}

/// The `*.md` files below `dir`, sorted by path; an absent directory has none. Symbolic
/// links are followed; each directory is visited once.
///
/// # Errors
///
/// A directory that exists but cannot be listed.
pub fn rule_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut visited = BTreeSet::new();
    collect(dir, &mut visited, &mut out, true)?;
    out.sort();
    Ok(out)
}

fn collect(
    dir: &Path,
    visited: &mut BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
    top: bool,
) -> io::Result<()> {
    let canonical = match dir.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if top && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        // A dangling link below the top: nothing to read.
        Err(_) if !top => return Ok(()),
        Err(error) => return Err(error),
    };
    if !visited.insert(canonical) {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if top && error.kind() == io::ErrorKind::NotADirectory => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        // `metadata` follows links: a linked directory is descended into.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            collect(&path, visited, out, false)?;
        } else if meta.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_paths_and_body() {
        let rule = parse("---\npaths:\n  - \"src/**/*.ts\"\n  - lib/\n---\n# API\nUse zod.\n");
        assert_eq!(
            rule.paths,
            Some(vec!["src/**/*.ts".to_owned(), "lib/".to_owned()])
        );
        assert_eq!(rule.body, "# API\nUse zod.\n");
        let rule = parse("---\r\npaths: \"*.md, docs/**\"\r\ndescription: x\r\n---\r\nBody");
        assert_eq!(
            rule.paths,
            Some(vec!["*.md".to_owned(), "docs/**".to_owned()])
        );
        assert_eq!(rule.body, "Body");
        let rule = parse("---\ndescription: only\n---\nText");
        assert_eq!(rule.paths, None);
        assert_eq!(rule.body, "Text");
        // No frontmatter, an unclosed block or invalid YAML: unconditional, text unchanged.
        for text in [
            "Plain rule",
            "---\npaths: [a\nBody",
            "---\npaths: [a\n---\nBody",
        ] {
            assert_eq!(
                parse(text),
                Rule {
                    paths: None,
                    body: text.to_owned()
                },
                "{text}"
            );
        }
        assert_eq!(parse("---\npaths: []\n---\nx").paths, Some(Vec::new()));
    }

    #[test]
    fn globs_follow_gitignore_rules_relative_to_the_root() {
        let m = |globs: &[&str]| {
            PathMatcher::new(&globs.iter().map(|g| (*g).to_owned()).collect::<Vec<_>>())
                .expect("globs")
        };
        let ts = m(&["src/**/*.{ts,tsx}"]);
        assert!(ts.matches("src/a.ts") && ts.matches("src/x/y/b.tsx"));
        assert!(!ts.matches("lib/src/a.ts") && !ts.matches("src/a.js"));
        let any = m(&["*.md"]);
        assert!(any.matches("README.md") && any.matches("docs/deep/x.md"));
        let dir = m(&["docs/"]);
        assert!(dir.matches("docs/a/b.txt") && !dir.matches("docsx/a.txt"));
        let negated = m(&["src/**", "!src/generated/**"]);
        assert!(negated.matches("src/a.rs") && !negated.matches("src/generated/b.rs"));
        let spaced = m(&["中文 目录/*.txt"]);
        assert!(spaced.matches("中文 目录/说明.txt"));
        assert!(!m(&[]).matches("a"));
        assert_eq!(m(&["SRC/*.rs"]).matches("src/a.rs"), cfg!(windows));
    }

    #[test]
    fn relative_paths_are_normalized() {
        let root = Path::new("/w/project");
        assert_eq!(
            relative_to(root, Path::new("/w/project/src/./a/../b.ts")),
            Some("src/b.ts".to_owned())
        );
        assert_eq!(relative_to(root, Path::new("/w/project")), None);
        assert_eq!(relative_to(root, Path::new("/w/projectx/a")), None);
        assert_eq!(relative_to(root, Path::new("/w/other/a")), None);
    }

    #[test]
    fn rule_files_follow_links_once_and_skip_hidden_entries() {
        let root = std::env::temp_dir().join(format!("piarc rules 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let rules = root.join("rules");
        let shared = root.join("shared rules");
        for dir in [rules.join("api"), rules.join(".hidden"), shared.clone()] {
            std::fs::create_dir_all(dir).expect("dir");
        }
        for file in [
            rules.join("a.md"),
            rules.join("api/b.MD"),
            rules.join("notes.txt"),
            rules.join(".hidden/c.md"),
            shared.join("s.md"),
        ] {
            std::fs::write(file, "x").expect("file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&shared, rules.join("shared")).expect("dir link");
            symlink(shared.join("s.md"), rules.join("linked.md")).expect("file link");
            symlink(&rules, rules.join("api/loop")).expect("cycle");
            symlink(root.join("missing"), rules.join("dangling.md")).expect("dangling");
        }
        let names: Vec<String> = rule_files(&rules)
            .expect("list")
            .iter()
            .map(|p| {
                p.strip_prefix(&rules)
                    .expect("below")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        let mut want = vec!["a.md", "api/b.MD"];
        if cfg!(unix) {
            want.extend(["linked.md", "shared/s.md"]);
        }
        assert_eq!(names, want);
        assert!(rule_files(&root.join("absent")).expect("absent").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_ignore_case_and_the_verbatim_prefix() {
        assert_eq!(
            relative_to(
                Path::new(r"C:\Work\Repo"),
                Path::new(r"\\?\c:\work\repo\Src\A.ts")
            ),
            Some("Src/A.ts".to_owned())
        );
    }
}
