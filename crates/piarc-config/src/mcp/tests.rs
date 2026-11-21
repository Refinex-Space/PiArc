use std::collections::BTreeMap;

use serde_json::json;

use super::*;

fn source(scope: McpScope, file: &str, servers: Value) -> SourceEntries {
    SourceEntries {
        scope,
        source: file.to_owned(),
        servers: Some(servers),
        pointer: "/mcpServers".to_owned(),
    }
}

fn lookup(var: &str) -> Option<String> {
    match var {
        "TOKEN" => Some("secret-token".to_owned()),
        "EMPTY" => Some(String::new()),
        "HOME_DIR" => Some("/home/工作 区".to_owned()),
        _ => None,
    }
}

fn options<'a>(trusted: bool) -> MergeOptions<'a> {
    MergeOptions {
        trusted,
        disabled_mcpjson: &[],
        disabled: &[],
        enabled: &[],
        lookup: &lookup,
    }
}

fn names(config: &McpConfig) -> Vec<(&str, McpScope, &str)> {
    config
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s.scope, s.source.as_str()))
        .collect()
}

#[test]
fn the_highest_scope_takes_the_whole_definition_without_merging_fields() {
    // enterprise > local > project > user > plugin; each defines `db` differently.
    let sources = [
        source(
            McpScope::Local,
            "~/.claude.json",
            json!({ "db": { "command": "local-db" }, "only-local": { "command": "l" } }),
        ),
        source(
            McpScope::Project,
            ".piarc/settings.json",
            json!({ "db": { "command": "project-db", "args": ["--project"], "env": { "A": "1" } } }),
        ),
        source(
            McpScope::Project,
            ".mcp.json",
            json!({ "db": { "command": "mcpjson-db" }, "docs": { "type": "http", "url": "https://p.example/mcp" } }),
        ),
        source(
            McpScope::User,
            "settings.json",
            json!({ "docs": { "type": "http", "url": "https://u.example/mcp", "headers": { "X": "1" } } }),
        ),
        source(
            McpScope::Plugin,
            "plugin",
            json!({ "plug": { "command": "p" } }),
        ),
    ];
    let config = merge(&sources, &options(true));
    assert_eq!(
        names(&config),
        vec![
            ("db", McpScope::Local, "~/.claude.json"),
            ("docs", McpScope::Project, ".mcp.json"),
            ("only-local", McpScope::Local, "~/.claude.json"),
            ("plug", McpScope::Plugin, "plugin"),
        ]
    );
    let db = &config.servers[0];
    let stdio = db.stdio.as_ref().expect("stdio");
    // Nothing of the project's definition leaks into the local one.
    assert_eq!(stdio.command, "local-db");
    assert!(stdio.args.is_empty() && stdio.env.is_empty());
    let docs = &config.servers[1];
    assert!(docs.http.as_ref().expect("http").headers.is_empty());
    let overridden: Vec<(&str, &str, &str)> = config
        .overridden
        .iter()
        .map(|o| (o.name.as_str(), o.source.as_str(), o.by.as_str()))
        .collect();
    assert_eq!(
        overridden,
        vec![
            ("db", ".piarc/settings.json", "~/.claude.json"),
            ("db", ".mcp.json", "~/.claude.json"),
            ("docs", "settings.json", ".mcp.json"),
        ]
    );
}

#[test]
fn enterprise_definitions_rank_above_local_ones() {
    let sources = [
        source(
            McpScope::Enterprise,
            "managed",
            json!({ "db": { "command": "managed" } }),
        ),
        source(
            McpScope::Local,
            "~/.claude.json",
            json!({ "db": { "command": "local" } }),
        ),
    ];
    let config = merge(&sources, &options(true));
    assert_eq!(config.servers[0].scope, McpScope::Enterprise);
    assert_eq!(
        config.servers[0].stdio.as_ref().expect("stdio").command,
        "managed"
    );
}

