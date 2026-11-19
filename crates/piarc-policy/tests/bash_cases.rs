//! T23-A03, A04, A06: the data-driven Bash cases (`bash_cases.json`) and random input.
//!
//! Each case states the input, the commands it splits into and the expected decision. The
//! facts double puts the workspace and the starting directory at `/w` and home at `/h`; every
//! program counts as verified.

use std::collections::BTreeMap;

use piarc_policy::bash::{self, CriticalContext, Cwd, Facts, Located, Operand};
use piarc_policy::paths::PathContext;
use piarc_policy::pattern::DYNAMIC;
use piarc_policy::rules::{Behavior, RuleSet, Source};
use piarc_policy::{Outcome, decide};
use piarc_protocol::policy::PermissionMode;
use serde_json::Value;

struct World;

impl World {
    fn normalize(path: &str) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for p in path.split('/') {
            match p {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                p => parts.push(p),
            }
        }
        format!("/{}", parts.join("/"))
    }
}

impl Facts for World {
    fn locate(&self, operand: &Operand, write: bool) -> Option<Located> {
        let text = &operand.word.text;
        if text.contains(DYNAMIC) {
            return None;
        }
        let text = if operand.word.glob {
            let cut = text.find(['*', '?', '[']).unwrap_or(text.len());
            text[..cut]
                .rsplit_once('/')
                .map_or(".", |(d, _)| d)
                .to_owned()
        } else {
            text.clone()
        };
        let text = text.replacen('~', "/h", usize::from(text.starts_with('~')));
        let path = if text.starts_with('/') {
            World::normalize(&text)
        } else {
            let Cwd::Known(rel) = &operand.cwd else {
                return None;
            };
            World::normalize(&format!("/w/{rel}/{text}"))
        };
        let inside = path == "/w" || path.starts_with("/w/");
        let protected = write
            && path
                .split('/')
                .any(|p| matches!(p, ".git" | ".piarc" | ".claude"));
        Some(Located {
            paths: vec![path],
            inside,
            protected,
        })
    }

    fn program_ok(&self, name: &str) -> bool {
        name != "evil"
    }

    fn path_context(&self) -> PathContext<'_> {
        PathContext {
            home: "/h",
            cwd: "/w",
            anchor: "/w",
            fold_case: false,
        }
    }

    fn critical_context(&self) -> CriticalContext<'_> {
        CriticalContext {
            home: "/h",
            root: "/w",
            cwd: "/w",
            fold_case: false,
        }
    }
}

