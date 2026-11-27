//! Text normalization and the conservative choice between base and refined text (addendum
//! V-6.2, V-6.3, V-7.4). Pure functions; nothing here rewrites meaning: it fixes the case of
//! known terms, joins spelled-out known acronyms, spaces Chinese and Latin text apart and,
//! when the user turned punctuation off, removes sentence punctuation.

use crate::vocabulary::Vocabulary;

/// Longest text one event carries ([`piarc_protocol::dictation::MAX_DICTATION_TEXT_BYTES`]).
pub use piarc_protocol::dictation::MAX_DICTATION_TEXT_BYTES as MAX_TEXT_BYTES;

/// Whether `c` is a CJK ideograph or kana (text written without spaces between words).
#[must_use]
pub fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}'
        | '\u{3400}'..='\u{4dbf}'
        | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}'
        | '\u{20000}'..='\u{2fa1f}')
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// Chinese sentence punctuation.
const CJK_PUNCTUATION: &[char] = &[
    '，', '。', '！', '？', '、', '；', '：', '“', '”', '‘', '’', '（', '）', '《', '》', '…',
];

/// Cuts `text` to at most [`MAX_TEXT_BYTES`] bytes at a character boundary.
#[must_use]
pub fn bounded(text: &str) -> &str {
    if text.len() <= MAX_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// What normalization may do besides spacing.
#[derive(Debug, Clone, Copy)]
pub struct Normalize<'a> {
    /// Known terms for case and acronyms.
    pub vocabulary: &'a Vocabulary,
    /// Keep sentence punctuation (the "auto punctuation" setting).
    pub punctuation: bool,
}

/// Normalizes one segment's text.
#[must_use]
pub fn normalize(text: &str, options: &Normalize<'_>) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let spaced = space_cjk_and_latin(&collapsed);
    let joined = join_acronyms(&spaced, options.vocabulary);
    let cased = fix_case(&joined, options.vocabulary);
    let out = if options.punctuation {
        cased
    } else {
        strip_punctuation(&cased)
    };
    bounded(out.trim()).to_owned()
}

/// Puts one space between a CJK character and an adjacent ASCII letter or digit.
#[must_use]
pub fn space_cjk_and_latin(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if let Some(p) = previous
            && ((is_cjk(p) && is_word(c)) || (is_word(p) && is_cjk(c)))
        {
            out.push(' ');
        }
        out.push(c);
        previous = Some(c);
    }
    out
}

/// Joins runs of single letters separated by single spaces (`M C P`) when the joined word is
/// a known term (`MCP`); other runs stay as spoken.
#[must_use]
pub fn join_acronyms(text: &str, vocabulary: &Vocabulary) -> String {
    let words: Vec<&str> = text.split(' ').collect();
    let mut out: Vec<String> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let mut j = i;
        while j < words.len()
            && words[j].len() == 1
            && words[j].chars().all(|c| c.is_ascii_alphabetic())
        {
            j += 1;
        }
        if j - i >= 2 {
            let joined: String = words[i..j].concat();
            if let Some(term) = vocabulary
                .terms()
                .iter()
                .find(|t| t.text.eq_ignore_ascii_case(&joined))
            {
                out.push(term.text.clone());
                i = j;
                continue;
            }
        }
        out.push(words[i].to_owned());
        i += 1;
    }
    out.join(" ")
}

