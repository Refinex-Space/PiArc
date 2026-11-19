//! Memory directives in Markdown prose. File I/O and approval belong to the caller.

use std::collections::{HashMap, VecDeque};
use std::io;

/// Replaces an import at its original position. Missing and previously included imports
/// retain their original spelling, so cross-references in the document remain readable.
pub(super) fn expand(
    text: &str,
    mut import: impl FnMut(&str) -> io::Result<Option<String>>,
) -> io::Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut prose = String::new();
    let mut fence = None;
    let mut comment = false;
    for line in text.split_inclusive('\n') {
        let body = block_body(line);
        if let Some((marker, count)) = fence {
            out.push_str(line);
            if delimiter(body)
                .is_some_and(|(ch, n, rest)| ch == marker && n >= count && rest.trim().is_empty())
            {
                fence = None;
            }
        } else if comment || body.starts_with("<!--") {
            flush(&mut out, &mut prose, &mut import)?;
            let mut remaining = line;
            loop {
                let Some((_, tail)) = remaining.split_once("-->") else {
                    comment = true;
                    break;
                };
                if tail.trim_start().starts_with("<!--") {
                    remaining = tail;
                } else {
                    comment = false;
                    prose.push_str(tail);
                    break;
                }
            }
        } else if let Some((ch, n, rest)) = delimiter(body)
            && (ch != b'`' || !rest.contains('`'))
        {
            flush(&mut out, &mut prose, &mut import)?;
            out.push_str(line);
            fence = Some((ch, n));
        } else if body.starts_with([' ', '\t']) || body.trim().is_empty() {
            flush(&mut out, &mut prose, &mut import)?;
            out.push_str(line);
        } else {
            prose.push_str(line);
        }
    }
    flush(&mut out, &mut prose, &mut import)?;
    Ok(out)
}

// Up to three spaces may precede a block marker. Account for quoted blocks and the
// first line of a list item before classifying fences, comments and indented code.
fn block_body(mut line: &str) -> &str {
    loop {
        line = &line[line.bytes().take(3).take_while(|&c| c == b' ').count()..];
        if let Some(rest) = line.strip_prefix('>') {
            line = rest.strip_prefix(' ').unwrap_or(rest);
        } else if let Some(rest) = line
            .strip_prefix(['-', '*', '+'])
            .and_then(|s| s.strip_prefix(' '))
        {
            line = rest;
        } else {
            return line;
        }
    }
}

fn delimiter(line: &str) -> Option<(u8, usize, &str)> {
    let &marker = line.as_bytes().first()?;
    if !matches!(marker, b'~' | b'`') {
        return None;
    }
    let count = line.bytes().take_while(|&c| c == marker).count();
    (count >= 3).then(|| (marker, count, &line[count..]))
}

fn flush(
    out: &mut String,
    prose: &mut String,
    import: &mut impl FnMut(&str) -> io::Result<Option<String>>,
) -> io::Result<()> {
    if !prose.contains('@') {
        out.push_str(prose);
        prose.clear();
        return Ok(());
    }
    let mut ticks = tick_runs(prose);
    let mut offset = 0;
    while let Some(next) = prose[offset..].find(['@', '`', '<']) {
        let start = offset + next;
        out.push_str(&prose[offset..start]);
        let tail = &prose[start..];
        if tail.starts_with('`') {
            let width = tail.bytes().take_while(|&c| c == b'`').count();
            let mut end = start + width;
            if !escaped(&prose[..start])
                && let Some(runs) = ticks.get_mut(&width)
            {
                while runs.front().is_some_and(|&pos| pos <= start) {
                    runs.pop_front();
                }
                if let Some(closing) = runs.pop_front() {
                    end = closing + width;
                }
            }
            out.push_str(&prose[start..end]);
            offset = end;
        } else if tail.starts_with("<!--") {
            // Inline HTML comments are part of the Markdown, but their text is not prose.
            let n = tail.find("-->").map_or(tail.len(), |index| index + 3);
            out.push_str(&tail[..n]);
            offset = start + n;
        } else if let Some((reference, consumed)) = directive(&prose[..start], tail) {
            if let Some(content) = import(reference)? {
                out.push_str(&content);
            } else {
                out.push_str(&tail[..consumed]);
            }
            offset = start + consumed;
        } else {
            out.push_str(&tail[..1]);
            offset = start + 1;
        }
    }
    out.push_str(&prose[offset..]);
    prose.clear();
    Ok(())
}

// Index closing backtick runs by width so an unmatched run stays literal without
// repeatedly searching the remainder of a large paragraph.
fn tick_runs(text: &str) -> HashMap<usize, VecDeque<usize>> {
    let mut runs: HashMap<_, VecDeque<_>> = HashMap::new();
    let mut cursor = 0;
    while let Some(delta) = text[cursor..].find('`') {
        let start = cursor + delta;
        let width = text[start..].bytes().take_while(|&c| c == b'`').count();
        runs.entry(width).or_default().push_back(start);
        cursor = start + width;
    }
    runs
}

fn escaped(prefix: &str) -> bool {
    !prefix
        .bytes()
        .rev()
        .take_while(|&b| b == b'\\')
        .count()
        .is_multiple_of(2)
}

fn directive<'a>(prefix: &str, tail: &'a str) -> Option<(&'a str, usize)> {
    let after = tail.strip_prefix('@')?;
    if prefix
        .chars()
        .next_back()
        .is_some_and(|ch| !ch.is_whitespace() && !"([{".contains(ch))
    {
        return None;
    }
    if let Some(quote) = after.chars().next().filter(|&c| matches!(c, '\'' | '"')) {
        let (path, _) = after[1..].split_once(quote)?;
        if path.is_empty() || path.contains(['\r', '\n']) {
            return None;
        }
        return Some((path, path.len() + 3));
    }
    let end = after
        .find(|ch: char| ch.is_whitespace() || "`<>[](){}\"'".contains(ch))
        .unwrap_or(after.len());
    let path = after[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
    (!path.is_empty()).then_some((path, path.len() + 1))
}
