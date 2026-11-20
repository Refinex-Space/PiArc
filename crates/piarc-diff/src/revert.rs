//! Reverse application of hunks: the Changes panel's "discard this hunk" (ADR-0044 rule 8).
//!
//! The hunks are those [`crate::file_diff`] computed from a base to `current`. Each one's new
//! side (context and added lines) must still be in `current` at its place, line for line
//! (texts compared without line breaks), or nothing is changed. The lines are replaced by the
//! hunk's old side (context and removed lines): context lines keep their bytes from `current`,
//! removed lines come back with the line break of the lines around them (the first one in the
//! hunk's region, else the file's first, else `\n`), or none where the hunk marks the end of
//! the file without one. Several hunks are applied from the bottom up, so each one's line
//! numbers stay valid however many lines the ones below it add or remove.

use std::borrow::Cow;

use piarc_protocol::diff::{DiffHunk, DiffLine, DiffLineKind};

/// Why hunks could not be reverted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RevertError {
    /// A hunk's new side is not in the text where it says (the file changed since the diff).
    #[error("the text at line {line} no longer matches the change")]
    Mismatch {
        /// 1-based line in the current text where the hunk starts.
        line: u64,
    },
    /// Two hunks cover the same lines.
    #[error("the changes overlap")]
    Overlap,
}

/// `current` with every hunk of `hunks` reverted.
///
/// # Errors
///
/// [`RevertError::Mismatch`] when a hunk does not apply, [`RevertError::Overlap`] when two do
/// not leave each other's lines alone; `current` is not changed.
pub fn revert_hunks(current: &str, hunks: &[&DiffHunk]) -> Result<String, RevertError> {
    let mut lines: Vec<Cow<'_, str>> = current.split_inclusive('\n').map(Cow::Borrowed).collect();
    let file_break = lines.iter().find_map(|l| line_break(l)).unwrap_or("\n");
    let mut sorted: Vec<&DiffHunk> = hunks.to_vec();
    sorted.sort_by_key(|h| std::cmp::Reverse(h.new_start));
    let mut floor = usize::MAX;
    for hunk in sorted {
        let mismatch = RevertError::Mismatch {
            line: hunk.new_start,
        };
        let start = start_index(hunk);
        let count = usize::try_from(hunk.new_lines).map_err(|_| RevertError::Overlap)?;
        // Bottom up: a hunk must end where the one below it starts, at the latest.
        if start.saturating_add(count) > floor {
            return Err(RevertError::Overlap);
        }
        floor = start;
        let region = lines.get(start..start + count).ok_or(mismatch.clone())?;
        let new_side: Vec<&DiffLine> = hunk
            .lines
            .iter()
            .filter(|l| l.kind != DiffLineKind::Removed)
            .collect();
        let applies = new_side.len() == region.len()
            && new_side
                .iter()
                .zip(region)
                .all(|(expected, actual)| strip_break(actual) == expected.text);
        if !applies {
            return Err(mismatch);
        }
        let ending = region
            .iter()
            .find_map(|l| line_break(l))
            .unwrap_or(file_break);
        let mut context = region
            .iter()
            .zip(&new_side)
            .filter(|(_, l)| l.kind == DiffLineKind::Context)
            .map(|(actual, _)| actual.clone());
        let mut old_side = Vec::with_capacity(hunk.lines.len());
        for line in &hunk.lines {
            match line.kind {
                DiffLineKind::Context => old_side.push(context.next().ok_or(mismatch.clone())?),
                DiffLineKind::Removed => {
                    let end = if line.no_newline == Some(true) {
                        ""
                    } else {
                        ending
                    };
                    old_side.push(Cow::Owned(format!("{}{end}", line.text)));
                }
                DiffLineKind::Added => {}
            }
        }
        lines.splice(start..start + count, old_side);
    }
    Ok(lines.concat())
}

/// The 0-based index of a hunk's first new-side line (an empty side starts after its line).
fn start_index(hunk: &DiffHunk) -> usize {
    let start = usize::try_from(hunk.new_start).unwrap_or(usize::MAX);
    if hunk.new_lines == 0 {
        start
    } else {
        start.saturating_sub(1)
    }
}

fn line_break(line: &str) -> Option<&'static str> {
    if line.ends_with("\r\n") {
        Some("\r\n")
    } else if line.ends_with('\n') {
        Some("\n")
    } else {
        None
    }
}

fn strip_break(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
mod tests;
