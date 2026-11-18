//! M1 preflight decisions. Core supplies canonical path checks and the exact rule match.

use piarc_protocol::policy::PermissionMode;

/// Core's classification of the effective target(s), including symlink resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Boundary {
    /// All targets are within the permitted directories.
    Inside,
    /// The invocation accesses another directory.
    Outside,
    /// A target to be written is protected, even if a rule matches.
    Protected,
}

/// An automatic allowance or a request for user review, with the step recorded in the audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ruling {
    /// Whether Core can let the call continue immediately.
    pub allow: bool,
    /// Stable description of the step that decided the call.
    pub step: &'static str,
}

/// The M1 mode for a session. The settings layer already removed disallowed project values.
#[must_use]
pub fn starting_mode(explicit: Option<PermissionMode>, setting: Option<&str>) -> PermissionMode {
    explicit.unwrap_or(match setting {
        Some("acceptEdits") => PermissionMode::AcceptEdits,
        _ => PermissionMode::Default,
    })
}

/// The literal text compared for a session or persistent permission in M1.
#[must_use]
pub fn exact_rule(tool: &str, specifier: &str) -> String {
    format!("{tool}({specifier})")
}

/// Decide before a tool executes. Core matches rules from the session and trusted settings.
/// A simple Bash command must have passed both lexical and effective path checks.
#[must_use]
pub fn evaluate(
    mode: PermissionMode,
    tool: &str,
    boundary: Boundary,
    matched_rule: bool,
    simple_command: bool,
) -> Ruling {
    let (allow, step) = match (boundary, tool) {
        (Boundary::Protected, _) => (false, "protectedPath"),
        (_, "AskUserQuestion") => (false, "requiresUserInteraction"),
        (_, _) if matched_rule => (true, "exactRule"),
        (Boundary::Outside, _) => (false, "outsideWorkspace"),
        (_, "Read" | "Glob" | "Grep") => (true, "readOnly"),
        (_, "Write" | "Edit") if mode == PermissionMode::AcceptEdits => (true, "acceptEdits"),
        (_, "Bash") if simple_command && mode == PermissionMode::AcceptEdits => {
            (true, "simpleCommand")
        }
        _ => (false, "ask"),
    };
    Ruling { allow, step }
}

/// Return the literal path operands of an unambiguous filesystem command. This is the M1
/// subset replaced by the Bash parser in T23. Treat unfamiliar syntax and options as a
/// prompt. In particular, path normalization cannot safely cancel a symlink followed by
/// `..` when the actual operator will be a shell utility.
#[must_use]
pub fn simple_paths(command: &str) -> Option<Vec<&str>> {
    if !command
        .chars()
        .all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '/' | '.' | '_' | '-'))
    {
        return None;
    }
    let mut words = command.split_ascii_whitespace();
    let program = words.next()?;
    let mut args = words.peekable();
    if program == "mkdir" && args.peek() == Some(&"-p") {
        args.next();
    }
    let paths: Vec<_> = args.collect();
    let valid_count = match program {
        "mkdir" | "touch" => !paths.is_empty(),
        "mv" | "cp" => paths.len() == 2,
        _ => false,
    };
    if !valid_count
        || paths
            .iter()
            .any(|p| p.starts_with('-') || p.split('/').any(|c| c == ".."))
    {
        return None;
    }
    Some(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionMode::{AcceptEdits, Default};

    #[test]
    fn matrix_and_exact_rule_precedence() {
        for mode in [Default, AcceptEdits] {
            for tool in ["Read", "Grep", "Glob"] {
                assert!(evaluate(mode, tool, Boundary::Inside, false, false).allow);
                assert!(!evaluate(mode, tool, Boundary::Outside, false, false).allow);
            }
            for tool in ["Edit", "Write"] {
                assert_eq!(
                    evaluate(mode, tool, Boundary::Inside, false, false).allow,
                    mode == AcceptEdits
                );
                assert!(!evaluate(mode, tool, Boundary::Protected, true, false).allow);
                assert!(!evaluate(mode, tool, Boundary::Outside, false, false).allow);
            }
            assert_eq!(
                evaluate(mode, "Bash", Boundary::Inside, false, true).allow,
                mode == AcceptEdits
            );
            for tool in ["Bash", "PowerShell", "CustomTool"] {
                assert!(!evaluate(mode, tool, Boundary::Inside, false, false).allow);
                assert!(evaluate(mode, tool, Boundary::Inside, true, false).allow);
            }
            assert!(!evaluate(mode, "PowerShell", Boundary::Inside, false, true).allow);
        }
    }

    #[test]
    fn lexical_subset_contains_only_literal_paths() {
        for (cmd, expected) in [
            ("mkdir -p one/two", vec!["one/two"]),
            ("touch 文件.txt", vec!["文件.txt"]),
            ("cp a.txt b.txt", vec!["a.txt", "b.txt"]),
            ("mv dir/a dir/b", vec!["dir/a", "dir/b"]),
        ] {
            assert_eq!(simple_paths(cmd), Some(expected));
        }
        for cmd in [
            "",
            "cp",
            "mkdir",
            "env touch a",
            "cp -R a b",
            "cp a -t b",
            "mkdir a;ls",
            "cp a b\nc",
            "touch a&&b",
            "mkdir a$var",
            "mkdir (a)",
            "touch *",
            "touch a?",
            "touch `ls`",
            "mkdir \"a\"",
            "cp a b|c",
            "touch ../file",
            "touch x/../a",
            "touch a>b",
            "mkdir ~/here",
            "touch a\\b",
            "touch -",
        ] {
            assert!(simple_paths(cmd).is_none(), "{cmd:?}");
        }
    }

    #[test]
    fn explicit_mode_then_supported_setting_then_manual() {
        assert_eq!(starting_mode(Some(Default), Some("acceptEdits")), Default);
        assert_eq!(starting_mode(None, Some("acceptEdits")), AcceptEdits);
        for v in [None, Some("auto"), Some("plan"), Some("bypassPermissions")] {
            assert_eq!(starting_mode(None, v), Default);
        }
        assert_ne!(
            exact_rule("Bash", "npm test"),
            exact_rule("Bash", "npm test --x")
        );
    }
}
