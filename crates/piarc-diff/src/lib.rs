//! piarc-diff: diff computation (similar), hunk structure, large-diff degradation, UTF-16 offsets.
//!
//! # Responsibilities
//!
//! - Line diffs of a file change ([`file_diff`]): the unified diff text and the same change as
//!   hunks ([`FileDiff`] of `piarc-protocol`), computed with `similar` (Myers, with a time
//!   limit after which it approximates).
//! - Degradation for large changes: past [`MAX_HUNK_LINES`] changed lines or
//!   [`MAX_UNIFIED_BYTES`] of diff text the hunks are left out and the text is cut; the line
//!   counts stay exact.
//! - Reverse application of hunks ([`revert_hunks`]): the Changes panel's "discard this hunk"
//!   (T28, ADR-0044).
//! - The Changes panel's degradation thresholds ([`MAX_PANEL_FILES`], [`MAX_PANEL_LINES`]).
//! - Text offsets for the client are UTF-16 code units (architecture section 7.7); the line
//!   diff has none.
//!
//! # Not responsible for
//!
//! - Reading files or repositories (`piarc-fs`, `piarc-git`).
//! - Rendering diffs.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

use std::fmt::Write as _;
use std::time::Duration;

mod revert;

pub use revert::{RevertError, revert_hunks};

use piarc_protocol::diff::{DiffHunk, DiffLine, DiffLineKind, FileDiff};
use similar::{ChangeTag, TextDiff};

/// Lines of unchanged context around each change.
pub const CONTEXT_LINES: usize = 3;

/// More added and removed lines than this, and the diff keeps no hunks (architecture 7.7).
pub const MAX_HUNK_LINES: u64 = 5_000;

/// Longest unified diff text kept; a longer one is cut there and the hunks are left out.
pub const MAX_UNIFIED_BYTES: usize = 512 * 1024;

/// More changed files than this, and the Changes panel lists paths and counts only; a file's
/// diff is fetched when it is expanded and shown as plain text (architecture 7.7).
pub const MAX_PANEL_FILES: usize = 300;

/// More added and removed lines than this across the session's files, and the Changes panel
/// degrades as for [`MAX_PANEL_FILES`].
pub const MAX_PANEL_LINES: u64 = 5_000;

/// How long the diff algorithm may search before it settles for a coarser diff.
const DIFF_TIME_LIMIT: Duration = Duration::from_secs(2);

/// The change from `old` (`None`: the file did not exist) to `new` of the file `label` (as the
/// diff names it, see [`FileDiff::path`]).
#[must_use]
pub fn file_diff(label: &str, old: Option<&str>, new: &str) -> FileDiff {
    let before = old.unwrap_or("");
    let diff = TextDiff::configure()
        .timeout(DIFF_TIME_LIMIT)
        .diff_lines(before, new);
    let (mut added, mut removed) = (0_u64, 0_u64);
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    let mut hunks = Vec::new();
    let mut preview = Preview::default();
    let keep_lines = added + removed <= MAX_HUNK_LINES;
    let groups = diff.grouped_ops(CONTEXT_LINES);
    if !groups.is_empty() {
        if old.is_none() {
            let _ = writeln!(preview, "--- /dev/null");
        } else {
            let _ = writeln!(preview, "--- a/{label}");
        }
        let _ = writeln!(preview, "+++ b/{label}");
    }
    for group in &groups {
        let mut hunk = hunk(group, Vec::new());
        let _ = writeln!(
            preview,
            "@@ -{} +{} @@",
            range(hunk.old_start, hunk.old_lines),
            range(hunk.new_start, hunk.new_lines)
        );
        for change in group.iter().flat_map(|op| diff.iter_changes(op)) {
            let (sign, kind) = match change.tag() {
                ChangeTag::Equal => (' ', DiffLineKind::Context),
                ChangeTag::Insert => ('+', DiffLineKind::Added),
                ChangeTag::Delete => ('-', DiffLineKind::Removed),
            };
            let line = without_line_break(change.value());
            let _ = writeln!(preview, "{sign}{line}");
            if change.missing_newline() {
                let _ = writeln!(preview, "\\ No newline at end of file");
            }
            if keep_lines && preview.omitted == 0 {
                hunk.lines.push(DiffLine {
                    kind,
                    text: line.to_owned(),
                    no_newline: change.missing_newline().then_some(true),
                });
            }
        }
        if keep_lines && preview.omitted == 0 {
            hunks.push(hunk);
        }
    }
    let degraded = !keep_lines || preview.omitted > 0;
    FileDiff {
        path: label.to_owned(),
        created: old.is_none().then_some(true),
        added,
        removed,
        unified: preview.finish(),
        hunks: if degraded { Vec::new() } else { hunks },
        degraded: degraded.then_some(true),
    }
}

/// The hunk of one op group: its ranges in unified diff convention (1-based; an empty range
/// starts at the line before it).
fn hunk(group: &[similar::DiffOp], lines: Vec<DiffLine>) -> DiffHunk {
    let (first, last) = (&group[0], &group[group.len() - 1]);
    let old = first.old_range().start..last.old_range().end;
    let new = first.new_range().start..last.new_range().end;
    let start = |range: &std::ops::Range<usize>| -> u64 {
        if range.is_empty() {
            range.start as u64
        } else {
            range.start as u64 + 1
        }
    };
    DiffHunk {
        old_start: start(&old),
        old_lines: old.len() as u64,
        new_start: start(&new),
        new_lines: new.len() as u64,
        lines,
    }
}

