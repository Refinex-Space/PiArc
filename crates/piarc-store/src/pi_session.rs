//! The metadata of a Pi session file, folded entry by entry (Pi 1.5.2,
//! `coding-agent/src/core/session-manager.ts`: `SessionHeader`, `SessionEntry`).
//!
//! Only what the session index needs is decoded; everything else in an entry (message
//! content, tool arguments, images) is skipped by the parser without being kept. Folding is
//! associative over the file's order, so continuing from a stored [`SessionMeta`] at a byte
//! offset gives the same result as reading the whole file again.

use serde::Deserialize;
use serde::de::{self, SeqAccess, Visitor};

use crate::time::parse_iso8601_ms;

/// Session format versions this build understands. Pi 1.5.2 writes version 3
/// (`CURRENT_SESSION_VERSION`); files without a version are version 1, which Pi still reads.
pub const KNOWN_VERSIONS: std::ops::RangeInclusive<i64> = 1..=3;

/// Characters of the first user message kept as the fallback title.
pub const FIRST_MESSAGE_CHARS: usize = 200;

/// Characters of one message indexed for full-text search (T35); the rest is not searchable.
pub const SEARCH_TEXT_CHARS: usize = 20_000;

/// The searchable text of one entry (T35): a user message or an assistant reply's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryText {
    /// The entry's id.
    pub entry_id: Option<String>,
    /// `user` or `assistant`.
    pub role: &'static str,
    /// When it was written (Unix ms).
    pub at: Option<i64>,
    /// Its text parts joined by line breaks, at most [`SEARCH_TEXT_CHARS`] characters.
    pub text: String,
}

/// One model request a session file records (T41): an assistant message's usage, or an
/// auxiliary call's `piarc.auxiliaryUsage` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestUsage {
    /// The entry's id.
    pub entry_id: Option<String>,
    /// When it was written (Unix ms).
    pub at: Option<i64>,
    /// `model` (the session's own request) or `auxiliary`.
    pub kind: &'static str,
    /// An auxiliary call's purpose (`webFetch`, `webSearch`, `hookPrompt`, ...).
    pub purpose: Option<String>,
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// Input tokens, excluding cache reads and writes.
    pub input: i64,
    /// Output tokens.
    pub output: i64,
    /// Cache-read tokens.
    pub cache_read: i64,
    /// Cache-write tokens (one-hour writes included).
    pub cache_write: i64,
    /// Cache-write tokens kept for an hour (Anthropic), priced at twice the input rate.
    pub cache_write_1h: i64,
    /// Reasoning tokens where reported (part of `output`).
    pub reasoning: i64,
}

/// The custom entry that records an auxiliary model call (T29, written by the Agent Host).
pub const AUXILIARY_USAGE_ENTRY: &str = "piarc.auxiliaryUsage";

/// What one entry adds besides the session's fields: searchable text, a model request.
#[derive(Debug, Default)]
pub struct Folded {
    /// Its searchable text (T35).
    pub text: Option<EntryText>,
    /// The request it records (T41).
    pub usage: Option<RequestUsage>,
}

/// What the index knows about one session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionMeta {
    /// The header's session id.
    pub id: Option<String>,
    /// The header's format version (1 when absent).
    pub version: Option<i64>,
    /// The working directory the session was started in.
    pub cwd: Option<String>,
    /// Path of the session file this one was forked from.
    pub parent_session: Option<String>,
    /// Name from the latest `session_info` entry (an empty name clears it).
    pub name: Option<String>,
    /// Text of the first user message, at most [`FIRST_MESSAGE_CHARS`] characters.
    pub first_message: Option<String>,
    /// Latest model: `model_change` entries and assistant messages, in file order.
    pub model_provider: Option<String>,
    /// See `model_provider`.
    pub model_id: Option<String>,
    /// `message` entries.
    pub message_count: i64,
    /// Summed usage of assistant messages, usage entries, compactions and branch summaries.
    pub usage: Usage,
    /// The header's timestamp.
    pub created_at: Option<i64>,
    /// Latest entry timestamp.
    pub updated_at: Option<i64>,
    /// Id of the last entry read.
    pub last_entry_id: Option<String>,
    /// For a subagent's session (T31): the session that started it, from its first
    /// `piarc.subagent` entry.
    pub subagent_parent: Option<String>,
    /// For a subagent's session: its type.
    pub subagent_type: Option<String>,
}

/// The custom entry a subagent's session file starts with (T31, written by the Agent Host).
pub const SUBAGENT_ENTRY: &str = "piarc.subagent";

