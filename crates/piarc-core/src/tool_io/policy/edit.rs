//! Verify the final text supplied by Pi against the approved Edit arguments. Pi still executes
//! the tool and reports match diagnostics. The LF/fuzzy matching and touched-line semantics
//! follow Pi v1.5.2, packages/coding-agent/src/core/tools/edit-diff.ts (MIT,
//! Copyright (c) 2025 Mario Zechner). We compare under Core's write lock using UTF-8 offsets.
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::ops::Range;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

struct Replacement {
    span: Range<usize>,
    new: String,
}

fn lf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn fuzzy(text: &str) -> String {
    let normalized: String = text.nfkc().collect();
    normalized
        .split('\n')
        .map(|line| {
            line.trim_end_matches(|c: char| {
                (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}'
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .map(|ch| match ch {
            '\u{2018}'..='\u{201b}' => '\'',
            '\u{201c}'..='\u{201f}' => '"',
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{00a0}' | '\u{2002}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// The only legal new content of this call, computed without modifying the file.
pub(super) fn proposed(before: &str, edits: &[Value], all: bool) -> Option<String> {
    let raw = before.strip_prefix('\u{feff}').unwrap_or(before);
    let normalized = lf(raw);
    let edits = edits
        .iter()
        .map(|e| Some((lf(e["oldText"].as_str()?), lf(e["newText"].as_str()?))))
        .collect::<Option<Vec<_>>>()?;
    if edits.is_empty() || edits.iter().any(|(old, _)| old.is_empty()) {
        return None;
    }
    let mut output = before[..before.len() - raw.len()].to_owned();
    if all {
        let mut runs: Vec<_> = edits
            .iter()
            .map(|(old, _)| normalized.match_indices(old))
            .collect();
        let mut positions = BinaryHeap::new();
        for (i, matches) in runs.iter_mut().enumerate() {
            let (start, part) = matches.next()?;
            positions.push(Reverse((start, start + part.len(), i)));
        }
        // Merge the matches in file order without allocating an object for every occurrence.
        let changes = std::iter::from_fn(|| {
            let Reverse((start, end, i)) = positions.pop()?;
            if let Some((next, part)) = runs[i].next() {
                positions.push(Reverse((next, next + part.len(), i)));
            }
            Some((start..end, edits[i].1.as_str()))
        });
        apply_raw(raw, changes, &mut output)?;
        return Some(output);
    }
    let fallback = edits.iter().any(|(old, _)| !normalized.contains(old));
    let fuzzy_base = fuzzy(&normalized);
    let base = if fallback { &fuzzy_base } else { &normalized };
    let mut changes = Vec::new();
    for (old, new) in edits {
        let key = fuzzy(&old);
        if fuzzy_base.match_indices(&key).take(2).count() > 1 {
            return None;
        }
        let pattern = if fallback && !base.contains(&old) {
            fuzzy(&old)
        } else {
            old
        };
        let mut matches = base.match_indices(pattern.as_str()).peekable();
        matches.peek()?;
        for (at, part) in matches {
            changes.push(Replacement {
                span: at..at + part.len(),
                new: new.clone(),
            });
        }
    }
    changes.sort_by_key(|r| r.span.start);
    if changes.windows(2).any(|w| w[0].span.end > w[1].span.start) {
        return None;
    }
    if fallback {
        changes = widen(&normalized, base, &changes)?;
    }
    apply_raw(
        raw,
        changes.iter().map(|r| (r.span.clone(), r.new.as_str())),
        &mut output,
    )?;
    Some(output)
}

fn line_limits(text: &str) -> Vec<usize> {
    let mut ends = vec![0];
    for line in text.split_inclusive('\n') {
        ends.push(ends.last().copied().unwrap_or(0) + line.len());
    }
    ends
}

// Fuzzy matches replace the affected normalized lines; retain every other line verbatim.
fn widen(original: &str, base: &str, edits: &[Replacement]) -> Option<Vec<Replacement>> {
    let old = line_limits(original);
    let normalized = line_limits(base);
    if old.len() != normalized.len() {
        return None;
    }
    let mut result = Vec::new();
    let mut index = 0;
    while index < edits.len() {
        let first = normalized
            .partition_point(|&pos| pos <= edits[index].span.start)
            .checked_sub(1)?;
        let mut last = normalized.partition_point(|&pos| pos < edits[index].span.end);
        let start = normalized[first];
        let mut cursor = start;
        let mut text = String::new();
        while let Some(edit) = edits.get(index) {
            if edit.span.start >= *normalized.get(last)? {
                break;
            }
            text.push_str(&base[cursor..edit.span.start]);
            text.push_str(&edit.new);
            cursor = edit.span.end;
            last = normalized.partition_point(|&pos| pos < cursor);
            index += 1;
        }
        text.push_str(&base[cursor..normalized[last]]);
        result.push(Replacement {
            span: old[first]..old[last],
            new: text,
        });
    }
    Some(result)
}

fn apply_raw<'a>(
    raw: &str,
    changes: impl Iterator<Item = (Range<usize>, &'a str)>,
    output: &mut String,
) -> Option<()> {
    let mut crlfs = raw
        .match_indices("\r\n")
        .enumerate()
        .map(|(i, (at, _))| at - i)
        .peekable();
    let mut shift = 0;
    let mut original = |offset| {
        while crlfs.next_if(|&at| at < offset).is_some() {
            shift += 1;
        }
        offset + shift
    };
    let mut endings = raw.match_indices('\n').map(|(at, _)| at).peekable();
    let mut last_lf = None;
    let mut position = 0;
    for (span, new) in changes {
        let start = original(span.start);
        if start < position {
            return None;
        }
        append(output, &raw[position..start])?;
        if new.contains('\n') {
            while let Some(at) = endings.next_if(|&at| at < start) {
                last_lf = Some(at);
            }
            let newline = match endings.peek().copied().or(last_lf) {
                Some(at) if raw[..at].ends_with('\r') => "\r\n",
                None if raw.contains('\r') => "\r",
                _ => "\n",
            };
            // Internal newlines form one inserted part; the seam rule applies at its start.
            let new = new.replace('\n', newline);
            append(output, &new)?;
        } else {
            append(output, new)?;
        }
        position = original(span.end);
    }
    append(output, &raw[position..])
}

fn append(output: &mut String, part: &str) -> Option<()> {
    let seam = output.ends_with('\r') && part.starts_with('\n');
    if (output.len() + part.len() + usize::from(seam)) as u64 > piarc_protocol::fs::MAX_UPLOAD_BYTES
    {
        return None;
    }
    if seam {
        output.push('\n');
    }
    output.push_str(part);
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approves_only_pi_edit_results_even_with_fuzzy_matching_and_mixed_endings() {
        let edit = [json!({"oldText":"'old'","newText":"new\nline"})];
        assert_eq!(
            proposed("untouched  \n\u{2018}old\u{2019}  \r\n", &edit, false).as_deref(),
            Some("untouched  \nnew\r\nline\r\n")
        );
        let edit = [json!({"oldText":"old","newText":"revised"})];
        assert_eq!(
            proposed("old\r\nold\n", &edit, true).as_deref(),
            Some("revised\r\nrevised\n")
        );
        assert!(proposed("old old", &edit, false).is_none());
    }
}
