//! The user's input beyond its text: the files it mentions and the attachments it carries
//! (architecture section 8.2, composer; ADR-0030).
//!
//! The text is what the model reads: a mention is spelled `@<path>` in it. Mentions record
//! where those spans are, so the transcript shows them as chips; they never change the text.
//! Attachments go by reference (ADR-0009 rule 8): the client hands the bytes to Core, Core
//! stores them in the session's `attachments/` directory and the input carries the
//! [`BlobRef`]. The Agent Host turns an image into image content of the user message and a
//! PDF into the text of its pages (`fs/pdf`), since pi-ai has no document content.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::fs::BlobRef;

/// A file the user mentioned with `@`: the span of the input's text that names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputMention {
    /// The file as the text spells it after the `@`, relative to the session's working
    /// directory.
    pub path: String,
    /// UTF-16 offset of the `@` in the text.
    pub start: u64,
    /// UTF-16 offset just past the mention.
    pub end: u64,
}

/// What an attachment is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    /// A PNG, JPEG, GIF or WebP image: image content of the user message.
    Image,
    /// A PDF: the text of its pages follows the user's text.
    Pdf,
}

/// An attachment Core stored for a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputAttachment {
    /// What it is.
    pub kind: AttachmentKind,
    /// The file name the user attached, for display.
    pub name: String,
    /// Its media type, for example `image/png`.
    pub mime_type: String,
    /// Where Core stored it: below `<data>/sessions/<session id>/attachments/`.
    pub blob: BlobRef,
    /// How many pages a PDF has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u64>,
}
