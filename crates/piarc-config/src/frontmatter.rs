//! YAML frontmatter of Markdown configuration files (subagent definitions, skills, commands,
//! output styles): the `---` block at the start of the file, parsed into a JSON mapping.
//!
//! The block must start on the file's first line; the closing `---` ends it (LF or CRLF).
//! Errors carry the file line (the frontmatter starts on line 2) and one line of text without
//! the parser's source snippet, for lists in the settings window.

use serde_json::{Map, Value};

/// A file split into its frontmatter and body.
#[derive(Debug, Clone, PartialEq)]
pub struct Document<'t> {
    /// The YAML between the `---` lines; `None` when the file has no frontmatter.
    pub yaml: Option<&'t str>,
    /// The text after the frontmatter (the whole file without one).
    pub body: &'t str,
}

/// A frontmatter that is not a YAML mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    /// The file line (1-based), when the parser knows it.
    pub line: Option<u64>,
    /// What is wrong.
    pub message: String,
}

/// Splits `text` into frontmatter and body.
#[must_use]
pub fn split(text: &str) -> Document<'_> {
    match crate::rules::split_frontmatter(text) {
        Some((yaml, body)) => Document {
            yaml: Some(yaml),
            body,
        },
        None => Document {
            yaml: None,
            body: text,
        },
    }
}

/// Parses `yaml` (a frontmatter's text) into a mapping; empty YAML is an empty mapping.
///
/// # Errors
///
/// The YAML is invalid or is not a mapping.
pub fn mapping(yaml: &str) -> Result<Map<String, Value>, Invalid> {
    let value = match serde_saphyr::from_str::<Option<Value>>(yaml) {
        Ok(Some(value)) => value,
        Ok(None) => Value::Null,
        Err(error) => {
            let text = error.render_with_options(serde_saphyr::render_options! {
                snippets: serde_saphyr::SnippetMode::Off,
                line_offset: 1,
            });
            return Err(Invalid {
                line: error.location().map(|l| l.line() + 1),
                message: format!(
                    "invalid YAML: {}",
                    text.split_whitespace().collect::<Vec<_>>().join(" ")
                ),
            });
        }
    };
    match value {
        Value::Object(map) => Ok(map),
        Value::Null => Ok(Map::new()),
        _ => Err(Invalid {
            line: Some(2),
            message: "the frontmatter is not a mapping".into(),
        }),
    }
}

/// The file line of `key` in `yaml` (a frontmatter starting on line 2).
#[must_use]
pub fn line_of(yaml: &str, key: &str) -> Option<u64> {
    let prefix = format!("{key}:");
    yaml.lines()
        .position(|line| line.trim_start().starts_with(&prefix))
        .and_then(|index| u64::try_from(index + 2).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_parses() {
        let doc = split("---\r\nname: a\r\n---\r\nBody\r\n");
        assert_eq!(doc.yaml, Some("name: a\r\n"));
        assert_eq!(doc.body, "Body\r\n");
        assert_eq!(mapping("name: a\n").unwrap()["name"], "a");
        assert!(mapping("").unwrap().is_empty());
        assert_eq!(split("No front\n").yaml, None);
        let bad = mapping("name: [a\n").unwrap_err();
        assert!(bad.message.starts_with("invalid YAML"), "{bad:?}");
        assert_eq!(mapping("- a\n").unwrap_err().line, Some(2));
        assert_eq!(line_of("a: 1\nb: 2\n", "b"), Some(3));
    }
}
