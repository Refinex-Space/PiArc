use super::*;

#[test]
fn memory_markers_are_read_from_the_text() {
    let text = "intro\n[Memory source: /w/a.md]\nA\n[End of memory source]\n[Memory import not approved: /x/b.md]\n";
    assert_eq!(
        markers(text, "[Memory source: ").collect::<Vec<_>>(),
        ["/w/a.md"]
    );
    assert_eq!(
        markers(text, "[Memory import not approved: ").collect::<Vec<_>>(),
        ["/x/b.md"]
    );
}

#[test]
fn claude_files_and_rules_are_recognised() {
    assert!(is_claude(Path::new("/w/.claude/agents/a.md")));
    assert!(is_claude(Path::new("/w/CLAUDE.local.md")));
    assert!(is_claude(Path::new("/w/.mcp.json")));
    assert!(!is_claude(Path::new("/w/.piarc/agents/a.md")));
    assert!(is_rule(Path::new("/w/.claude/rules/sub/a.md")));
    assert!(!is_rule(Path::new("/w/.claude/CLAUDE.md")));
}

fn package(id: &str, scope: PackageScope, enabled: bool, active: bool) -> serde_json::Value {
    json!({
        "id": id,
        "kind": "claudePlugin",
        "source": { "kind": "directory", "location": "/p" },
        "path": format!("/packages/{id}"),
        "scope": scope,
        "enabled": enabled,
        "active": active,
        "components": { "commands": ["fix"], "skills": [], "agents": [], "hooks": ["PostToolUse"],
            "mcpServers": [], "extensions": [] },
        "unsupported": ["lspServers"],
        "executables": [
            { "kind": "hook", "name": "PostToolUse: lint", "confirmed": true },
            { "kind": "mcpServer", "name": "db", "confirmed": false }
        ],
        "issues": [],
        "installedAt": 0,
        "updatedAt": 0
    })
}

#[test]
fn packages_report_their_state_components_and_unconfirmed_items() {
    let list: PackagesList = serde_json::from_value(json!({
        "packages": [
            package("on", PackageScope::User, true, true),
            package("waits", PackageScope::Project, true, false),
            package("off", PackageScope::User, false, false),
        ]
    }))
    .expect("list");
    let reports = packages(&list, false);
    let status: Vec<FileStatus> = reports.iter().map(|r| r.status).collect();
    assert_eq!(
        status,
        [
            FileStatus::Loaded,
            FileStatus::Untrusted,
            FileStatus::Ignored
        ]
    );
    let on = &reports[0];
    assert_eq!(on.kind, SourceKind::Plugin);
    let applied: Vec<&str> = on.effective.iter().map(|k| k.pointer.as_str()).collect();
    assert_eq!(applied, ["/commands/fix", "/hooks/PostToolUse"]);
    let ignored: Vec<(&str, IgnoreReason)> = on
        .ignored
        .iter()
        .map(|k| (k.pointer.as_str(), k.reason))
        .collect();
    assert_eq!(
        ignored,
        [
            ("/db", IgnoreReason::Unconfirmed),
            ("/lspServers", IgnoreReason::Unsupported)
        ]
    );
    assert!(
        reports[2]
            .ignored
            .iter()
            .any(|k| k.reason == IgnoreReason::Disabled)
    );
}
