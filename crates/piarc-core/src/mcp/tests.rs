//! T36-A04 (configuration part) and A05 on Core's side: what `mcp/servers` answers for a real
//! data directory, trust store and settings files.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use piarc_protocol::mcp::{McpAvailability, McpScope, McpServerDefinition, McpTransport};
use serde_json::json;

use super::*;
use crate::DataDirs;
use crate::tool_io::{CommandEnv, ToolIoConfig};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    home: PathBuf,
    storage: Storage,
    trust: TrustService,
    source: McpConfigSource,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "piarc mcp config 中文 {}",
            crate::sessions::new_session_id().expect("unique id")
        ));
        let workspace = root.join("工作 区");
        let home = root.join("home 家");
        let data = root.join("data");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(home.join(".claude")).expect("home");
        let dirs = DataDirs::new(data.clone(), root.join("cache"))
            .expect("directories")
            .with_home(Some(home.clone()));
        dirs.create_layout().expect("layout");
        let storage = Storage::open(dirs).expect("database");
        let trust = TrustService::new(storage.clone());
        let env: Vec<(OsString, OsString)> = [
            ("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
            ("HOME", "/Users/test"),
            ("GITHUB_TOKEN", "ghp-test-value"),
            ("PIARC_INTERNAL_THING", "x"),
        ]
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let io = ToolIo::new(ToolIoConfig {
            command_env: CommandEnv::Fixed(env),
            ..ToolIoConfig::new(data)
        });
        let source = McpConfigSource::new(trust.clone(), storage.clone(), io);
        Self {
            root,
            workspace,
            home,
            storage,
            trust,
            source,
        }
    }

    fn write(&self, path: &Path, value: &serde_json::Value) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, value.to_string()).expect("write");
    }

    async fn trust_now(&self) {
        let view = self.trust.view(&self.workspace).await.expect("view");
        self.trust
            .decide(&self.workspace, true, &view.version)
            .await
            .expect("trust");
    }

    async fn servers(&self) -> McpServersResult {
        self.source.servers(&self.workspace).await.expect("servers")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.storage.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn by_name<'a>(result: &'a McpServersResult, name: &str) -> &'a McpServerDefinition {
    result
        .servers
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("{name} is listed: {:?}", result.servers))
}

fn configure(f: &Fixture) {
    f.write(
        &f.workspace.join(".mcp.json"),
        &json!({ "mcpServers": {
            "repo": { "command": "npx", "args": ["-y", "repo-mcp"], "env": { "TOKEN": "${GITHUB_TOKEN}" } },
            "legacy": { "type": "sse", "url": "https://legacy.example/sse" }
        } }),
    );
    let mut projects = serde_json::Map::new();
    projects.insert(
        f.workspace.to_string_lossy().into_owned(),
        json!({ "mcpServers": { "repo": { "command": "my-own-repo-mcp" } } }),
    );
    f.write(
        &f.home.join(".claude.json"),
        &json!({
            "mcpServers": { "docs": { "type": "http", "url": "https://docs.example/mcp" } },
            "projects": projects,
        }),
    );
    f.write(
        &f.root.join("data").join("settings.json"),
        &json!({
            "mcpServers": { "notes": { "command": "notes-mcp" } },
            "mcp": { "idleTimeoutSeconds": 5, "deferThreshold": 2 }
        }),
    );
}

#[tokio::test]
async fn an_untrusted_projects_servers_wait_and_user_servers_are_ready() {
    let f = Fixture::new();
    f.write(
        &f.workspace.join(".mcp.json"),
        &json!({ "mcpServers": { "repo": { "command": "repo-mcp", "env": { "TOKEN": "${GITHUB_TOKEN}" } } } }),
    );
    f.write(
        &f.root.join("data").join("settings.json"),
        &json!({ "mcpServers": { "notes": { "command": "notes-mcp" } } }),
    );
    let result = f.servers().await;
    let repo = by_name(&result, "repo");
    assert_eq!(repo.availability, McpAvailability::Untrusted);
    assert!(repo.stdio.is_none(), "no program or token before trust");
    assert_eq!(
        by_name(&result, "notes").availability,
        McpAvailability::Ready
    );
    // Stdio servers start from the command environment, without PiArc's variables.
    assert_eq!(
        result.env.get("PATH").map(String::as_str),
        Some("/opt/homebrew/bin:/usr/bin:/bin")
    );
    assert!(!result.env.contains_key("PIARC_INTERNAL_THING"));
    assert!(
        !result.env.contains_key("GITHUB_TOKEN"),
        "ADR-0035: credentials are not inherited"
    );
    assert_eq!(
        (result.idle_timeout_ms, result.defer_threshold),
        (600_000, 30)
    );

    f.trust_now().await;
    let trusted = f.servers().await;
    let repo = by_name(&trusted, "repo");
    assert_eq!(repo.availability, McpAvailability::Ready);
    // `${VAR}` expands from the user's environment, for this definition only.
    assert_eq!(
        repo.stdio.as_ref().expect("program").env["TOKEN"],
        "ghp-test-value"
    );

    // A server added after the decision is a new item: the project waits for confirmation.
    f.write(
        &f.workspace.join(".mcp.json"),
        &json!({ "mcpServers": {
            "repo": { "command": "repo-mcp", "env": { "TOKEN": "${GITHUB_TOKEN}" } },
            "added": { "command": "added-mcp" }
        } }),
    );
    let pending = f.servers().await;
    assert_eq!(
        by_name(&pending, "repo").availability,
        McpAvailability::Untrusted
    );
    assert_eq!(
        by_name(&pending, "added").availability,
        McpAvailability::Untrusted
    );
    assert_eq!(
        by_name(&pending, "notes").availability,
        McpAvailability::Ready
    );
    f.trust_now().await;
    assert_eq!(
        by_name(&f.servers().await, "added").availability,
        McpAvailability::Ready
    );
}

