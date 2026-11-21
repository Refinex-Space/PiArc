//! MCP server configuration (architecture section 6.8, T36): reading the `mcpServers` entries
//! of every source, checking them, expanding `${VAR}`, and taking each name's whole definition
//! from its highest scope.
//!
//! Sources, highest first (ADR-0005 inside a scope: PiArc's file before Claude Code's):
//!
//! | Scope | Source |
//! |---|---|
//! | enterprise | managed configuration (T47, none yet) |
//! | local | `~/.claude.json` → `projects["<workspace>"].mcpServers` |
//! | project | `.piarc/settings.local.json`, `.piarc/settings.json`, `.mcp.json` (need trust) |
//! | user | PiArc's `settings.json`, `~/.claude.json` → `mcpServers` |
//! | plugin | plugins (T40, none yet) |
//!
//! Entries use Claude Code's `.mcp.json` shape: `type` (`stdio`, `http`, `streamable-http`,
//! `sse`, `ws`), `command`/`args`/`env`/`cwd`, `url`/`headers`/`oauth`, `timeout`
//! (milliseconds per tool call), `description`, `enabled`, `alwaysLoad`. `${VAR}` and
//! `${VAR:-default}` expand in `command`, `args`, `env`, `cwd`, `url` and `headers`; a variable
//! without a value and without a default stays as written and is reported. SSE and WebSocket
//! servers are listed as unsupported with the reason; nothing is merged across scopes.

use std::collections::BTreeMap;
use std::path::Path;

use piarc_protocol::mcp::{
    McpAvailability, McpConfigIssue, McpHttp, McpOAuth, McpOverridden, McpScope,
    McpServerDefinition, McpStdio, McpTransport,
};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::schema::push_token;

/// A tool call's limit below this (milliseconds) is ignored, as Claude Code does.
pub const MIN_TIMEOUT_MS: u64 = 1_000;

/// Default of `mcp.idleTimeoutSeconds`: the pool disconnects a server nobody called for this
/// long.
pub const DEFAULT_IDLE_TIMEOUT_SECONDS: u64 = 600;

/// Default of `mcp.deferThreshold`: more MCP tools than this in a session are deferred.
pub const DEFAULT_DEFER_THRESHOLD: u64 = 30;

/// The PiArc settings key of server definitions (user and project settings files).
pub const SETTINGS_KEY: &str = "mcpServers";

/// One source's entries before the merge.
#[derive(Debug, Clone)]
pub struct SourceEntries {
    /// The scope.
    pub scope: McpScope,
    /// The file, as shown to the user.
    pub source: String,
    /// The `mcpServers` object (absent: the source defines none).
    pub servers: Option<Value>,
    /// JSON Pointer of `servers` in the file, for issues.
    pub pointer: String,
}

/// The merged configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpConfig {
    /// Every name's definition from its highest scope, sorted by name.
    pub servers: Vec<McpServerDefinition>,
    /// Lower definitions of names defined higher.
    pub overridden: Vec<McpOverridden>,
    /// Entries left out and values not used.
    pub issues: Vec<McpConfigIssue>,
}

/// What [`merge`] needs besides the sources.
pub struct MergeOptions<'a> {
    /// Whether the project is trusted: project definitions are listed without their program
    /// or endpoint until it is.
    pub trusted: bool,
    /// `.mcp.json` servers turned off by `disabledMcpjsonServers`.
    pub disabled_mcpjson: &'a [String],
    /// Servers the user turned off for this workspace (Core's store).
    pub disabled: &'a [String],
    /// Servers the user turned on although their definition says `enabled: false`.
    pub enabled: &'a [String],
    /// Looks up a variable for `${VAR}`.
    pub lookup: &'a dyn Fn(&str) -> Option<String>,
}

/// The `.mcp.json` file of a workspace.
pub const MCP_JSON: &str = ".mcp.json";

