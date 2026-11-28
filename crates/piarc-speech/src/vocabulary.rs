//! Hotword vocabulary: the built-in technical terms, the user's dictionary and the trusted
//! workspace's package names, checked, deduplicated and capped (addendum V-6.1).
//!
//! A term must be at most [`MAX_TERM_BYTES`] bytes, free of control and bidi characters and
//! of `/`, `:` and `,` (sherpa-onnx splits streaming hotwords on `/` and Qwen3-ASR's context
//! words on `,`), and every character must exist in the
//! model's BPE vocabulary, otherwise the recognizer could not encode it.

use std::collections::HashSet;

/// Most terms a session's vocabulary holds.
pub const MAX_TERMS: usize = 128;
/// Longest term, in UTF-8 bytes.
pub const MAX_TERM_BYTES: usize = 64;
/// Most terms the user's dictionary keeps.
pub const MAX_CUSTOM_TERMS: usize = 64;
/// Most terms taken from a workspace.
pub const MAX_WORKSPACE_TERMS: usize = 64;

/// A built-in term and whether it is also an everyday English word, whose case is only fixed
/// inside Chinese text (`react` in "how users react" stays lowercase).
#[derive(Debug, Clone, Copy)]
pub struct BuiltinTerm {
    /// The canonical spelling.
    pub text: &'static str,
    /// Also an everyday English word.
    pub common: bool,
}

const fn term(text: &'static str) -> BuiltinTerm {
    BuiltinTerm {
        text,
        common: false,
    }
}

const fn common(text: &'static str) -> BuiltinTerm {
    BuiltinTerm { text, common: true }
}

/// Technical terms boosted by default (addendum V-6.1).
pub const BUILTIN: &[BuiltinTerm] = &[
    term("PiArc"),
    term("Claude Code"),
    term("Codex"),
    term("Qwen"),
    term("GLM"),
    term("AgentScope"),
    term("Spring Boot"),
    term("MyBatis"),
    term("PostgreSQL"),
    term("MySQL"),
    term("SQLite"),
    term("MongoDB"),
    term("Elasticsearch"),
    term("TypeScript"),
    term("JavaScript"),
    common("React"),
    term("Vue"),
    term("Vite"),
    term("Electron"),
    common("Rust"),
    term("MCP"),
    common("Harness"),
    term("Redis"),
    term("Kubernetes"),
    term("Docker"),
    term("GitHub"),
    term("GitLab"),
    common("Git"),
    term("Node.js"),
    term("npm"),
    term("pnpm"),
    term("Python"),
    common("Java"),
    term("Kotlin"),
    term("Golang"),
    term("Tauri"),
    term("Next.js"),
    term("Tailwind"),
    term("ProseMirror"),
    term("Kafka"),
    term("RabbitMQ"),
    term("gRPC"),
    term("GraphQL"),
    term("JSON"),
    term("YAML"),
    term("API"),
    term("SDK"),
    term("CLI"),
    term("IPC"),
    term("LLM"),
    common("Agent"),
    common("Prompt"),
    term("OpenAI"),
    term("DeepSeek"),
    term("Gemini"),
    term("Copilot"),
    common("Cursor"),
    term("VS Code"),
    term("IntelliJ"),
    term("macOS"),
    term("Linux"),
    term("WebSocket"),
    term("OAuth"),
    term("Nginx"),
    term("Terraform"),
    term("Tokio"),
    term("Serde"),
    term("Pi SDK"),
    term("Zipformer"),
    term("ONNX"),
    term("Webpack"),
    term("Deno"),
];

/// Why a term was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TermProblem {
    /// Nothing left after trimming.
    Empty,
    /// More than [`MAX_TERM_BYTES`] bytes.
    TooLong,
    /// A control, bidi, `/`, `:`, `,` or line-break character.
    Forbidden,
    /// A character the model cannot encode, or no letter at all.
    NotEncodable,
}

impl TermProblem {
    /// Stable code for the settings page.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong => "tooLong",
            Self::Forbidden => "forbidden",
            Self::NotEncodable => "notEncodable",
        }
    }
}

/// The characters of a model's BPE vocabulary (`bpe.vocab`, "piece\tscore" lines).
#[derive(Debug, Clone, Default)]
pub struct Alphabet(HashSet<char>);

impl Alphabet {
    /// Reads the pieces of a `bpe.vocab` file's text; the word marker `▁` is not a character.
    #[must_use]
    pub fn from_bpe_vocab(text: &str) -> Self {
        let mut chars = HashSet::new();
        for line in text.lines() {
            let piece = line.split('\t').next().unwrap_or_default();
            if piece.starts_with('<') && piece.ends_with('>') {
                continue;
            }
            chars.extend(piece.chars().filter(|c| *c != '\u{2581}'));
        }
        Self(chars)
    }

    fn encodes(&self, c: char) -> bool {
        c == ' ' || self.0.contains(&c) || self.0.contains(&c.to_ascii_lowercase())
    }
}

fn forbidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '/' | ':'
                | ','
                | '\u{200e}'
                | '\u{200f}'
                | '\u{061c}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{2028}'
                | '\u{2029}'
        )
}

