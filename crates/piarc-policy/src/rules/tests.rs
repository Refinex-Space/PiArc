//! T23-A01: every specifier and tool-name wildcard, matching and not matching.
use super::*;
use crate::pattern::DYNAMIC;

const CTX: PathContext<'static> = PathContext {
    home: "/home/u",
    cwd: "/home/u/proj",
    anchor: "/home/u/proj",
    fold_case: false,
};

fn set(behavior: Behavior, rules: &[&str]) -> RuleSet {
    let mut set = RuleSet::default();
    set.add_source(
        Source {
            id: "project".into(),
            anchor: "/home/u/proj".into(),
        },
        rules.iter().map(|r| (behavior, *r)),
    );
    set
}

fn hits(behavior: Behavior, rule: &str, tool: &str, subject: Subject<'_>) -> bool {
    set(behavior, &[rule])
        .find(behavior, tool, subject, Some(&CTX))
        .is_some_and(|(_, c)| c == Certainty::Certain)
}

#[test]
fn bash_rules_match_command_text() {
    for b in [Behavior::Deny, Behavior::Ask, Behavior::Allow] {
        assert!(hits(
            b,
            "Bash(npm run *)",
            "Bash",
            Subject::Command("npm run build")
        ));
        assert!(hits(
            b,
            "Bash(npm run *)",
            "Bash",
            Subject::Command("npm run")
        ));
        assert!(!hits(
            b,
            "Bash(npm run *)",
            "Bash",
            Subject::Command("npm install")
        ));
        assert!(hits(b, "Bash(ls:*)", "Bash", Subject::Command("ls -la")));
        assert!(!hits(b, "Bash(ls *)", "Bash", Subject::Command("lsof")));
        assert!(hits(b, "Bash", "Bash", Subject::Command("anything at all")));
        assert!(hits(b, "Bash(*)", "Bash", Subject::Command("rm -rf x")));
        assert!(!hits(
            b,
            "Bash(npm test)",
            "PowerShell",
            Subject::Command("npm test")
        ));
        // Monitor is covered by Bash rules (T32).
        assert!(hits(
            b,
            "Bash(tail *)",
            "Monitor",
            Subject::Command("tail -f log")
        ));
    }
    // Text computed at run time: deny may match, allow must cover it.
    let dynamic = format!("git {DYNAMIC} origin");
    let deny = set(Behavior::Deny, &["Bash(git push *)"]);
    let found = deny.find(Behavior::Deny, "Bash", Subject::Command(&dynamic), None);
    assert_eq!(found.map(|(_, c)| c), Some(Certainty::Possible));
    let allow = set(Behavior::Allow, &["Bash(git push *)"]);
    assert!(
        allow
            .find(Behavior::Allow, "Bash", Subject::Command(&dynamic), None)
            .is_none()
    );
}

#[test]
fn powershell_rules_match_the_whole_command_without_case() {
    let rule = "PowerShell(Get-ChildItem *)";
    assert!(hits(
        Behavior::Allow,
        rule,
        "PowerShell",
        Subject::Command("get-childitem -Force")
    ));
    assert!(hits(
        Behavior::Allow,
        rule,
        "PowerShell",
        Subject::Command("Get-ChildItem")
    ));
    assert!(!hits(
        Behavior::Allow,
        "PowerShell(Get-ChildItem)",
        "PowerShell",
        Subject::Command("Get-ChildItem; Remove-Item x")
    ));
    assert!(!hits(
        Behavior::Deny,
        "PowerShell(Remove-Item *)",
        "PowerShell",
        Subject::Command("Get-Item x")
    ));
    assert!(!hits(
        Behavior::Deny,
        "PowerShell(Remove-Item *)",
        "Bash",
        Subject::Command("Remove-Item x")
    ));
}

