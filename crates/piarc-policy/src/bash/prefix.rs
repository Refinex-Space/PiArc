//! "Always allow" rules for Bash: one rule per subcommand that still needs the user, written as
//! the command prefix (program plus subcommand) followed by ` *`, such as `Bash(git commit *)`
//! or `Bash(npm run build *)`. Programs that delete, change permissions, reach the network or
//! run other programs get an exact rule instead of a prefix.

use super::{Command, Word};

/// At most this many rules are offered for one command.
pub const MAX_RULES: usize = 5;

/// Tools whose second word selects what they do.
const SUBCOMMAND_TOOLS: &[&str] = &[
    "git",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "cargo",
    "go",
    "docker",
    "podman",
    "kubectl",
    "gh",
    "pip",
    "pip3",
    "uv",
    "poetry",
    "pipx",
    "brew",
    "dotnet",
    "mvn",
    "gradle",
    "rustup",
    "deno",
    "terraform",
    "helm",
    "aws",
    "gcloud",
    "az",
    "swift",
    "flutter",
    "dart",
    "conda",
    "composer",
    "bundle",
    "rake",
    "rails",
    "mix",
    "make",
    "just",
    "nx",
    "turbo",
    "npx",
    "pnpx",
    "bunx",
];

/// `(tool, subcommand)` pairs where a third word names the script or resource.
const THIRD_WORD: &[(&str, &str)] = &[
    ("npm", "run"),
    ("npm", "run-script"),
    ("npm", "exec"),
    ("pnpm", "run"),
    ("pnpm", "exec"),
    ("yarn", "run"),
    ("bun", "run"),
    ("uv", "run"),
    ("poetry", "run"),
    ("pipx", "run"),
    ("docker", "compose"),
    ("podman", "compose"),
    ("git", "stash"),
    ("git", "remote"),
    ("git", "worktree"),
    ("git", "submodule"),
];

/// Interpreters: the script is part of the prefix.
const INTERPRETERS: &[&str] = &[
    "python", "python3", "node", "ruby", "perl", "php", "bash", "sh", "zsh", "tsx", "ts-node",
];

/// Programs only an exact rule should allow.
const EXACT_ONLY: &[&str] = &[
    "rm", "rmdir", "curl", "wget", "chmod", "chown", "chgrp", "dd", "ssh", "scp", "rsync", "kill",
    "pkill", "killall", "ln", "mkfs", "shutdown", "reboot", "truncate", "shred", "mv", "cp",
    "eval", "exec", "source", ".",
];

fn word_ok(w: &Word) -> bool {
    w.is_static() && !w.glob && !w.text.is_empty() && !w.text.contains(char::is_whitespace)
}

/// The prefix of an "always allow" rule for one command, `None` for an exact rule.
#[must_use]
pub fn rule_prefix(argv: &[Word]) -> Option<String> {
    let program = argv.first().filter(|w| word_ok(w))?;
    let name = program.text.as_str();
    if EXACT_ONLY.contains(&name) {
        return None;
    }
    let mut words = vec![name];
    let arg = |i: usize| {
        argv.get(i)
            .filter(|w| word_ok(w) && !w.text.starts_with('-'))
    };
    if SUBCOMMAND_TOOLS.contains(&name) {
        let Some(sub) = arg(1) else {
            // Options before the subcommand (`git -C dir push`): only the exact command.
            return (argv.len() == 1).then(|| name.to_owned());
        };
        words.push(&sub.text);
        if THIRD_WORD.contains(&(name, sub.text.as_str()))
            && let Some(third) = arg(2)
        {
            words.push(&third.text);
        }
        if matches!(name, "gh" | "aws" | "gcloud" | "az")
            && let Some(third) = arg(2)
        {
            words.push(&third.text);
        }
    } else if INTERPRETERS.contains(&name) {
        match argv.get(1) {
            Some(m) if m.text == "-m" => {
                words.push("-m");
                words.push(&arg(2)?.text);
            }
            Some(script) if word_ok(script) && !script.text.starts_with('-') => {
                words.push(&script.text);
            }
            _ => return None,
        }
    }
    Some(words.join(" "))
}

/// The rule for one command: `Bash(<prefix> *)`, or `Bash(<command>)` when no prefix is safe.
#[must_use]
pub fn rule_for(command: &Command) -> Option<String> {
    let text = command.text();
    if text.contains(crate::pattern::DYNAMIC) && !command.argv.first().is_some_and(word_ok) {
        return None;
    }
    let rule = match rule_prefix(&command.argv) {
        Some(prefix) if !command.exec_wrapper => format!("Bash({prefix} *)"),
        _ if text.contains(crate::pattern::DYNAMIC) => return None,
        _ => format!("Bash({text})"),
    };
    // The rule must cover this very command.
    let parsed = crate::rules::parse(&rule, crate::rules::Behavior::Allow).ok()?;
    match parsed.spec {
        Some(crate::rules::Spec::Command(p)) if p.covers(&text) => Some(rule),
        None => Some(rule),
        _ => None,
    }
}

/// Rules for the commands that still need the user, without duplicates, at most
/// [`MAX_RULES`]. Empty when any of them cannot be expressed as a rule.
#[must_use]
pub fn suggestions<'a>(commands: impl IntoIterator<Item = &'a Command>) -> Vec<String> {
    let mut rules = Vec::new();
    for command in commands {
        let Some(rule) = rule_for(command) else {
            return Vec::new();
        };
        if !rules.contains(&rule) {
            rules.push(rule);
        }
    }
    if rules.len() > MAX_RULES {
        return Vec::new();
    }
    rules
}