/// Takes every name's definition from the first source that defines it (`sources` highest
/// first) and checks it.
#[must_use]
pub fn merge(sources: &[SourceEntries], options: &MergeOptions<'_>) -> McpConfig {
    let mut config = McpConfig::default();
    let mut taken: BTreeMap<String, (String, McpServerDefinition)> = BTreeMap::new();
    // Tool names spell the server name with `_` for other characters: two names that spell the
    // same would share a tool prefix and each other's rules (R4 M2).
    let mut spelled: BTreeMap<String, String> = BTreeMap::new();
    for entries in sources {
        let Some(servers) = &entries.servers else {
            continue;
        };
        let Some(map) = servers.as_object() else {
            config.issues.push(issue(
                &entries.source,
                &entries.pointer,
                "mcpServers must be an object of server definitions",
            ));
            continue;
        };
        for (name, raw) in map {
            let mut pointer = entries.pointer.clone();
            push_token(&mut pointer, name);
            if let Some((by, _)) = taken.get(name) {
                config.overridden.push(McpOverridden {
                    name: name.clone(),
                    source: entries.source.clone(),
                    by: by.clone(),
                });
                continue;
            }
            let at = Location {
                scope: entries.scope,
                source: &entries.source,
                pointer: &pointer,
            };
            let tool_prefix = name.replace('-', "_");
            if let Some(first) = spelled.get(&tool_prefix) {
                config.issues.push(issue(
                    &entries.source,
                    &pointer,
                    &format!(
                        "server {name:?} would name its tools like server {first:?} (mcp__{tool_prefix}__…); the server is left out"
                    ),
                ));
                continue;
            }
            match definition(name, raw, &at, options, &mut config.issues) {
                Some(def) => {
                    spelled.insert(tool_prefix, name.clone());
                    taken.insert(name.clone(), (entries.source.clone(), def));
                }
                None => continue,
            }
        }
    }
    config.servers = taken.into_values().map(|(_, def)| def).collect();
    config
}

/// Where an entry is.
pub struct Location<'a> {
    /// Its scope.
    pub scope: McpScope,
    /// Its file.
    pub source: &'a str,
    /// Its JSON Pointer in the file.
    pub pointer: &'a str,
}

/// One entry as it applies; `None` (with an issue) when it is not a usable definition.
#[must_use]
pub fn definition(
    name: &str,
    raw: &Value,
    at: &Location<'_>,
    options: &MergeOptions<'_>,
    issues: &mut Vec<McpConfigIssue>,
) -> Option<McpServerDefinition> {
    if !valid_name(name) {
        issues.push(issue(
            at.source,
            at.pointer,
            &format!(
                "server name {name:?} must be 1–64 letters, digits, \"_\" or \"-\" without \"__\" (it separates the server from the tool in tool names); the server is left out"
            ),
        ));
        return None;
    }
    let Some(entry) = raw.as_object() else {
        issues.push(issue(
            at.source,
            at.pointer,
            "a server definition must be an object; the server is left out",
        ));
        return None;
    };
    let mut def = McpServerDefinition {
        name: name.to_owned(),
        scope: at.scope,
        source: at.source.to_owned(),
        transport: McpTransport::Stdio,
        availability: McpAvailability::Ready,
        reason: None,
        stdio: None,
        http: None,
        timeout_ms: None,
        description: text(entry, "description").map(str::to_owned),
        always_load: entry.get("alwaysLoad").and_then(Value::as_bool) == Some(true),
    };
    def.timeout_ms = timeout(entry, at, issues);
    let mut problems = Vec::new();
    let expand = |value: &str, problems: &mut Vec<String>| -> String {
        let (expanded, missing) = expand_vars(value, options.lookup);
        for var in missing {
            problems.push(format!(
                "${{{var}}} has no value and no default; it stays as written"
            ));
        }
        expanded
    };
    if let Err(message) = transport(&mut def, entry, &mut problems, &expand) {
        issues.push(issue(
            at.source,
            at.pointer,
            &format!("{message}; the server is left out"),
        ));
        return None;
    }
    if entry.contains_key("headersHelper") {
        problems.push("headersHelper is not supported; the headers are sent as configured".into());
    }
    for problem in problems {
        issues.push(issue(at.source, at.pointer, &problem));
    }
    apply_availability(&mut def, entry, at, options);
    Some(def)
}

