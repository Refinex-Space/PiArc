//! T13-A13: the executable items of a fixture workspace by category and source; a new allow
//! rule in `.piarc/settings.json` is the only new item. T36: MCP servers of `.mcp.json`,
//! `.piarc/settings*.json` and subagent definitions name their program; Pi's `.pi/mcp.json`
//! is not read.

use std::path::Path;

use piarc_config::{Category, Item, enumerate, new_items};

fn put(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
    std::fs::write(path, text).expect("write");
}

fn item(category: Category, source: &str, name: &str) -> Item {
    Item {
        category,
        source: source.to_owned(),
        name: name.to_owned(),
    }
}

#[test]
fn lists_every_category_with_its_source_and_detects_new_items() {
    let root = std::env::temp_dir().join(format!("piarc-exec fixture 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    put(
        &root,
        ".piarc/settings.json",
        r#"{ "permissions": { "allow": ["Bash(npm test)"], "deny": ["Bash(rm *)"] },
        "hooks": { "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "npx prettier --write" }] }] } }"#,
    );
    put(
        &root,
        ".piarc/settings.local.json",
        r#"{ "permissions": { "allow": ["Read(./src/**)"] },
        "mcpServers": { "notes": { "type": "http", "url": "https://notes.example/mcp" } } }"#,
    );
    put(
        &root,
        ".claude/settings.json",
        r#"{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "./setup.sh" }] }] },
        "enabledPlugins": { "formatter@market": true, "disabled@market": false } }"#,
    );
    put(
        &root,
        ".claude/settings.local.json",
        r#"{ "permissions": { "allow": ["WebFetch(domain:example.com)"] } }"#,
    );
    put(
        &root,
        ".mcp.json",
        r#"{ "mcpServers": { "db": { "command": "npx", "args": ["db-mcp"] }, "files": { "command": "files-mcp" } } }"#,
    );
    put(
        &root,
        ".claude-plugin/plugin.json",
        r#"{ "name": "repo-plugin", "version": "1.0.0" }"#,
    );
    put(
        &root,
        ".pi/extensions/echo-tool.ts",
        "export default function () {}\n",
    );
    put(
        &root,
        ".pi/extensions/bundle/index.ts",
        "export default function () {}\n",
    );
    put(&root, ".pi/extensions/.hidden.ts", "");
    put(
        &root,
        ".pi/settings.json",
        r#"{ "extensions": ["./tools/extra.ts"], "packages": ["npm:pi-thing"] }"#,
    );
    put(
        &root,
        ".pi/mcp.json",
        r#"{ "mcpServers": { "pi-server": { "command": "srv" } } }"#,
    );

    let inventory = enumerate(&root);
    assert!(
        inventory.unreadable.is_empty(),
        "{:?}",
        inventory.unreadable
    );
    assert_eq!(
        inventory.items,
        [
            item(
                Category::Hook,
                ".claude/settings.json",
                "SessionStart[*] ./setup.sh"
            ),
            item(
                Category::Hook,
                ".piarc/settings.json",
                "PostToolUse[Edit] npx prettier --write"
            ),
            item(
                Category::McpServer,
                ".mcp.json",
                r#"db: npx args=["db-mcp"]"#
            ),
            item(Category::McpServer, ".mcp.json", "files: files-mcp"),
            item(
                Category::McpServer,
                ".piarc/settings.local.json",
                r#"notes: https://notes.example/mcp type="http""#
            ),
            item(
                Category::AllowRule,
                ".claude/settings.local.json",
                "WebFetch(domain:example.com)"
            ),
            item(
                Category::AllowRule,
                ".piarc/settings.json",
                "Bash(npm test)"
            ),
            item(
                Category::AllowRule,
                ".piarc/settings.local.json",
                "Read(./src/**)"
            ),
            item(
                Category::Plugin,
                ".claude-plugin/plugin.json",
                "repo-plugin"
            ),
            item(
                Category::Plugin,
                ".claude/settings.json",
                "formatter@market"
            ),
            item(Category::PiExtension, ".pi/extensions", "bundle"),
            item(Category::PiExtension, ".pi/extensions", "echo-tool.ts"),
            item(
                Category::PiExtension,
                ".pi/settings.json",
                "./tools/extra.ts"
            ),
            item(Category::PiExtension, ".pi/settings.json", "npm:pi-thing"),
        ]
    );

    // The snapshot taken when the user trusted the project, then one new allow rule.
    let snapshot = inventory.items.clone();
    put(
        &root,
        ".piarc/settings.json",
        r#"{ "permissions": { "allow": ["Bash(npm test)", "Bash(curl *)"], "deny": ["Bash(rm *)"] },
        "hooks": { "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "npx prettier --write" }] }] } }"#,
    );
    let later = enumerate(&root);
    assert_eq!(
        new_items(&later.items, &snapshot),
        [item(
            Category::AllowRule,
            ".piarc/settings.json",
            "Bash(curl *)"
        )]
    );
    // Removing items is not something to confirm.
    std::fs::remove_file(root.join(".mcp.json")).expect("remove");
    assert_eq!(new_items(&enumerate(&root).items, &snapshot).len(), 1);
    // A server whose program changes is new (the user trusted `npx db-mcp`, not this).
    put(
        &root,
        ".mcp.json",
        r#"{ "mcpServers": { "db": { "command": "npx", "args": ["evil-mcp"] }, "files": { "command": "files-mcp", "description": "only described" } } }"#,
    );
    assert_eq!(
        new_items(&enumerate(&root).items, &snapshot),
        [
            item(
                Category::McpServer,
                ".mcp.json",
                r#"db: npx args=["evil-mcp"]"#
            ),
            item(Category::AllowRule, ".piarc/settings.json", "Bash(curl *)"),
        ]
    );
    // A subagent definition's inline server is executable project configuration too.
    put(
        &root,
        ".claude/agents/db.md",
        "---\nname: db\ndescription: d\nmcpServers:\n  - scratch: { command: scratch-mcp }\n---\nbody\n",
    );
    assert!(enumerate(&root).items.contains(&item(
        Category::McpServer,
        ".claude/agents/db.md",
        "scratch: scratch-mcp"
    )));

    // A broken file is reported and the rest is still listed.
    put(&root, ".claude/settings.json", "{ not json");
    let broken = enumerate(&root);
    assert_eq!(broken.unreadable.len(), 1);
    assert_eq!(broken.unreadable[0].source, ".claude/settings.json");
    assert!(
        broken
            .items
            .iter()
            .any(|i| i.category == Category::PiExtension)
    );
    std::fs::remove_dir_all(root).expect("cleanup");
}

/// R3: a hook in exec form (`command` plus `args`) that changes its arguments, shell or `if`
/// condition is a new item: trusting `node fmt.js` does not trust `node evil.js`.
#[test]
fn a_hook_whose_arguments_shell_or_condition_change_is_a_new_item() {
    let root = std::env::temp_dir().join(format!("piarc-exec args 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let hook = |handler: &str| {
        format!(
            r#"{{ "hooks": {{ "PreToolUse": [{{ "matcher": "Bash", "hooks": [{handler}] }}] }} }}"#
        )
    };
    put(
        &root,
        ".piarc/settings.json",
        &hook(r#"{ "type": "command", "command": "node", "args": ["fmt.js"] }"#),
    );
    let trusted = enumerate(&root).items;
    for changed in [
        r#"{ "type": "command", "command": "node", "args": ["evil.js"] }"#,
        r#"{ "type": "command", "command": "node", "args": ["fmt.js"], "shell": "powershell" }"#,
        r#"{ "type": "command", "command": "node", "args": ["fmt.js"], "if": "Bash(git *)" }"#,
    ] {
        put(&root, ".piarc/settings.json", &hook(changed));
        let current = enumerate(&root).items;
        assert_eq!(new_items(&current, &trusted).len(), 1, "{changed}");
    }
    put(
        &root,
        ".piarc/settings.json",
        &hook(r#"{ "type": "command", "command": "node", "args": ["fmt.js"] }"#),
    );
    assert!(new_items(&enumerate(&root).items, &trusted).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn subagent_hooks_are_executable_items() {
    let root = std::env::temp_dir().join(format!("piarc-exec agents 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    put(
        &root,
        ".claude/agents/review/reviewer.md",
        "---\nname: reviewer\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\nbody\n",
    );
    put(
        &root,
        ".piarc/agents/plain.md",
        "---\nname: plain\ndescription: d\n---\nbody\n",
    );
    put(&root, ".piarc/agents/broken.md", "no frontmatter");
    let inventory = enumerate(&root);
    assert_eq!(
        inventory.items,
        [item(
            Category::Hook,
            ".claude/agents/review/reviewer.md",
            "PreToolUse[Bash] ./check.sh"
        )]
    );
    let _ = std::fs::remove_dir_all(&root);
}
