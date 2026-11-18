//! The composer's Core side (T19, architecture section 8.2, ADR-0030).
//!
//! - [`UserInput`]: what the client sends with a prompt, a steering message or a follow-up:
//!   the text, the `@` mentions in it, the attachments by reference and an optional
//!   idempotency key the client chose (a message sent again with the same key is not
//!   repeated). Checked here, at the client boundary, before it reaches the Agent Host.
//! - [`attachments`]: the accepted kinds and limits, and storing an attachment's bytes in the
//!   session's `attachments/` directory.
//! - [`file_search`]: the fuzzy file search behind `@` mentions (ignore files, a result cap,
//!   cancellation).
//! - [`commands`]: the built-in slash commands the command palette lists.
//!
//! [`info`] gives the client all of it in one answer: the commands, the attachment limits and
//! the search cap.

pub mod attachments;
pub mod commands;
pub mod file_search;

use std::path::Path;

use piarc_protocol::ErrorKind;
use piarc_protocol::input::{InputAttachment, InputMention};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{Error, Result};

/// The most mentions one input carries.
pub const MAX_MENTIONS: usize = 100;

/// The user's input as the client sends it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInput {
    /// The client's idempotency key: 1 to 128 letters, digits, `.`, `_`, `:` or `-`. Core
    /// chooses one when absent.
    #[serde(default)]
    pub request_id: Option<String>,
    /// The text, with mentions spelled `@<path>`.
    pub text: String,
    /// Where the mentions are in the text.
    #[serde(default)]
    pub mentions: Vec<InputMention>,
    /// Attachments the client stored with `store_attachment` for this session.
    #[serde(default)]
    pub attachments: Vec<InputAttachment>,
}

impl UserInput {
    /// Plain text.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }

    /// Parses and checks the client's JSON.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] when the JSON is not an input.
    pub fn from_json(text: &str) -> Result<Self> {
        // serde's message can quote the input; the user's own text is not secret, but keep the
        // error short and structural.
        serde_json::from_str(text).map_err(|e| Error::InvalidArgument {
            field: "input",
            reason: format!(
                "is not a user input (line {}, column {})",
                e.line(),
                e.column()
            ),
        })
    }

    /// Checks the input against session `attachments_dir` (its `attachments/` directory):
    /// the key's form, the mentions' spans and every attachment's location and kind.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] naming the member that is wrong.
    pub fn check(&self, attachments_dir: &Path) -> Result<()> {
        if let Some(key) = &self.request_id {
            let valid = !key.is_empty()
                && key.len() <= 128
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
            if !valid {
                return Err(invalid(
                    "requestId",
                    "must be 1 to 128 letters, digits, '.', '_', ':' or '-'",
                ));
            }
        }
        let length = self.text.encode_utf16().count() as u64;
        if self.mentions.len() > MAX_MENTIONS {
            return Err(invalid("mentions", &format!("at most {MAX_MENTIONS}")));
        }
        for mention in &self.mentions {
            if mention.path.is_empty() || mention.start >= mention.end || mention.end > length {
                return Err(invalid("mentions", "a mention must be a span of the text"));
            }
        }
        attachments::check_refs(&self.attachments, attachments_dir)
    }
}

/// The composer's configuration for the client: commands, attachment limits, search cap.
#[must_use]
pub fn info() -> Value {
    json!({
        "commands": commands::builtin(),
        "attachments": attachments::limits(),
        "fileSearch": { "maxResults": file_search::MAX_RESULTS },
    })
}

pub(crate) fn invalid(field: &'static str, reason: &str) -> Error {
    Error::InvalidArgument {
        field,
        reason: reason.to_owned(),
    }
}

pub(crate) fn feature(kind: ErrorKind, message: String, details: &Value) -> Error {
    Error::Feature {
        kind,
        retryable: false,
        message,
        details: Some(details.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_the_key_and_the_mention_spans() {
        let dir = Path::new("/data/sessions/s/attachments");
        let mut input = UserInput::from_json(
            r#"{"requestId":"c-1","text":"see @a.ts 中文","mentions":[{"path":"a.ts","start":4,"end":9}]}"#,
        )
        .expect("parsed");
        input.check(dir).expect("valid");
        input.mentions[0].end = 99;
        assert!(input.check(dir).is_err());
        input.mentions.clear();
        input.request_id = Some("bad key".into());
        assert!(input.check(dir).is_err());
        assert!(UserInput::from_json(r#"{"text":3}"#).is_err());
    }
}
