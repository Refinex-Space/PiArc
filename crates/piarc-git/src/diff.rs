//! Diffs of the Git panel's scopes (ADR-0084 rule 4): file lists from `diff --raw`/`--numstat`,
//! patches from `diff -U3` parsed into the protocol's [`FileDiff`], untracked files diffed in
//! process, and the budget past which patches are withheld and fetched one file at a time.

use std::collections::HashMap;
use std::path::Path;

use piarc_protocol::diff::{DiffHunk, DiffLine, DiffLineKind, FileDiff};
use piarc_protocol::git::{GitChanges, GitFileChange, GitFileStatus, GitScope};

use crate::exec::ExecOptions;
use crate::git::GitError;
use crate::repo::Reader;

/// More files than this withhold patches.
pub const MAX_PATCH_FILES: usize = 300;
/// More changed lines than this withhold patches.
pub const MAX_PATCH_LINES: u64 = 20_000;
/// A scope's patch output past this withholds patches.
pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
/// One file's patch (or text) past this is not shown.
pub const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
/// The most files a scope lists.
pub const MAX_FILES: usize = 10_000;
/// A file with more changed lines than this loses its hunks (section 7.7).
pub const MAX_HUNK_LINES: u64 = 5_000;
/// A degraded file's unified text is cut here.
pub const MAX_UNIFIED_BYTES: usize = 512 * 1024;

/// Common flags of every diff the panel runs: no external programs, fixed prefixes, paths from
/// the top level.
const DIFF_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--find-renames",
    "--ignore-submodules=dirty",
];

/// One file of a parsed patch.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedFile {
    /// The path before (`None` for `/dev/null`).
    pub old_path: Option<String>,
    /// The path after (`None` for `/dev/null`).
    pub new_path: Option<String>,
    /// The mode before, when the header names it.
    pub old_mode: Option<String>,
    /// The mode after.
    pub new_mode: Option<String>,
    /// `Binary files … differ`.
    pub binary: bool,
    /// The raw header lines, each ending with `\n` (for building patches).
    pub header: Vec<u8>,
    /// The hunks with their raw bytes.
    pub hunks: Vec<RawHunk>,
}

impl ParsedFile {
    /// The path the file is listed under.
    #[must_use]
    pub fn path(&self) -> Option<&str> {
        self.new_path.as_deref().or(self.old_path.as_deref())
    }
}

/// One hunk with the bytes git printed for it (`@@` line included, each line ending with
/// `\n`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHunk {
    /// The raw bytes.
    pub raw: Vec<u8>,
    /// The parsed hunk.
    pub hunk: DiffHunk,
}

/// Parses `git diff` output with `a/` and `b/` prefixes.
#[must_use]
pub fn parse_patch(out: &[u8]) -> Vec<ParsedFile> {
    let lines: Vec<&[u8]> = split_lines(out);
    let mut files = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if !lines[i].starts_with(b"diff --git ") {
            i += 1;
            continue;
        }
        let mut file = ParsedFile::default();
        let git_line = lines[i];
        push_line(&mut file.header, git_line);
        i += 1;
        while i < lines.len()
            && !lines[i].starts_with(b"@@ ")
            && !lines[i].starts_with(b"diff --git ")
        {
            header_line(&mut file, lines[i]);
            push_line(&mut file.header, lines[i]);
            i += 1;
        }
        while i < lines.len() && lines[i].starts_with(b"@@ ") {
            let (hunk, next) = parse_hunk(&lines, i);
            if let Some(hunk) = hunk {
                file.hunks.push(hunk);
            }
            i = next;
        }
        if file.old_path.is_none() && file.new_path.is_none() {
            let (old, new) = git_line_paths(&git_line[b"diff --git ".len()..]);
            if !file.header_says_created() {
                file.old_path = old.clone();
            }
            if !file.header_says_deleted() {
                file.new_path = new.or(old);
            }
        }
        files.push(file);
    }
    files
}

impl ParsedFile {
    fn header_says_created(&self) -> bool {
        contains(&self.header, b"\nnew file mode ")
    }

