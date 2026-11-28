//! MCP servers on Core's side (architecture section 6.8, T36, ADR-0053): the configuration a
//! workspace's Agent Host connects (`mcp/servers`), the user's on/off choices per workspace,
//! and the state the settings window shows when no Agent Host runs. The pool itself lives in
//! the Agent Host (`agent-host/src/mcp/`).
//!
//! The merge is `piarc_config::mcp::merge`; this module gathers its inputs: the settings
//! layers loaded with the project's trust (the same load permission decisions use),
//! `.mcp.json`, `~/.claude.json` from the injected home directory, the choices in
//! `core.sqlite`, and the environment `${VAR}` expands from (the user's login shell without
//! PiArc's internal variables, read for expansion only). Stdio servers start from the
//! command environment (ADR-0035); definitions add their own `env`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use piarc_config::mcp::policy::McpPolicy;
use piarc_config::mcp::{self as config, MergeOptions, SourceEntries};
use piarc_config::{TrustState, ids};
use piarc_protocol::mcp::{
    McpAvailability, McpConnectionState, McpScope, McpServerDefinition, McpServerStatus,
    McpServersResult, McpStatus,
};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::managed::ManagedMcp;
use crate::storage::Storage;
use crate::tool_io::ToolIo;
use crate::trust::TrustService;

/// The route of MCP state changes (`core/mcp`): `{ workspace, servers, overridden, issues }`.
pub const MCP_ROUTE: &str = "core/mcp";

/// Reads a workspace's MCP configuration.
#[derive(Clone)]
pub struct McpConfigSource {
    trust: TrustService,
    storage: Storage,
    tool_io: ToolIo,
}

impl McpConfigSource {
    /// Over Core's trust, storage and command environment.
    #[must_use]
    pub fn new(trust: TrustService, storage: Storage, tool_io: ToolIo) -> Self {
        Self {
            trust,
            storage,
            tool_io,
        }
    }

    /// The `mcp/servers` answer for `workspace`.
    ///
    /// # Errors
    ///
    /// The settings, the trust lookup or the database failed.
    pub async fn servers(&self, workspace: &Path) -> Result<McpServersResult> {
        let settings = self.trust.permission_settings(workspace).await?;
        let canonical = piarc_git::canonical(workspace)?;
        let key = canonical.to_string_lossy().into_owned();
        let choices = self
            .storage
            .run({
                let key = key.clone();
                move |store| store.mcp_choices(&key)
            })
            .await??;
        let expansion = self.tool_io.expansion_environment().await;
        let base = self.tool_io.command_environment().await;
        let home = self.storage.dirs().home().map(Path::to_owned);
        let managed = self.storage.dirs().managed().snapshot();
        let merged = tokio::task::spawn_blocking(move || {
            merge_for(
                &settings,
                &canonical,
                home.as_deref(),
                managed.mcp.as_ref(),
                &choices,
                &expansion,
            )
        })
        .await
        .map_err(|error| Error::Internal {
            reason: format!("an MCP configuration task failed: {error}"),
        })?;
        let (config, idle, threshold) = merged;
        Ok(McpServersResult {
            servers: config.servers,
            env: utf8_env(&base),
            idle_timeout_ms: idle.saturating_mul(1000),
            defer_threshold: threshold,
            overridden: config.overridden,
            issues: config.issues,
        })
    }

    /// The inline `mcpServers` of a subagent definition, checked and expanded (scope
    /// `subagent`); a project definition's servers wait for the project's trust.
    pub async fn inline(
        &self,
        source: &str,
        inline: &serde_json::Map<String, Value>,
        trusted: bool,
    ) -> Vec<McpServerDefinition> {
        if inline.is_empty() {
            return Vec::new();
        }
        let expansion = self.tool_io.expansion_environment().await;
        inline_servers(source, inline, trusted, &expansion, None)
    }

