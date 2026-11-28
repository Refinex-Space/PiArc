//! The built-in read-only command list and the Accept edits file commands.
//!
//! A read-only command runs without approval in every mode when its path operands are inside
//! the session's directories, its program is the one Core verified, and it has no output
//! redirection to a file. The list is not configurable; an ask or deny rule overrides it.
//! Options that write, run programs or open files named elsewhere take a command off the list.

use super::{Command, Cwd, Word};

/// What a command does, for the mode defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Class {
    /// Reads `reads` and writes only `writes` (`tee`).
    ReadOnly {
        /// Paths it reads.
        reads: Vec<Operand>,
        /// Paths it writes.
        writes: Vec<Operand>,
    },
    /// `mkdir`, `touch`, `mv`, `cp` in their literal forms (Accept edits).
    FileEdit {
        /// Paths it reads (the `cp` source).
        reads: Vec<Operand>,
        /// Paths it creates or changes.
        writes: Vec<Operand>,
    },
    /// Anything else.
    Other,
}

/// A path argument, resolved by Core against the command's directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Operand {
    /// The word.
    pub word: Word,
    /// The directory it is relative to.
    pub cwd: Cwd,
}

/// Shell builtins on the list: no program to verify.
pub const BUILTINS: &[&str] = &[
    "echo", "printf", "pwd", "true", "false", ":", "test", "[", "[[", "((", "cd", "pushd", "type",
    "command", "exit",
];

/// External programs on the read-only list (Core verifies and pins them).
pub const PROGRAMS: &[&str] = &[
    "seq",
    "expr",
    "sleep",
    "whoami",
    "id",
    "uname",
    "basename",
    "dirname",
    "tr",
    "locale",
    "tty",
    "nproc",
    "sw_vers",
    "getconf",
    "date",
    "hostname",
    "which",
    "head",
    "tail",
    "cut",
    "cat",
    "wc",
    "stat",
    "du",
    "df",
    "ls",
    "nl",
    "od",
    "hexdump",
    "strings",
    "cmp",
    "diff",
    "comm",
    "column",
    "tac",
    "rev",
    "fold",
    "fmt",
    "paste",
    "join",
    "expand",
    "unexpand",
    "realpath",
    "readlink",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "shasum",
    "md5",
    "cksum",
    "b2sum",
    "file",
    "tree",
    "sort",
    "uniq",
    "xxd",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "jq",
    "find",
    "tee",
    "git",
    "ps",
];

/// Programs that may run under a wrapper on the list: the exec-ing wrappers and the builtins
/// that also exist as programs (Windows probes these too).
pub const WRAPPED: &[&str] = &[
    "timeout", "nice", "nohup", "stdbuf", "env", "echo", "printf", "pwd", "test", "[", "true",
    "false",
];

enum Paths {
    None,
    All,
    AfterFirst,
}

struct Spec {
    paths: Paths,
    /// Options that take the next word as their value.
    valued: &'static [&'static str],
    /// Options that write, run programs or read paths given elsewhere.
    forbidden: &'static [&'static str],
    /// An unquoted glob could expand to an option.
    glob_sensitive: bool,
    max_operands: Option<usize>,
}

const fn spec(paths: Paths) -> Spec {
    Spec {
        paths,
        valued: &[],
        forbidden: &[],
        glob_sensitive: false,
        max_operands: None,
    }
}