fn rules(case: &Value) -> RuleSet {
    let mut set = RuleSet::default();
    let list = |key: &str| -> Vec<String> {
        case["rules"][key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let (deny, ask, allow) = (list("deny"), list("ask"), list("allow"));
    let lists = deny
        .iter()
        .map(|r| (Behavior::Deny, r.as_str()))
        .chain(ask.iter().map(|r| (Behavior::Ask, r.as_str())))
        .chain(allow.iter().map(|r| (Behavior::Allow, r.as_str())));
    set.add_source(
        Source {
            id: "projectLocal".into(),
            anchor: "/w".into(),
        },
        lists,
    );
    set
}

fn mode(case: &Value) -> PermissionMode {
    match case["mode"].as_str() {
        Some("acceptEdits") => PermissionMode::AcceptEdits,
        Some("plan") => PermissionMode::Plan,
        Some("bypassPermissions") => PermissionMode::BypassPermissions,
        _ => PermissionMode::Default,
    }
}

#[test]
fn data_driven_cases() {
    let data: Value =
        serde_json::from_str(include_str!("bash_cases.json")).expect("valid case file");
    let cases = data["cases"].as_array().expect("cases");
    let mut per_category: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures = Vec::new();
    for case in cases {
        let input = case["input"].as_str().expect("input");
        let category = case["category"].as_str().expect("category");
        *per_category.entry(category.to_owned()).or_default() += 1;
        let analysis = bash::analyze(input);
        let split: Vec<String> = analysis
            .commands
            .iter()
            .map(|c| {
                let text = c.text().replace(DYNAMIC, "…");
                if c.shadow {
                    format!("shadow: {text}")
                } else {
                    text
                }
            })
            .collect();
        if let Some(expected) = case["split"].as_array() {
            let expected: Vec<&str> = expected.iter().filter_map(Value::as_str).collect();
            if split != expected {
                failures.push(format!("{input:?}: split {split:?}, expected {expected:?}"));
            }
        }
        let judgment = bash::judge(&analysis, &rules(case), &World);
        let ruling = decide(&judgment.input(mode(case)));
        let outcome = match ruling.outcome {
            Outcome::Allow => "allow",
            Outcome::Ask => "ask",
            Outcome::Deny => "deny",
        };
        let want = (
            case["expected"].as_str().unwrap_or(""),
            case["step"].as_str().unwrap_or(""),
        );
        if (outcome, ruling.step) != want {
            failures.push(format!(
                "{input:?} ({:?}): {outcome}/{}, expected {}/{}; {judgment:?}",
                mode(case),
                ruling.step,
                want.0,
                want.1
            ));
        }
    }
    println!("{} Bash cases by category: {per_category:?}", cases.len());
    assert!(cases.len() >= 40);
    for (category, minimum) in [
        ("simple", 6),
        ("operators", 6),
        ("pipes", 4),
        ("groups", 4),
        ("substitution", 5),
        ("wrappers", 7),
        ("env", 2),
        ("redirects", 3),
        ("control", 3),
        ("readonly", 4),
        ("critical", 3),
        ("unresolved", 3),
    ] {
        assert!(
            per_category.get(category).copied().unwrap_or(0) >= minimum,
            "{category}"
        );
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

const ALPHABET: &[&str] = &[
    "ls",
    "rm",
    " ",
    "-rf",
    "&&",
    "||",
    ";",
    "|",
    "|&",
    "&",
    "\n",
    "(",
    ")",
    "{",
    "}",
    "$(",
    "`",
    "'",
    "\"",
    "\\",
    "$",
    "${",
    "<<",
    "EOF",
    "<",
    ">",
    ">>",
    "2>&1",
    "*",
    "?",
    "[",
    "]",
    "for x in a; do",
    "done",
    "if",
    "then",
    "fi",
    "case",
    "esac",
    "!",
    "~",
    "=",
    "PATH=",
    "eval",
    "sudo",
    "timeout 5",
    "xargs",
    "<(",
    ">(",
    "$'",
    "\\n",
    "文",
    "#",
    "((",
    "[[",
    "]]",
    "function f",
    "\t",
    "\r",
];

/// Well-formed pieces, so the random walk also reaches deep into valid syntax.
const COMMANDS: &[&str] = &[
    "ls -la",
    "rm -rf build",
    "git status",
    "npm test",
    "cd src",
    "echo \"$(id)\"",
    "cat <<EOF\nx\nEOF",
    "sudo rm -rf /",
    "env A=1 ls",
    "find . -exec rm {} \\;",
    "x=$(pwd)",
    "{ ls; }",
    "(cd .. && ls)",
    "for f in *; do echo $f; done",
    "timeout 3 nice ls > out",
    "bash -c 'ls; rm -rf ~'",
    "watch 'ls'",
    "xargs -0 rm",
    "[[ -f a ]]",
    "f() { rm x; }",
];
const JOINERS: &[&str] = &[" && ", " || ", "; ", " | ", " & ", "\n", " |& "];

fn xorshift(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

fn pick<'a>(state: &mut u64, list: &[&'a str]) -> &'a str {
    list[usize::try_from(xorshift(state) % list.len() as u64).unwrap_or(0)]
}

/// Shell-like random input never panics and always yields an answer.
#[test]
fn random_input_does_not_panic() {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let rules = RuleSet::default();
    let (mut unresolved, total) = (0, 6_000);
    for round in 0..total {
        let len = xorshift(&mut state) % 40;
        let mut text = String::new();
        for i in 0..len {
            if round % 2 == 0 {
                text.push_str(pick(&mut state, ALPHABET));
            } else {
                if i > 0 {
                    text.push_str(pick(&mut state, JOINERS));
                }
                text.push_str(pick(&mut state, COMMANDS));
            }
        }
        let analysis = bash::analyze(&text);
        unresolved += usize::from(!analysis.is_resolved());
        let judgment = bash::judge(&analysis, &rules, &World);
        let _ = decide(&judgment.input(PermissionMode::BypassPermissions));
        let _ = bash::suggestions(analysis.primary());
    }
    // Deeply nested and oversized text is refused, not walked into a stack overflow.
    let deep = "$(".repeat(4_000) + &")".repeat(4_000);
    assert!(!bash::analyze(&deep).is_resolved());
    assert!(!bash::analyze(&"a".repeat(bash::MAX_COMMAND_LEN + 1)).is_resolved());
    println!("{total} random inputs, {unresolved} unresolved, no panic");
}
