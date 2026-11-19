//! Matcher groups' filters, with Claude Code's rules:
//!
//! - `"*"`, `""` or no matcher: every value.
//! - Only letters, digits, `_`, `-`, space, `,` and `|`: exact values, separated by `|` or `,`
//!   (`Edit|Write`).
//! - Anything else: an unanchored regular expression (`Edit.*` also matches `NotebookEdit`;
//!   `^Bash$` matches only `Bash`).
//!
//! Claude Code evaluates JavaScript regular expressions. PiArc uses the `regex` crate, whose
//! syntax covers the common forms but not look-around or backreferences: such a matcher is
//! reported with the reason and its group never runs.

use regex::Regex;

/// A parsed matcher.
#[derive(Debug, Clone)]
pub enum Matcher {
    /// Every value.
    All,
    /// One of these exact values.
    Exact(Vec<String>),
    /// An unanchored regular expression.
    Pattern(Regex),
}

/// The characters of an exact matcher.
fn is_exact_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' ' | ',' | '|')
}

impl Matcher {
    /// Parses a matcher.
    ///
    /// # Errors
    ///
    /// Why a regular expression is not accepted: syntax JavaScript has and the `regex` crate
    /// does not (look-around, backreferences), or invalid syntax.
    pub fn parse(text: Option<&str>) -> Result<Self, String> {
        let text = text.unwrap_or("");
        if text.is_empty() || text == "*" {
            return Ok(Self::All);
        }
        if text.chars().all(is_exact_char) {
            let values: Vec<String> = text
                .split(['|', ','])
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect();
            return Ok(if values.is_empty() {
                Self::All
            } else {
                Self::Exact(values)
            });
        }
        if let Some(construct) = unsupported_construct(text) {
            return Err(format!(
                "the matcher uses {construct}, which PiArc's regular expressions do not support"
            ));
        }
        Regex::new(text)
            .map(Self::Pattern)
            .map_err(|e| format!("the matcher is not a valid regular expression: {e}"))
    }

    /// Whether `value` matches.
    #[must_use]
    pub fn matches(&self, value: &str) -> bool {
        match self {
            Self::All => true,
            Self::Exact(values) => values.iter().any(|v| v == value),
            Self::Pattern(regex) => regex.is_match(value),
        }
    }
}

/// JavaScript constructs the `regex` crate rejects, named for the diagnostic.
fn unsupported_construct(text: &str) -> Option<&'static str> {
    let mut chars = text.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(d) if !in_class && d.is_ascii_digit() && d != '0' => {
                    return Some("a backreference");
                }
                Some('k') if chars.peek() == Some(&'<') => return Some("a named backreference"),
                _ => {}
            },
            '[' => in_class = true,
            ']' => in_class = false,
            '(' if !in_class && chars.peek() == Some(&'?') => {
                let rest: String = chars.clone().skip(1).take(2).collect();
                if rest.starts_with('=') || rest.starts_with('!') {
                    return Some("a look-ahead");
                }
                if rest == "<=" || rest == "<!" {
                    return Some("a look-behind");
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(text: &str) -> Matcher {
        Matcher::parse(Some(text)).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    #[test]
    fn empty_star_and_absent_match_everything() {
        for matcher in [m(""), m("*"), Matcher::parse(None).unwrap_or(Matcher::All)] {
            assert!(matcher.matches("Bash"));
            assert!(matcher.matches(""));
        }
    }

    #[test]
    fn plain_names_match_exactly_and_lists_split_on_bar_and_comma() {
        let one = m("Bash");
        assert!(one.matches("Bash"));
        assert!(!one.matches("PowerShell"));
        assert!(!one.matches("bash"));
        let list = m("Edit|Write");
        assert!(list.matches("Edit") && list.matches("Write"));
        assert!(!list.matches("NotebookEdit"));
        let commas = m("Edit, Write");
        assert!(commas.matches("Write"));
        assert!(m("permission_prompt").matches("permission_prompt"));
    }

    #[test]
    fn other_text_is_an_unanchored_regular_expression() {
        let edit = m("Edit.*");
        assert!(edit.matches("Edit"));
        assert!(edit.matches("NotebookEdit"));
        assert!(m("^Bash$").matches("Bash"));
        assert!(!m("^Bash$").matches("BashOutput"));
        assert!(m("mcp__memory__.*").matches("mcp__memory__create_entities"));
        assert!(!m("mcp__memory__.*").matches("mcp__github__search"));
    }

    #[test]
    fn javascript_only_syntax_is_reported() {
        for (text, construct) in [
            ("^(?!Bash).*", "look-ahead"),
            ("(?=Edit)Edit", "look-ahead"),
            ("(?<!Notebook)Edit", "look-behind"),
            ("(a)\\1", "backreference"),
        ] {
            let error = Matcher::parse(Some(text)).err().unwrap_or_default();
            assert!(error.contains(construct), "{text}: {error}");
        }
        assert!(Matcher::parse(Some("(unclosed")).is_err());
        // A named group is plain syntax for both.
        assert!(m("(?<tool>Edit|Write)$").matches("Write"));
        // `[(?=]` is a character class, not a look-ahead.
        assert!(m("[(?=]x").matches("=x"));
    }
}