/// `line` without its `\n` or `\r\n`.
fn without_line_break(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

/// Keeps the prefix while counting the exact UTF-8 bytes omitted from the preview.
#[derive(Default)]
struct Preview {
    text: String,
    omitted: usize,
}

impl std::fmt::Write for Preview {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        let keep = if self.omitted == 0 {
            value.floor_char_boundary((MAX_UNIFIED_BYTES - self.text.len()).min(value.len()))
        } else {
            0
        };
        self.text.push_str(&value[..keep]);
        self.omitted += value.len() - keep;
        Ok(())
    }
}

impl Preview {
    fn finish(mut self) -> String {
        if self.omitted > 0 {
            let _ = writeln!(self.text, "\n[diff cut: {} more bytes]", self.omitted);
        }
        self.text
    }
}

/// A hunk range as unified diff writes it: `start` alone for one line.
fn range(start: u64, lines: u64) -> String {
    if lines == 1 {
        start.to_string()
    } else {
        format!("{start},{lines}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(hunk: &DiffHunk) -> Vec<(DiffLineKind, &str)> {
        hunk.lines
            .iter()
            .map(|l| (l.kind, l.text.as_str()))
            .collect()
    }

    #[test]
    fn one_changed_line_gives_one_hunk_with_context() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nb\nc\nd\nE\nf\ng\nh\n";
        let diff = file_diff("src/x 文.txt", Some(old), new);
        assert_eq!((diff.added, diff.removed), (1, 1));
        assert_eq!(diff.created, None);
        assert_eq!(diff.hunks.len(), 1);
        let hunk = &diff.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (2, 7, 2, 7)
        );
        assert_eq!(
            kinds(hunk),
            vec![
                (DiffLineKind::Context, "b"),
                (DiffLineKind::Context, "c"),
                (DiffLineKind::Context, "d"),
                (DiffLineKind::Removed, "e"),
                (DiffLineKind::Added, "E"),
                (DiffLineKind::Context, "f"),
                (DiffLineKind::Context, "g"),
                (DiffLineKind::Context, "h"),
            ]
        );
        assert_eq!(
            diff.unified,
            "--- a/src/x 文.txt\n+++ b/src/x 文.txt\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n"
        );
    }

    #[test]
    fn a_new_file_starts_at_line_zero_and_marks_a_missing_final_newline() {
        let diff = file_diff("n.txt", None, "one\ntwo");
        assert_eq!(diff.created, Some(true));
        assert_eq!((diff.added, diff.removed), (2, 0));
        let hunk = &diff.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (0, 0, 1, 2)
        );
        assert_eq!(hunk.lines[1].no_newline, Some(true));
        assert_eq!(
            diff.unified,
            "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n"
        );
    }

    #[test]
    fn distant_changes_are_separate_hunks_and_crlf_is_not_part_of_the_text() {
        let old: String = (1..=20).map(|n| format!("line {n}\r\n")).collect();
        let new = old
            .replace("line 2\r\n", "line two\r\n")
            .replace("line 18\r\n", "line eighteen\r\n");
        let diff = file_diff("crlf.txt", Some(&old), &new);
        assert_eq!(diff.hunks.len(), 2);
        assert_eq!(diff.hunks[0].old_start, 1);
        assert_eq!(diff.hunks[1].old_start, 15);
        assert!(diff.hunks[0].lines.iter().all(|l| !l.text.contains('\r')));
        assert_eq!(diff.hunks[1].lines[3].text, "line 18");
    }

    #[test]
    fn identical_text_has_no_hunks_and_no_text() {
        let diff = file_diff("same.txt", Some("x\n"), "x\n");
        assert!(diff.hunks.is_empty());
        assert_eq!(diff.unified, "");
        assert_eq!((diff.added, diff.removed), (0, 0));
    }

    #[test]
    fn deleting_every_line_keeps_the_old_start_and_a_zero_new_start() {
        let diff = file_diff("gone.txt", Some("a\nb\n"), "");
        let hunk = &diff.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 2, 0, 0)
        );
        assert!(diff.unified.contains("@@ -1,2 +0,0 @@"));
    }

    #[test]
    fn a_large_change_degrades_with_exact_counts() {
        let new: String = (0..6_000).map(|n| format!("{n}\n")).collect();
        let diff = file_diff("big.txt", Some(""), &new);
        assert_eq!(diff.added, 6_000);
        assert_eq!(diff.degraded, Some(true));
        assert!(diff.hunks.is_empty());
        assert!(diff.unified.len() <= MAX_UNIFIED_BYTES + 64);
    }

    #[test]
    fn a_long_unified_text_is_cut_at_a_character_boundary() {
        let line = "中".repeat(MAX_UNIFIED_BYTES);
        let diff = file_diff("wide.txt", Some("a\n"), &format!("{line}\n{line}\n"));
        assert_eq!(diff.degraded, Some(true));
        assert!(diff.unified.contains("[diff cut: "));
        assert!(
            diff.unified.capacity() <= MAX_UNIFIED_BYTES * 2 + 128,
            "bounded preview allocation"
        );
        assert!(diff.hunks.is_empty());
    }
}
