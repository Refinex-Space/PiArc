//! Path patterns of `Read(…)` and `Edit(…)` rules: gitignore syntax with four anchors.
//!
//! | Pattern | Base directory |
//! |---|---|
//! | `//path` | the filesystem root |
//! | `~/path` | the home directory |
//! | `/path` | the directory of the rule's source ([`PathContext::anchor`]) |
//! | `path`, `./path` | the session's current directory |
//!
//! A path matches when the pattern matches it or one of its ancestors below the base, as a
//! directory excluded by gitignore excludes its contents. A pattern without a slash (other
//! than a trailing one) matches a name at any depth. Paths are compared in POSIX form
//! (`C:\a` is `/c/a`) and without case where the volume ignores case.

use std::path::{Component, Path, Prefix};

use globset::{GlobBuilder, GlobMatcher};

/// Where a pattern is anchored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// `//path`.
    Root,
    /// `~/path`.
    Home,
    /// `/path`: the source's directory.
    Source,
    /// `path` or `./path`: the current directory.
    Cwd,
}

/// A compiled path pattern.
#[derive(Debug, Clone)]
pub struct PathPattern {
    /// Where the pattern starts.
    pub anchor: Anchor,
    /// `!pattern`: removes earlier matches of relative rules in the same list.
    pub negated: bool,
    exact: GlobMatcher,
    folded: GlobMatcher,
}

/// The directories a path pattern can be anchored at, in POSIX form.
#[derive(Debug, Clone, Copy)]
pub struct PathContext<'a> {
    /// The home directory.
    pub home: &'a str,
    /// The session's current directory.
    pub cwd: &'a str,
    /// The directory of the rule's source.
    pub anchor: &'a str,
    /// Whether the volume ignores case.
    pub fold_case: bool,
}

impl PathPattern {
    /// Parse a gitignore-style pattern with an anchor prefix. `deny_like` widens a relative
    /// single-directory pattern such as `secrets/**` to every depth, as deny and ask rules do.
    ///
    /// # Errors
    ///
    /// An empty pattern or one globset cannot compile.
    pub fn parse(text: &str, deny_like: bool) -> Result<Self, crate::Error> {
        Self::parse_text(text, deny_like).map_err(crate::Error::InvalidPath)
    }

    fn parse_text(text: &str, deny_like: bool) -> Result<Self, String> {
        let (negated, text) = match text.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let (anchor, rest) = if negated {
            (Anchor::Cwd, text.trim_start_matches("./"))
        } else if let Some(rest) = text.strip_prefix("//") {
            (Anchor::Root, rest)
        } else if let Some(rest) = text.strip_prefix("~/") {
            (Anchor::Home, rest)
        } else if text == "~" {
            (Anchor::Home, "")
        } else if let Some(rest) = text.strip_prefix('/') {
            (Anchor::Source, rest)
        } else {
            (Anchor::Cwd, text.strip_prefix("./").unwrap_or(text))
        };
        let trimmed = rest.trim_end_matches('/');
        let mut glob = if trimmed.is_empty() {
            "**".to_owned()
        } else if anchor == Anchor::Cwd && !trimmed.contains('/') {
            // A bare name matches at any depth.
            format!("**/{trimmed}")
        } else {
            trimmed.to_owned()
        };
        if deny_like
            && anchor == Anchor::Cwd
            && let Some(dir) = glob.strip_suffix("/**")
            && !dir.contains('/')
            && !dir.contains("**")
        {
            glob = format!("**/{dir}/**");
        }
        let compile = |fold: bool| {
            GlobBuilder::new(&glob)
                .literal_separator(true)
                .backslash_escape(true)
                .case_insensitive(fold)
                .build()
                .map(|g| g.compile_matcher())
                .map_err(|e| format!("invalid path pattern: {e}"))
        };
        Ok(Self {
            anchor,
            negated,
            exact: compile(false)?,
            folded: compile(true)?,
        })
    }