/// Rewrites case-insensitive whole-word matches of known terms to their canonical spelling.
/// Terms that are everyday English words are only fixed when the text contains Chinese.
#[must_use]
pub fn fix_case(text: &str, vocabulary: &Vocabulary) -> String {
    let chinese = text.chars().any(is_cjk);
    let mut out = text.to_owned();
    for term in vocabulary.terms() {
        if term.common && !chinese {
            continue;
        }
        if !term.text.chars().any(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        out = replace_word(&out, &term.text);
    }
    out
}

/// Replaces every case-insensitive whole-word occurrence of `term` in `text` with `term`.
fn replace_word(text: &str, term: &str) -> String {
    let lower_text = text.to_ascii_lowercase();
    let lower_term = term.to_ascii_lowercase();
    if lower_text.len() != text.len() || lower_term.is_empty() {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(found) = lower_text[at..].find(&lower_term) {
        let start = at + found;
        let end = start + lower_term.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let boundary = !before.is_some_and(is_word) && !after.is_some_and(is_word);
        out.push_str(&text[at..start]);
        out.push_str(if boundary { term } else { &text[start..end] });
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

/// Removes sentence punctuation: Chinese punctuation always, ASCII `, . ! ? ; :` only before
/// a space or the end (so `v1.2.3`, `Node.js` and `src/main` stay intact).
#[must_use]
pub fn strip_punctuation(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let next = chars.get(i + 1).copied();
        let previous = out.chars().next_back();
        if CJK_PUNCTUATION.contains(&c) {
            // Between two Latin words a removed mark leaves a space.
            if previous.is_some_and(is_word) && next.is_some_and(is_word) {
                out.push(' ');
            }
            continue;
        }
        if matches!(c, ',' | '.' | '!' | '?' | ';' | ':') && next.is_none_or(char::is_whitespace) {
            continue;
        }
        out.push(c);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The separator to put before `next` when it follows text ending in `previous`: a space
/// between two Latin words (or after Latin sentence punctuation), nothing in Chinese.
#[must_use]
pub fn separator(previous: Option<char>, next: &str) -> &'static str {
    let Some(p) = previous else {
        return "";
    };
    let Some(n) = next.chars().next() else {
        return "";
    };
    if p.is_whitespace() || n.is_whitespace() {
        return "";
    }
    let latin_before = is_word(p) || matches!(p, '.' | ',' | '!' | '?' | ';' | ':');
    if (latin_before && (is_word(n) || is_cjk(n))) || (is_cjk(p) && is_word(n)) {
        " "
    } else {
        ""
    }
}

/// Chinese characters that negate what follows (counted, not parsed: base and refined text
/// are counted the same way, so only a change in the count matters).
const CJK_NEGATIONS: &[char] = &['不', '没', '别', '勿', '未', '莫', '禁'];

/// English negations, matched as whole words.
const NEGATION_WORDS: &[&str] = &[
    "not",
    "no",
    "never",
    "don't",
    "doesn't",
    "didn't",
    "isn't",
    "aren't",
    "can't",
    "cannot",
    "won't",
    "shouldn't",
    "without",
];

fn negations(text: &str) -> usize {
    let cjk = text.chars().filter(|c| CJK_NEGATIONS.contains(c)).count();
    let lower = text.to_lowercase().replace('\u{2019}', "'");
    let words = lower
        .split(|c: char| !(c.is_ascii_alphabetic() || c == '\''))
        .filter(|w| NEGATION_WORDS.contains(w))
        .count();
    cjk + words
}

/// Numbers, versions and paths in `text` (`17`, `v1.2.3`, `src/main/core`).
fn protected_tokens(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || is_cjk(c) || CJK_PUNCTUATION.contains(&c))
        .map(|w| w.trim_matches(|c: char| matches!(c, ',' | '!' | '?' | ';' | ':' | '(' | ')')))
        .map(|w| w.trim_end_matches('.'))
        .filter(|w| w.chars().any(|c| c.is_ascii_digit()) || w.contains('/') || w.contains('\\'))
        .map(str::to_lowercase)
        .collect()
}

fn comparable(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let current = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(current + 1)
                .min(previous + usize::from(x != y));
            previous = current;
        }
    }
    row[b.len()]
}

/// Whether the refined text may replace the base text (addendum V-7.4): every number,
/// version, path and known term of the base is still there, no negation was added or
/// dropped, and the two differ in at most half of the longer one's characters.
#[must_use]
pub fn accept_refined(base: &str, refined: &str, vocabulary: &Vocabulary) -> bool {
    let refined_lower = refined.to_lowercase();
    let refined_compact: String = refined_lower
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if refined.trim().is_empty() {
        return false;
    }
    if protected_tokens(base)
        .iter()
        .any(|token| !refined_compact.contains(&token.replace(' ', "")))
    {
        return false;
    }
    let base_lower = base.to_lowercase();
    for term in vocabulary.terms() {
        let lower = term.text.to_lowercase();
        if base_lower.contains(&lower) && !refined_lower.contains(&lower) {
            return false;
        }
    }
    if negations(base) != negations(refined) {
        return false;
    }
    let (a, b) = (comparable(base), comparable(refined));
    let longest = a.len().max(b.len()).max(1);
    distance(&a, &b) * 2 <= longest
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vocabulary::VocabularySources;

    fn builtin() -> Vocabulary {
        Vocabulary::build(
            &VocabularySources {
                builtin: true,
                custom: &[],
                workspace: &[],
            },
            None,
        )
    }

    fn normalized(text: &str) -> String {
        normalize(
            text,
            &Normalize {
                vocabulary: &builtin(),
                punctuation: true,
            },
        )
    }

    #[test]
    fn known_terms_get_their_case() {
        assert_eq!(
            normalized("使用 react typescript 和 rust 重新设计 mcp server 的管理页面"),
            "使用 React TypeScript 和 Rust 重新设计 MCP server 的管理页面"
        );
        assert_eq!(normalized("配置一下 redis 缓存"), "配置一下 Redis 缓存");
        assert_eq!(
            normalized("compare codex and claude code"),
            "compare Codex and Claude Code"
        );
    }

    #[test]
    fn everyday_words_keep_their_case_in_english() {
        assert_eq!(
            normalized("how users react to rust"),
            "how users react to rust"
        );
        assert_eq!(normalized("用 react 写"), "用 React 写");
    }

    #[test]
    fn spelled_acronyms_join_only_for_known_terms() {
        assert_eq!(normalized("接入 M C P 和 G L M"), "接入 MCP 和 GLM");
        assert_eq!(normalized("检查 S R C 斜杠"), "检查 S R C 斜杠");
        assert_eq!(normalized("electron I P C 的边界"), "Electron IPC 的边界");
    }

    #[test]
    fn chinese_and_latin_are_spaced_apart() {
        assert_eq!(
            normalized("帮我使用Cloud Code分析当前P R D"),
            "帮我使用 Cloud Code 分析当前 P R D"
        );
        assert_eq!(space_cjk_and_latin("版本v1.2.3兼容"), "版本 v1.2.3 兼容");
        assert_eq!(space_cjk_and_latin("你好😀世界"), "你好😀世界");
    }

    #[test]
    fn similar_words_are_never_replaced() {
        assert_eq!(normalized("cloud code"), "cloud code");
        assert_eq!(normalized("redistribute it"), "redistribute it");
        assert_eq!(normalized("reactor"), "reactor");
    }

    #[test]
    fn punctuation_can_be_removed_without_breaking_code() {
        assert_eq!(
            strip_punctuation("请检查 src/main/core 的接口，保留 v1.2.3 的兼容逻辑。"),
            "请检查 src/main/core 的接口保留 v1.2.3 的兼容逻辑"
        );
        assert_eq!(
            strip_punctuation("First read it. Then run Node.js, ok?"),
            "First read it Then run Node.js ok"
        );
        assert_eq!(strip_punctuation("Hello，world"), "Hello world");
        let options = Normalize {
            vocabulary: &builtin(),
            punctuation: false,
        };
        assert_eq!(normalize("不要删除数据库。", &options), "不要删除数据库");
    }

    #[test]
    fn negations_numbers_and_emoji_survive_normalization() {
        assert_eq!(
            normalized("不要删除数据库，不要修改生产环境的 Redis 密码。"),
            "不要删除数据库，不要修改生产环境的 Redis 密码。"
        );
        assert_eq!(
            normalized("Java 17 和 Spring Boot 3"),
            "Java 17 和 Spring Boot 3"
        );
        assert_eq!(normalized("好的👍  ok"), "好的👍 ok");
    }

    #[test]
    fn separators_follow_the_script() {
        assert_eq!(separator(None, "hello"), "");
        assert_eq!(separator(Some('d'), "hello"), " ");
        assert_eq!(separator(Some('.'), "Then"), " ");
        assert_eq!(separator(Some('。'), "然后"), "");
        assert_eq!(separator(Some('好'), "然后"), "");
        assert_eq!(separator(Some('好'), "React"), " ");
        assert_eq!(separator(Some('t'), "然后"), " ");
        assert_eq!(separator(Some(' '), "x"), "");
    }

    #[test]
    fn text_is_cut_at_a_character_boundary() {
        let long = "中".repeat(2000);
        let cut = bounded(&long);
        assert!(cut.len() <= MAX_TEXT_BYTES);
        assert!(cut.chars().all(|c| c == '中'));
    }

    #[test]
    fn refinement_must_keep_numbers_terms_and_negations() {
        let vocabulary = builtin();
        assert!(accept_refined(
            "在 spring boot 三和 java 十七的项目里检查 my batches plus 配置",
            "在 Spring Boot 3 和 Java 17 的项目里检查 MyBatis-Plus 配置",
            &vocabulary
        ));
        assert!(!accept_refined("先不删除日志", "先删除日志", &vocabulary));
        assert!(!accept_refined("do not push", "do push", &vocabulary));
        assert!(accept_refined(
            "请把 NapRs 写清楚",
            "请把 NAPI-RS 写清楚",
            &vocabulary
        ));
        assert!(!accept_refined("不要删除数据库", "删除数据库", &vocabulary));
        assert!(!accept_refined("删除数据库", "不要删除数据库", &vocabulary));
        assert!(!accept_refined(
            "保留 v1.2.3 的逻辑",
            "保留 v1.3 的逻辑",
            &vocabulary
        ));
        assert!(!accept_refined(
            "检查 src/main/core",
            "检查 source main core",
            &vocabulary
        ));
        assert!(!accept_refined(
            "配置 Redis 缓存",
            "配置 readies 缓存",
            &vocabulary
        ));
        assert!(!accept_refined(
            "今天下午三点开会",
            "完全不同的一句话内容在这里",
            &vocabulary
        ));
        assert!(!accept_refined("任何文字", "  ", &vocabulary));
        assert!(accept_refined(
            "今天下午三点开会讨论新版本",
            "今天下午三点开会，讨论新版本。",
            &vocabulary
        ));
    }
}