#[test]
fn read_and_edit_rules_match_paths_of_their_tools() {
    let env = ["/home/u/proj/.env".to_owned()];
    let src = ["/home/u/proj/src/a.ts".to_owned()];
    for tool in ["Read", "Glob", "Grep"] {
        assert!(hits(
            Behavior::Deny,
            "Read(./.env)",
            tool,
            Subject::Paths(&env)
        ));
        assert!(!hits(
            Behavior::Deny,
            "Read(./.env)",
            tool,
            Subject::Paths(&src)
        ));
        assert!(!hits(
            Behavior::Deny,
            "Edit(./.env)",
            tool,
            Subject::Paths(&env)
        ));
    }
    for tool in ["Edit", "Write"] {
        assert!(hits(
            Behavior::Allow,
            "Edit(/src/**)",
            tool,
            Subject::Paths(&src)
        ));
        assert!(!hits(
            Behavior::Allow,
            "Edit(/src/**)",
            tool,
            Subject::Paths(&env)
        ));
        assert!(!hits(
            Behavior::Allow,
            "Read(/src/**)",
            tool,
            Subject::Paths(&src)
        ));
    }
    // Allow needs every path, deny any.
    let both = [src[0].clone(), env[0].clone()];
    assert!(!hits(
        Behavior::Allow,
        "Edit(/src/**)",
        "Edit",
        Subject::Paths(&both)
    ));
    assert!(hits(
        Behavior::Deny,
        "Edit(/src/**)",
        "Edit",
        Subject::Paths(&both)
    ));
    // `Write(path)` is accepted but never matches; the bare name does.
    assert!(!hits(
        Behavior::Deny,
        "Write(src/**)",
        "Write",
        Subject::Paths(&src)
    ));
    assert!(hits(Behavior::Deny, "Write", "Write", Subject::Paths(&src)));
    assert!(hits(
        Behavior::Deny,
        "Read(~/secrets/**)",
        "Read",
        Subject::Paths(&["/home/u/secrets/k".to_owned()])
    ));
    // A user-level `/path` is anchored at its source, not the project.
    let mut user = RuleSet::default();
    user.add_source(
        Source {
            id: "user".into(),
            anchor: "/data".into(),
        },
        [(Behavior::Deny, "Read(/secrets/**)")],
    );
    assert!(
        user.find(
            Behavior::Deny,
            "Read",
            Subject::Paths(&["/data/secrets/a".to_owned()]),
            Some(&CTX)
        )
        .is_some()
    );
    assert!(
        user.find(
            Behavior::Deny,
            "Read",
            Subject::Paths(&["/home/u/proj/secrets/a".to_owned()]),
            Some(&CTX)
        )
        .is_none()
    );
}

#[test]
fn webfetch_rules_match_hosts() {
    let r = "WebFetch(domain:example.com)";
    assert!(hits(
        Behavior::Allow,
        r,
        "WebFetch",
        Subject::Domain("example.com")
    ));
    assert!(hits(
        Behavior::Allow,
        r,
        "WebFetch",
        Subject::Domain("EXAMPLE.com.")
    ));
    assert!(!hits(
        Behavior::Allow,
        r,
        "WebFetch",
        Subject::Domain("api.example.com")
    ));
    let sub = "WebFetch(domain:*.example.com)";
    assert!(hits(
        Behavior::Allow,
        sub,
        "WebFetch",
        Subject::Domain("a.b.example.com")
    ));
    assert!(!hits(
        Behavior::Allow,
        sub,
        "WebFetch",
        Subject::Domain("example.com")
    ));
    assert!(!hits(
        Behavior::Allow,
        sub,
        "WebFetch",
        Subject::Domain("evilexample.com")
    ));
    assert!(hits(
        Behavior::Allow,
        "WebFetch(domain:*)",
        "WebFetch",
        Subject::Domain("x.org")
    ));
    let tld = "WebFetch(domain:example.*)";
    assert!(hits(
        Behavior::Deny,
        tld,
        "WebFetch",
        Subject::Domain("example.org")
    ));
    assert!(!hits(
        Behavior::Deny,
        tld,
        "WebFetch",
        Subject::Domain("example.evil.com")
    ));
    assert!(parse("WebFetch(example.com)", Behavior::Allow).is_err());
}

#[test]
fn agent_and_skill_rules_match_names() {
    assert!(hits(
        Behavior::Deny,
        "Agent(Explore)",
        "Agent",
        Subject::Name("Explore")
    ));
    assert!(!hits(
        Behavior::Deny,
        "Agent(Explore)",
        "Agent",
        Subject::Name("Plan")
    ));
    assert!(hits(
        Behavior::Allow,
        "Skill(deploy *)",
        "Skill",
        Subject::Name("deploy staging")
    ));
    assert!(hits(
        Behavior::Allow,
        "Skill(deploy *)",
        "Skill",
        Subject::Name("deploy")
    ));
    assert!(!hits(
        Behavior::Allow,
        "Skill(deploy *)",
        "Skill",
        Subject::Name("deployer")
    ));
    assert!(!hits(
        Behavior::Allow,
        "Skill(deploy)",
        "Agent",
        Subject::Name("deploy")
    ));
}

#[test]
fn mcp_rules_match_tool_names() {
    let tool = "mcp__github__get_issue";
    for b in [Behavior::Deny, Behavior::Ask, Behavior::Allow] {
        assert!(hits(b, "mcp__github__get_issue", tool, Subject::Tool));
        assert!(!hits(b, "mcp__github__create_issue", tool, Subject::Tool));
        assert!(hits(b, "mcp__github__*", tool, Subject::Tool));
        assert!(hits(b, "mcp__github__get_*", tool, Subject::Tool));
        assert!(!hits(b, "mcp__gitlab__*", tool, Subject::Tool));
        assert!(hits(b, "mcp__github", tool, Subject::Tool));
        assert!(!hits(b, "mcp__git", tool, Subject::Tool));
    }
    for rule in ["mcp__github__get_issue(x)", "mcp__github(x)"] {
        assert!(parse(rule, Behavior::Allow).is_err(), "{rule}");
    }
}