/// Summed token usage and cost.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// Input tokens.
    pub input: i64,
    /// Output tokens.
    pub output: i64,
    /// Cache read tokens.
    pub cache_read: i64,
    /// Cache write tokens.
    pub cache_write: i64,
    /// Total cost in the catalog's currency.
    pub cost: f64,
}

/// Why a file cannot be indexed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unindexable {
    /// The first entry is not a session header.
    NoHeader,
    /// The header carries a version this build does not read.
    UnknownVersion(String),
}

impl std::fmt::Display for Unindexable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoHeader => f.write_str("the file does not start with a session header"),
            Self::UnknownVersion(version) => {
                write!(f, "unknown session format version {version}")
            }
        }
    }
}

/// One line of a session file, reduced to the fields the index uses.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    version: Option<serde_json::Number>,
    #[serde(default)]
    timestamp: Option<Timestamp>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    parent_session: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    /// A `usage` entry's model (T41).
    #[serde(default)]
    model: Option<String>,
    /// A `usage` entry's category (`cache_warm`, ...).
    #[serde(default, rename = "kind")]
    usage_kind: Option<String>,
    #[serde(default)]
    usage: Option<RawUsage>,
    #[serde(default)]
    message: Option<Message>,
    #[serde(default)]
    custom_type: Option<String>,
    /// A custom entry's data, reduced to a subagent link; any other data is skipped.
    #[serde(default)]
    data: CustomData,
}

/// The fields of a `piarc.subagent` entry's data and of a `piarc.auxiliaryUsage` entry's. Other
/// custom entries' data (text, lists, other objects) deserializes to the empty value without
/// being kept.
#[derive(Debug, Default)]
struct CustomData {
    parent_session_id: Option<String>,
    agent_type: Option<String>,
    purpose: Option<String>,
    model: Option<ModelRef>,
    usage: Option<RawUsage>,
}