/// Fills the transport and its program or endpoint; an error leaves the entry out.
fn transport(
    def: &mut McpServerDefinition,
    entry: &Map<String, Value>,
    problems: &mut Vec<String>,
    expand: &Expand<'_>,
) -> Result<(), String> {
    match transport_of(entry)? {
        Kind::Unsupported(transport, reason) => {
            def.transport = transport;
            def.availability = McpAvailability::Unsupported;
            def.reason = Some(reason.to_owned());
        }
        Kind::Stdio => def.stdio = Some(stdio(entry, problems, expand)?),
        Kind::Http => {
            def.transport = McpTransport::Http;
            def.http = Some(http(entry, problems, expand)?);
        }
    }
    Ok(())
}

fn apply_availability(
    def: &mut McpServerDefinition,
    entry: &Map<String, Value>,
    at: &Location<'_>,
    options: &MergeOptions<'_>,
) {
    if def.availability == McpAvailability::Unsupported {
        return;
    }
    let off = |reason: &str, def: &mut McpServerDefinition| {
        def.availability = McpAvailability::Disabled;
        def.reason = Some(reason.to_owned());
    };
    let named = |list: &[String]| list.iter().any(|n| n == &def.name);
    if at.scope == McpScope::Project && !options.trusted {
        def.availability = McpAvailability::Untrusted;
        def.reason = Some("the project is not trusted yet".to_owned());
    } else if named(options.disabled) {
        off("turned off for this workspace", def);
    } else if entry.get("enabled").and_then(Value::as_bool) == Some(false)
        && !named(options.enabled)
    {
        off("enabled is false in its definition", def);
    } else if at.source.ends_with(MCP_JSON) && named(options.disabled_mcpjson) {
        off("listed in disabledMcpjsonServers", def);
    }
    if def.availability != McpAvailability::Ready {
        // Only servers that may run carry their program or endpoint (and any expanded secret).
        def.stdio = None;
        def.http = None;
    }
}

enum Kind {
    Stdio,
    Http,
    Unsupported(McpTransport, &'static str),
}

fn transport_of(entry: &Map<String, Value>) -> Result<Kind, String> {
    match entry.get("type") {
        None => Ok(
            if entry.contains_key("url") && !entry.contains_key("command") {
                Kind::Http
            } else {
                Kind::Stdio
            },
        ),
        Some(Value::String(kind)) => match kind.as_str() {
            "stdio" => Ok(Kind::Stdio),
            "http" | "streamable-http" => Ok(Kind::Http),
            "sse" => Ok(Kind::Unsupported(
                McpTransport::Sse,
                "the SSE transport is deprecated and PiArc does not support it; use the server's Streamable HTTP endpoint (type \"http\")",
            )),
            "ws" | "websocket" => Ok(Kind::Unsupported(
                McpTransport::Ws,
                "PiArc does not support the WebSocket transport; use stdio or Streamable HTTP",
            )),
            other => Err(format!(
                "type {other:?} is not one of stdio, http, streamable-http, sse, ws"
            )),
        },
        Some(_) => Err("type must be a string".to_owned()),
    }
}

type Expand<'a> = dyn Fn(&str, &mut Vec<String>) -> String + 'a;

fn stdio(
    entry: &Map<String, Value>,
    problems: &mut Vec<String>,
    expand: &Expand<'_>,
) -> Result<McpStdio, String> {
    let command = match entry.get("command") {
        Some(Value::String(c)) if !c.trim().is_empty() => expand(c, problems),
        Some(_) => return Err("command must be a non-empty string".to_owned()),
        None => return Err("a stdio server needs a command".to_owned()),
    };
    let args = match entry.get("args") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut args = Vec::with_capacity(items.len());
            for item in items {
                let Some(arg) = item.as_str() else {
                    return Err("args must be a list of strings".to_owned());
                };
                args.push(expand(arg, problems));
            }
            args
        }
        Some(_) => return Err("args must be a list of strings".to_owned()),
    };
    let env = strings(entry, "env", problems, expand)?;
    let cwd = match entry.get("cwd") {
        None => None,
        Some(Value::String(dir)) => Some(expand(dir, problems)),
        Some(_) => return Err("cwd must be a string".to_owned()),
    };
    Ok(McpStdio {
        command,
        args,
        env,
        cwd,
    })
}

