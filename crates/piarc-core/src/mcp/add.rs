//! Adding a server from the settings page (ADR-0101): a stdio command or an HTTP endpoint,
//! written as a new `mcpServers` entry of the user's `settings.json` or the project's
//! `.piarc/settings.local.json`. The main process confirms the definition natively first; Core
//! checks it again, refuses a name any source already uses and, for the project, adds the
//! entry to an existing trust decision (the user just confirmed it) so the project does not
//! ask for trust again.

use std::path::Path;

use piarc_config::mcp as config;
use piarc_protocol::mcp::McpAvailability;
use serde_json::{Map, Value};

use super::{McpConfigSource, lookup_in};
use crate::error::{Error, Result};

/// Where an added server is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddScope {
    /// PiArc's user `settings.json`: every project.
    User,
    /// `.piarc/settings.local.json` of the workspace: this project, not shared.
    ProjectLocal,
}

impl AddScope {
    /// `user` or `projectLocal`.
    ///
    /// # Errors
    ///
    /// `invalidParams` for another value.
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "user" => Ok(Self::User),
            "projectLocal" => Ok(Self::ProjectLocal),
            _ => Err(invalid("scope", "must be user or projectLocal")),
        }
    }
}

/// Longest command, argument, URL or environment value accepted.
const MAX_TEXT: usize = 4096;
/// Most arguments or environment variables accepted.
const MAX_ITEMS: usize = 64;

fn invalid(field: &'static str, reason: &str) -> Error {
    Error::InvalidArgument {
        field,
        reason: reason.to_owned(),
    }
}

fn text_ok(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_TEXT && !value.contains('\0')
}

fn env_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn check_stdio(entry: &Map<String, Value>) -> Result<()> {
    if entry.contains_key("url") {
        return Err(invalid("definition", "a stdio server has no url"));
    }
    match entry.get("command") {
        Some(Value::String(command)) if text_ok(command) => {}
        _ => return Err(invalid("definition", "command must be a non-empty string")),
    }
    if let Some(args) = entry.get("args") {
        let ok = args.as_array().is_some_and(|list| {
            list.len() <= MAX_ITEMS
                && list.iter().all(|a| {
                    a.as_str()
                        .is_some_and(|a| a.len() <= MAX_TEXT && !a.contains('\0'))
                })
        });
        if !ok {
            return Err(invalid("definition", "args must be a list of strings"));
        }
    }
    if let Some(env) = entry.get("env") {
        let ok = env.as_object().is_some_and(|map| {
            map.len() <= MAX_ITEMS
                && map.iter().all(|(k, v)| {
                    env_name_ok(k)
                        && v.as_str()
                            .is_some_and(|v| v.len() <= MAX_TEXT && !v.contains('\0'))
                })
        });
        if !ok {
            return Err(invalid(
                "definition",
                "env must map variable names to strings",
            ));
        }
    }
    Ok(())
}

fn check_http(entry: &Map<String, Value>) -> Result<()> {
    if ["command", "args", "env"]
        .iter()
        .any(|k| entry.contains_key(*k))
    {
        return Err(invalid("definition", "an HTTP server has only a url"));
    }
    let ok = entry.get("url").and_then(Value::as_str).is_some_and(|url| {
        text_ok(url)
            && (url.starts_with("https://") || url.starts_with("http://"))
            && !url.chars().any(char::is_whitespace)
    });
    if ok {
        Ok(())
    } else {
        Err(invalid("definition", "url must be an http(s) address"))
    }
}