#[test]
fn sse_and_websocket_servers_are_listed_as_unsupported_with_the_reason() {
    let sources = [source(
        McpScope::Project,
        ".mcp.json",
        json!({
            "old": { "type": "sse", "url": "https://x.example/sse" },
            "socket": { "type": "ws", "url": "wss://x.example/ws" },
            "streamable": { "type": "streamable-http", "url": "https://x.example/mcp" },
        }),
    )];
    let config = merge(&sources, &options(true));
    let by_name: BTreeMap<&str, &McpServerDefinition> = config
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s))
        .collect();
    let old = by_name["old"];
    assert_eq!(
        (old.transport, old.availability),
        (McpTransport::Sse, McpAvailability::Unsupported)
    );
    assert!(old.reason.as_deref().expect("reason").contains("SSE"));
    assert!(old.http.is_none() && old.stdio.is_none());
    let socket = by_name["socket"];
    assert_eq!(
        (socket.transport, socket.availability),
        (McpTransport::Ws, McpAvailability::Unsupported)
    );
    assert!(
        socket
            .reason
            .as_deref()
            .expect("reason")
            .contains("WebSocket")
    );
    assert_eq!(by_name["streamable"].transport, McpTransport::Http);
    assert_eq!(by_name["streamable"].availability, McpAvailability::Ready);
}

#[test]
fn variables_expand_in_program_endpoint_and_headers() {
    let sources = [source(
        McpScope::User,
        "settings.json",
        json!({
            "files": {
                "command": "${HOME_DIR}/bin/server",
                "args": ["--token=${TOKEN}", "${MISSING:-fallback}", "${EMPTY:-unused}"],
                "env": { "KEY": "${TOKEN}", "LITERAL": "$TOKEN" },
                "cwd": "${MISSING}"
            },
            "remote": {
                "type": "http",
                "url": "https://api.example/${MISSING:-v1}/mcp",
                "headers": { "Authorization": "Bearer ${TOKEN}" }
            }
        }),
    )];
    let config = merge(&sources, &options(true));
    let files = config.servers[0].stdio.as_ref().expect("stdio");
    assert_eq!(files.command, "/home/工作 区/bin/server");
    assert_eq!(files.args, ["--token=secret-token", "fallback", ""]);
    assert_eq!(files.env["KEY"], "secret-token");
    assert_eq!(files.env["LITERAL"], "$TOKEN");
    // Unset without a default: stays as written, and the issue says so.
    assert_eq!(files.cwd.as_deref(), Some("${MISSING}"));
    assert!(
        config
            .issues
            .iter()
            .any(|i| i.pointer == "/mcpServers/files" && i.message.contains("${MISSING}"))
    );
    let remote = config.servers[1].http.as_ref().expect("http");
    assert_eq!(remote.url, "https://api.example/v1/mcp");
    assert_eq!(remote.headers["Authorization"], "Bearer secret-token");
}

#[test]
fn expansion_leaves_malformed_references_alone() {
    let (text, missing) = expand_vars("a ${ b} ${1X} ${unterminated", &lookup);
    assert_eq!(text, "a ${ b} ${1X} ${unterminated");
    assert!(missing.is_empty());
}

#[test]
fn an_untrusted_projects_servers_are_listed_without_their_program() {
    let sources = [
        source(
            McpScope::Project,
            ".mcp.json",
            json!({ "db": { "command": "db-server", "env": { "TOKEN": "${TOKEN}" } } }),
        ),
        source(
            McpScope::User,
            "settings.json",
            json!({ "mine": { "command": "m" } }),
        ),
    ];
    let config = merge(&sources, &options(false));
    let db = &config.servers[0];
    assert_eq!(db.availability, McpAvailability::Untrusted);
    assert!(
        db.stdio.is_none(),
        "no program (or expanded secret) before trust"
    );
    assert_eq!(config.servers[1].availability, McpAvailability::Ready);
}

#[test]
fn disabled_servers_keep_their_name_and_reason_only() {
    let sources = [
        source(
            McpScope::Project,
            ".mcp.json",
            json!({
                "a": { "command": "a" },
                "b": { "command": "b", "enabled": false },
                "c": { "command": "c" },
                "d": { "command": "d", "enabled": false },
            }),
        ),
        source(
            McpScope::User,
            "settings.json",
            json!({ "e": { "command": "e" } }),
        ),
    ];
    let disabled_mcpjson = ["a".to_owned(), "e".to_owned()];
    let disabled = ["c".to_owned()];
    let enabled = ["d".to_owned()];
    let config = merge(
        &sources,
        &MergeOptions {
            trusted: true,
            disabled_mcpjson: &disabled_mcpjson,
            disabled: &disabled,
            enabled: &enabled,
            lookup: &lookup,
        },
    );
    let state: Vec<(&str, McpAvailability, bool)> = config
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s.availability, s.stdio.is_some()))
        .collect();
    assert_eq!(
        state,
        vec![
            ("a", McpAvailability::Disabled, false),
            ("b", McpAvailability::Disabled, false),
            ("c", McpAvailability::Disabled, false),
            // The user turned it on in the settings window.
            ("d", McpAvailability::Ready, true),
            // disabledMcpjsonServers only concerns `.mcp.json`.
            ("e", McpAvailability::Ready, true),
        ]
    );
}