#[expect(clippy::too_many_lines, reason = "one table entry per listed command")]
fn spec_of(name: &str) -> Option<Spec> {
    Some(match name {
        "echo" | "pwd" | "true" | "false" | ":" | "test" | "[" | "[[" | "((" | "exit" | "seq"
        | "expr" | "sleep" | "whoami" | "id" | "uname" | "basename" | "dirname" | "tr" | "type"
        | "locale" | "tty" | "nproc" | "sw_vers" | "getconf" => spec(Paths::None),
        "printf" => Spec {
            forbidden: &["-v"],
            ..spec(Paths::None)
        },
        "date" => Spec {
            forbidden: &["-s", "--set"],
            ..spec(Paths::None)
        },
        "hostname" => Spec {
            max_operands: Some(0),
            ..spec(Paths::None)
        },
        "which" => Spec {
            forbidden: &["-i", "--read-alias", "--read-functions", "--tty-only"],
            ..spec(Paths::None)
        },
        "command" => spec(Paths::None),
        "head" | "tail" => Spec {
            valued: &["-n", "-c"],
            ..spec(Paths::All)
        },
        "cut" => Spec {
            valued: &["-f", "-d", "-c", "-b"],
            ..spec(Paths::All)
        },
        // Values of other options are checked as paths, which only errs toward asking.
        "cat" | "wc" | "stat" | "du" | "df" | "ls" | "nl" | "od" | "hexdump" | "strings"
        | "cmp" | "diff" | "comm" | "column" | "tac" | "rev" | "fold" | "fmt" | "paste"
        | "join" | "expand" | "unexpand" | "realpath" | "readlink" | "md5sum" | "sha1sum"
        | "sha256sum" | "sha512sum" | "shasum" | "md5" | "cksum" | "b2sum" => spec(Paths::All),
        "file" => Spec {
            forbidden: &[
                "-m",
                "--magic-file",
                "-f",
                "--files-from",
                "-C",
                "--compile",
            ],
            ..spec(Paths::All)
        },
        "tree" => Spec {
            valued: &["-L", "-P", "-I"],
            forbidden: &["-o", "-R", "-H"],
            ..spec(Paths::All)
        },
        "sort" => Spec {
            valued: &["-k", "-t", "-S"],
            forbidden: &["-o", "--output", "--compress-program"],
            glob_sensitive: true,
            ..spec(Paths::All)
        },
        // `uniq -c` counts: only the options that take a value are valued.
        "uniq" => Spec {
            valued: &["-f", "-s", "-w"],
            max_operands: Some(1),
            ..spec(Paths::All)
        },
        "xxd" => Spec {
            valued: &["-s", "-c", "-l", "-g", "-o"],
            forbidden: &["-r"],
            max_operands: Some(1),
            ..spec(Paths::All)
        },
        "grep" | "egrep" | "fgrep" => Spec {
            valued: &[
                "-e",
                "-f",
                "-m",
                "-A",
                "-B",
                "-C",
                "--include",
                "--exclude",
                "--exclude-dir",
            ],
            ..spec(Paths::AfterFirst)
        },
        "rg" => Spec {
            valued: &[
                "-e",
                "-f",
                "-m",
                "-A",
                "-B",
                "-C",
                "-g",
                "--glob",
                "-t",
                "--type",
                "-T",
                "--type-not",
            ],
            forbidden: &["--pre", "--pre-glob", "-z", "--search-zip"],
            ..spec(Paths::AfterFirst)
        },
        "jq" => Spec {
            forbidden: &[
                "--arg",
                "--argjson",
                "--slurpfile",
                "--rawfile",
                "--args",
                "--jsonargs",
                "-f",
                "--from-file",
            ],
            ..spec(Paths::AfterFirst)
        },
        "find" => Spec {
            forbidden: &[
                "-exec",
                "-execdir",
                "-ok",
                "-okdir",
                "-delete",
                "-fprint",
                "-fprint0",
                "-fprintf",
                "-fls",
                "-files0-from",
            ],
            glob_sensitive: true,
            ..spec(Paths::All)
        },
        "cd" | "pushd" => Spec {
            max_operands: Some(1),
            ..spec(Paths::All)
        },
        "tee" => Spec {
            forbidden: &["-p"],
            ..spec(Paths::None)
        },
        _ => return None,
    })
}

/// Classify one command.
#[must_use]
pub fn classify(cmd: &Command) -> Class {
    // Arguments `xargs` adds come from input that cannot be checked.
    if !cmd.unsafe_env.is_empty() || cmd.exec_wrapper || cmd.wrappers.iter().any(|w| w == "xargs") {
        return Class::Other;
    }
    let name = cmd.program();
    if name.contains('/') {
        return Class::Other;
    }
    let args = &cmd.argv[1..];
    match name {
        "git" => git(args),
        "ps" => {
            if args.iter().all(|a| a.is_static() && !a.text.contains('e')) {
                Class::ReadOnly {
                    reads: Vec::new(),
                    writes: Vec::new(),
                }
            } else {
                Class::Other
            }
        }
        "mkdir" | "touch" | "mv" | "cp" => file_edit(cmd),
        _ => listed(cmd),
    }
}

