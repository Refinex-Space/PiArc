//! Full-text search over sessions (T35, architecture section 9.2): `session_fts` indexes the
//! text of user messages and assistant replies (`session_text`) with FTS5's trigram tokenizer.
//!
//! - Trigrams find substrings in any script, so Chinese, English and mixed text are all
//!   searchable without a word segmenter. Terms are split at whitespace and all must occur.
//! - A term shorter than three characters has no trigram: such a query is answered by `LIKE`
//!   over `session_text` (a scan, case-insensitive for ASCII only).
//! - Results are grouped by session (most recently updated first) with a snippet around the
//!   first match and the matched ranges in UTF-16 code units, so the client can highlight
//!   them without building markup from text. Subagents' sessions are not listed.

use std::collections::HashMap;

use rusqlite::params_from_iter;

use crate::error::{Error, Result};
use crate::store::Store;

/// The most terms of one query.
pub const MAX_TERMS: usize = 8;

/// The most characters of one query.
pub const MAX_QUERY_CHARS: usize = 200;

/// Rows read for one query at most (before grouping).
const MAX_ROWS: usize = 2_000;

/// Characters of context before the first match in a snippet.
const BEFORE: usize = 40;

/// Characters of a snippet at most.
const SNIPPET_CHARS: usize = 160;

/// One matching entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// The entry the text belongs to.
    pub entry_id: Option<String>,
    /// `user` or `assistant`.
    pub role: String,
    /// When it was written (Unix ms).
    pub at: Option<i64>,
    /// The text around the first match, on one line.
    pub snippet: String,
    /// Matched ranges in `snippet`, as UTF-16 code unit offsets `[start, end)`.
    pub highlights: Vec<(usize, usize)>,
}

/// The matches of one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionHits {
    /// The session.
    pub session_id: String,
    /// The first matches, in conversation order.
    pub hits: Vec<SearchHit>,
    /// Matching entries in all (of the rows read).
    pub total: usize,
}

impl Store {
    /// Sessions whose text contains every whitespace-separated term of `query`: at most
    /// `sessions` sessions, `per_session` hits each.
    ///
    /// # Errors
    ///
    /// [`Error::Sqlite`] when the index cannot be read.
    pub fn search_sessions(
        &self,
        query: &str,
        sessions: usize,
        per_session: usize,
    ) -> Result<Vec<SessionHits>> {
        let terms = terms(query);
        if terms.is_empty() || sessions == 0 {
            return Ok(Vec::new());
        }
        let trigrams = terms.iter().all(|t| t.chars().count() >= 3);
        let (filter, values): (String, Vec<String>) = if trigrams {
            let expression = terms
                .iter()
                .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            (
                "t.id IN (SELECT rowid FROM session_fts WHERE session_fts MATCH ?)".into(),
                vec![expression],
            )
        } else {
            let filter = vec!["t.text LIKE ? ESCAPE '\\'"; terms.len()].join(" AND ");
            (
                filter,
                terms
                    .iter()
                    .map(|t| format!("%{}%", like_escape(t)))
                    .collect(),
            )
        };
        let sql = format!(
            "SELECT t.session_id, t.entry_id, t.role, t.at, t.text
             FROM session_text t JOIN sessions s ON s.id = t.session_id
             WHERE {filter} AND s.subagent_parent IS NULL
             ORDER BY s.updated_at DESC, s.id, t.id
             LIMIT {MAX_ROWS}"
        );
        let mut statement = self
            .conn
            .prepare(&sql)
            .map_err(Error::sqlite("cannot search sessions"))?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(Error::sqlite("cannot search sessions"))?;
        let mut order: Vec<SessionHits> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for row in rows {
            let (session_id, entry_id, role, at, text) =
                row.map_err(Error::sqlite("cannot search sessions"))?;
            let slot = match index.get(&session_id) {
                Some(slot) => *slot,
                None if order.len() < sessions => {
                    index.insert(session_id.clone(), order.len());
                    order.push(SessionHits {
                        session_id,
                        hits: Vec::new(),
                        total: 0,
                    });
                    order.len() - 1
                }
                None => continue,
            };
            let group = &mut order[slot];
            group.total += 1;
            if group.hits.len() < per_session {
                let (snippet, highlights) = snippet(&text, &terms);
                group.hits.push(SearchHit {
                    entry_id,
                    role,
                    at,
                    snippet,
                    highlights,
                });
            }
        }
        Ok(order)
    }
}