#[test]
fn invalid_entries_are_left_out_with_their_pointer() {
    let sources = [source(
        McpScope::Project,
        ".mcp.json",
        json!({
            "bad name": { "command": "x" },
            "no-command": { "args": ["a"] },
            "not-object": "x",
            "wrong-type": { "type": "grpc", "url": "https://x" },
            "bad-url": { "type": "http", "url": "ftp://x" },
            "bad-args": { "command": "x", "args": "one" },
            "slow": { "command": "x", "timeout": 30 },
            "helper": { "type": "http", "url": "https://x/mcp", "headersHelper": "./h.sh" },
        }),
    )];
    let config = merge(&sources, &options(true));
    let kept: Vec<&str> = config.servers.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(kept, ["helper", "slow"]);
    assert_eq!(config.servers[1].timeout_ms, None);
    let pointers: Vec<&str> = config.issues.iter().map(|i| i.pointer.as_str()).collect();
    for name in [
        "bad name",
        "no-command",
        "not-object",
        "wrong-type",
        "bad-url",
        "bad-args",
        "slow",
        "helper",
    ] {
        assert!(
            pointers.contains(&format!("/mcpServers/{name}").as_str()),
            "{name} has an issue: {pointers:?}"
        );
    }
}

#[test]
fn trust_item_names_change_with_the_program_but_not_with_the_description() {
    let a = trust_item_name("db", &json!({ "command": "srv", "args": ["-x"] }));
    assert_eq!(a, r#"db: srv args=["-x"]"#);
    let described = trust_item_name(
        "db",
        &json!({ "command": "srv", "args": ["-x"], "description": "d", "enabled": false }),
    );
    assert_eq!(a, described);
    assert_ne!(
        a,
        trust_item_name("db", &json!({ "command": "srv", "args": ["-y"] }))
    );
    assert_ne!(
        a,
        trust_item_name(
            "db",
            &json!({ "command": "srv", "args": ["-x"], "env": { "NODE_OPTIONS": "--require x" } })
        )
    );
    assert_eq!(
        trust_item_name("docs", &json!({ "type": "http", "url": "https://x/mcp" })),
        r#"docs: https://x/mcp type="http""#
    );
}

#[test]
fn pool_settings_have_defaults() {
    assert_eq!(pool_settings(&json!({})), (600, 30));
    assert_eq!(
        pool_settings(&json!({ "mcp": { "idleTimeoutSeconds": 5, "deferThreshold": 2 } })),
        (5, 2)
    );
    assert_eq!(
        pool_settings(&json!({ "mcp": { "idleTimeoutSeconds": 0 } })),
        (600, 30)
    );
}

#[test]
fn the_claude_state_file_gives_user_and_local_servers() {
    let home = std::env::temp_dir().join(format!("piarc mcp state 中文 {}", std::process::id()));
    let workspace = home.join("项目 ws");
    std::fs::create_dir_all(&workspace).expect("dirs");
    let key = workspace.to_string_lossy().into_owned();
    let mut projects = Map::new();
    projects.insert(
        key.clone(),
        json!({ "mcpServers": { "l": { "command": "local" } }, "history": [1, 2] }),
    );
    projects.insert(
        "/elsewhere".to_owned(),
        json!({ "mcpServers": { "x": { "command": "x" } } }),
    );
    std::fs::write(
        home.join(".claude.json"),
        json!({
            "numStartups": 3,
            "mcpServers": { "u": { "command": "user" } },
            "projects": projects,
        })
        .to_string(),
    )
    .expect("state file");
    let state = claude_state_servers(&home, &workspace).expect("read");
    assert_eq!(state.user, Some(json!({ "u": { "command": "user" } })));
    let (found, local) = state.local.expect("local");
    assert_eq!(found, key);
    assert_eq!(local, json!({ "l": { "command": "local" } }));
    std::fs::write(home.join(".claude.json"), "{").expect("broken");
    assert!(claude_state_servers(&home, &workspace).is_err());
    std::fs::remove_dir_all(&home).expect("cleanup");
    assert!(
        claude_state_servers(&home, &workspace)
            .expect("missing")
            .user
            .is_none()
    );
}