#[tokio::test]
async fn every_source_is_read_and_the_highest_scope_wins() {
    let f = Fixture::new();
    configure(&f);
    f.trust_now().await;
    let result = f.servers().await;
    let names: Vec<(&str, McpScope)> = result
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s.scope))
        .collect();
    assert_eq!(
        names,
        [
            ("docs", McpScope::User),
            ("legacy", McpScope::Project),
            ("notes", McpScope::User),
            ("repo", McpScope::Local),
        ]
    );
    // Local (`~/.claude.json` for this workspace) beats the project's `.mcp.json`, whole.
    let repo = by_name(&result, "repo").stdio.as_ref().expect("program");
    assert_eq!(
        (repo.command.as_str(), repo.args.len(), repo.env.len()),
        ("my-own-repo-mcp", 0, 0)
    );
    assert_eq!(result.overridden.len(), 1);
    assert!(result.overridden[0].source.ends_with(".mcp.json"));
    let legacy = by_name(&result, "legacy");
    assert_eq!(
        (legacy.transport, legacy.availability),
        (McpTransport::Sse, McpAvailability::Unsupported)
    );
    assert_eq!((result.idle_timeout_ms, result.defer_threshold), (5_000, 2));
}

#[tokio::test]
async fn the_users_choices_and_disabled_mcpjson_servers_turn_servers_off() {
    let f = Fixture::new();
    f.write(
        &f.workspace.join(".mcp.json"),
        &json!({ "mcpServers": {
            "a": { "command": "a" },
            "b": { "command": "b", "enabled": false },
            "c": { "command": "c" }
        } }),
    );
    f.write(
        &f.workspace.join(".claude").join("settings.json"),
        &json!({ "disabledMcpjsonServers": ["c"] }),
    );
    f.trust_now().await;
    f.source
        .set_enabled(&f.workspace, "a", false)
        .await
        .expect("off");
    f.source
        .set_enabled(&f.workspace, "b", true)
        .await
        .expect("on");
    let result = f.servers().await;
    let state: Vec<(&str, McpAvailability)> = result
        .servers
        .iter()
        .map(|s| (s.name.as_str(), s.availability))
        .collect();
    assert_eq!(
        state,
        [
            ("a", McpAvailability::Disabled),
            ("b", McpAvailability::Ready),
            ("c", McpAvailability::Disabled),
        ]
    );
    assert!(
        f.source
            .set_enabled(&f.workspace, "bad name", true)
            .await
            .is_err()
    );
    let status = status_from_config(&result);
    assert_eq!(
        status.servers[0].state,
        piarc_protocol::mcp::McpConnectionState::Disabled
    );
    assert_eq!(
        status.servers[1].state,
        piarc_protocol::mcp::McpConnectionState::Idle
    );
}

#[tokio::test]
async fn inline_subagent_servers_wait_for_the_projects_trust() {
    let f = Fixture::new();
    let inline = json!({ "scratch": { "command": "scratch-mcp", "args": ["${GITHUB_TOKEN}"] } });
    let inline = inline.as_object().expect("object");
    let waiting = f
        .source
        .inline("/w/.claude/agents/db.md", inline, false)
        .await;
    assert_eq!(waiting[0].scope, McpScope::Subagent);
    assert_eq!(waiting[0].availability, McpAvailability::Untrusted);
    assert!(waiting[0].stdio.is_none());
    let ready = f
        .source
        .inline("/w/.claude/agents/db.md", inline, true)
        .await;
    assert_eq!(ready[0].availability, McpAvailability::Ready);
    assert_eq!(
        ready[0].stdio.as_ref().expect("program").args,
        ["ghp-test-value"]
    );
}

#[tokio::test]
async fn the_diagnostics_list_unsupported_servers_without_expanding_variables() {
    let f = Fixture::new();
    configure(&f);
    let report = crate::config_diagnostics::report(&f.storage, &f.trust, Some(f.workspace.clone()))
        .await
        .expect("report");
    let unsupported = report["mcp"]["unsupported"]
        .as_array()
        .expect("unsupported");
    assert_eq!(unsupported.len(), 1, "{report}");
    assert_eq!(unsupported[0]["name"], "legacy");
    assert_eq!(unsupported[0]["transport"], "sse");
    assert!(
        unsupported[0]["source"]
            .as_str()
            .is_some_and(|s| s.ends_with(".mcp.json")),
        "{report}"
    );
    assert!(
        unsupported[0]["reason"]
            .as_str()
            .is_some_and(|r| !r.is_empty())
    );
    assert!(
        !report.to_string().contains("ghp-test-value"),
        "no value of the environment reaches the report"
    );
}