    fn base<'a>(&self, ctx: &PathContext<'a>) -> &'a str {
        match self.anchor {
            Anchor::Root => "/",
            Anchor::Home => ctx.home,
            Anchor::Source => ctx.anchor,
            Anchor::Cwd => ctx.cwd,
        }
    }

    /// Whether the pattern itself matches `path` (POSIX form), without the ancestor rule.
    fn matches_exactly(&self, path: &str, ctx: &PathContext<'_>) -> bool {
        let Some(relative) = relative_to(path, self.base(ctx), ctx.fold_case) else {
            return false;
        };
        if relative.is_empty() {
            return false;
        }
        if ctx.fold_case {
            self.folded.is_match(relative)
        } else {
            self.exact.is_match(relative)
        }
    }

    /// Whether the pattern matches `path` or an ancestor below the base.
    #[must_use]
    pub fn matches(&self, path: &str, ctx: &PathContext<'_>) -> bool {
        ancestors(path).any(|p| self.matches_exactly(p, ctx))
    }
}

/// Evaluate one source's list of relative patterns with gitignore semantics: later patterns
/// override earlier ones, `!` patterns re-include, and nothing re-includes a path whose
/// directory is excluded. Anchored patterns are evaluated alone (`!` cannot reach them).
#[must_use]
pub fn list_matches<'p>(
    patterns: impl IntoIterator<Item = &'p PathPattern> + Clone,
    path: &str,
    ctx: &PathContext<'_>,
) -> bool {
    let state = |p: &str| {
        let mut matched = false;
        for pattern in patterns.clone() {
            if pattern.anchor != Anchor::Cwd {
                continue;
            }
            if pattern.matches_exactly(p, ctx) {
                matched = !pattern.negated;
            }
        }
        matched
    };
    let anchored = patterns
        .clone()
        .into_iter()
        .any(|p| p.anchor != Anchor::Cwd && !p.negated && p.matches(path, ctx));
    anchored || ancestors(path).any(state)
}

/// The path and its ancestors, nearest first, down to the root.
fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    let mut next = Some(path);
    std::iter::from_fn(move || {
        let current = next?;
        next = match current.rfind('/') {
            Some(0) if current.len() > 1 => Some("/"),
            Some(i) if i > 0 => Some(&current[..i]),
            _ => None,
        };
        Some(current)
    })
}

fn relative_to<'p>(path: &'p str, base: &str, fold_case: bool) -> Option<&'p str> {
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return path.strip_prefix('/');
    }
    let head = path.get(..base.len())?;
    let same = if fold_case {
        head.to_lowercase() == base.to_lowercase()
    } else {
        head == base
    };
    if !same {
        return None;
    }
    let rest = &path[base.len()..];
    if rest.is_empty() {
        Some("")
    } else {
        rest.strip_prefix('/')
    }
}

/// A path in the POSIX form used for matching: `/` separators, `C:\x` as `/c/x`, a UNC share
/// `\\server\share\x` as `//server/share/x`, without a verbatim prefix.
#[must_use]
pub fn posix(path: &Path) -> String {
    let mut out = String::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                    out.push('/');
                    out.push(char::from(d).to_ascii_lowercase());
                }
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    out.push_str("//");
                    out.push_str(&server.to_string_lossy());
                    out.push('/');
                    out.push_str(&share.to_string_lossy());
                }
                Prefix::DeviceNS(name) | Prefix::Verbatim(name) => {
                    out.push_str("//");
                    out.push_str(&name.to_string_lossy());
                }
            },
            Component::RootDir => {}
            Component::CurDir => {}
            Component::ParentDir => out.push_str("/.."),
            Component::Normal(part) => {
                out.push('/');
                out.push_str(&part.to_string_lossy());
            }
        }
    }
    if out.is_empty() {
        out.push('/');
    }
    out
}