fn operand(cmd: &Command, word: &Word) -> Operand {
    Operand {
        word: word.clone(),
        cwd: cmd.cwd.clone(),
    }
}

fn listed(cmd: &Command) -> Class {
    let name = cmd.program();
    let Some(spec) = spec_of(name) else {
        return Class::Other;
    };
    let grep_like = matches!(name, "grep" | "egrep" | "fgrep" | "rg");
    let args = &cmd.argv[1..];
    let mut operands: Vec<Word> = Vec::new();
    // Values of `--option=value` and attached pattern files: checked as paths, not operands.
    let mut values: Vec<Word> = Vec::new();
    let mut explicit_pattern = false;
    let mut i = 0;
    let mut options_done = false;
    while let Some(arg) = args.get(i) {
        i += 1;
        let text = arg.text.as_str();
        if !arg.is_static() && text.starts_with('-') {
            return Class::Other;
        }
        if options_done || !text.starts_with('-') || text == "-" || name == "echo" {
            if spec.glob_sensitive && arg.glob {
                return Class::Other;
            }
            operands.push(arg.clone());
            continue;
        }
        if text == "--" {
            options_done = true;
            continue;
        }
        let option = match option_word(name, text, &spec) {
            OptionWord::Forbidden => return Class::Other,
            OptionWord::Done => continue,
            OptionWord::Attached { option, value } => {
                explicit_pattern |= grep_like && is_pattern_option(option);
                // `--name=value` values and attached pattern files are read as paths.
                if text.starts_with("--") || (grep_like && option == "-f") {
                    values.push(attached(arg, value));
                }
                continue;
            }
            OptionWord::TakesNext(option) => option,
        };
        explicit_pattern |= grep_like && is_pattern_option(option);
        if grep_like && matches!(option, "-f" | "--file") {
            // The pattern file is read.
            values.extend(args.get(i).cloned());
        }
        i += 1;
    }
    if name == "find" {
        operands = find_start_paths(args);
    }
    if spec.max_operands.is_some_and(|max| operands.len() > max) {
        return Class::Other;
    }
    let mut reads: Vec<Operand> = match spec.paths {
        Paths::None => Vec::new(),
        Paths::All => operands.iter().map(|w| operand(cmd, w)).collect(),
        Paths::AfterFirst if explicit_pattern => operands.iter().map(|w| operand(cmd, w)).collect(),
        Paths::AfterFirst => operands.iter().skip(1).map(|w| operand(cmd, w)).collect(),
    };
    if !matches!(spec.paths, Paths::None) {
        reads.extend(values.iter().map(|w| operand(cmd, w)));
    }
    if matches!(name, "cd" | "pushd") && reads.iter().any(|o| o.word.text == "-") {
        return Class::Other;
    }
    reads.retain(|o| o.word.text != "-");
    if matches!(name, "cd" | "pushd") && reads.is_empty() {
        reads.push(Operand {
            word: Word::literal("~"),
            cwd: cmd.cwd.clone(),
        });
    }
    let writes = if name == "tee" {
        operands.iter().map(|w| operand(cmd, w)).collect()
    } else {
        Vec::new()
    };
    Class::ReadOnly { reads, writes }
}

fn is_pattern_option(option: &str) -> bool {
    matches!(option, "-e" | "-f" | "--regexp" | "--file")
}

/// The value part of an option word, as a word of its own.
fn attached(word: &Word, value: &str) -> Word {
    Word {
        text: value.to_owned(),
        source: word.source.clone(),
        glob: false,
    }
}