/// The terms of a query: whitespace-separated, at most [`MAX_TERMS`], from the first
/// [`MAX_QUERY_CHARS`] characters.
fn terms(query: &str) -> Vec<String> {
    let query: String = query.chars().take(MAX_QUERY_CHARS).collect();
    let mut terms: Vec<String> = Vec::new();
    for term in query.split_whitespace() {
        if !terms.iter().any(|t| t == term) {
            terms.push(term.to_owned());
        }
        if terms.len() == MAX_TERMS {
            break;
        }
    }
    terms
}

fn like_escape(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Where `term` occurs in `text` (character indices, case-insensitive).
fn occurrences(text: &[char], term: &[char]) -> Vec<(usize, usize)> {
    let same = |a: char, b: char| a == b || a.to_lowercase().eq(b.to_lowercase());
    let mut found = Vec::new();
    if term.is_empty() || term.len() > text.len() {
        return found;
    }
    let mut i = 0;
    while i + term.len() <= text.len() {
        if text[i..i + term.len()]
            .iter()
            .zip(term)
            .all(|(a, b)| same(*a, *b))
        {
            found.push((i, i + term.len()));
            i += term.len();
        } else {
            i += 1;
        }
    }
    found
}

/// The text around the first match on one line, and the matches in it (UTF-16 offsets).
fn snippet(text: &str, terms: &[String]) -> (String, Vec<(usize, usize)>) {
    let chars: Vec<char> = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    let mut matches: Vec<(usize, usize)> = terms
        .iter()
        .flat_map(|t| occurrences(&chars, &t.chars().collect::<Vec<_>>()))
        .collect();
    matches.sort_unstable();
    let first = matches.first().map_or(0, |m| m.0);
    let start = first.saturating_sub(BEFORE);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let mut out = String::new();
    let mut units = 0;
    let lead = start > 0;
    if lead {
        out.push('…');
        units += 1;
    }
    let mut offsets = Vec::with_capacity(end - start + 1);
    for c in &chars[start..end] {
        offsets.push(units);
        out.push(*c);
        units += c.len_utf16();
    }
    offsets.push(units);
    if end < chars.len() {
        out.push('…');
    }
    let highlights = matches
        .into_iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| (offsets[s - start], offsets[e - start]))
        .fold(Vec::<(usize, usize)>::new(), |mut merged, (s, e)| {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
            merged
        });
    (out, highlights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_are_split_deduplicated_and_bounded() {
        assert_eq!(terms("  修复  bug 修复 "), ["修复", "bug"]);
        assert_eq!(terms(&"a ".repeat(20)).len(), 1);
        assert_eq!(
            terms(&(0..20).map(|i| format!("t{i} ")).collect::<String>()).len(),
            8
        );
    }

    #[test]
    fn snippets_mark_matches_in_utf16_units() {
        let (text, marks) = snippet("Fix the 登录 bug\nin auth", &["登录".into(), "BUG".into()]);
        assert_eq!(text, "Fix the 登录 bug in auth");
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let marked: Vec<String> = marks
            .iter()
            .map(|(s, e)| String::from_utf16_lossy(&utf16[*s..*e]))
            .collect();
        assert_eq!(marked, ["登录", "bug"]);
    }

    #[test]
    fn long_text_is_cut_around_the_first_match() {
        let text = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        let (snippet, marks) = snippet(&text, &["needle".into()]);
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert_eq!(snippet.chars().count(), SNIPPET_CHARS + 2);
        let utf16: Vec<u16> = snippet.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&utf16[marks[0].0..marks[0].1]),
            "needle"
        );
    }

    #[test]
    fn like_patterns_are_escaped() {
        assert_eq!(like_escape("50%_a\\"), "50\\%\\_a\\\\");
    }
}