/// The definitions the settings page writes: `{type: "stdio", command, args?, env?}` or
/// `{type: "http", url}`, which the merge accepts as a ready server.
fn check(name: &str, raw: &Value) -> Result<()> {
    if !config::valid_name(name) {
        return Err(invalid("name", "not an MCP server name"));
    }
    let Some(entry) = raw.as_object() else {
        return Err(invalid("definition", "must be an object"));
    };
    if let Some(key) = entry
        .keys()
        .find(|k| !["type", "command", "args", "env", "url"].contains(&k.as_str()))
    {
        return Err(invalid("definition", &format!("{key} cannot be set here")));
    }
    match entry.get("type").and_then(Value::as_str) {
        Some("stdio") => check_stdio(entry)?,
        Some("http") => check_http(entry)?,
        _ => return Err(invalid("definition", "type must be stdio or http")),
    }
    // The merge's own reading must take it as a ready server.
    let lookup = lookup_in(&[]);
    let options = config::MergeOptions {
        trusted: true,
        disabled_mcpjson: &[],
        disabled: &[],
        enabled: &[],
        lookup: &lookup,
        policy: None,
    };
    let mut issues = Vec::new();
    let at = config::Location {
        scope: piarc_protocol::mcp::McpScope::User,
        source: "",
        pointer: "",
    };
    match config::definition(name, raw, &at, &options, &mut issues) {
        Some(def) if def.availability == McpAvailability::Ready => Ok(()),
        _ => Err(invalid(
            "definition",
            issues
                .first()
                .map_or("not a usable server definition", |i| i.message.as_str()),
        )),
    }
}

impl McpConfigSource {
    /// Writes server `name` with definition `raw` in `scope` for `workspace`.
    ///
    /// # Errors
    ///
    /// `invalidParams` for a bad name or definition or a name that is taken; a locked
    /// (managed) setting, the settings file, the trust store or the path failed.
    pub async fn add_server(
        &self,
        workspace: &Path,
        scope: AddScope,
        name: &str,
        raw: Value,
    ) -> Result<()> {
        check(name, &raw)?;
        let current = self.servers(workspace).await?;
        if current.servers.iter().any(|s| s.name == name)
            || current.overridden.iter().any(|o| o.name == name)
        {
            return Err(invalid("name", "a server with this name exists"));
        }
        // A valid name has no `/` or `~`: the pointer needs no escaping.
        let pointer = format!("/{}/{name}", config::SETTINGS_KEY);
        let dirs = self.storage.dirs().clone();
        let at = workspace.to_owned();
        let value = raw.clone();
        tokio::task::spawn_blocking(move || match scope {
            AddScope::User => crate::client_settings::write_user_value(
                dirs.data(),
                dirs.managed(),
                &pointer,
                Some(value),
            ),
            AddScope::ProjectLocal => piarc_config::write_value(
                &dirs.layers(&at),
                piarc_config::ids::PROJECT_LOCAL,
                &pointer,
                Some(value),
            )
            .map(drop)
            .map_err(Error::from),
        })
        .await
        .map_err(|e| Error::Internal {
            reason: format!("writing the MCP server failed: {e}"),
        })??;
        if scope == AddScope::ProjectLocal {
            let item = piarc_config::Item {
                category: piarc_config::Category::McpServer,
                source: ".piarc/settings.local.json".to_owned(),
                name: config::trust_item_name(name, &raw),
            };
            self.trust.confirm_items(workspace, vec![item]).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::check;

    #[test]
    fn accepts_the_two_shapes_the_page_writes() {
        check("github", &json!({"type": "stdio", "command": "npx", "args": ["-y", "server"], "env": {"TOKEN": "${GITHUB_TOKEN}"}})).expect("stdio");
        check(
            "linear",
            &json!({"type": "http", "url": "https://mcp.linear.app/mcp"}),
        )
        .expect("http");
    }

    #[test]
    fn refuses_other_fields_shapes_and_names() {
        for (name, raw) in [
            ("bad name", json!({"type": "http", "url": "https://x.test"})),
            ("a__b", json!({"type": "http", "url": "https://x.test"})),
            (
                "h",
                json!({"type": "http", "url": "https://x.test", "headers": {"Authorization": "x"}}),
            ),
            ("h", json!({"type": "http", "url": "file:///etc/passwd"})),
            ("h", json!({"type": "sse", "url": "https://x.test"})),
            ("s", json!({"type": "stdio", "command": "  "})),
            (
                "s",
                json!({"type": "stdio", "command": "x", "url": "https://x.test"}),
            ),
            ("s", json!({"type": "stdio", "command": "x", "args": [1]})),
            (
                "s",
                json!({"type": "stdio", "command": "x", "env": {"1A": "x"}}),
            ),
            ("s", json!({"type": "stdio", "command": "x", "cwd": "/"})),
        ] {
            assert!(check(name, &raw).is_err(), "{name} {raw}");
        }
    }
}