/// What one static option word (not `--`) does.
enum OptionWord<'a> {
    /// Writes, runs a program or reads paths named elsewhere: not read-only.
    Forbidden,
    /// Complete (flags only, or a value the command does not read as a path).
    Done,
    /// An option with its value in the same word (`--name=value`, `-ofile`, `-k1`).
    Attached { option: &'a str, value: &'a str },
    /// An option whose value is the next word.
    TakesNext(&'a str),
}

/// Parses an option word. Long options: getopt accepts any unambiguous prefix, so a prefix of
/// a forbidden option (`--out` for `--output`) is forbidden too, and `--files0-from` (paths
/// read from a file) is forbidden for every command. Short options: each letter of a cluster
/// (`-no`) is an option until one that takes a value, whose value is the rest of the word.
/// `find`'s single-dash words are whole primaries.
fn option_word<'a>(name: &str, text: &'a str, spec: &Spec) -> OptionWord<'a> {
    if spec.forbidden.contains(&text) {
        return OptionWord::Forbidden;
    }
    if name == "find" {
        return if text == "-files0-from" {
            OptionWord::Forbidden
        } else {
            OptionWord::Done
        };
    }
    if let Some(long) = text.strip_prefix("--") {
        let (option, value) = long
            .split_once('=')
            .map_or((text, None), |(n, v)| (&text[..n.len() + 2], Some(v)));
        let prefix_of =
            |full: &str| full == option || (option.len() > 3 && full.starts_with(option));
        if spec
            .forbidden
            .iter()
            .chain(&["--files0-from"])
            .any(|f| prefix_of(f))
        {
            return OptionWord::Forbidden;
        }
        return match value {
            Some(value) => OptionWord::Attached { option, value },
            None if spec.valued.contains(&option) || matches!(option, "--regexp" | "--file") => {
                OptionWord::TakesNext(option)
            }
            None => OptionWord::Done,
        };
    }
    let letters = &text[1..];
    for (at, c) in letters.char_indices() {
        let short = |list: &[&'static str]| {
            list.iter()
                .copied()
                .find(|f| f.len() == 2 && f.ends_with(c))
        };
        if short(spec.forbidden).is_some() {
            return OptionWord::Forbidden;
        }
        if let Some(option) = short(spec.valued) {
            let rest = &letters[at + c.len_utf8()..];
            return if rest.is_empty() {
                OptionWord::TakesNext(option)
            } else {
                OptionWord::Attached {
                    option,
                    value: rest,
                }
            };
        }
    }
    OptionWord::Done
}

/// `find`'s start paths: the words before the first expression, after the leading options
/// (`-H`, `-L`, `-P`, BSD's `-E`, `-X`, `-d`, `-s`, `-x`, `-f path`, GNU's `-D x`, `-O<n>`).
fn find_start_paths(args: &[Word]) -> Vec<Word> {
    let mut paths = Vec::new();
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        i += 1;
        match arg.text.as_str() {
            "-H" | "-L" | "-P" | "-E" | "-X" | "-d" | "-s" | "-x" => {}
            "-D" => i += 1,
            "-f" => paths.extend(args.get(i).cloned()),
            t if t.starts_with("-O") => {}
            t if t.starts_with('-') || t == "(" || t == "!" => break,
            _ => paths.push(arg.clone()),
        }
    }
    paths
}

/// `git` with a read-only subcommand and no option that writes, runs a program, or reaches
/// another repository.
fn git(args: &[Word]) -> Class {
    let other = Class::Other;
    if args.iter().any(|a| !a.is_static() || a.glob) {
        return other;
    }
    let mut i = 0;
    while let Some(a) = args.get(i) {
        match a.text.as_str() {
            "--no-pager" | "--no-optional-locks" | "-P" => i += 1,
            t if t.starts_with('-') => return other,
            _ => break,
        }
    }
    let Some(sub) = args.get(i).map(|a| a.text.as_str()) else {
        return other;
    };
    let rest: Vec<&str> = args[i + 1..].iter().map(|a| a.text.as_str()).collect();
    const ESCAPES: &[&str] = &[
        "--output",
        "-o",
        "--ext-diff",
        "--no-index",
        "--contents",
        "-O",
        "--open-files-in-pager",
        "--exec",
        "--upload-pack",
        "--receive-pack",
    ];
    if rest.iter().any(|r| {
        ESCAPES
            .iter()
            .any(|e| *r == *e || r.starts_with(&format!("{e}=")))
            || (r.starts_with("-O") && sub == "grep")
    }) {
        return other;
    }
    if subcommand_ok(sub, &rest) {
        Class::ReadOnly {
            reads: Vec::new(),
            writes: Vec::new(),
        }
    } else {
        other
    }
}

