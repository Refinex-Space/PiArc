//! The project search uses ripgrep's matcher and PiArc's descriptor-relative walker.
use super::{Access, Error, Result, Scope, Value, invalid, json, tree};
use crate::walk::{self, Visit};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use std::{
    collections::HashSet,
    io::Read as _,
    path::Path,
    time::{Duration, Instant},
};

/// Options for content search. A name search uses the composer's fuzzy path ranking.
#[derive(Default, Debug, Clone, Copy)]
pub struct SearchOptions {
    /// Case-sensitive content matching.
    pub match_case: bool,
    /// Match full words.
    pub whole_word: bool,
    /// Interpret the query as a regular expression.
    pub regexp: bool,
}

impl SearchOptions {
    fn matcher(self, query: &str) -> Result<RegexMatcher> {
        RegexMatcherBuilder::new()
            .fixed_strings(!self.regexp)
            .case_insensitive(!self.match_case)
            .word(self.whole_word)
            .size_limit(2 * 1024 * 1024)
            .build(query)
            .map_err(|e| Error::InvalidPattern {
                message: e.to_string(),
            })
    }
}

const MAX_ENTRIES: usize = 25_000;
const MAX_CONTENT_RESULTS: usize = 240;
const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const BYTE_LIMIT: u64 = 32 * 1024 * 1024;

/// Searches ignored-file-aware names or regular-file contents below the project root. Cancelling
/// or exceeding work limits stops enumeration and bounds allocations.
///
/// # Errors
/// The query is invalid, the lookup was cancelled or the directory could not be read.
pub fn search(
    scope: &Scope,
    query: &str,
    content: bool,
    options: SearchOptions,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    if query.len() > 1024 {
        return Err(invalid("search query is too long"));
    }
    if cancelled() {
        return Err(cancel_error(scope));
    }
    if query.trim().is_empty() {
        return Ok(json!({"results":[],"truncated":false}));
    }
    let matcher = content.then(|| options.matcher(query)).transpose()?;
    let bound = scope.bind(".", Access::Read)?;
    let mut paths = Vec::new();
    let mut directories = HashSet::new();
    let mut results = Vec::new();
    let mut truncated = false;
    let mut seen = 0;
    let mut index_bytes = 0;
    let mut scan = Scan {
        bytes_read: 0,
        started: Instant::now(),
        cancelled,
        root: scope.root(),
        truncated: false,
    };
    walk::visit(scope, &bound, walk::Search::Mentions, |entry| {
        if cancelled() {
            return Err(cancel_error(scope));
        }
        seen += 1;
        if seen > MAX_ENTRIES || scan.started.elapsed() >= Duration::from_secs(4) {
            truncated = true;
            return Ok(Visit::Stop);
        }
        if entry.name.to_str().is_none_or(tree::excluded) {
            return Ok(Visit::Prune);
        }
        if !entry.kind.is_file() && !entry.kind.is_dir() {
            return Ok(Visit::Continue);
        }
        let path = crate::glob::relative(bound.path(), &entry.path);
        if let Some(matcher) = &matcher {
            if entry.kind.is_file() {
                return scan_file(entry, &path, matcher, &mut scan, &mut results);
            }
        } else {
            index_bytes += path.len();
            if index_bytes > 2 * 1024 * 1024 {
                truncated = true;
                return Ok(Visit::Stop);
            }
            if entry.kind.is_dir() {
                directories.insert(path.clone());
            }
            paths.push(path);
        }
        Ok(Visit::Continue)
    })?;
    if !content {
        let (matches, limited) = name_matches(&paths, &directories, query, cancelled)?;
        results = matches;
        truncated |= limited;
    } else {
        results.sort_by(|a, b| {
            a["path"]
                .as_str()
                .cmp(&b["path"].as_str())
                .then_with(|| a["line"].as_u64().cmp(&b["line"].as_u64()))
        });
    }
    Ok(json!({"results":results,"truncated":truncated || scan.truncated}))
}