/// An auxiliary call's model (`{provider, id}`).
#[derive(Debug, Default, Deserialize)]
struct ModelRef {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

impl<'de> Deserialize<'de> for CustomData {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DataVisitor;
        impl<'de> Visitor<'de> for DataVisitor {
            type Value = CustomData;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any value")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<CustomData, A::Error> {
                let mut data = CustomData::default();
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    match key.as_ref() {
                        "parentSessionId" => data.parent_session_id = map.next_value()?,
                        "agentType" => data.agent_type = map.next_value()?,
                        "purpose" => data.purpose = map.next_value().unwrap_or_default(),
                        "model" => data.model = map.next_value().unwrap_or_default(),
                        "usage" => data.usage = map.next_value().unwrap_or_default(),
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(data)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<CustomData, A::Error> {
                while seq.next_element::<de::IgnoredAny>()?.is_some() {}
                Ok(CustomData::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<CustomData, E> {
                Ok(CustomData::default())
            }
        }
        deserializer.deserialize_any(DataVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Timestamp {
    Text(String),
    Millis(f64),
}

impl Timestamp {
    fn millis(&self) -> Option<i64> {
        match self {
            Self::Text(text) => parse_iso8601_ms(text),
            #[expect(
                clippy::cast_possible_truncation,
                reason = "millisecond timestamps fit in i64"
            )]
            Self::Millis(ms) if ms.is_finite() => Some(*ms as i64),
            Self::Millis(_) => None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawUsage {
    #[serde(default)]
    input: f64,
    #[serde(default)]
    output: f64,
    #[serde(default)]
    cache_read: f64,
    #[serde(default)]
    cache_write: f64,
    #[serde(default, rename = "cacheWrite1h")]
    cache_write_1h: f64,
    #[serde(default)]
    reasoning: Option<f64>,
    #[serde(default)]
    cost: Option<RawCost>,
}

#[derive(Debug, Default, Deserialize)]
struct RawCost {
    #[serde(default)]
    total: f64,
}

#[derive(Debug, Deserialize)]
struct Message {
    /// A fork copied this message from its parent; its usage belongs to the original.
    #[serde(default, rename = "piarcInherited")]
    inherited: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<MessageText>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<RawUsage>,
    #[serde(default)]
    timestamp: Option<Timestamp>,
}

impl SessionMeta {
    /// Folds the first entry of a file. Returns why the file cannot be indexed, if so.
    ///
    /// # Errors
    ///
    /// [`Unindexable`] when the entry is not a session header or names an unknown version.
    pub fn start(&mut self, header: &Entry) -> Result<(), Unindexable> {
        if header.kind != "session" {
            return Err(Unindexable::NoHeader);
        }
        self.id.clone_from(&header.id);
        let version = match &header.version {
            None => 1,
            Some(number) => match number.as_i64() {
                Some(v) if KNOWN_VERSIONS.contains(&v) => v,
                _ => return Err(Unindexable::UnknownVersion(number.to_string())),
            },
        };
        self.version = Some(version);
        self.cwd.clone_from(&header.cwd);
        self.parent_session.clone_from(&header.parent_session);
        self.created_at = header.timestamp.as_ref().and_then(Timestamp::millis);
        self.updated_at = self.created_at;
        Ok(())
    }

    /// Folds one entry after the header; returns its searchable text and the model request it
    /// records, if any.
    pub fn fold(&mut self, entry: Entry) -> Folded {
        let entry_id = entry.id.clone();
        if let Some(id) = entry.id {
            self.last_entry_id = Some(id);
        }
        let mut text = None;
        let mut usage = None;
        let mut at = entry.timestamp.as_ref().and_then(Timestamp::millis);
        match entry.kind.as_str() {
            "custom" if entry.custom_type.as_deref() == Some(AUXILIARY_USAGE_ENTRY) => {
                let data = entry.data;
                if let (Some(raw), Some(model)) = (&data.usage, &data.model)
                    && let (Some(provider), Some(id)) = (&model.provider, &model.id)
                {
                    usage = Some(raw.request(entry_id.clone(), at, "auxiliary", provider, id));
                    if let Some(record) = &mut usage {
                        record.purpose = data.purpose;
                    }
                }
            }
            "custom" if entry.custom_type.as_deref() == Some(SUBAGENT_ENTRY) => {
                // Set once: the first entry names the parent.
                if self.subagent_parent.is_none() {
                    self.subagent_parent = entry.data.parent_session_id;
                    self.subagent_type = entry.data.agent_type;
                }
            }
            // Pi's `usage` entries (cache warming, ...) are requests outside the conversation.
            "usage" => {
                if let (Some(raw), Some(provider), Some(model)) =
                    (&entry.usage, &entry.provider, &entry.model)
                {
                    let mut record =
                        raw.request(entry_id.clone(), at, "auxiliary", provider, model);
                    record.purpose.clone_from(&entry.usage_kind);
                    usage = Some(record);
                }
            }
            "session_info" => {
                self.name = entry
                    .name
                    .map(|n| n.trim().to_owned())
                    .filter(|n| !n.is_empty());
            }
            "model_change" => {
                if entry.provider.is_some() || entry.model_id.is_some() {
                    self.model_provider = entry.provider;
                    self.model_id = entry.model_id;
                }
            }
            "message" if !entry.message.as_ref().is_some_and(|m| m.inherited) => {
                self.message_count += 1;
                if let Some(message) = entry.message {
                    if let Some(ms) = message.timestamp.as_ref().and_then(Timestamp::millis) {
                        at = Some(at.map_or(ms, |a| a.max(ms)));
                    }
                    if message.role.as_deref() == Some("assistant")
                        && let Some(raw) = &message.usage
                    {
                        let provider = message.provider.as_ref().or(self.model_provider.as_ref());
                        let model = message.model.as_ref().or(self.model_id.as_ref());
                        if let (Some(provider), Some(model)) = (provider, model) {
                            usage =
                                Some(raw.request(entry_id.clone(), at, "model", provider, model));
                        }
                    }
                    text = self.fold_message(message).map(|(role, text)| EntryText {
                        entry_id,
                        role,
                        at,
                        text,
                    });
                }
            }
            _ => {}
        }
        if let Some(raw) = &entry.usage {
            self.usage.add(raw);
        }
        if let Some(ms) = at {
            self.updated_at = Some(self.updated_at.map_or(ms, |u| u.max(ms)));
        }
        Folded { text, usage }
    }

    /// Folds a message; returns its role and searchable text when it is a user message or an
    /// assistant reply with text.
    fn fold_message(&mut self, message: Message) -> Option<(&'static str, String)> {
        let content = message.content.unwrap_or_default();
        let role = match message.role.as_deref() {
            Some("user") => {
                if self.first_message.is_none() && !content.prefix.is_empty() {
                    self.first_message = Some(content.prefix);
                }
                "user"
            }
            Some("assistant") => {
                if message.provider.is_some() || message.model.is_some() {
                    self.model_provider = message.provider;
                    self.model_id = message.model;
                }
                if let Some(usage) = &message.usage {
                    self.usage.add(usage);
                }
                "assistant"
            }
            _ => return None,
        };
        (!content.full.is_empty()).then_some((role, content.full))
    }
}

/// A token count from JSON (a float in the file): rounded, 0 when not finite or negative.
#[expect(
    clippy::cast_possible_truncation,
    reason = "token counts are integers well inside i64"
)]
fn tokens(value: f64) -> i64 {
    if value.is_finite() && value > 0.0 {
        value.round() as i64
    } else {
        0
    }
}

impl RawUsage {
    /// The request this usage records.
    fn request(
        &self,
        entry_id: Option<String>,
        at: Option<i64>,
        kind: &'static str,
        provider: &str,
        model: &str,
    ) -> RequestUsage {
        RequestUsage {
            entry_id,
            at,
            kind,
            purpose: None,
            provider: provider.to_owned(),
            model: model.to_owned(),
            input: tokens(self.input),
            output: tokens(self.output),
            cache_read: tokens(self.cache_read),
            cache_write: tokens(self.cache_write),
            cache_write_1h: tokens(self.cache_write_1h),
            reasoning: self.reasoning.map_or(0, tokens),
        }
    }
}

impl Usage {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "token counts are integers well inside i64"
    )]
    fn add(&mut self, raw: &RawUsage) {
        let tokens = |v: f64| if v.is_finite() { v.round() as i64 } else { 0 };
        self.input = self.input.saturating_add(tokens(raw.input));
        self.output = self.output.saturating_add(tokens(raw.output));
        self.cache_read = self.cache_read.saturating_add(tokens(raw.cache_read));
        self.cache_write = self.cache_write.saturating_add(tokens(raw.cache_write));
        if let Some(cost) = &raw.cost
            && cost.total.is_finite()
        {
            self.cost += cost.total;
        }
    }
}

/// The text of message content (a string, or the `text` parts of a part list): `prefix` joins
/// the parts by a space and is cut to [`FIRST_MESSAGE_CHARS`] characters (the title), `full`
/// joins them by line breaks and is cut to [`SEARCH_TEXT_CHARS`] (search). Non-text parts
/// (images, thinking, tool calls) are skipped without being kept.
#[derive(Debug, Default)]
struct MessageText {
    prefix: String,
    prefix_chars: usize,
    full: String,
    full_chars: usize,
}

impl MessageText {
    fn push(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        Self::append(
            &mut self.prefix,
            &mut self.prefix_chars,
            ' ',
            text,
            FIRST_MESSAGE_CHARS,
        );
        Self::append(
            &mut self.full,
            &mut self.full_chars,
            '\n',
            text,
            SEARCH_TEXT_CHARS,
        );
    }