    /// Stores the user's choice for server `name` of `workspace`.
    ///
    /// # Errors
    ///
    /// The path or the database failed.
    pub async fn set_enabled(&self, workspace: &Path, name: &str, enabled: bool) -> Result<()> {
        if !config::valid_name(name) {
            return Err(Error::InvalidArgument {
                field: "name",
                reason: "not an MCP server name".into(),
            });
        }
        let key = piarc_git::canonical(workspace)?
            .to_string_lossy()
            .into_owned();
        let name = name.to_owned();
        let now = crate::storage::now_ms();
        self.storage
            .run(move |store| store.set_mcp_enabled(&key, &name, enabled, now))
            .await??;
        Ok(())
    }
}

/// A subagent definition's inline servers (`agents/list`, T36): checked and expanded like
/// other definitions, scope `subagent`; untrusted ones are listed without their program.
#[must_use]
pub(crate) fn inline_servers(
    source: &str,
    inline: &serde_json::Map<String, Value>,
    trusted: bool,
    expansion: &[(OsString, OsString)],
    policy: Option<&McpPolicy>,
) -> Vec<McpServerDefinition> {
    let lookup = lookup_in(expansion);
    let options = MergeOptions {
        trusted,
        disabled_mcpjson: &[],
        disabled: &[],
        enabled: &[],
        lookup: &lookup,
        policy,
    };
    let entries = SourceEntries {
        // Checked like a project's servers, so untrusted ones wait.
        scope: McpScope::Project,
        source: source.to_owned(),
        servers: Some(Value::Object(inline.clone())),
        pointer: "/mcpServers".to_owned(),
    };
    config::merge(&[entries], &options)
        .servers
        .into_iter()
        .map(|mut def| {
            def.scope = McpScope::Subagent;
            def
        })
        .collect()
}

/// `mcp/servers` with only the servers of one PiArc settings file (scope `user`), for the
/// packaged app's Agent Host probe (S6, `host_probe`), which has no database or trust store.
pub(crate) async fn settings_file_servers(io: &ToolIo, file: &Path) -> McpServersResult {
    let mut issues = Vec::new();
    let mut entries = file_source(file, &mut issues);
    entries.scope = McpScope::User;
    let expansion = io.expansion_environment().await;
    let base = io.command_environment().await;
    let lookup = lookup_in(&expansion);
    let mut merged = config::merge(
        &[entries],
        &MergeOptions {
            trusted: true,
            disabled_mcpjson: &[],
            disabled: &[],
            enabled: &[],
            lookup: &lookup,
            policy: None,
        },
    );
    issues.append(&mut merged.issues);
    let (idle, threshold) = config::pool_settings(&Value::Null);
    McpServersResult {
        servers: merged.servers,
        env: utf8_env(&base),
        idle_timeout_ms: idle.saturating_mul(1000),
        defer_threshold: threshold,
        overridden: merged.overridden,
        issues,
    }
}

type Merged = (config::McpConfig, u64, u64);

/// The merged MCP configuration of `workspace` without the user's choices or variable
/// expansion: what the configuration diagnostics report per source (T41).
pub(crate) fn merged_config(
    settings: &piarc_config::Settings,
    workspace: &Path,
    home: Option<&Path>,
    managed: Option<&ManagedMcp>,
) -> config::McpConfig {
    merge_for(settings, workspace, home, managed, &[], &[]).0
}

/// The managed servers (T47, design addendum sections 5.5 and 7), the highest scope: PiArc's
/// managed `mcpServers`, then Claude Code's `managed-mcp.json`.
fn enterprise_sources(
    settings: &piarc_config::Settings,
    managed: Option<&ManagedMcp>,
    sources: &mut Vec<SourceEntries>,
    issues: &mut Vec<piarc_protocol::mcp::McpConfigIssue>,
) {
    sources.push(layer_source(
        settings,
        ids::ENTERPRISE,
        McpScope::Enterprise,
    ));
    if let Some(mcp) = managed {
        let source = mcp.location.display().to_string();
        if let Some(problem) = &mcp.problem {
            issues.push(piarc_protocol::mcp::McpConfigIssue {
                source: source.clone(),
                pointer: String::new(),
                message: problem.clone(),
            });
        }
        sources.push(SourceEntries {
            scope: McpScope::Enterprise,
            source,
            servers: mcp.servers.clone(),
            pointer: "/mcpServers".to_owned(),
        });
    }
}