fn http(
    entry: &Map<String, Value>,
    problems: &mut Vec<String>,
    expand: &Expand<'_>,
) -> Result<McpHttp, String> {
    let url = match entry.get("url") {
        Some(Value::String(url)) => expand(url, problems),
        Some(_) => return Err("url must be a string".to_owned()),
        None => return Err("an HTTP server needs a url".to_owned()),
    };
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("url {url:?} must start with https:// or http://"));
    }
    let headers = strings(entry, "headers", problems, expand)?;
    let oauth = match entry.get("oauth") {
        None => None,
        Some(Value::Object(o)) => Some(McpOAuth {
            client_id: text(o, "clientId").map(str::to_owned),
            callback_port: o.get("callbackPort").and_then(Value::as_u64),
            // Claude Code writes `scopes`, pi-mcp `scope`: both a space-separated string.
            scope: text(o, "scopes")
                .or_else(|| text(o, "scope"))
                .map(str::to_owned),
            auth_server_metadata_url: text(o, "authServerMetadataUrl").map(str::to_owned),
        }),
        Some(_) => return Err("oauth must be an object".to_owned()),
    };
    Ok(McpHttp {
        url,
        headers,
        oauth,
    })
}

fn strings(
    entry: &Map<String, Value>,
    key: &str,
    problems: &mut Vec<String>,
    expand: &Expand<'_>,
) -> Result<BTreeMap<String, String>, String> {
    match entry.get(key) {
        None => Ok(BTreeMap::new()),
        Some(Value::Object(map)) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                let Some(value) = v.as_str() else {
                    return Err(format!("{key} values must be strings"));
                };
                out.insert(k.clone(), expand(value, problems));
            }
            Ok(out)
        }
        Some(_) => Err(format!("{key} must be an object of strings")),
    }
}

fn timeout(
    entry: &Map<String, Value>,
    at: &Location<'_>,
    issues: &mut Vec<McpConfigIssue>,
) -> Option<u64> {
    let value = entry.get("timeout")?;
    match value.as_u64() {
        Some(ms) if ms >= MIN_TIMEOUT_MS => Some(ms),
        _ => {
            issues.push(issue(
                at.source,
                at.pointer,
                "timeout is milliseconds per tool call, at least 1000; it is ignored",
            ));
            None
        }
    }
}

fn text<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
}

/// Server names tool names are built from (`mcp__<server>__<tool>`).
#[must_use]
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        // `mcp__github` rules would cover `github__admin`'s tools (R4 M2).
        && !name.contains("__")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn issue(source: &str, pointer: &str, message: &str) -> McpConfigIssue {
    McpConfigIssue {
        source: source.to_owned(),
        pointer: pointer.to_owned(),
        message: message.to_owned(),
    }
}

