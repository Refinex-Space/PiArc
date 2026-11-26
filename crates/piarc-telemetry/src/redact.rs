//! Redaction of credentials from log lines and the diagnostic bundle (T45, architecture section
//! 10.1 "凭据泄露", 10.5).
//!
//! Two sources of what to hide:
//! - the values of the credentials Core has loaded from the vault ([`remember_secret`]), replaced
//!   wherever they appear, whatever their format;
//! - common credential formats ([`PATTERNS`]): provider API key prefixes, cloud access key ids,
//!   `Bearer`/`Basic` credentials, JWTs, the values of secret-named fields (`apiKey`,
//!   `authorization`, `password`, …) and the password of a URL's user information.
//!
//! Each match becomes `[REDACTED:<kind>]`; a `Bearer` or a field name keeps its prefix so the
//! line stays readable. [`redact`] counts the replacements by kind for the bundle's summary.
//! The log writer ([`crate::subscriber`]) runs every line through [`redact`] before it reaches a
//! file, Core's events and the Agent Host's stderr alike.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock, PoisonError};

use regex::{Captures, Regex};

/// What a replacement hid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    /// The value of a credential Core loaded from the vault.
    KnownSecret,
    /// A provider API key or service token recognised by its prefix.
    ApiKey,
    /// A cloud access key id (AWS, Alibaba Cloud, Tencent Cloud).
    AccessKey,
    /// The credential after `Bearer` or `Basic`.
    BearerToken,
    /// A JSON Web Token.
    Jwt,
    /// The value of a field whose name says it is secret, or a URL's password.
    SecretField,
    /// The user's home directory in a path (the diagnostic bundle only).
    HomePath,
}

impl Kind {
    /// The placeholder's label.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::KnownSecret => "secret",
            Self::ApiKey => "api-key",
            Self::AccessKey => "access-key",
            Self::BearerToken => "token",
            Self::Jwt => "jwt",
            Self::SecretField => "secret",
            Self::HomePath => "home",
        }
    }

    /// `[REDACTED:<label>]`.
    #[must_use]
    pub fn placeholder(self) -> String {
        format!("[REDACTED:{}]", self.label())
    }
}

/// Credential values shorter than this are not remembered: they would match ordinary words.
pub const MIN_SECRET_LEN: usize = 12;

/// The credential formats replaced in every line, in order, with the capture group that holds
/// the secret: only that span is replaced, so `Bearer`, a field name or a URL's user stay.
/// Values of secret-named fields come last, after the formats that keep a prefix.
const PATTERNS: &[(Kind, &str, usize)] = &[
    (
        Kind::Jwt,
        r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        0,
    ),
    (
        Kind::ApiKey,
        concat!(
            r"\b(?:",
            r"sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}", // OpenAI, Anthropic, OpenRouter, DashScope
            r"|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}", // Stripe-style
            r"|AIza[0-9A-Za-z_-]{35}",           // Google API keys
            r"|ya29\.[0-9A-Za-z_-]{20,}",        // Google OAuth access tokens
            r"|gh[pousr]_[A-Za-z0-9]{36,}",      // GitHub tokens
            r"|github_pat_[A-Za-z0-9_]{22,}",
            r"|glpat-[A-Za-z0-9_-]{20,}",     // GitLab
            r"|xox[abprs]-[A-Za-z0-9-]{10,}", // Slack
            r"|xai-[A-Za-z0-9]{20,}",         // xAI
            r"|gsk_[A-Za-z0-9]{20,}",         // Groq
            r"|hf_[A-Za-z0-9]{30,}",          // Hugging Face
            r"|npm_[A-Za-z0-9]{36}",          // npm
            r")"
        ),
        0,
    ),
    (
        Kind::AccessKey,
        r"\b(?:(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}|LTAI[0-9A-Za-z]{12,30}|AKID[0-9A-Za-z]{13,40})\b",
        0,
    ),
    (
        Kind::BearerToken,
        r"(?i)\b(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{8,}=*)",
        1,
    ),
    (
        Kind::SecretField,
        r#"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@"']+:([^/\s@"']+)@"#,
        1,
    ),
    // A token as the URL's whole user part (`https://<token>@github.com`, Git panel). Short
    // user names such as `git@` stay.
    (
        Kind::SecretField,
        r#"(?i)\b[a-z][a-z0-9+.-]*://([^/\s:@"']{12,})@"#,
        1,
    ),
    (
        Kind::SecretField,
        concat!(
            // Not `\b`: `_` is a word character, and `AWS_SECRET_ACCESS_KEY` has no boundary
            // before `SECRET` (R5). The character before the name stays outside group 1.
            r#"(?i)(?:^|[^a-z0-9])(?:api[_-]?key|x-api-key|authorization|access[_-]?token|refresh[_-]?token"#,
            r#"|id[_-]?token|token|client[_-]?secret|secret[_-]?access[_-]?key|secret|password"#,
            r#"|passwd|private[_-]?key)"?\s*[:=]\s*"?([^\s"',;&}\]]{6,})"#
        ),
        1,
    ),
];

struct Pattern {
    kind: Kind,
    regex: Regex,
    group: usize,
}

struct Redactor {
    patterns: Vec<Pattern>,
    known: BTreeSet<String>,
    known_regex: Option<Regex>,
}