    fn append(out: &mut String, count: &mut usize, separator: char, text: &str, limit: usize) {
        let gap = usize::from(!out.is_empty());
        let room = limit.saturating_sub(*count + gap);
        if room == 0 {
            return;
        }
        if gap == 1 {
            out.push(separator);
        }
        let before = out.len();
        out.extend(text.chars().take(room));
        *count += gap + out[before..].chars().count();
    }
}

impl<'de> Deserialize<'de> for MessageText {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Content;

        impl<'de> Visitor<'de> for Content {
            type Value = MessageText;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string or a list of content parts")
            }

            fn visit_str<E: de::Error>(self, text: &str) -> Result<MessageText, E> {
                let mut content = MessageText::default();
                content.push(text);
                Ok(content)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut parts: A) -> Result<MessageText, A::Error> {
                let mut content = MessageText::default();
                while let Some(part) = parts.next_element::<Part>()? {
                    if part.kind.as_deref() == Some("text")
                        && let Some(text) = part.text
                    {
                        content.push(&text);
                    }
                }
                Ok(content)
            }
        }

        deserializer.deserialize_any(Content)
    }
}

#[derive(Debug, Deserialize)]
struct Part {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    // Other fields (image data, tool arguments) are skipped by serde without being kept.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> Entry {
        serde_json::from_str(json).expect("valid entry")
    }