    fn header_says_deleted(&self) -> bool {
        contains(&self.header, b"\ndeleted file mode ")
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn split_lines(out: &[u8]) -> Vec<&[u8]> {
    let mut lines: Vec<&[u8]> = out.split(|&b| b == b'\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    lines
}

fn push_line(buf: &mut Vec<u8>, line: &[u8]) {
    buf.extend_from_slice(line);
    buf.push(b'\n');
}

fn header_line(file: &mut ParsedFile, line: &[u8]) {
    let text = |prefix: &[u8]| {
        line.strip_prefix(prefix)
            .map(|rest| lossy(rest).into_owned())
    };
    if let Some(mode) = text(b"old mode ").or_else(|| text(b"deleted file mode ")) {
        file.old_mode = Some(mode);
    } else if let Some(mode) = text(b"new mode ").or_else(|| text(b"new file mode ")) {
        file.new_mode = Some(mode);
    } else if let Some(rest) = line
        .strip_prefix(b"rename from ")
        .or(line.strip_prefix(b"copy from "))
    {
        file.old_path = Some(unquote(rest));
    } else if let Some(rest) = line
        .strip_prefix(b"rename to ")
        .or(line.strip_prefix(b"copy to "))
    {
        file.new_path = Some(unquote(rest));
    } else if let Some(rest) = line.strip_prefix(b"--- ") {
        file.old_path = side_path(rest, b"a/");
    } else if let Some(rest) = line.strip_prefix(b"+++ ") {
        file.new_path = side_path(rest, b"b/");
    } else if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
        file.binary = true;
    }
}

/// The path of a `---`/`+++` line: `None` for `/dev/null`; quoted names unquoted; the TAB git
/// adds after names with spaces removed.
fn side_path(rest: &[u8], prefix: &[u8]) -> Option<String> {
    let rest = rest.strip_suffix(b"\t").unwrap_or(rest);
    if rest == b"/dev/null" {
        return None;
    }
    let name = if rest.first() == Some(&b'"') {
        unquote(rest)
    } else {
        lossy(rest).into_owned()
    };
    let prefix = std::str::from_utf8(prefix).unwrap_or_default();
    Some(name.strip_prefix(prefix).unwrap_or(&name).to_owned())
}

/// Both paths of a `diff --git` line (after the command) when nothing else names them: a
/// binary or mode-only change without renames, so both halves are the same path.
fn git_line_paths(rest: &[u8]) -> (Option<String>, Option<String>) {
    if rest.first() == Some(&b'"') {
        let (first, tail) = take_quoted(rest);
        let tail = tail.strip_prefix(b" ").unwrap_or(tail);
        let second = if tail.first() == Some(&b'"') {
            take_quoted(tail).0
        } else {
            lossy(tail).into_owned()
        };
        let strip = |s: String, p: &str| s.strip_prefix(p).map(str::to_owned).unwrap_or(s);
        return (Some(strip(first, "a/")), Some(strip(second, "b/")));
    }
    let text = lossy(rest);
    // "a/<P> b/<P>": 2 * len(P) + 5 bytes.
    if text.len() >= 5 && (text.len() - 5).is_multiple_of(2) {
        let n = (text.len() - 5) / 2;
        if let (Some(a), Some(b)) = (text.get(2..2 + n), text.get(n + 5..))
            && a == b
            && text.starts_with("a/")
            && text.get(n + 2..n + 5) == Some(" b/")
        {
            return (Some(a.to_owned()), Some(b.to_owned()));
        }
    }
    (None, None)
}

/// A C-style quoted name as git prints it (`"a\tb\303\244"`), decoded to bytes then UTF-8.
#[must_use]
pub fn unquote(raw: &[u8]) -> String {
    if raw.first() != Some(&b'"') {
        return lossy(raw).into_owned();
    }
    take_quoted(raw).0
}

fn take_quoted(raw: &[u8]) -> (String, &[u8]) {
    let mut out = Vec::new();
    let mut i = 1;
    while i < raw.len() {
        match raw[i] {
            b'"' => return (lossy(&out).into_owned(), &raw[i + 1..]),
            b'\\' if i + 1 < raw.len() => {
                let c = raw[i + 1];
                i += 2;
                match c {
                    b'n' => out.push(b'\n'),
                    b't' => out.push(b'\t'),
                    b'r' => out.push(b'\r'),
                    b'a' => out.push(7),
                    b'b' => out.push(8),
                    b'f' => out.push(12),
                    b'v' => out.push(11),
                    b'0'..=b'7' => {
                        let mut value = u32::from(c - b'0');
                        for _ in 0..2 {
                            if let Some(&d @ b'0'..=b'7') = raw.get(i) {
                                value = value * 8 + u32::from(d - b'0');
                                i += 1;
                            }
                        }
                        out.push(u8::try_from(value & 0xff).unwrap_or(0));
                    }
                    other => out.push(other),
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    (lossy(&out).into_owned(), &[])
}

fn lossy(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(bytes)
}

/// `@@ -a[,b] +c[,d] @@`.
fn hunk_range(line: &[u8]) -> Option<(u64, u64, u64, u64)> {
    let text = std::str::from_utf8(line).ok()?;
    let rest = text.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let (old, new) = rest[..end].split_once(" +")?;
    let range = |s: &str| -> Option<(u64, u64)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (a, b) = range(old)?;
    let (c, d) = range(new)?;
    Some((a, b, c, d))
}

fn parse_hunk(lines: &[&[u8]], start: usize) -> (Option<RawHunk>, usize) {
    let Some((old_start, old_lines, new_start, new_lines)) = hunk_range(lines[start]) else {
        return (None, start + 1);
    };
    let mut raw = Vec::new();
    push_line(&mut raw, lines[start]);
    let mut out: Vec<DiffLine> = Vec::new();
    let (mut old_seen, mut new_seen) = (0, 0);
    let mut i = start + 1;
    while i < lines.len() {
        let line = lines[i];
        let done = old_seen >= old_lines && new_seen >= new_lines;
        match line.first() {
            Some(b'\\') => {
                if let Some(last) = out.last_mut() {
                    last.no_newline = Some(true);
                }
            }
            _ if done => break,
            Some(b' ') | None => {
                old_seen += 1;
                new_seen += 1;
                out.push(line_of(DiffLineKind::Context, line));
            }
            Some(b'+') => {
                new_seen += 1;
                out.push(line_of(DiffLineKind::Added, line));
            }
            Some(b'-') => {
                old_seen += 1;
                out.push(line_of(DiffLineKind::Removed, line));
            }
            Some(_) => break,
        }
        push_line(&mut raw, line);
        i += 1;
    }
    let hunk = DiffHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: out,
    };
    (Some(RawHunk { raw, hunk }), i)
}

fn line_of(kind: DiffLineKind, line: &[u8]) -> DiffLine {
    let body = line.get(1..).unwrap_or_default();
    let body = body.strip_suffix(b"\r").unwrap_or(body);
    DiffLine {
        kind,
        text: lossy(body).into_owned(),
        no_newline: None,
    }
}

/// The protocol diff of a parsed file under `path`, degraded past the limits.
#[must_use]
pub fn file_diff(path: &str, file: &ParsedFile, created: bool) -> FileDiff {
    let (mut added, mut removed) = (0, 0);
    for line in file.hunks.iter().flat_map(|h| &h.hunk.lines) {
        match line.kind {
            DiffLineKind::Added => added += 1,
            DiffLineKind::Removed => removed += 1,
            DiffLineKind::Context => {}
        }
    }
    let degraded = added + removed > MAX_HUNK_LINES;
    let unified = if degraded {
        let mut text = String::new();
        for hunk in &file.hunks {
            text.push_str(&lossy(&hunk.raw));
            if text.len() > MAX_UNIFIED_BYTES {
                let mut cut = MAX_UNIFIED_BYTES;
                while !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
                break;
            }
        }
        text
    } else {
        String::new()
    };
    FileDiff {
        path: path.to_owned(),
        created: created.then_some(true),
        added,
        removed,
        unified,
        hunks: if degraded {
            Vec::new()
        } else {
            file.hunks.iter().map(|h| h.hunk.clone()).collect()
        },
        degraded: degraded.then_some(true),
    }
}

/// The diff of an untracked file: every line added. `None` for a binary or oversized file.
#[must_use]
pub fn untracked_diff(root: &Path, path: &str) -> Option<FileDiff> {
    let full = root.join(path);
    let meta = std::fs::symlink_metadata(&full).ok()?;
    let bytes = if meta.file_type().is_symlink() {
        std::fs::read_link(&full)
            .ok()?
            .to_string_lossy()
            .into_owned()
            .into_bytes()
    } else {
        if meta.len() > MAX_FILE_BYTES as u64 {
            return None;
        }
        std::fs::read(&full).ok()?
    };
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return None;
    }
    let mut text_lines: Vec<&[u8]> = bytes.split(|&b| b == b'\n').collect();
    let ends_with_newline = bytes.last() == Some(&b'\n');
    if ends_with_newline || bytes.is_empty() {
        text_lines.pop();
    }
    let count = text_lines.len() as u64;
    let mut lines: Vec<DiffLine> = text_lines
        .iter()
        .map(|l| {
            let l = l.strip_suffix(b"\r").unwrap_or(l);
            DiffLine {
                kind: DiffLineKind::Added,
                text: lossy(l).into_owned(),
                no_newline: None,
            }
        })
        .collect();
    if !ends_with_newline && let Some(last) = lines.last_mut() {
        last.no_newline = Some(true);
    }
    let degraded = count > MAX_HUNK_LINES;
    let hunks = if count == 0 || degraded {
        Vec::new()
    } else {
        vec![DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: count,
            lines,
        }]
    };
    let unified = if degraded {
        let cut = bytes.len().min(MAX_UNIFIED_BYTES);
        lossy(&bytes[..cut]).into_owned()
    } else {
        String::new()
    };
    Some(FileDiff {
        path: path.to_owned(),
        created: Some(true),
        added: count,
        removed: 0,
        unified,
        hunks,
        degraded: degraded.then_some(true),
    })
}

/// One entry of `diff --raw -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    /// The path after.
    pub path: String,
    /// The path before, for renames and copies.
    pub old_path: Option<String>,
    /// The status.
    pub status: GitFileStatus,
    /// The mode before.
    pub old_mode: String,
    /// The mode after.
    pub new_mode: String,
}

/// Parses `diff --raw -z`.
#[must_use]
pub fn parse_raw(out: &[u8]) -> Vec<RawEntry> {
    let text = lossy(out);
    let mut fields = text.split('\0');
    let mut entries = Vec::new();
    while let Some(meta) = fields.next() {
        let Some(meta) = meta.strip_prefix(':') else {
            continue;
        };
        let parts: Vec<&str> = meta.split(' ').collect();
        if parts.len() < 5 {
            continue;
        }
        let code = parts[4].chars().next().unwrap_or('M');
        let status = match code {
            'A' => GitFileStatus::Added,
            'D' => GitFileStatus::Deleted,
            'R' => GitFileStatus::Renamed,
            'C' => GitFileStatus::Copied,
            'T' => GitFileStatus::TypeChanged,
            'U' => GitFileStatus::Conflicted,
            _ => GitFileStatus::Modified,
        };
        let first = fields.next().unwrap_or_default().to_owned();
        let (path, old_path) = if matches!(code, 'R' | 'C') {
            (fields.next().unwrap_or_default().to_owned(), Some(first))
        } else {
            (first, None)
        };
        entries.push(RawEntry {
            path,
            old_path,
            status,
            old_mode: parts[0].to_owned(),
            new_mode: parts[1].to_owned(),
        });
    }
    entries
}

/// The revisions a scope compares: `from` and (for a commit) `to`; `None` `to` means the
/// working tree. A branch scope without a merge base answers as `uncommitted`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range {
    /// The scope answered.
    pub scope: GitScope,
    /// The base of a branch scope.
    pub base: Option<piarc_protocol::git::GitBase>,
    /// The old side.
    pub from: String,
    /// The new side; the working tree when absent.
    pub to: Option<String>,
}

/// Resolves `scope` to revisions.
///
/// # Errors
///
/// The reader's errors; [`GitError::Failed`] for an unknown commit.
pub async fn resolve_range(
    reader: &Reader,
    scope: &GitScope,
    session_base: Option<&str>,
) -> Result<Range, GitError> {
    let head = reader
        .run(
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            ExecOptions::default(),
        )
        .await?;
    let has_head = head.success();
    let empty = || async { crate::status::empty_tree(reader).await };
    match scope {
        GitScope::Commit { sha } => {
            let commit = format!("{sha}^{{commit}}");
            reader
                .ok(&[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    &commit,
                ])
                .await?;
            let parent = format!("{sha}^1");
            let has_parent = reader
                .run(
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "--end-of-options",
                        &parent,
                    ],
                    ExecOptions::default(),
                )
                .await?
                .success();
            let from = if has_parent { parent } else { empty().await? };
            Ok(Range {
                scope: scope.clone(),
                base: None,
                from,
                to: Some(sha.clone()),
            })
        }
        GitScope::Branch { base } if has_head => {
            let refs = crate::refs::ref_names(reader).await?;
            let current = crate::worktree::head_branch(&reader.repo.root);
            let inferred = crate::status::infer_base(
                reader,
                &refs,
                base.as_deref(),
                session_base,
                current.as_deref(),
            )
            .await?;
            match inferred {
                Some(found) if found.merge_base.is_some() => Ok(Range {
                    scope: GitScope::Branch {
                        base: Some(found.name.clone()),
                    },
                    from: found.merge_base.clone().unwrap_or_default(),
                    base: Some(found),
                    to: None,
                }),
                _ => uncommitted(true, reader).await,
            }
        }
        GitScope::Branch { .. } | GitScope::Uncommitted => uncommitted(has_head, reader).await,
    }
}

