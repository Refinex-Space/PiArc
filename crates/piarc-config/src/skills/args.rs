//! Argument substitution of skills, command files and Pi prompt templates (ADR-0054 rule 5).
//! The one implementation: Core expands slash commands and the `Skill` tool's loads with it.
//!
//! | Placeholder | Value |
//! |---|---|
//! | `$ARGUMENTS`, `$@` | the arguments as typed |
//! | `$1`, `$2`, … | the arguments split shell-style, from 1; a missing one is empty |
//! | `$ARGUMENTS[N]` | the same list from 0 (Claude Code); a missing one stays as written |
//! | `$name` | a name declared in `arguments`, by position; a missing one is empty |
//! | `${N:-default}`, `${@:-default}`, `${ARGUMENTS:-default}` | Pi: the value, or `default` when empty |
//! | `${@:N}`, `${@:N:L}` | Pi: the arguments from the Nth (1-based), at most L of them |
//!
//! A backslash before `$` keeps the `$` literal when it starts a placeholder (an even run of
//! backslashes stays and the placeholder expands). Values are inserted as they are, never
//! expanded again. When arguments were given and no placeholder received one, the body gets a
//! last line `ARGUMENTS: <as typed>`. Variables (`${CLAUDE_SKILL_DIR}` and the like) are
//! replaced afterwards, over the whole text.

/// What a body's placeholders are filled with.
#[derive(Debug, Clone, Copy)]
pub struct Arguments<'a> {
    /// The arguments as typed.
    pub text: &'a str,
    /// The names `arguments` declares, in order.
    pub names: &'a [String],
    /// `${NAME}` variables and their values.
    pub vars: &'a [(&'a str, String)],
}

/// Splits `text` the way a shell splits words: whitespace separates, single quotes keep
/// everything, double quotes keep everything but `\"` and `\\`, a backslash outside quotes
/// keeps the next character.
#[must_use]
pub fn split(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                started = true;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' if matches!(chars.peek(), Some('"' | '\\')) => {
                            if let Some(next) = chars.next() {
                                word.push(next);
                            }
                        }
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                started = true;
                if let Some(next) = chars.next() {
                    word.push(next);
                }
            }
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        words.push(word);
    }
    words
}

/// `body` with the placeholders filled and the variables replaced.
#[must_use]
pub fn substitute(body: &str, args: &Arguments<'_>) -> String {
    let words = split(args.text);
    let mut out = String::with_capacity(body.len() + args.text.len());
    let mut received = false;
    let mut rest = body;
    while let Some(at) = rest.find('$') {
        let (before, from) = rest.split_at(at);
        let slashes = before.len() - before.trim_end_matches('\\').len();
        match placeholder(from, args, &words) {
            Some((_, length, _)) if slashes % 2 == 1 => {
                // An escaped placeholder: drop one backslash, keep the text.
                out.push_str(&before[..before.len() - 1]);
                out.push_str(&from[..length]);
                rest = &from[length..];
            }
            Some((value, length, counts)) => {
                out.push_str(before);
                out.push_str(&value);
                received |= counts;
                rest = &from[length..];
            }
            None => {
                out.push_str(before);
                out.push('$');
                rest = &from[1..];
            }
        }
    }
    out.push_str(rest);
    if !received && !args.text.trim().is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\nARGUMENTS: ");
        out.push_str(args.text.trim());
    }
    replace_vars(&out, args.vars)
}

/// Replaces `${NAME}` for each variable.
#[must_use]
pub fn replace_vars(text: &str, vars: &[(&str, String)]) -> String {
    let mut out = text.to_owned();
    for (name, value) in vars {
        out = out.replace(&format!("${{{name}}}"), value);
    }
    out
}

/// The placeholder at the start of `from` (which starts with `$`): its value, its length and
/// whether it counts as receiving the arguments.
fn placeholder(
    from: &str,
    args: &Arguments<'_>,
    words: &[String],
) -> Option<(String, usize, bool)> {
    let after = &from[1..];
    if let Some(inner) = after.strip_prefix('{') {
        let close = inner.find('}')?;
        return braced(&inner[..close], args, words).map(|(v, counts)| (v, close + 3, counts));
    }
    if let Some(tail) = after.strip_prefix("ARGUMENTS[") {
        let close = tail.find(']')?;
        let index: usize = tail[..close].parse().ok()?;
        let length = 1 + "ARGUMENTS[".len() + close + 1;
        return Some(match words.get(index) {
            Some(word) => (word.clone(), length, true),
            None => (from[..length].to_owned(), length, false),
        });
    }
    if word_at(after, "ARGUMENTS") {
        return Some((args.text.trim().to_owned(), 1 + "ARGUMENTS".len(), true));
    }
    if after.starts_with('@') {
        return Some((args.text.trim().to_owned(), 2, true));
    }
    let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits > 0 {
        let index: usize = after[..digits].parse().ok()?;
        if index == 0 {
            return None;
        }
        let value = words.get(index - 1).cloned();
        let counts = value.is_some();
        return Some((value.unwrap_or_default(), 1 + digits, counts));
    }
    // The longest declared name that ends at a word boundary.
    let mut names: Vec<(usize, &String)> = args.names.iter().enumerate().collect();
    names.sort_by_key(|(_, name)| std::cmp::Reverse(name.len()));
    names
        .into_iter()
        .find(|(_, name)| word_at(after, name))
        .map(|(index, name)| {
            (
                words.get(index).cloned().unwrap_or_default(),
                1 + name.len(),
                true,
            )
        })
}