/// Escape gitignore pattern characters so a generated rule names one literal path.
#[must_use]
pub fn escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '\\' | '!') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTX: PathContext<'static> = PathContext {
        home: "/home/u",
        cwd: "/home/u/proj",
        anchor: "/home/u/proj",
        fold_case: false,
    };

    fn m(rule: &str, deny: bool, path: &str) -> bool {
        PathPattern::parse(rule, deny)
            .expect("pattern")
            .matches(path, &CTX)
    }

    #[test]
    fn anchors_follow_the_documented_prefixes() {
        assert!(m("//etc/hosts", true, "/etc/hosts"));
        assert!(!m("/etc/hosts", true, "/etc/hosts"));
        assert!(m("/src/**", true, "/home/u/proj/src/a.ts"));
        assert!(!m("/src/**", true, "/home/u/proj/vendor/src/a.ts"));
        assert!(m("~/.zshrc", true, "/home/u/.zshrc"));
        assert!(m("~/Documents/*.pdf", true, "/home/u/Documents/a.pdf"));
        assert!(!m("~/Documents/*.pdf", true, "/home/u/Documents/x/a.pdf"));
        assert!(m("./.env", true, "/home/u/proj/.env"));
        assert!(!m("./.env", true, "/home/u/.env"));
        assert!(m("//**/.env", true, "/srv/x/.env"));
    }

    #[test]
    fn depth_and_directory_rules() {
        // A bare name matches at any depth below the current directory.
        assert!(m(".env", true, "/home/u/proj/a/b/.env"));
        assert!(m("**/.env", true, "/home/u/proj/.env"));
        assert!(!m(".env", true, "/home/u/.env"));
        // A single-directory pattern: any depth for deny and ask, anchored for allow.
        assert!(m("src/**", true, "/home/u/proj/vendor/pkg/src/lib.js"));
        assert!(!m("src/**", false, "/home/u/proj/vendor/pkg/src/lib.js"));
        assert!(m("src/**", false, "/home/u/proj/src/app.ts"));
        assert!(m("**/src/**", false, "/home/u/proj/vendor/pkg/src/lib.js"));
        assert!(!m(
            "src/components/**",
            true,
            "/home/u/proj/x/src/components/a"
        ));
        // `*` stays within one segment; a matched directory covers its contents.
        assert!(!m("/*.ts", true, "/home/u/proj/src/a.ts"));
        assert!(m("secrets", true, "/home/u/proj/secrets/key.pem"));
        assert!(m(
            "Finance (2024)/**",
            false,
            "/home/u/proj/Finance (2024)/a"
        ));
    }

    #[test]
    fn negation_carves_out_of_relative_rules_only() {
        let list = |rules: &[&str]| -> Vec<PathPattern> {
            rules
                .iter()
                .map(|r| PathPattern::parse(r, true).expect("pattern"))
                .collect()
        };
        let env = list(&["*.env", "!sample.env"]);
        assert!(list_matches(&env, "/home/u/proj/a/.env", &CTX));
        assert!(!list_matches(&env, "/home/u/proj/a/sample.env", &CTX));
        let first = list(&["!sample.env", "*.env"]);
        assert!(list_matches(&first, "/home/u/proj/sample.env", &CTX));
        let dir = list(&["secrets/**", "!secrets/public/**"]);
        assert!(list_matches(&dir, "/home/u/proj/secrets/public/a", &CTX));
        let anchored = list(&["~/notes/**", "!~/notes/public/**"]);
        assert!(list_matches(&anchored, "/home/u/notes/public/a", &CTX));
    }

    #[test]
    fn posix_form_and_case() {
        assert_eq!(posix(Path::new("/a/b")), "/a/b");
        let folded = PathContext {
            fold_case: true,
            ..CTX
        };
        let p = PathPattern::parse(".ENV", true).expect("pattern");
        assert!(p.matches("/home/u/proj/.env", &folded));
        assert!(!p.matches("/home/u/proj/.env", &CTX));
        assert!(PathPattern::parse("a[", true).is_err());
        assert_eq!(escape("a[1]*.ts"), "a\\[1\\]\\*.ts");
        assert!(m(&escape("a[1].ts"), false, "/home/u/proj/a[1].ts"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_become_posix() {
        assert_eq!(posix(Path::new(r"C:\Users\a")), "/c/Users/a");
        assert_eq!(posix(Path::new(r"\\?\C:\Users\a")), "/c/Users/a");
        assert_eq!(posix(Path::new(r"\\srv\share\x")), "//srv/share/x");
    }
}