/// Checks one term; returns it trimmed with inner whitespace collapsed.
///
/// # Errors
///
/// The [`TermProblem`]. With `alphabet` `None` only the model-independent rules apply.
pub fn check_term(term: &str, alphabet: Option<&Alphabet>) -> Result<String, TermProblem> {
    let text = term.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(TermProblem::Empty);
    }
    if text.len() > MAX_TERM_BYTES {
        return Err(TermProblem::TooLong);
    }
    if term.chars().any(forbidden) {
        return Err(TermProblem::Forbidden);
    }
    if !text.chars().any(char::is_alphanumeric) {
        return Err(TermProblem::NotEncodable);
    }
    if let Some(alphabet) = alphabet
        && !text.chars().all(|c| alphabet.encodes(c))
    {
        return Err(TermProblem::NotEncodable);
    }
    Ok(text)
}

/// One accepted term.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    /// Canonical spelling (what the text is normalized to).
    pub text: String,
    /// Also an everyday English word (see [`BuiltinTerm::common`]).
    pub common: bool,
}

/// A session's vocabulary, fixed when the session starts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Vocabulary {
    terms: Vec<Term>,
}

/// What a vocabulary is built from.
#[derive(Debug, Clone, Default)]
pub struct VocabularySources<'a> {
    /// Include [`BUILTIN`].
    pub builtin: bool,
    /// The user's dictionary.
    pub custom: &'a [String],
    /// The trusted workspace's package names.
    pub workspace: &'a [String],
}

impl Vocabulary {
    /// Builds the vocabulary: the user's terms first, then the built-in ones, then the
    /// workspace's, deduplicated case-insensitively, invalid ones dropped, at most
    /// [`MAX_TERMS`].
    #[must_use]
    pub fn build(sources: &VocabularySources<'_>, alphabet: Option<&Alphabet>) -> Self {
        let mut seen = HashSet::new();
        let mut terms = Vec::new();
        let builtin: &[BuiltinTerm] = if sources.builtin { BUILTIN } else { &[] };
        let candidates = sources
            .custom
            .iter()
            .take(MAX_CUSTOM_TERMS)
            .map(|t| (t.as_str(), false))
            .chain(builtin.iter().map(|t| (t.text, t.common)))
            .chain(
                sources
                    .workspace
                    .iter()
                    .take(MAX_WORKSPACE_TERMS)
                    .map(|t| (t.as_str(), false)),
            );
        for (candidate, common) in candidates {
            if terms.len() == MAX_TERMS {
                break;
            }
            let Ok(text) = check_term(candidate, alphabet) else {
                continue;
            };
            if seen.insert(text.to_lowercase()) {
                terms.push(Term { text, common });
            }
        }
        Self { terms }
    }