fn name_matches(
    paths: &[String],
    directories: &HashSet<String>,
    query: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<Value>, bool)> {
    let found = crate::fuzzy::rank(paths, query, 51, cancelled)?;
    let truncated = found.len() > 50;
    let mut results = Vec::new();
    for row in found.into_iter().take(50) {
        let kind = if directories.contains(&row.path) {
            "directory"
        } else {
            "file"
        };
        let name = row.path.rsplit('/').next().unwrap_or(&row.path);
        let mut wanted = row.positions.iter().copied().peekable();
        let mut utf16 = 0;
        let mut positions = Vec::with_capacity(row.positions.len());
        for (i, ch) in row.path.chars().enumerate() {
            if wanted.next_if_eq(&i).is_some() {
                positions.push(utf16);
            }
            utf16 += ch.len_utf16();
        }
        results.push(json!({"path":row.path,"name":name,"kind":kind,"positions":positions}));
    }
    Ok((results, truncated))
}

struct Scan<'a> {
    bytes_read: u64,
    started: Instant,
    cancelled: &'a dyn Fn() -> bool,
    root: &'a Path,
    truncated: bool,
}

fn scan_file(
    entry: &walk::Entry<'_>,
    path: &str,
    matcher: &RegexMatcher,
    scan: &mut Scan<'_>,
    results: &mut Vec<Value>,
) -> Result<Visit> {
    let Ok(file) = entry.open_file() else {
        return Ok(Visit::Continue);
    };
    let meta = file.metadata().map_err(|e| Error::io(&entry.path, e))?;
    if meta.len() > FILE_LIMIT {
        scan.truncated = true;
        return Ok(Visit::Continue);
    }
    if scan.bytes_read + meta.len() > BYTE_LIMIT {
        scan.truncated = true;
        return Ok(Visit::Stop);
    }
    let mut buf = Vec::new();
    file.take(meta.len() + 1)
        .read_to_end(&mut buf)
        .map_err(|e| Error::io(&entry.path, e))?;
    scan.bytes_read += buf.len() as u64;
    if buf.len() as u64 > meta.len() {
        scan.truncated = true;
        return Ok(Visit::Continue);
    }
    if !buf.contains(&0)
        && let Ok(text) = std::str::from_utf8(&buf)
    {
        for (line_number, line) in text.lines().enumerate() {
            if line_number % 128 == 0 {
                if (scan.cancelled)() {
                    return Err(Error::coded(
                        scan.root,
                        "ECANCELED",
                        "project search cancelled",
                    ));
                }
                if scan.started.elapsed() >= Duration::from_secs(4) {
                    scan.truncated = true;
                    return Ok(Visit::Stop);
                }
            }
            if line.len() > 64 * 1024 {
                scan.truncated = true;
                continue;
            }
            if let Some(row) = matched_line(matcher, path, line_number + 1, line) {
                if results.len() == MAX_CONTENT_RESULTS {
                    scan.truncated = true;
                    return Ok(Visit::Stop);
                }
                results.push(row);
            }
        }
    }

    Ok(Visit::Continue)
}

fn cancel_error(scope: &Scope) -> Error {
    Error::coded(scope.root(), "ECANCELED", "project search cancelled")
}

fn matched_line(
    matcher: &RegexMatcher,
    path: &str,
    line_number: usize,
    line: &str,
) -> Option<Value> {
    let first = matcher
        .find(line.as_bytes())
        .expect("infallible regex matcher")?;
    let start = line.floor_char_boundary(first.start().saturating_sub(160));
    let end = line.ceil_char_boundary((start + 700).min(line.len()));
    let mut ranges = Vec::new();
    matcher
        .find_iter(line.as_bytes(), |m| {
            if m.start() >= end {
                return false;
            }
            if m.start() >= start
                && m.end() <= end
                && m.end() > m.start()
                && line.is_char_boundary(m.start())
                && line.is_char_boundary(m.end())
            {
                ranges.push([
                    line[start..m.start()].encode_utf16().count(),
                    line[start..m.end()].encode_utf16().count(),
                ]);
            }
            ranges.len() < 64
        })
        .expect("infallible regex matcher");
    let name = Path::new(path).file_name()?.to_str()?;
    let column = line[..line.floor_char_boundary(first.start())]
        .encode_utf16()
        .count()
        + 1;
    Some(
        json!({"path":path,"name":name,"kind":"file","line":line_number,"column":column,"preview":&line[start..end],"ranges":ranges}),
    )
}