/// `${VAR}` and `${VAR:-default}` replaced from `lookup`; returns the text and the variables
/// that had no value and no default (left as written). An empty value counts as set.
#[must_use]
pub fn expand_vars(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut missing = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return (out, missing);
        };
        let inner = &after[..end];
        let (var, default) = match inner.split_once(":-") {
            Some((var, default)) => (var, Some(default)),
            None => (inner, None),
        };
        let is_name = !var.is_empty()
            && var.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !var.as_bytes()[0].is_ascii_digit();
        if is_name {
            match (lookup(var), default) {
                (Some(value), _) => out.push_str(&value),
                (None, Some(default)) => out.push_str(default),
                (None, None) => {
                    missing.push(var.to_owned());
                    out.push_str(&rest[start..start + 3 + end]);
                }
            }
        } else {
            out.push_str(&rest[start..start + 3 + end]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    (out, missing)
}

/// The `mcpServers` of `~/.claude.json`: the user-level object and the workspace's entry
/// under `projects`. Other keys are skipped while parsing (they are Claude Code's own state).
#[derive(Debug, Clone, Default)]
pub struct ClaudeStateServers {
    /// Top-level `mcpServers` (user scope).
    pub user: Option<Value>,
    /// `projects["<workspace>"].mcpServers` (local scope), with the key it was found under.
    pub local: Option<(String, Value)>,
}

/// Reads the MCP servers of `<home>/.claude.json` for `workspace`. A missing file is empty; an
/// unreadable or invalid one is an error message.
///
/// # Errors
///
/// The file cannot be read or is not valid JSON.
pub fn claude_state_servers(home: &Path, workspace: &Path) -> Result<ClaudeStateServers, String> {
    #[derive(Deserialize)]
    struct State {
        #[serde(rename = "mcpServers")]
        mcp_servers: Option<Value>,
        #[serde(default)]
        projects: BTreeMap<String, Project>,
    }
    #[derive(Deserialize)]
    struct Project {
        #[serde(rename = "mcpServers")]
        mcp_servers: Option<Value>,
    }
    let file = home.join(crate::claude::CLAUDE_STATE_FILE);
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClaudeStateServers::default());
        }
        Err(error) => return Err(format!("cannot read the file: {error}")),
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let state: State = serde_json::from_slice(text).map_err(|e| format!("not valid JSON: {e}"))?;
    let local = state
        .projects
        .into_iter()
        .find(|(key, _)| same_dir(Path::new(key), workspace))
        .and_then(|(key, project)| project.mcp_servers.map(|servers| (key, servers)));
    Ok(ClaudeStateServers {
        user: state.mcp_servers,
        local,
    })
}

/// Whether a `projects` key of `~/.claude.json` names the workspace: the same path, or the
/// same directory once both are resolved.
fn same_dir(key: &Path, workspace: &Path) -> bool {
    if key == workspace {
        return true;
    }
    match (std::fs::canonicalize(key), std::fs::canonicalize(workspace)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The JSON Pointer of `projects["<key>"].mcpServers`.
#[must_use]
pub fn local_pointer(key: &str) -> String {
    let mut pointer = "/projects".to_owned();
    push_token(&mut pointer, key);
    push_token(&mut pointer, "mcpServers");
    pointer
}

/// The pool's settings: `mcp.idleTimeoutSeconds` and `mcp.deferThreshold` of the merged
/// settings, with their defaults.
#[must_use]
pub fn pool_settings(merged: &Value) -> (u64, u64) {
    let idle = merged
        .pointer("/mcp/idleTimeoutSeconds")
        .and_then(Value::as_u64)
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_IDLE_TIMEOUT_SECONDS);
    let threshold = merged
        .pointer("/mcp/deferThreshold")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_DEFER_THRESHOLD);
    (idle, threshold)
}

/// What identifies an entry for project trust: a change of the program, its arguments,
/// environment or working directory, or of the endpoint and its headers, is a new
/// executable item (like a hook's arguments, R3). `description`, `enabled`, `timeout` and
/// `alwaysLoad` are not part of it.
#[must_use]
pub fn trust_item_name(name: &str, raw: &Value) -> String {
    let Some(entry) = raw.as_object() else {
        return format!("{name}: {raw}");
    };
    let mut out = match (entry.get("command"), entry.get("url")) {
        (Some(Value::String(command)), _) => format!("{name}: {command}"),
        (_, Some(Value::String(url))) => format!("{name}: {url}"),
        _ => name.to_owned(),
    };
    for key in ["type", "args", "env", "cwd", "headers", "oauth"] {
        if let Some(value) = entry.get(key) {
            out.push_str(&format!(" {key}={value}"));
        }
    }
    out
}

#[cfg(test)]
mod tests;