    /// The canonical terms joined by `,`: Qwen3-ASR's context words.
    #[must_use]
    pub fn context_words(&self) -> String {
        self.terms
            .iter()
            .map(|t| t.text.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }

    /// The terms in priority order.
    #[must_use]
    pub fn terms(&self) -> &[Term] {
        &self.terms
    }

    /// Whether there are no terms.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// The hotword string sherpa-onnx takes per stream: lowercase terms joined by `/`
    /// (the model's BPE pieces are lowercase; `-` and `_` are spoken as pauses).
    #[must_use]
    pub fn hotwords(&self) -> String {
        self.terms
            .iter()
            .map(|t| {
                t.text
                    .to_lowercase()
                    .replace(['-', '_'], " ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    }
}

/// Package names of a `package.json`: `name` and the keys of `dependencies` and
/// `devDependencies`, the scope dropped (`@scope/name` → `name`). Bounded by the caller's
/// size cap; invalid JSON gives nothing.
#[must_use]
pub fn package_json_terms(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    if let Some(name) = value.get("name").and_then(serde_json::Value::as_str) {
        names.push(name.to_owned());
    }
    for section in ["dependencies", "devDependencies"] {
        if let Some(map) = value.get(section).and_then(serde_json::Value::as_object) {
            names.extend(map.keys().cloned());
        }
    }
    names
        .into_iter()
        .map(|name| name.rsplit('/').next().unwrap_or_default().to_owned())
        .filter(|name| !name.is_empty())
        .take(MAX_WORKSPACE_TERMS)
        .collect()
}

/// Crate names of a `Cargo.toml`: `[package] name` and the keys of `[dependencies]`,
/// `[dev-dependencies]` and `[workspace.dependencies]`. A line-based reader: only
/// `key = …` lines directly under those tables count.
#[must_use]
pub fn cargo_toml_terms(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut table = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            table = line
                .trim_matches(|c| c == '[' || c == ']')
                .trim()
                .to_owned();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        // `serde.workspace = true` names `serde`.
        let key = key
            .trim()
            .trim_matches('"')
            .split('.')
            .next()
            .unwrap_or_default();
        match table.as_str() {
            "package" if key == "name" => {
                names.push(value.trim().trim_matches('"').to_owned());
            }
            "dependencies" | "dev-dependencies" | "workspace.dependencies" => {
                names.push(key.to_owned());
            }
            _ => {}
        }
    }
    names
        .into_iter()
        .filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
        .take(MAX_WORKSPACE_TERMS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alphabet() -> Alphabet {
        Alphabet::from_bpe_vocab(
            "<blk>\t0.0\n\u{2581}a\t-1.0\nbcdefghijklmnopqrstuvwxyz\t-2.0\n\u{2581}0123456789.-_\t-3\n\u{2581}你好\t-1\n",
        )
    }

    #[test]
    fn terms_are_trimmed_capped_and_checked() {
        assert_eq!(
            check_term("  Spring   Boot ", None),
            Ok("Spring Boot".into())
        );
        assert_eq!(check_term("   ", None), Err(TermProblem::Empty));
        assert_eq!(check_term(&"a".repeat(65), None), Err(TermProblem::TooLong));
        assert_eq!(check_term("src/main", None), Err(TermProblem::Forbidden));
        assert_eq!(check_term("a:b", None), Err(TermProblem::Forbidden));
        assert_eq!(check_term("a,b", None), Err(TermProblem::Forbidden));
        assert_eq!(
            check_term("evil\u{202e}txt", None),
            Err(TermProblem::Forbidden)
        );
        assert_eq!(check_term("line\nbreak", None), Err(TermProblem::Forbidden));
        assert_eq!(check_term("!!!", None), Err(TermProblem::NotEncodable));
        assert_eq!(check_term("PiArc", Some(&alphabet())), Ok("PiArc".into()));
        assert_eq!(check_term("你好", Some(&alphabet())), Ok("你好".into()));
        assert_eq!(
            check_term("再见", Some(&alphabet())),
            Err(TermProblem::NotEncodable)
        );
        assert_eq!(
            check_term("emoji😀", Some(&alphabet())),
            Err(TermProblem::NotEncodable)
        );
    }

    #[test]
    fn the_vocabulary_puts_user_terms_first_and_dedupes() {
        let custom = vec![
            "redis".to_owned(),
            "MyProject".to_owned(),
            "bad/term".to_owned(),
        ];
        let workspace = vec!["tokio".to_owned(), "piarc".to_owned()];
        let vocabulary = Vocabulary::build(
            &VocabularySources {
                builtin: true,
                custom: &custom,
                workspace: &workspace,
            },
            None,
        );
        let texts: Vec<&str> = vocabulary.terms().iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts[0], "redis");
        assert_eq!(texts[1], "MyProject");
        assert!(!texts.contains(&"Redis"), "case-insensitive duplicate kept");
        assert!(!texts.contains(&"bad/term"));
        assert_eq!(
            texts
                .iter()
                .filter(|t| t.eq_ignore_ascii_case("piarc"))
                .count(),
            1
        );
        assert!(texts.len() <= MAX_TERMS);
    }

    #[test]
    fn the_vocabulary_is_capped() {
        let custom: Vec<String> = (0..200).map(|i| format!("term{i}")).collect();
        let workspace: Vec<String> = (0..200).map(|i| format!("crate{i}")).collect();
        let vocabulary = Vocabulary::build(
            &VocabularySources {
                builtin: true,
                custom: &custom,
                workspace: &workspace,
            },
            None,
        );
        assert_eq!(vocabulary.terms().len(), MAX_TERMS);
        assert_eq!(vocabulary.terms()[0].text, "term0");
        assert_eq!(
            vocabulary
                .terms()
                .iter()
                .filter(|t| t.text.starts_with("term"))
                .count(),
            MAX_CUSTOM_TERMS
        );
    }

    #[test]
    fn hotwords_are_lowercase_and_slash_separated() {
        let custom = vec!["MyBatis-Plus".to_owned(), "Claude Code".to_owned()];
        let vocabulary = Vocabulary::build(
            &VocabularySources {
                builtin: false,
                custom: &custom,
                workspace: &[],
            },
            None,
        );
        assert_eq!(vocabulary.hotwords(), "mybatis plus/claude code");
        assert!(Vocabulary::default().hotwords().is_empty());
    }

    #[test]
    fn package_names_come_from_manifests() {
        let json = r#"{"name":"@piarc/desktop","dependencies":{"react":"1","@scope/pkg":"2"},"devDependencies":{"vitest":"5"},"scripts":{"x":"y"}}"#;
        let mut names = package_json_terms(json);
        names.sort();
        assert_eq!(names, vec!["desktop", "pkg", "react", "vitest"]);
        assert!(package_json_terms("not json").is_empty());
        let toml = "[package]\nname = \"piarc-core\"\n\n[dependencies]\ntokio = { version = \"1\" }\nserde.workspace = true\n\"quoted\" = \"1\"\n\n[features]\nx = []\n";
        assert_eq!(
            cargo_toml_terms(toml),
            vec!["piarc-core", "tokio", "serde", "quoted"]
        );
    }

    #[test]
    fn every_builtin_term_passes_its_own_rules() {
        for term in BUILTIN {
            assert_eq!(check_term(term.text, None).as_deref(), Ok(term.text));
        }
        assert!(BUILTIN.len() <= MAX_TERMS);
    }
}
