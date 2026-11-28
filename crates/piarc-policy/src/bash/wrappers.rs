//! Wrappers and leading assignments.
//!
//! - Stripped before rules are matched (the wrapper runs its argument as the command):
//!   `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare
//!   `xargs`, and `env` with only safe assignments. Options PiArc cannot skip make the command
//!   unresolved rather than leaving the wrapper in place.
//! - A leading assignment is stripped when the variable is in [`SAFE_ENV`]; any other is kept
//!   in [`super::Command::unsafe_env`] and the command needs the user.
//! - Exec wrappers (`sudo`, `watch`, `setsid`, `flock`, `env` with options, `xargs` with
//!   flags, `find -exec`, `sh -c`, ...) stay the command, only an exact rule allows them, and
//!   the command they run is checked as a shadow.

use super::{Unresolved, Word};
use crate::pattern::DYNAMIC;

/// Variables a leading assignment may set without changing which program runs or what it
/// loads.
pub const SAFE_ENV: &[&str] = &[
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NUMERIC",
    "LC_TIME",
    "TZ",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "COLUMNS",
    "LINES",
    "CI",
    "DEBUG",
    "VERBOSE",
    "NODE_ENV",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "CARGO_TERM_COLOR",
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONIOENCODING",
    "GOOS",
    "GOARCH",
    "CGO_ENABLED",
    "GO111MODULE",
];

/// Stripped wrappers that are programs and run the command with `exec`: the command's own
/// name is then looked up on PATH even when bash has a builtin of that name.
pub const EXEC_RUNNERS: &[&str] = &["timeout", "nice", "nohup", "stdbuf", "env", "xargs"];

/// The wrappers stripped before matching.
pub const WRAPPERS: &[&str] = &[
    "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "xargs", "env",
];

/// Programs that run another program from their arguments.
pub const EXEC_WRAPPERS: &[&str] = &[
    "sudo",
    "doas",
    "env",
    "watch",
    "setsid",
    "ionice",
    "flock",
    "chroot",
    "nsenter",
    "unshare",
    "chrt",
    "taskset",
    "caffeinate",
    "exec",
    "strace",
    "ltrace",
    "xargs",
    "find",
    "su",
    "script",
    "parallel",
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "mksh",
];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "mksh"];

/// A leading `NAME=value`.
#[derive(Debug, Clone)]
pub struct Assignment {
    /// The variable.
    pub name: String,
    /// `NAME=value` as a word.
    pub word: Word,
}

pub(super) struct Stripped {
    pub argv: Vec<Word>,
    pub wrappers: Vec<String>,
    pub unsafe_env: Vec<String>,
    pub shadows: Vec<Vec<Word>>,
    pub scripts: Vec<String>,
    pub exec_wrapper: bool,
}

pub(super) fn strip(argv: Vec<Word>, assignments: &[Assignment]) -> Result<Stripped, Unresolved> {
    let unsafe_env = assignments
        .iter()
        .filter(|a| !SAFE_ENV.contains(&a.name.as_str()))
        .map(|a| a.word.text.clone())
        .collect();
    let mut out = Stripped {
        argv,
        wrappers: Vec::new(),
        unsafe_env,
        shadows: Vec::new(),
        scripts: Vec::new(),
        exec_wrapper: false,
    };
    while let Some(rest) = strip_one(&out.argv)? {
        if rest.is_empty() {
            break;
        }
        out.wrappers.push(out.argv[0].text.clone());
        out.argv = rest;
    }
    exec_wrapper(&mut out)?;
    Ok(out)
}