fn merge_for(
    settings: &piarc_config::Settings,
    workspace: &Path,
    home: Option<&Path>,
    managed: Option<&ManagedMcp>,
    choices: &[(String, bool)],
    expansion: &[(OsString, OsString)],
) -> Merged {
    let trusted = settings.trust() == TrustState::Trusted;
    let mut issues = Vec::new();
    let mut sources = Vec::new();
    enterprise_sources(settings, managed, &mut sources, &mut issues);
    let state = home.map(|home| {
        let file = home.join(piarc_config::claude::CLAUDE_STATE_FILE);
        let read = config::claude_state_servers(home, workspace).unwrap_or_else(|message| {
            issues.push(piarc_protocol::mcp::McpConfigIssue {
                source: file.display().to_string(),
                pointer: String::new(),
                message,
            });
            config::ClaudeStateServers::default()
        });
        (file.display().to_string(), read)
    });
    if let Some((file, state)) = &state
        && let Some((key, servers)) = &state.local
    {
        sources.push(SourceEntries {
            scope: McpScope::Local,
            source: file.clone(),
            servers: Some(servers.clone()),
            pointer: config::local_pointer(key),
        });
    }
    for id in [ids::PROJECT_LOCAL, ids::PROJECT] {
        sources.push(layer_source(settings, id, McpScope::Project));
    }
    let mcp_json = workspace.join(config::MCP_JSON);
    sources.push(file_source(&mcp_json, &mut issues));
    sources.push(layer_source(settings, ids::USER, McpScope::User));
    if let Some((file, state)) = &state {
        sources.push(SourceEntries {
            scope: McpScope::User,
            source: file.clone(),
            servers: state.user.clone(),
            pointer: "/mcpServers".to_owned(),
        });
    }
    let plugin_of = plugin_sources(settings, &mut sources);
    let disabled_mcpjson: Vec<String> = settings
        .get("/disabledMcpjsonServers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let (on, off): (Vec<_>, Vec<_>) = choices.iter().partition(|(_, enabled)| *enabled);
    let enabled: Vec<String> = on.into_iter().map(|(n, _)| n.clone()).collect();
    let disabled: Vec<String> = off.into_iter().map(|(n, _)| n.clone()).collect();
    let lookup = lookup_in(expansion);
    let policy = McpPolicy::from_settings(settings, managed.is_some(), &lookup);
    let mut merged = config::merge(
        &sources,
        &MergeOptions {
            trusted,
            disabled_mcpjson: &disabled_mcpjson,
            disabled: &disabled,
            enabled: &enabled,
            lookup: &lookup,
            policy: Some(&policy),
        },
    );
    issues.append(&mut merged.issues);
    merged.issues = issues;
    for server in &mut merged.servers {
        if server.scope == McpScope::Plugin {
            server.plugin = plugin_of.get(&server.name).cloned();
        }
    }
    let (idle, threshold) = config::pool_settings(settings.merged());
    (merged, idle, threshold)
}

/// The confirmed servers of the extension packages in effect (T40): the lowest scope. Returns
/// each server's package.
fn plugin_sources(
    settings: &piarc_config::Settings,
    sources: &mut Vec<SourceEntries>,
) -> BTreeMap<String, String> {
    let mut plugin_of = BTreeMap::new();
    for package in &settings.packages().active {
        let servers = package.mcp_servers();
        if servers.is_empty() {
            continue;
        }
        for name in servers.keys() {
            plugin_of.insert(name.clone(), package.id().to_owned());
        }
        sources.push(SourceEntries {
            scope: McpScope::Plugin,
            source: package
                .manifest
                .root
                .join(config::MCP_JSON)
                .display()
                .to_string(),
            servers: Some(Value::Object(servers)),
            pointer: "/mcpServers".to_owned(),
        });
    }
    plugin_of
}

fn layer_source(settings: &piarc_config::Settings, id: &str, scope: McpScope) -> SourceEntries {
    let file = settings
        .table()
        .get(id)
        .and_then(|spec| spec.file().map(Path::to_owned))
        .unwrap_or_else(|| PathBuf::from(id));
    SourceEntries {
        scope,
        source: file.display().to_string(),
        // As loaded: an untrusted project's servers are listed (without their program).
        servers: settings
            .loaded(id)
            .and_then(|value| value.get(config::SETTINGS_KEY))
            .cloned(),
        pointer: format!("/{}", config::SETTINGS_KEY),
    }
}

fn file_source(
    path: &Path,
    issues: &mut Vec<piarc_protocol::mcp::McpConfigIssue>,
) -> SourceEntries {
    let source = path.display().to_string();
    let servers = match std::fs::read(path) {
        Ok(bytes) => {
            let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            match serde_json::from_slice::<Value>(text) {
                Ok(value) => value.get("mcpServers").cloned(),
                Err(error) => {
                    issues.push(piarc_protocol::mcp::McpConfigIssue {
                        source: source.clone(),
                        pointer: String::new(),
                        message: format!("not valid JSON: {error}"),
                    });
                    None
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            issues.push(piarc_protocol::mcp::McpConfigIssue {
                source: source.clone(),
                pointer: String::new(),
                message: format!("cannot read the file: {error}"),
            });
            None
        }
    };
    SourceEntries {
        scope: McpScope::Project,
        source,
        servers,
        pointer: "/mcpServers".to_owned(),
    }
}

/// `${VAR}` lookup in an environment (Windows names case-insensitively).
pub(crate) fn lookup_in(env: &[(OsString, OsString)]) -> impl Fn(&str) -> Option<String> + '_ {
    move |name: &str| {
        env.iter()
            .find(|(k, _)| {
                let k = k.to_string_lossy();
                if cfg!(windows) {
                    k.eq_ignore_ascii_case(name)
                } else {
                    k == name
                }
            })
            .and_then(|(_, v)| v.to_str().map(str::to_owned))
    }
}

fn utf8_env(env: &[(OsString, OsString)]) -> BTreeMap<String, String> {
    env.iter()
        .filter_map(|(k, v)| Some((k.to_str()?.to_owned(), v.to_str()?.to_owned())))
        .collect()
}

/// The configuration diagnostics' MCP part (T36): servers PiArc cannot use (SSE, WebSocket,
/// with the reason) and the issues of the merge, read without expanding variables.
#[must_use]
pub fn diagnostics(
    settings: &piarc_config::Settings,
    workspace: &Path,
    home: Option<&Path>,
    managed: Option<&ManagedMcp>,
) -> Value {
    let (config, _, _) = merge_for(settings, workspace, home, managed, &[], &[]);
    let unsupported: Vec<Value> = config
        .servers
        .iter()
        .filter(|s| s.availability == McpAvailability::Unsupported)
        .map(|s| {
            serde_json::json!({
                "name": s.name, "scope": s.scope, "source": s.source,
                "transport": s.transport, "reason": s.reason,
            })
        })
        .collect();
    serde_json::json!({ "unsupported": unsupported, "issues": config.issues })
}

/// The state of every configured server when no Agent Host runs: a server that may run is
/// `idle` (the pool connects it when a session needs it).
#[must_use]
pub fn status_from_config(result: &McpServersResult) -> McpStatus {
    McpStatus {
        servers: result
            .servers
            .iter()
            .map(|def| McpServerStatus {
                name: def.name.clone(),
                scope: def.scope,
                source: def.source.clone(),
                transport: def.transport,
                state: match def.availability {
                    McpAvailability::Ready => McpConnectionState::Idle,
                    McpAvailability::Disabled => McpConnectionState::Disabled,
                    McpAvailability::Unsupported => McpConnectionState::Unsupported,
                    McpAvailability::Untrusted => McpConnectionState::Untrusted,
                },
                tools: 0,
                error: def.reason.clone(),
                sessions: 0,
                pid: None,
                oauth: def.http.as_ref().is_some_and(uses_oauth),
            })
            .collect(),
        overridden: result.overridden.clone(),
        issues: result.issues.clone(),
    }
}

/// HTTP servers sign in with OAuth unless they send their own `Authorization` header.
#[must_use]
pub fn uses_oauth(http: &piarc_protocol::mcp::McpHttp) -> bool {
    !http
        .headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization"))
}

mod add;
pub use add::AddScope;

#[cfg(test)]
mod tests;
