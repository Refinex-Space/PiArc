//! Whether a command succeeded, judged by what its exit code means (architecture section 5.3):
//! some programs exit with 1 to report an answer, not an error.
//!
//! | Program                        | Exit code 1 means   |
//! |--------------------------------|---------------------|
//! | `grep`, `egrep`, `fgrep`, `rg` | no line matched     |
//! | `diff`, `cmp`                  | the inputs differ   |
//! | `test`, `[`                    | the condition is false |
//!
//! The table applies only when the whole command line is one simple command: a pipeline or a
//! list (`|`, `&&`, `||`, `;`, `&`, a newline, a subshell, a command substitution) is judged
//! by its exit code alone, since the exit code then comes from somewhere the table cannot see
//! (unquoted text is checked; quoted operators are arguments). Leading variable
//! assignments (`LC_ALL=C grep …`) and a directory before the program name
//! (`/usr/bin/grep`) are allowed. T23 replaces this check with the syntax tree of
//! tree-sitter-bash.

/// Programs whose exit code 1 is an answer, and the answer.
pub const EXIT_ONE_MEANINGS: &[(&str, &str)] = &[
    ("grep", "no matches"),
    ("egrep", "no matches"),
    ("fgrep", "no matches"),
    ("rg", "no matches"),
    ("diff", "files differ"),
    ("cmp", "files differ"),
    ("test", "condition is false"),
    ("[", "condition is false"),
];

/// How a command's exit is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interpretation {
    /// Whether the command did what it was asked.
    pub success: bool,
    /// What a non-zero exit code means when it is not a failure (`"no matches"`).
    pub meaning: Option<&'static str>,
}

/// Reads `exit_code` (none: the command was ended by a signal) of the bash command line
/// `command`.
#[must_use]
pub fn interpret(command: &str, exit_code: Option<i32>) -> Interpretation {
    let plain = |success| Interpretation {
        success,
        meaning: None,
    };
    match exit_code {
        Some(0) => plain(true),
        Some(1) => match simple_command_program(command)
            .and_then(|program| EXIT_ONE_MEANINGS.iter().find(|(name, _)| *name == program))
        {
            Some((_, meaning)) => Interpretation {
                success: true,
                meaning: Some(meaning),
            },
            None => plain(false),
        },
        _ => plain(false),
    }
}

/// The program name (without its directory) when `command` is a single simple command.
fn simple_command_program(command: &str) -> Option<&str> {
    let words = simple_command_words(command)?;
    let program = words.into_iter().find(|word| !is_assignment(word))?;
    let name = program.rsplit('/').next().unwrap_or(program);
    (!name.is_empty()).then_some(name)
}

/// The words of `command` when it has no operator outside quotes; `None` otherwise. Words are
/// slices of `command` with their quotes left in (quoted program names do not match the table,
/// which errs on the side of reporting a failure).
fn simple_command_words(command: &str) -> Option<Vec<&str>> {
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    let mut quote: Option<char> = None;
    let mut chars = command.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
                continue;
            }
            Some(_) => {
                match c {
                    '\\' => {
                        chars.next();
                    }
                    '"' => quote = None,
                    _ => {}
                }
                continue;
            }
            None => {}
        }
        match c {
            '\\' => {
                start.get_or_insert(at);
                chars.next();
            }
            '\'' | '"' => {
                start.get_or_insert(at);
                quote = Some(c);
            }
            // A comment ends the line.
            '#' if start.is_none() => break,
            // Operators, subshells and command substitutions (`$(…)`, backquotes, whose own
            // commands this check cannot see): the exit code alone decides.
            '|' | '&' | ';' | '\n' | '(' | ')' | '`' => return None,
            c if c.is_whitespace() => {
                if let Some(s) = start.take() {
                    words.push(&command[s..at]);
                }
            }
            _ => {
                start.get_or_insert(at);
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if let Some(s) = start {
        words.push(&command[s..]);
    }
    Some(words)
}

/// `NAME=value`, a variable assignment before the program.
fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(command: &str, code: i32) -> (bool, Option<&'static str>) {
        let i = interpret(command, Some(code));
        (i.success, i.meaning)
    }

    #[test]
    fn exit_one_of_the_listed_programs_is_an_answer() {
        assert_eq!(read("grep foo file.txt", 1), (true, Some("no matches")));
        assert_eq!(read("egrep 'a|b' f", 1), (true, Some("no matches")));
        assert_eq!(read("fgrep x f", 1), (true, Some("no matches")));
        assert_eq!(read("rg -n needle src", 1), (true, Some("no matches")));
        assert_eq!(read("diff a.txt b.txt", 1), (true, Some("files differ")));
        assert_eq!(read("cmp a b", 1), (true, Some("files differ")));
        assert_eq!(
            read("test -f missing", 1),
            (true, Some("condition is false"))
        );
        assert_eq!(
            read("[ -d nowhere ]", 1),
            (true, Some("condition is false"))
        );
    }

    #[test]
    fn assignments_paths_and_quotes_are_allowed() {
        assert_eq!(read("LC_ALL=C grep x f", 1), (true, Some("no matches")));
        assert_eq!(read("/usr/bin/grep x f", 1), (true, Some("no matches")));
        assert_eq!(read("grep 'a; b && c' f", 1), (true, Some("no matches")));
        assert_eq!(read("grep \"a | b\" f", 1), (true, Some("no matches")));
        assert_eq!(read("grep a\\;b f", 1), (true, Some("no matches")));
        assert_eq!(read("  grep x f  # look", 1), (true, Some("no matches")));
    }

    #[test]
    fn other_exit_codes_and_programs_are_failures() {
        assert_eq!(read("grep foo file.txt", 2), (false, None));
        assert_eq!(read("diff a b", 2), (false, None));
        assert_eq!(read("ls missing", 1), (false, None));
        assert_eq!(read("grepx foo", 1), (false, None));
        assert_eq!(read("FOO=1", 1), (false, None));
        assert!(!interpret("grep x f", None).success);
        assert_eq!(read("grep x f", 0), (true, None));
        assert_eq!(read("false", 0), (true, None));
    }

    #[test]
    fn pipelines_and_lists_use_the_exit_code_only() {
        for command in [
            "cat f | grep x",
            "grep x f && echo found",
            "grep x f || true",
            "cd src; grep x f",
            "grep x f &",
            "grep x f\necho done",
            "(grep x f)",
            "grep $(cat pattern) f",
            "grep `cat pattern` f",
            "grep 'unterminated f",
        ] {
            assert_eq!(read(command, 1), (false, None), "{command}");
        }
    }
}
