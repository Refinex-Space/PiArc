//! Searching file contents: `fs/grep`, with ripgrep's libraries.
//!
//! Matches the behavior of `rg --json --line-number --hidden` as Pi's native `grep` tool runs
//! it: hidden files are searched; `.gitignore` applies inside Git repositories (ripgrep's
//! default), `.ignore` and `.rgignore` everywhere; `glob` restricts the files searched (a
//! leading `./` is dropped, `!` negates); binary files are skipped in a directory search; a
//! file named directly is always searched.
//!
//! The match limit works as in Pi's tool (`grep.ts`, v1.5.2): after the last allowed match its
//! trailing context is still collected, and `limitReached` is set only when another match
//! proves the limit cut results off. Files are searched in path order (ripgrep's order is not
//! deterministic). Lines are cut at [`MAX_LINE_CHARS`] characters and collection stops after
//! about [`MAX_OUTPUT_BYTES`]: Pi's tool shows far less than either.

use std::io;
use std::path::Path;

use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use piarc_protocol::fs::{FsGrepResult, GrepLine};

use crate::error::{Error, Result};
use crate::glob::relative;
use crate::scope::{Scope, display};

/// Longest line text returned, in characters.
pub const MAX_LINE_CHARS: usize = 4096;
/// Collection stops once the returned lines exceed this many bytes.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Match limit when the request names none.
pub const DEFAULT_MATCH_LIMIT: u64 = 100;

/// What to search for.
#[derive(Debug, Clone, Default)]
pub struct GrepQuery<'a> {
    /// Regular expression, or a literal with `literal`.
    pub pattern: &'a str,
    /// Restricts the files searched in a directory.
    pub glob: Option<&'a str>,
    /// Case-insensitive matching.
    pub ignore_case: bool,
    /// `pattern` is a literal string.
    pub literal: bool,
    /// Context lines before and after each match.
    pub context: u64,
    /// Matches to return at most; [`DEFAULT_MATCH_LIMIT`] when `None`.
    pub limit: Option<u64>,
}

/// Searches the file or directory `requested` for `query`.
///
/// # Errors
///
/// The path is outside the scope or does not exist; the pattern or glob does not compile
/// (`invalidParams`).
pub fn grep(scope: &Scope, requested: &str, query: &GrepQuery<'_>) -> Result<FsGrepResult> {
    let target = scope.check(requested, crate::access::Access::Read)?;
    let metadata = std::fs::metadata(&target).map_err(|e| Error::io(&target, e))?;
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(query.ignore_case)
        .fixed_strings(query.literal)
        .line_terminator(Some(b'\n'))
        .build(query.pattern)
        .map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })?;
    let mut collector = Collector {
        limit: query.limit.unwrap_or(DEFAULT_MATCH_LIMIT).max(1),
        context: query.context,
        ..Collector::default()
    };
    let is_directory = metadata.is_dir();
    if is_directory {
        search_directory(&target, &matcher, query, &mut collector)?;
    } else {
        collector.file = target
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let mut searcher = searcher(query.context, BinaryDetection::convert(b'\0'));
        // An unreadable file yields no lines, as ripgrep reports and skips it.
        let _ = searcher.search_path(&matcher, &target, &mut collector);
    }
    Ok(FsGrepResult {
        path: display(&target),
        is_directory,
        match_count: collector.match_count,
        limit_reached: collector.limit_reached,
        lines: collector.lines,
    })
}

fn search_directory(
    root: &Path,
    matcher: &RegexMatcher,
    query: &GrepQuery<'_>,
    collector: &mut Collector,
) -> Result<()> {
    let mut walk = WalkBuilder::new(root);
    walk.hidden(false)
        .add_custom_ignore_filename(".rgignore")
        .sort_by_file_name(Ord::cmp);
    if let Some(glob) = query.glob {
        let (negate, rest) = glob
            .strip_prefix('!')
            .map_or((false, glob), |rest| (true, rest));
        let mut rest = rest;
        while let Some(stripped) = rest.strip_prefix("./") {
            rest = stripped;
        }
        let glob = if negate {
            format!("!{rest}")
        } else {
            rest.to_owned()
        };
        let mut overrides = OverrideBuilder::new(root);
        overrides.add(&glob).map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })?;
        walk.overrides(overrides.build().map_err(|e| Error::InvalidPattern {
            message: e.to_string(),
        })?);
    }
    let mut searcher = searcher(query.context, BinaryDetection::quit(b'\0'));
    // Unreadable entries are skipped, as ripgrep reports and skips them.
    for entry in walk.build().filter_map(std::result::Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        collector.file = relative(root, entry.path());
        let _ = searcher.search_path(matcher, entry.path(), &mut *collector);
        if collector.done {
            break;
        }
    }
    Ok(())
}

fn searcher(context: u64, binary: BinaryDetection) -> Searcher {
    let context = usize::try_from(context).unwrap_or(usize::MAX);
    SearcherBuilder::new()
        .line_number(true)
        .before_context(context)
        .after_context(context)
        .binary_detection(binary)
        .build()
}

/// Collects lines with Pi's limit semantics.
#[derive(Default)]
struct Collector {
    limit: u64,
    context: u64,
    /// The file being searched, as reported in [`GrepLine::path`].
    file: String,
    lines: Vec<GrepLine>,
    bytes: usize,
    match_count: u64,
    /// The last allowed match was seen; only its trailing context is still collected.
    limit_hit: bool,
    trailing_end: u64,
    limit_reached: bool,
    done: bool,
}

