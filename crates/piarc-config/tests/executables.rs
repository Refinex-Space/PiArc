//! T13-A13: the executable items of a fixture workspace by category and source; a new allow
//! rule in `.piarc/settings.json` is the only new item.

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
        r#"{ "permissions": { "allow": ["Read(./src/**)"] } }"#,
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
            item(Category::McpServer, ".mcp.json", "db"),
            item(Category::McpServer, ".mcp.json", "files"),
            item(Category::McpServer, ".pi/mcp.json", "pi-server"),
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