/// Whether `text` starts with `word` not followed by an identifier character.
fn word_at(text: &str, word: &str) -> bool {
    text.strip_prefix(word).is_some_and(|rest| {
        !rest
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}

/// Pi's `${…}` forms; `None` leaves the text (variables are replaced later).
fn braced(inner: &str, args: &Arguments<'_>, words: &[String]) -> Option<(String, bool)> {
    let all = args.text.trim();
    if let Some((head, default)) = inner.split_once(":-") {
        let value = match head {
            "@" | "ARGUMENTS" => all.to_owned(),
            index => {
                let index: usize = index.parse().ok().filter(|i| *i > 0)?;
                words.get(index - 1).cloned().unwrap_or_default()
            }
        };
        let counts = !value.is_empty();
        return Some((
            if value.is_empty() {
                default.to_owned()
            } else {
                value
            },
            counts,
        ));
    }
    if let Some(range) = inner.strip_prefix("@:") {
        let (start, count) = match range.split_once(':') {
            Some((start, count)) => (
                start.parse::<usize>().ok()?,
                Some(count.parse::<usize>().ok()?),
            ),
            None => (range.parse::<usize>().ok()?, None),
        };
        let skip = start.saturating_sub(1);
        let taken: Vec<&str> = words
            .iter()
            .skip(skip)
            .take(count.unwrap_or(usize::MAX))
            .map(String::as_str)
            .collect();
        return Some((taken.join(" "), !taken.is_empty()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(body: &str, text: &str, names: &[&str]) -> String {
        let names: Vec<String> = names.iter().map(|n| (*n).to_owned()).collect();
        substitute(
            body,
            &Arguments {
                text,
                names: &names,
                vars: &[("CLAUDE_SKILL_DIR", "/skills/demo".to_owned())],
            },
        )
    }

    #[test]
    fn splits_like_a_shell() {
        assert_eq!(split(r#"a "b c" 'd e' f\ g"#), ["a", "b c", "d e", "f g"]);
        assert_eq!(split(r#""say \"hi\"" """#), [r#"say "hi""#, ""]);
        assert!(split("   ").is_empty());
        assert_eq!(split("中文 参数"), ["中文", "参数"]);
    }

    #[test]
    fn all_positional_and_named_placeholders() {
        assert_eq!(
            run("Fix $ARGUMENTS now", "issue 12", &[]),
            "Fix issue 12 now"
        );
        assert_eq!(run("All: $@", " a b ", &[]), "All: a b");
        assert_eq!(
            run("$1 then $2 then $3.", "one \"two words\"", &[]),
            "one then two words then ."
        );
        assert_eq!(
            run("$ARGUMENTS[0]/$ARGUMENTS[1]/$ARGUMENTS[5]", "x y", &[]),
            "x/y/$ARGUMENTS[5]"
        );
        assert_eq!(
            run("Issue $issue on $branch", "42 main", &["issue", "branch"]),
            "Issue 42 on main"
        );
        assert_eq!(run("$issue$issues", "7", &["issue"]), "7$issues");
        assert_eq!(
            run("Missing: [$branch]", "7", &["issue", "branch"]),
            "Missing: []"
        );
    }

    #[test]
    fn pi_forms() {
        assert_eq!(run("${1:-none} ${2:-none}", "a", &[]), "a none");
        assert_eq!(run("${@:-nothing}", "", &[]), "nothing");
        assert_eq!(run("${@:2}", "a b c", &[]), "b c");
        assert_eq!(run("${@:2:1}", "a b c", &[]), "b");
    }

    #[test]
    fn appends_unreceived_arguments_and_keeps_values_literal() {
        assert_eq!(
            run("Review the diff.", "focus on tests", &[]),
            "Review the diff.\n\nARGUMENTS: focus on tests"
        );
        assert_eq!(run("Only $3", "a", &[]), "Only \n\nARGUMENTS: a");
        assert_eq!(run("No args.", "", &[]), "No args.");
        // A value with placeholders is not expanded again.
        assert_eq!(run("Say $1", "$ARGUMENTS", &[]), "Say $ARGUMENTS");
        // A named placeholder counts even when empty.
        assert_eq!(run("[$b]", "x", &["a", "b"]), "[]");
    }

    #[test]
    fn escapes_and_variables() {
        assert_eq!(run(r"Costs \$1.00 for $1", "x", &[]), "Costs $1.00 for x");
        assert_eq!(run(r"\\$1", "x", &[]), r"\\x");
        assert_eq!(run(r"a \$b", "", &[]), r"a \$b");
        assert_eq!(
            run("Run ${CLAUDE_SKILL_DIR}/x.sh $1", "go", &[]),
            "Run /skills/demo/x.sh go"
        );
        assert_eq!(run("Price $5 and $0", "", &[]), "Price  and $0");
        assert_eq!(run("${UNKNOWN} $", "", &[]), "${UNKNOWN} $");
    }
}