#[test]
fn tool_name_wildcards() {
    for b in [Behavior::Deny, Behavior::Ask] {
        assert!(hits(b, "*", "Bash", Subject::Command("ls")));
        assert!(hits(b, "mcp__*", "mcp__a__b", Subject::Tool));
        assert!(!hits(
            b,
            "mcp__*",
            "Read",
            Subject::Paths(&["/x".to_owned()])
        ));
        assert!(hits(b, "Web*", "WebFetch", Subject::Domain("a.b")));
        assert!(!hits(b, "Web*", "Bash", Subject::Command("ls")));
    }
    for rule in ["*", "mcp__*", "B*", "mcp__*__x"] {
        assert!(parse(rule, Behavior::Allow).is_err(), "{rule}");
    }
    assert!(parse("mcp__srv__*", Behavior::Allow).is_ok());
}

#[test]
fn whole_tool_rules_and_coverage() {
    let rules = set(Behavior::Deny, &["Read", "Bash(rm *)", "mcp__srv"]);
    for tool in ["Read", "Glob", "Grep", "mcp__srv__t"] {
        assert!(rules.whole_tool(Behavior::Deny, tool).is_some(), "{tool}");
    }
    for tool in ["Bash", "Edit", "mcp__other__t"] {
        assert!(rules.whole_tool(Behavior::Deny, tool).is_none(), "{tool}");
    }
    let star = set(Behavior::Deny, &["Bash(*)"]);
    assert!(star.whole_tool(Behavior::Deny, "Bash").is_some());
}

#[test]
fn invalid_rules_are_reported_and_deny_asks_for_its_tool() {
    let mut rules = RuleSet::default();
    rules.add_source(
        Source {
            id: "user".into(),
            anchor: "/data".into(),
        },
        [
            (Behavior::Deny, "Bash(rm -rf *"),
            (Behavior::Ask, "Read([)"),
            (Behavior::Deny, "(oops)"),
            (Behavior::Allow, "*"),
        ],
    );
    let invalid = rules.invalid();
    assert_eq!(invalid.len(), 4);
    assert_eq!(invalid[0].asks_for.as_deref(), Some("Bash"));
    assert_eq!(invalid[1].asks_for.as_deref(), Some("Read"));
    assert_eq!(invalid[2].asks_for.as_deref(), Some("*"));
    assert_eq!(invalid[3].asks_for, None);
    assert!(rules.invalid_for("Grep").is_some());
    let mut only_bash = RuleSet::default();
    only_bash.add_source(
        Source {
            id: "user".into(),
            anchor: "/data".into(),
        },
        [(Behavior::Deny, "Bash(rm -rf *")],
    );
    assert!(only_bash.invalid_for("Bash").is_some());
    assert!(only_bash.invalid_for("Read").is_none());
}

#[test]
fn sources_report_the_highest_hit() {
    let mut rules = RuleSet::default();
    rules.add_source(
        Source {
            id: "session".into(),
            anchor: "/p".into(),
        },
        [(Behavior::Allow, "Bash(npm *)")],
    );
    rules.add_source(
        Source {
            id: "user".into(),
            anchor: "/d".into(),
        },
        [
            (Behavior::Allow, "Bash(npm test)"),
            (Behavior::Deny, "Bash(npm test)"),
        ],
    );
    let (allow, _) = rules
        .find(Behavior::Allow, "Bash", Subject::Command("npm test"), None)
        .expect("allow");
    assert_eq!(allow.source, "session");
    let (deny, _) = rules
        .find(Behavior::Deny, "Bash", Subject::Command("npm test"), None)
        .expect("deny");
    assert_eq!(
        (deny.source.as_str(), deny.behavior),
        ("user", Behavior::Deny)
    );
}

#[test]
fn broad_rules_are_flagged() {
    for rule in [
        "Bash",
        "Bash(git *)",
        "Bash(* --version)",
        "Bash(git * main)",
        "WebFetch(domain:*)",
        "Edit(**)",
    ] {
        assert!(RuleSet::is_broad(rule), "{rule}");
    }
    for rule in [
        "Bash(git log *)",
        "Bash(npm run build)",
        "Edit(/src/**)",
        "mcp__a__b",
    ] {
        assert!(!RuleSet::is_broad(rule), "{rule}");
    }
}

#[test]
fn powershell_segments_respect_quotes() {
    assert_eq!(
        powershell_segments("Get-Item a; Remove-Item b | Out-Null && echo 'x;y' \"p|q\""),
        [
            "Get-Item a",
            "Remove-Item b",
            "Out-Null",
            "echo 'x;y' \"p|q\""
        ]
    );
    assert_eq!(powershell_segments("a`;b"), ["a`;b"]);
}