/// Read-only forms of a git subcommand.
fn subcommand_ok(sub: &str, rest: &[&str]) -> bool {
    let positional = rest.iter().filter(|r| !r.starts_with('-')).count();
    let has = |flags: &[&str]| rest.iter().any(|r| flags.contains(r));
    match sub {
        "status" | "diff" | "log" | "show" | "blame" | "shortlog" | "describe" | "rev-parse"
        | "rev-list" | "ls-files" | "ls-tree" | "cat-file" | "show-ref" | "for-each-ref"
        | "merge-base" | "name-rev" | "count-objects" | "grep" | "version" | "whatchanged"
        | "diff-tree" | "diff-files" | "diff-index" | "check-ignore" | "check-attr" => true,
        "branch" => {
            positional == 0
                && !has(&[
                    "-d",
                    "-D",
                    "--delete",
                    "-m",
                    "-M",
                    "--move",
                    "-c",
                    "-C",
                    "--copy",
                    "-u",
                    "--set-upstream-to",
                    "--unset-upstream",
                    "--edit-description",
                    "-f",
                    "--force",
                ])
        }
        "tag" => {
            positional == 0
                || has(&["-l", "--list"]) && !has(&["-d", "--delete", "-a", "-s", "-f", "-m"])
        }
        "remote" => rest.is_empty() || rest == ["-v"] || rest.first() == Some(&"get-url"),
        "stash" => matches!(rest.first(), Some(&"list" | &"show")),
        "worktree" => rest.first() == Some(&"list"),
        "reflog" => rest.is_empty() || rest.first() == Some(&"show"),
        "config" => {
            has(&["--get", "--get-all", "--get-regexp", "--list", "-l"])
                && !has(&[
                    "--add",
                    "--unset",
                    "--unset-all",
                    "--replace-all",
                    "--edit",
                    "-e",
                    "--rename-section",
                    "--remove-section",
                ])
        }
        "symbolic-ref" => positional <= 1 && !has(&["-d", "--delete", "-m"]),
        _ => false,
    }
}

/// The M1 literal subset: `mkdir [-p] dir…`, `touch file…`, `mv a b`, `cp a b`.
fn file_edit(cmd: &Command) -> Class {
    let name = cmd.program();
    let mut args: Vec<&Word> = cmd.argv[1..].iter().collect();
    if name == "mkdir" && args.first().is_some_and(|a| a.text == "-p") {
        args.remove(0);
    }
    let literal = args.iter().all(|a| {
        a.is_static()
            && !a.glob
            && !a.text.starts_with('-')
            && !a.text.starts_with('~')
            && !a.text.split('/').any(|c| c == "..")
    });
    let count_ok = match name {
        "mkdir" | "touch" => !args.is_empty(),
        _ => args.len() == 2,
    };
    if !literal || !count_ok {
        return Class::Other;
    }
    let all: Vec<Operand> = args.iter().map(|w| operand(cmd, w)).collect();
    if name == "cp" {
        Class::FileEdit {
            reads: vec![all[0].clone()],
            writes: vec![all[1].clone()],
        }
    } else {
        Class::FileEdit {
            reads: Vec::new(),
            writes: all,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_program_has_a_specification() {
        for name in PROGRAMS {
            assert!(
                spec_of(name).is_some() || matches!(*name, "git" | "ps"),
                "{name}"
            );
            assert!(!BUILTINS.contains(name), "{name}");
        }
        for name in BUILTINS {
            assert!(spec_of(name).is_some(), "{name}");
        }
    }
}