impl Collector {
    fn line(&mut self, number: u64, bytes: &[u8], is_match: bool) {
        if self.done {
            return;
        }
        if !self.limit_hit {
            self.push(number, bytes, is_match);
            if is_match {
                self.match_count += 1;
                if self.match_count >= self.limit {
                    self.limit_hit = true;
                    self.trailing_end = number.saturating_add(self.context);
                }
            }
            return;
        }
        let last_file = self.lines.last().map(|l| l.path.as_str());
        let in_window = last_file == Some(self.file.as_str()) && number <= self.trailing_end;
        if in_window {
            // A match inside the last match's trailing context is shown as context.
            self.push(number, bytes, false);
        }
        if is_match {
            self.limit_reached = true;
        }
        if self.limit_reached && !(in_window && number < self.trailing_end) {
            self.done = true;
        }
    }

    fn push(&mut self, number: u64, bytes: &[u8], is_match: bool) {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end_matches('\n').trim_end_matches('\r');
        let text: String = text.chars().take(MAX_LINE_CHARS).collect();
        self.bytes += text.len() + self.file.len();
        self.lines.push(GrepLine {
            path: self.file.clone(),
            line_number: number,
            text,
            is_match,
        });
        if self.bytes > MAX_OUTPUT_BYTES {
            self.done = true;
        }
    }
}

impl Sink for &mut Collector {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> io::Result<bool> {
        let first = found.line_number().unwrap_or(0);
        for (offset, line) in (0_u64..).zip(found.lines()) {
            self.line(first + offset, line, true);
        }
        Ok(!self.done)
    }

    fn context(&mut self, _: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        self.line(context.line_number().unwrap_or(0), context.bytes(), false);
        Ok(!self.done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn scope(tree: &TempTree) -> Scope {
        Scope::new(&tree.path("ws"), &tree.path("ws")).expect("scope")
    }

    fn rendered(result: &FsGrepResult) -> Vec<String> {
        result
            .lines
            .iter()
            .map(|l| {
                let sep = if l.is_match { ':' } else { '-' };
                format!("{}{sep}{}{sep}{}", l.path, l.line_number, l.text)
            })
            .collect()
    }

    #[test]
    fn finds_matches_with_context_honoring_ignore_files_and_globs() {
        let tree = TempTree::new("grep-basic");
        tree.file("ws/.gitignore", "skip.txt\n");
        tree.file("ws/a.txt", "one\nTODO first\nthree\r\n");
        tree.file("ws/sub 子/b.rs", "// TODO 第二\n");
        tree.file(
            "ws/skip.txt",
            "TODO hidden by gitignore outside a repo? no\n",
        );
        let scope = scope(&tree);
        let query = GrepQuery {
            pattern: "TODO",
            context: 1,
            ..GrepQuery::default()
        };
        let found = grep(&scope, ".", &query).expect("grep");
        // Outside a Git repository ripgrep ignores .gitignore.
        assert_eq!(
            rendered(&found),
            [
                "a.txt-1-one",
                "a.txt:2:TODO first",
                "a.txt-3-three",
                "skip.txt:1:TODO hidden by gitignore outside a repo? no",
                "sub 子/b.rs:1:// TODO 第二"
            ]
        );
        assert!(found.is_directory);
        let only_rs = GrepQuery {
            pattern: "todo",
            ignore_case: true,
            glob: Some("./*.rs"),
            ..GrepQuery::default()
        };
        assert_eq!(
            rendered(&grep(&scope, ".", &only_rs).expect("grep")),
            ["sub 子/b.rs:1:// TODO 第二"]
        );
        let file = grep(&scope, "a.txt", &query).expect("grep");
        assert!(!file.is_directory);
        assert_eq!(file.lines[0].path, "a.txt");
    }

    #[test]
    fn the_limit_keeps_trailing_context_and_needs_one_more_match() {
        let tree = TempTree::new("grep-limit");
        tree.file("ws/f.txt", "x1\nctx\nx2\nx3\n");
        let scope = scope(&tree);
        let exactly_three = GrepQuery {
            pattern: "^x",
            limit: Some(3),
            ..GrepQuery::default()
        };
        let all = grep(&scope, ".", &exactly_three).expect("grep");
        assert_eq!((all.match_count, all.limit_reached), (3, false));
        let limited = GrepQuery {
            pattern: "^x",
            limit: Some(1),
            context: 1,
            ..GrepQuery::default()
        };
        let found = grep(&scope, ".", &limited).expect("grep");
        assert_eq!(rendered(&found), ["f.txt:1:x1", "f.txt-2-ctx"]);
        assert!(found.limit_reached);
    }

    #[test]
    fn literal_patterns_and_errors() {
        let tree = TempTree::new("grep-literal");
        tree.file("ws/f.txt", "a.b\naxb\n");
        let scope = scope(&tree);
        let literal = GrepQuery {
            pattern: "a.b",
            literal: true,
            ..GrepQuery::default()
        };
        assert_eq!(
            rendered(&grep(&scope, ".", &literal).expect("grep")),
            ["f.txt:1:a.b"]
        );
        let bad = GrepQuery {
            pattern: "(",
            ..GrepQuery::default()
        };
        assert!(matches!(
            grep(&scope, ".", &bad),
            Err(Error::InvalidPattern { .. })
        ));
        assert!(matches!(
            grep(&scope, "missing", &literal),
            Err(Error::NotFound { .. })
        ));
    }
}
