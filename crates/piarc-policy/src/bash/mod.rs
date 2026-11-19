//! Static analysis of Bash command text with tree-sitter-bash (architecture section 6.2.2).
//!
//! [`analyze`] is pure: it takes the command text and returns every simple command the text can
//! run, with its words normalized (quotes removed, escapes resolved, run-time values replaced by
//! [`DYNAMIC`]), the wrappers and safe environment assignments stripped, its redirections and
//! the directory it runs in. Anything that cannot be judged statically is listed in
//! [`Analysis::unresolved`]; the caller asks the user about such a command.
//!
//! Subcommands come from `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, subshells, command groups,
//! command and process substitutions, and the bodies of `for`, `while`, `until`, `if`, `case`
//! and functions. Commands an exec wrapper, `find -exec`, `xargs` or `sh -c` would run are
//! added as *shadow* commands: deny and ask rules and critical-path checks see them, but they
//! do not need an allow of their own (the outer command does).

mod critical;
mod judge;
mod prefix;
mod readonly;
mod walk;
mod words;
mod wrappers;

pub use critical::{CriticalContext, is_critical_delete};
pub use judge::{AskCause, Facts, Judgment, Located, judge};
pub use prefix::{MAX_RULES, rule_for, rule_prefix, suggestions};
pub use readonly::{BUILTINS, Class, Operand, PROGRAMS, WRAPPED, classify};
pub use wrappers::{EXEC_RUNNERS, EXEC_WRAPPERS, SAFE_ENV, WRAPPERS};

use crate::pattern::DYNAMIC;

/// Commands longer than this always ask.
pub const MAX_COMMAND_LEN: usize = 10_000;

/// Why a command cannot be judged statically.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum Unresolved {
    /// Longer than [`MAX_COMMAND_LEN`].
    TooLong,
    /// The parser reported an error or a missing token.
    ParseError,
    /// The command name is computed at run time (`$CMD args`, a glob or brace expansion).
    DynamicCommand,
    /// `eval` or a shell started with a computed script.
    Eval,
    /// A wrapper with options PiArc does not know how to skip.
    WrapperOptions(String),
    /// Syntax the analyzer does not handle.
    Unsupported(String),
    /// Nested beyond the analyzer's limits.
    TooDeep,
}

/// Where a command runs, relative to the starting directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cwd {
    /// `""` for the starting directory, otherwise a path joined lexically: relative, absolute
    /// (`/x`) or home-relative (`~/x`).
    Known(String),
    /// A `cd` that cannot be followed statically, or a conditional one.
    Unknown,
}

impl Cwd {
    /// The starting directory.
    #[must_use]
    pub fn start() -> Self {
        Self::Known(String::new())
    }

    fn join(&self, target: &str) -> Self {
        match self {
            Self::Unknown => Self::Unknown,
            _ if target.starts_with('/') || target.starts_with('~') => {
                Self::Known(target.to_owned())
            }
            Self::Known(base) if base.is_empty() => Self::Known(target.to_owned()),
            Self::Known(base) => Self::Known(format!("{}/{target}", base.trim_end_matches('/'))),
        }
    }
}

/// One word after quote removal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    /// The value, with [`DYNAMIC`] for text computed at run time.
    pub text: String,
    /// The word as written.
    pub source: String,
    /// Contains an unquoted glob or brace expansion.
    pub glob: bool,
}

impl Word {
    /// Whether the value is known before the command runs.
    #[must_use]
    pub fn is_static(&self) -> bool {
        !self.text.contains(DYNAMIC)
    }

    fn literal(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            source: text.to_owned(),
            glob: false,
        }
    }
}

/// A file redirection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    /// Output (`>`, `>>`, `&>`, `>|`) rather than input (`<`).
    pub write: bool,
    /// The target.
    pub target: Word,
}

/// One simple command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    /// Program and arguments after stripping wrappers and safe assignments.
    pub argv: Vec<Word>,
    /// Stripped wrappers, outermost first.
    pub wrappers: Vec<String>,
    /// Leading assignments that were kept because the variable is not known to be safe.
    pub unsafe_env: Vec<String>,
    /// Run by another command (exec wrapper, `find -exec`, `xargs`, `sh -c`): checked against
    /// deny, ask and critical paths only.
    pub shadow: bool,
    /// Where it runs.
    pub cwd: Cwd,
    /// File redirections that apply to it.
    pub redirects: Vec<Redirect>,
    /// Its program runs another program given in its arguments; only an exact rule allows it.
    pub exec_wrapper: bool,
}

impl Command {
    /// The program name as written.
    #[must_use]
    pub fn program(&self) -> &str {
        self.argv.first().map_or("", |w| w.text.as_str())
    }

    /// The words joined by single spaces: the text rules are matched against.
    #[must_use]
    pub fn text(&self) -> String {
        join(&self.argv)
    }

    /// The text including kept assignments, which an allow rule must also cover.
    #[must_use]
    pub fn full_text(&self) -> String {
        let mut parts = self.unsafe_env.clone();
        parts.push(self.text());
        parts.join(" ")
    }
}

fn join(words: &[Word]) -> String {
    let mut text = String::new();
    for (i, w) in words.iter().enumerate() {
        if i > 0 {
            text.push(' ');
        }
        text.push_str(&w.text);
    }
    text
}

/// The analysis of one command text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Analysis {
    /// Every simple command, in source order.
    pub commands: Vec<Command>,
    /// Reasons the text cannot be judged statically; empty when it can.
    pub unresolved: Vec<Unresolved>,
    /// Variables the text assigns or unsets that change how later commands resolve or run
    /// (`PATH`, `IFS`, ...).
    pub unsafe_assignments: Vec<String>,
}

impl Analysis {
    /// The commands that need an allow of their own.
    pub fn primary(&self) -> impl Iterator<Item = &Command> {
        self.commands.iter().filter(|c| !c.shadow)
    }

    /// Whether the text can be judged statically.
    #[must_use]
    pub fn is_resolved(&self) -> bool {
        self.unresolved.is_empty()
    }
}

/// Analyze Bash command text. Never panics; unknown or invalid input ends up in
/// [`Analysis::unresolved`].
#[must_use]
pub fn analyze(command: &str) -> Analysis {
    if command.len() > MAX_COMMAND_LEN {
        return Analysis {
            unresolved: vec![Unresolved::TooLong],
            ..Analysis::default()
        };
    }
    if command.contains(DYNAMIC) || command.contains('\0') {
        return Analysis {
            unresolved: vec![Unresolved::ParseError],
            ..Analysis::default()
        };
    }
    walk::run(command, 0)
}

#[cfg(test)]
mod tests;