async fn uncommitted(has_head: bool, reader: &Reader) -> Result<Range, GitError> {
    let from = if has_head {
        "HEAD".to_owned()
    } else {
        crate::status::empty_tree(reader).await?
    };
    Ok(Range {
        scope: GitScope::Uncommitted,
        base: None,
        from,
        to: None,
    })
}

fn range_args<'a>(range: &'a Range, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["diff"];
    args.extend_from_slice(DIFF_FLAGS);
    args.extend_from_slice(extra);
    args.push("--end-of-options");
    args.push(&range.from);
    if let Some(to) = &range.to {
        args.push(to);
    }
    args.push("--");
    args
}

/// The files and (within budget) diffs of `range`.
///
/// # Errors
///
/// The reader's errors.
pub async fn changes(
    reader: &Reader,
    range: Range,
    ignore_whitespace: bool,
) -> Result<GitChanges, GitError> {
    let ws: &[&str] = if ignore_whitespace { &["-w"] } else { &[] };
    let raw = reader.ok(&range_args(&range, &["--raw", "-z"])).await?;
    let mut numstat_flags = vec!["--numstat", "-z"];
    numstat_flags.extend_from_slice(ws);
    let counts =
        crate::status::parse_numstat(&reader.ok(&range_args(&range, &numstat_flags)).await?);
    let mut entries = parse_raw(&raw);
    if range.to.is_none() {
        let others = reader
            .ok(&["ls-files", "-z", "--others", "--exclude-standard"])
            .await?;
        for path in lossy(&others).split('\0').filter(|p| !p.is_empty()) {
            entries.push(RawEntry {
                path: path.to_owned(),
                old_path: None,
                status: GitFileStatus::Untracked,
                old_mode: String::new(),
                new_mode: String::new(),
            });
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let truncated = entries.len() > MAX_FILES;
    entries.truncate(MAX_FILES);
    let mut files: Vec<GitFileChange> = entries
        .iter()
        .map(|entry| change_of(entry, &counts, &reader.repo.root, ignore_whitespace))
        .collect();
    let total: u64 = files
        .iter()
        .map(|f| f.added.unwrap_or(0) + f.removed.unwrap_or(0))
        .sum();
    let mut withheld = files.len() > MAX_PATCH_FILES || total > MAX_PATCH_LINES;
    if !withheld {
        let mut flags = vec!["-U3", "--src-prefix=a/", "--dst-prefix=b/"];
        flags.extend_from_slice(ws);
        let patch = reader
            .run(
                &range_args(&range, &flags),
                ExecOptions {
                    stdout_limit: Some(MAX_PATCH_BYTES),
                    ..ExecOptions::default()
                },
            )
            .await?;
        if !patch.success() {
            return Err(crate::repo::failed(&["diff"], &patch));
        }
        if patch.truncated {
            withheld = true;
        } else {
            attach(&mut files, &parse_patch(&patch.stdout));
        }
    }
    if withheld {
        for file in &mut files {
            file.diff = None;
        }
    }
    let added = files.iter().filter_map(|f| f.added).sum();
    let removed = files.iter().filter_map(|f| f.removed).sum();
    Ok(GitChanges {
        scope: range.scope,
        base: range.base,
        files,
        added,
        removed,
        withheld: withheld.then_some(true),
        truncated: truncated.then_some(true),
    })
}

fn change_of(
    entry: &RawEntry,
    counts: &HashMap<String, Option<(u64, u64)>>,
    root: &Path,
    ignore_whitespace: bool,
) -> GitFileChange {
    let submodule = entry.old_mode == "160000" || entry.new_mode == "160000";
    let mode_changed = entry.status != GitFileStatus::Added
        && entry.status != GitFileStatus::Deleted
        && entry.status != GitFileStatus::Untracked
        && entry.old_mode != entry.new_mode;
    if entry.status == GitFileStatus::Untracked {
        let diff = untracked_diff(root, &entry.path);
        return GitFileChange {
            path: entry.path.clone(),
            old_path: None,
            status: GitFileStatus::Untracked,
            added: diff.as_ref().map(|d| d.added),
            removed: diff.as_ref().map(|_| 0),
            binary: diff.is_none().then_some(true),
            old_mode: None,
            new_mode: None,
            submodule: None,
            diff,
        };
    }
    let pair = counts.get(&entry.path).copied().flatten();
    let binary = !submodule && counts.get(&entry.path).is_some_and(Option::is_none);
    GitFileChange {
        path: entry.path.clone(),
        old_path: entry.old_path.clone(),
        status: entry.status,
        added: pair.map(|p| p.0),
        removed: pair.map(|p| p.1),
        binary: binary.then_some(true),
        old_mode: mode_changed.then(|| entry.old_mode.clone()),
        new_mode: mode_changed.then(|| entry.new_mode.clone()),
        submodule: submodule.then_some(true),
        // A listed text file without a patch section changed only in whitespace (with `-w`)
        // or only in mode or name: an empty diff tells the client so.
        diff: (!binary && !submodule).then(|| FileDiff {
            path: entry.path.clone(),
            created: (entry.status == GitFileStatus::Added).then_some(true),
            added: if ignore_whitespace {
                0
            } else {
                pair.map_or(0, |p| p.0)
            },
            removed: if ignore_whitespace {
                0
            } else {
                pair.map_or(0, |p| p.1)
            },
            unified: String::new(),
            hunks: Vec::new(),
            degraded: None,
        }),
    }
}

/// Puts the parsed patch sections on their files.
fn attach(files: &mut [GitFileChange], parsed: &[ParsedFile]) {
    let mut by_path: HashMap<&str, &ParsedFile> = HashMap::new();
    for file in parsed {
        if let Some(path) = file.path() {
            by_path.insert(path, file);
        }
    }
    for file in files.iter_mut() {
        if file.status == GitFileStatus::Untracked {
            continue;
        }
        let Some(section) = by_path.get(file.path.as_str()) else {
            continue;
        };
        if section.binary {
            file.binary = Some(true);
            file.diff = None;
            continue;
        }
        file.diff = Some(file_diff(
            &file.path,
            section,
            file.status == GitFileStatus::Added,
        ));
    }
}

/// One file's diff in `range` (`fileDiff`).
///
/// # Errors
///
/// The reader's errors.
pub async fn single(
    reader: &Reader,
    range: &Range,
    path: &str,
    old_path: Option<&str>,
    ignore_whitespace: bool,
) -> Result<Option<FileDiff>, GitError> {
    let tracked = reader
        .run(
            &["ls-files", "--error-unmatch", "--", path],
            ExecOptions::default(),
        )
        .await?
        .success();
    let in_range = range.to.is_some() || tracked || old_path.is_some();
    if !in_range {
        return Ok(untracked_diff(&reader.repo.root, path));
    }
    let mut flags = vec!["-U3", "--src-prefix=a/", "--dst-prefix=b/"];
    if ignore_whitespace {
        flags.push("-w");
    }
    let mut args = range_args(range, &flags);
    args.push(path);
    if let Some(old) = old_path {
        args.push(old);
    }
    let out = reader
        .run(
            &args,
            ExecOptions {
                stdout_limit: Some(MAX_FILE_BYTES),
                ..ExecOptions::default()
            },
        )
        .await?;
    if !out.success() {
        return Err(crate::repo::failed(&["diff"], &out));
    }
    let parsed = parse_patch(&out.stdout);
    let Some(section) = parsed.iter().find(|f| f.path() == Some(path)) else {
        return Ok(None);
    };
    if section.binary {
        return Ok(None);
    }
    let mut diff = file_diff(path, section, section.old_path.is_none());
    if out.truncated {
        diff.degraded = Some(true);
        diff.hunks.clear();
    }
    Ok(Some(diff))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &[u8] = b"diff --git a/src/a.rs b/src/a.rs\n\
index 1111111..2222222 100644\n\
--- a/src/a.rs\n\
+++ b/src/a.rs\n\
@@ -1,3 +1,3 @@ fn main\n\
\x20one\n\
-two\n\
+TWO\r\n\
\x20three\n\
@@ -10 +10,2 @@\n\
-last\n\
\\ No newline at end of file\n\
+last\n\
+more\n\
\\ No newline at end of file\n\
diff --git a/new file.md b/new file.md\n\
new file mode 100644\n\
index 0000000..3333333\n\
--- /dev/null\n\
+++ b/new file.md\t\n\
@@ -0,0 +1 @@\n\
+hello\n\
diff --git a/img.png b/img.png\n\
index 4444444..5555555 100644\n\
Binary files a/img.png and b/img.png differ\n\
diff --git a/old.rs b/new.rs\n\
similarity index 100%\n\
rename from old.rs\n\
rename to new.rs\n\
diff --git a/run.sh b/run.sh\n\
old mode 100644\n\
new mode 100755\n\
diff --git \"a/tab\\there.txt\" \"b/tab\\there.txt\"\n\
deleted file mode 100644\n\
index 6666666..0000000\n\
--- \"a/tab\\there.txt\"\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-gone\n";

    #[test]
    fn patches_parse_paths_modes_and_hunks() {
        let files = parse_patch(PATCH);
        assert_eq!(files.len(), 6);
        let a = &files[0];
        assert_eq!(a.path(), Some("src/a.rs"));
        assert_eq!(a.hunks.len(), 2);
        assert_eq!(a.hunks[0].hunk.lines[2].text, "TWO");
        assert_eq!(a.hunks[1].hunk.lines[0].no_newline, Some(true));
        assert_eq!(a.hunks[1].hunk.lines[2].no_newline, Some(true));
        assert_eq!(files[1].new_path.as_deref(), Some("new file.md"));
        assert_eq!(files[1].old_path, None);
        assert!(files[2].binary);
        assert_eq!(files[2].path(), Some("img.png"));
        assert_eq!(files[3].old_path.as_deref(), Some("old.rs"));
        assert_eq!(files[3].new_path.as_deref(), Some("new.rs"));
        assert_eq!(files[4].path(), Some("run.sh"));
        assert_eq!(files[4].new_mode.as_deref(), Some("100755"));
        assert_eq!(files[5].old_path.as_deref(), Some("tab\there.txt"));
        assert_eq!(files[5].new_path, None);
        let diff = file_diff("src/a.rs", a, false);
        assert_eq!((diff.added, diff.removed), (3, 2));
        assert!(diff.unified.is_empty());
    }

    #[test]
    fn raw_entries_with_renames() {
        let out = b":100644 100644 aaa bbb M\0a.txt\0:100644 100644 ccc ccc R100\0old.rs\0new.rs\0:000000 100644 000 ddd A\0n.md\0";
        let entries = parse_raw(out);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].status, GitFileStatus::Renamed);
        assert_eq!(entries[1].old_path.as_deref(), Some("old.rs"));
        assert_eq!(entries[1].path, "new.rs");
        assert_eq!(entries[2].status, GitFileStatus::Added);
    }

    #[test]
    fn quoted_names_decode_octal_utf8() {
        assert_eq!(unquote(b"\"\\344\\270\\255.txt\""), "中.txt");
        assert_eq!(unquote(b"plain name"), "plain name");
    }
}