impl Redactor {
    fn new() -> Self {
        let patterns = PATTERNS
            .iter()
            .filter_map(|(kind, pattern, group)| {
                Regex::new(pattern).ok().map(|regex| Pattern {
                    kind: *kind,
                    regex,
                    group: *group,
                })
            })
            .collect();
        Self {
            patterns,
            known: BTreeSet::new(),
            known_regex: None,
        }
    }

    fn remember(&mut self, value: &str) {
        let value = value.trim();
        if value.chars().count() < MIN_SECRET_LEN
            || value.chars().any(char::is_whitespace)
            || !self.known.insert(value.to_owned())
        {
            return;
        }
        // Longest first, so a value that contains another is replaced whole.
        let mut values: Vec<&String> = self.known.iter().collect();
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        let alternation = values
            .iter()
            .map(|v| regex::escape(v))
            .collect::<Vec<_>>()
            .join("|");
        self.known_regex = Regex::new(&alternation).ok();
    }
}

fn redactor() -> &'static Mutex<Redactor> {
    static REDACTOR: OnceLock<Mutex<Redactor>> = OnceLock::new();
    REDACTOR.get_or_init(|| Mutex::new(Redactor::new()))
}

/// Remembers a credential's value so every later log line and bundle hides it. Values shorter
/// than [`MIN_SECRET_LEN`] characters or containing whitespace are ignored.
pub fn remember_secret(value: &str) {
    redactor()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remember(value);
}

/// Every string of a credential's JSON value (the vault stores objects such as
/// `{"type": "api_key", "key": "…"}`), remembered with [`remember_secret`].
pub fn remember_secrets_in(value: &serde_json::Value) {
    match value {
        serde_json::Value::String(text) => remember_secret(text),
        serde_json::Value::Array(items) => items.iter().for_each(remember_secrets_in),
        serde_json::Value::Object(map) => map.values().for_each(remember_secrets_in),
        _ => {}
    }
}

/// Text with credentials replaced, and how many of each kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted<'a> {
    /// The redacted text (borrowed when nothing matched).
    pub text: Cow<'a, str>,
    /// Replacements by kind.
    pub counts: BTreeMap<Kind, usize>,
}

/// `text` with the remembered credentials and the credential formats replaced.
#[must_use]
pub fn redact(text: &str) -> Redacted<'_> {
    let redactor = redactor().lock().unwrap_or_else(PoisonError::into_inner);
    let mut counts = BTreeMap::new();
    let mut out = Cow::Borrowed(text);
    if let Some(known) = &redactor.known_regex {
        out = replace(out, known, 0, Kind::KnownSecret, &mut counts);
    }
    for pattern in &redactor.patterns {
        out = replace(
            out,
            &pattern.regex,
            pattern.group,
            pattern.kind,
            &mut counts,
        );
    }
    Redacted { text: out, counts }
}

/// Replaces group `group` of each match of `regex` with the placeholder of `kind`, skipping
/// values that are already placeholders or name a credential scheme; counts the replacements.
fn replace<'a>(
    text: Cow<'a, str>,
    regex: &Regex,
    group: usize,
    kind: Kind,
    counts: &mut BTreeMap<Kind, usize>,
) -> Cow<'a, str> {
    if !regex.is_match(&text) {
        return text;
    }
    let mut hits = 0;
    let replaced = regex.replace_all(&text, |caps: &Captures<'_>| {
        let whole = caps.get(0).map_or("", |m| m.as_str());
        let Some(value) = caps.get(group) else {
            return whole.to_owned();
        };
        let secret = value.as_str();
        if secret.starts_with("[REDACTED")
            || secret.eq_ignore_ascii_case("bearer")
            || secret.eq_ignore_ascii_case("basic")
        {
            return whole.to_owned();
        }
        hits += 1;
        let start = caps.get(0).map_or(0, |m| m.start());
        format!(
            "{}{}{}",
            &whole[..value.start() - start],
            kind.placeholder(),
            &whole[value.end() - start..]
        )
    });
    if hits == 0 {
        return text;
    }
    *counts.entry(kind).or_default() += hits;
    Cow::Owned(replaced.into_owned())
}

/// `text` with the user's home directory replaced by `~` where it starts a path (the diagnostic
/// bundle). Either separator, doubled separators (JSON) and, as on macOS and Windows file
/// systems, any letter case match.
#[must_use]
pub fn redact_home<'a>(
    text: &'a str,
    home: &str,
    counts: &mut BTreeMap<Kind, usize>,
) -> Cow<'a, str> {
    let home = home.trim_end_matches(['/', '\\']);
    if home.chars().count() < 2 {
        return Cow::Borrowed(text);
    }
    let mut pattern = String::from("(?im)");
    for ch in home.chars() {
        if ch == '/' || ch == '\\' {
            pattern.push_str(r"[\\/]+");
        } else {
            pattern.push_str(&regex::escape(&ch.to_string()));
        }
    }
    // The home directory itself or a path below it, not a longer sibling name.
    pattern.push_str(r#"([\\/"'\s:,)\]}]|$)"#);
    let Ok(regex) = Regex::new(&pattern) else {
        return Cow::Borrowed(text);
    };
    let hits = regex.find_iter(text).count();
    if hits == 0 {
        return Cow::Borrowed(text);
    }
    *counts.entry(Kind::HomePath).or_default() += hits;
    Cow::Owned(regex.replace_all(text, "~$1").into_owned())
}

#[cfg(test)]
#[path = "redact_tests.rs"]
mod tests;