/// The command a stripped wrapper runs, `None` when `argv` is not a stripped wrapper.
fn strip_one(argv: &[Word]) -> Result<Option<Vec<Word>>, Unresolved> {
    let Some(program) = argv.first() else {
        return Ok(None);
    };
    let args = &argv[1..];
    let name = program.text.as_str();
    let fail = || Unresolved::WrapperOptions(name.to_owned());
    let rest = match name {
        "timeout" => {
            let i = skip_options(
                args,
                &["-k", "--kill-after", "-s", "--signal"],
                &["--preserve-status", "--foreground", "-v", "--verbose"],
            )
            .ok_or_else(fail)?;
            // The duration comes first.
            if i >= args.len() {
                return Ok(None);
            }
            &args[i + 1..]
        }
        "time" => &args[skip_options(args, &[], &["-p"]).ok_or_else(fail)?..],
        "nice" => {
            // `nice -10 cmd` sets the niceness without a flag letter.
            let numeric = args.first().is_some_and(|a| {
                a.text.len() > 1
                    && a.text.starts_with('-')
                    && a.text[1..].chars().all(|c| c.is_ascii_digit())
            });
            if numeric {
                &args[1..]
            } else {
                &args[skip_options(args, &["-n", "--adjustment"], &[]).ok_or_else(fail)?..]
            }
        }
        "nohup" | "builtin" | "noglob" => &args[skip_options(args, &[], &[]).ok_or_else(fail)?..],
        "stdbuf" => {
            &args[skip_options(
                args,
                &["-i", "-o", "-e", "--input", "--output", "--error"],
                &[],
            )
            .ok_or_else(fail)?..]
        }
        "command" => {
            if args
                .first()
                .is_some_and(|a| matches!(a.text.as_str(), "-v" | "-V"))
            {
                return Ok(None);
            }
            &args[skip_options(args, &[], &["-p"]).ok_or_else(fail)?..]
        }
        // Only bare `xargs` is stripped; with flags it is an exec wrapper.
        "xargs" if args.first().is_some_and(|a| !a.text.starts_with('-')) => args,
        "env" => {
            let n = args
                .iter()
                .take_while(|a| a.text.contains('=') && !a.text.starts_with('-'))
                .count();
            let safe = args[..n].iter().all(|a| {
                a.is_static()
                    && a.text
                        .split_once('=')
                        .is_some_and(|(k, _)| SAFE_ENV.contains(&k))
            });
            if n > 0 && n < args.len() && safe && !args[n].text.starts_with('-') {
                &args[n..]
            } else {
                return Ok(None);
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(rest.to_vec()))
}

/// Index of the first word after the options. `valued` options take the next word (or
/// `--opt=value`, `-ovalue`); `flags` take none. Unknown options are an error (`None`).
fn skip_options(args: &[Word], valued: &[&str], flags: &[&str]) -> Option<usize> {
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        let text = arg.text.as_str();
        if text == "--" {
            return Some(i + 1);
        }
        if !text.starts_with('-') || text == "-" {
            return Some(i);
        }
        if !arg.is_static() {
            return None;
        }
        let (name, attached) = match text.split_once('=') {
            Some((n, _)) if text.starts_with("--") => (n, true),
            _ => (text, false),
        };
        if flags.contains(&name) {
            i += 1;
        } else if valued.contains(&name) {
            i += if attached { 1 } else { 2 };
        } else if !text.starts_with("--")
            && valued.iter().any(|v| v.len() == 2 && text.starts_with(v))
        {
            i += 1;
        } else {
            return None;
        }
    }
    Some(i)
}

/// Mark exec wrappers and collect what they run.
fn exec_wrapper(out: &mut Stripped) -> Result<(), Unresolved> {
    let name = out.argv[0].text.clone();
    let args = out.argv[1..].to_vec();
    match name.as_str() {
        _ if SHELLS.contains(&name.as_str()) => {
            let Some(c) = args.iter().position(|a| {
                a.text.starts_with('-') && !a.text.starts_with("--") && a.text.contains('c')
            }) else {
                return Ok(());
            };
            out.exec_wrapper = true;
            match args.get(c + 1) {
                Some(script) if script.is_static() => out.scripts.push(script.text.clone()),
                _ => return Err(Unresolved::Eval),
            }
        }
        "find" => {
            const ACTIONS: &[&str] = &[
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
            ];
            out.exec_wrapper = args.iter().any(|a| ACTIONS.contains(&a.text.as_str()));
            let mut i = 0;
            while i < args.len() {
                if matches!(
                    args[i].text.as_str(),
                    "-exec" | "-execdir" | "-ok" | "-okdir"
                ) {
                    let end = args[i + 1..]
                        .iter()
                        .position(|a| a.text == ";" || a.text == "+")
                        .map_or(args.len(), |p| i + 1 + p);
                    out.shadows.push(args[i + 1..end].to_vec());
                    i = end;
                }
                i += 1;
            }
        }
        "watch" => {
            out.exec_wrapper = true;
            let i = generic_skip(
                &args,
                &[
                    "-n",
                    "--interval",
                    "-d",
                    "--differences",
                    "-q",
                    "--equexit",
                    "-g",
                ],
            );
            let inner = &args[i..];
            if inner.iter().all(Word::is_static) {
                out.scripts.push(
                    inner
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            } else {
                return Err(Unresolved::Eval);
            }
        }
        _ if EXEC_WRAPPERS.contains(&name.as_str()) => {
            out.exec_wrapper = true;
            other_exec(out, &name, &args)?;
        }
        _ => {}
    }
    Ok(())
}

/// Shadow extraction for the other exec wrappers.
fn other_exec(out: &mut Stripped, name: &str, args: &[Word]) -> Result<(), Unresolved> {
    let (valued, positional): (&[&str], usize) = match name {
        "sudo" => (
            &["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"],
            0,
        ),
        "env" => {
            if args
                .iter()
                .any(|a| a.text.starts_with("-S") || a.text.starts_with("--split-string"))
            {
                return Err(Unresolved::Eval);
            }
            (&["-u", "--unset", "-C", "--chdir"], 0)
        }
        "xargs" => (
            &[
                "-n",
                "-L",
                "-P",
                "-I",
                "-d",
                "-E",
                "-e",
                "-s",
                "-a",
                "--max-args",
                "--max-lines",
                "--max-procs",
                "--replace",
                "--delimiter",
                "--eof",
                "--max-chars",
                "--arg-file",
            ],
            0,
        ),
        "ionice" => (&["-c", "-n", "-p", "-P", "-u"], 0),
        "flock" => (&["-w", "-E", "--timeout", "--conflict-exit-code"], 1),
        "chroot" => (&["--userspec", "--groups"], 1),
        "chrt" => (&["-T", "-P", "-D"], 1),
        "taskset" => (&[], 1),
        "caffeinate" => (&["-t", "-w"], 0),
        "exec" => (&["-a"], 0),
        "su" | "script" => {
            if let Some(c) = args
                .iter()
                .position(|a| a.text == "-c" || a.text == "--command")
            {
                match args.get(c + 1) {
                    Some(s) if s.is_static() => out.scripts.push(s.text.clone()),
                    _ => return Err(Unresolved::Eval),
                }
            }
            return Ok(());
        }
        _ => (&[], 0),
    };
    let mut i = generic_skip(args, valued);
    while i < args.len() && args[i].text.contains('=') && name != "xargs" {
        i += 1;
    }
    i += positional;
    if i < args.len() {
        out.shadows.push(args[i..].to_vec());
    }
    Ok(())
}

/// Skip options (with values for `valued`) the best we can, for shadow extraction.
fn generic_skip(args: &[Word], valued: &[&str]) -> usize {
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        let text = arg.text.as_str();
        if text == "--" {
            return i + 1;
        }
        if !text.starts_with('-') || text == "-" || text.contains(DYNAMIC) && !text.starts_with('-')
        {
            return i;
        }
        i += if valued.contains(&text) { 2 } else { 1 };
    }
    i
}