    #[test]
    fn inherited_fork_messages_do_not_charge_the_parent_twice() {
        let mut meta = SessionMeta::default();
        meta.fold(entry(r#"{"type":"custom","customType":"piarc.subagent","data":{"parentSessionId":"main","agentType":"fork"}}"#));
        let assistant = r#"{"type":"message","id":"a","message":{"role":"assistant","provider":"p","model":"m","content":[{"type":"text","text":"Prior result"}],"usage":{"input":4,"output":2},"piarcInherited":true}}"#;
        let inherited = meta.fold(entry(assistant));
        assert!(inherited.usage.is_none() && inherited.text.is_none());
        assert_eq!(meta.message_count, 0);
        assert_eq!(meta.last_entry_id.as_deref(), Some("a"));
        let local = meta.fold(entry(&assistant.replace("true", "false")));
        assert_eq!(local.usage.expect("new request").input, 4);
        assert_eq!(meta.message_count, 1);
    }

    #[test]
    fn folds_header_and_entries() {
        let mut meta = SessionMeta::default();
        meta.start(&entry(
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-11-16T10:00:00.000Z","cwd":"/w","parentSession":"/p.jsonl"}"#,
        ))
        .expect("header");
        meta.fold(entry(
            r#"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-11-16T10:00:01.000Z","message":{"role":"user","content":[{"type":"image","data":"QUJD","mimeType":"image/png"},{"type":"text","text":"  fix the   bug "}],"timestamp":1763287201500}}"#,
        ));
        meta.fold(entry(
            r#"{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-11-16T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"provider":"p","model":"m","usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"totalTokens":18,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.25}},"stopReason":"stop","timestamp":1763287202000}}"#,
        ));
        meta.fold(entry(
            r#"{"type":"session_info","id":"e3","parentId":"e2","timestamp":"2026-11-16T10:00:03.000Z","name":" Title "}"#,
        ));
        meta.fold(entry(
            r#"{"type":"model_change","id":"e4","parentId":"e3","timestamp":"2026-11-16T10:00:04.000Z","provider":"q","modelId":"n"}"#,
        ));
        meta.fold(entry(
            r#"{"type":"usage","id":"e5","parentId":"e4","timestamp":"2026-11-16T10:00:05.000Z","kind":"cache_warm","provider":"q","model":"n","usage":{"input":1,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":1,"cost":{"total":0.5}}}"#,
        ));
        assert_eq!(meta.id.as_deref(), Some("s1"));
        assert_eq!(meta.version, Some(3));
        assert_eq!(meta.cwd.as_deref(), Some("/w"));
        assert_eq!(meta.parent_session.as_deref(), Some("/p.jsonl"));
        assert_eq!(meta.name.as_deref(), Some("Title"));
        assert_eq!(meta.first_message.as_deref(), Some("fix the   bug"));
        assert_eq!(meta.model_provider.as_deref(), Some("q"));
        assert_eq!(meta.model_id.as_deref(), Some("n"));
        assert_eq!(meta.message_count, 2);
        assert_eq!(
            meta.usage,
            Usage {
                input: 11,
                output: 5,
                cache_read: 2,
                cache_write: 1,
                cost: 0.75
            }
        );
        assert_eq!(
            meta.created_at,
            parse_iso8601_ms("2026-11-16T10:00:00.000Z")
        );
        assert_eq!(
            meta.updated_at,
            parse_iso8601_ms("2026-11-16T10:00:05.000Z")
        );
        assert_eq!(meta.last_entry_id.as_deref(), Some("e5"));

        meta.fold(entry(r#"{"type":"session_info","id":"e6","name":""}"#));
        assert_eq!(meta.name, None, "an empty name clears it");
    }

    #[test]
    fn unknown_versions_and_missing_headers_are_reported() {
        let mut meta = SessionMeta::default();
        assert_eq!(
            meta.start(&entry(r#"{"type":"session","version":4,"id":"s"}"#)),
            Err(Unindexable::UnknownVersion("4".into()))
        );
        assert_eq!(
            meta.start(&entry(r#"{"type":"session","version":2.5,"id":"s"}"#)),
            Err(Unindexable::UnknownVersion("2.5".into()))
        );
        assert_eq!(
            meta.start(&entry(r#"{"type":"message","id":"x"}"#)),
            Err(Unindexable::NoHeader)
        );
        let mut v1 = SessionMeta::default();
        v1.start(&entry(r#"{"type":"session","id":"old"}"#))
            .expect("version 1 has no version field");
        assert_eq!(v1.version, Some(1));
    }

    #[test]
    fn the_title_prefix_is_cut_by_characters() {
        let long = "中".repeat(FIRST_MESSAGE_CHARS + 50);
        let mut meta = SessionMeta::default();
        meta.fold(entry(&format!(
            r#"{{"type":"message","message":{{"role":"user","content":"{long}"}}}}"#
        )));
        assert_eq!(
            meta.first_message.as_deref().map(|t| t.chars().count()),
            Some(FIRST_MESSAGE_CHARS)
        );
    }
}
