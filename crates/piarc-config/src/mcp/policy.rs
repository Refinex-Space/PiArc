//! MCP server policy (T47, design addendum section 5.5): Claude Code's `allowedMcpServers` and
//! `deniedMcpServers`, `allowManagedMcpServersOnly`, and the exclusive server set of Claude
//! Code's `managed-mcp.json`.
//!
//! An entry names a server (`serverName`, exact), a stdio command line (`serverCommand`, the
//! program and its arguments in order) or a URL pattern (`serverUrl`, `*` matches any run of
//! characters). A deny entry always wins. Once any settings file sets the allowlist (an empty
//! list included), a server must match it: a remote server a `serverUrl` entry (a `serverName`
//! entry counts only when the list has no `serverUrl` entry), a stdio server a `serverCommand`
//! entry (likewise). Enterprise servers skip the allowlist; the denylist still applies.

use piarc_protocol::mcp::{McpScope, McpServerDefinition};
use serde_json::Value;

use super::expand_vars;
use crate::settings::Settings;

/// One entry of the lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// `serverName`.
    Name(String),
    /// `serverCommand`.
    Command(Vec<String>),
    /// `serverUrl`.
    Url(String),
}

/// The policy that applies to a workspace's servers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpPolicy {
    /// `allowedMcpServers` (`None`: no file sets it, every server is allowed).
    pub allowed: Option<Vec<Entry>>,
    /// `deniedMcpServers` of every layer.
    pub denied: Vec<Entry>,
    /// Claude Code's `managed-mcp.json` is deployed: only enterprise servers run.
    pub exclusive: bool,
}

impl McpPolicy {
    /// The policy of `settings`: the denylist merges across layers; the allowlist too, unless
    /// managed settings turn `allowManagedMcpServersOnly` on, then only the managed one counts.
    /// `${VAR}` in `serverCommand` and `serverUrl` entries expands with `lookup`.
    #[must_use]
    pub fn from_settings(
        settings: &Settings,
        exclusive: bool,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Self {
        let managed_only = settings.get("/allowManagedMcpServersOnly") == Some(&Value::Bool(true));
        let allowed = if managed_only {
            settings
                .managed()
                .and_then(|m| m.pointer("/allowedMcpServers"))
        } else {
            settings.get("/allowedMcpServers")
        };
        Self {
            allowed: allowed.map(|list| entries(list, lookup)),
            denied: settings
                .get("/deniedMcpServers")
                .map(|list| entries(list, lookup))
                .unwrap_or_default(),
            exclusive,
        }
    }

    /// Why `def` may not run, or `None` when the policy allows it.
    #[must_use]
    pub fn refusal(&self, def: &McpServerDefinition) -> Option<&'static str> {
        if self.denied.iter().any(|entry| matches(entry, def)) {
            return Some("listed in deniedMcpServers");
        }
        if def.scope == McpScope::Enterprise {
            return None;
        }
        if self.exclusive {
            return Some("the organization's managed MCP configuration lists the only servers");
        }
        let allowed = self.allowed.as_ref()?;
        let remote = def.http.is_some();
        let has = |kind: fn(&Entry) -> bool| allowed.iter().any(kind);
        let by_kind = if remote {
            has(|e| matches!(e, Entry::Url(_)))
        } else {
            has(|e| matches!(e, Entry::Command(_)))
        };
        let ok = allowed.iter().any(|entry| match entry {
            Entry::Name(_) => !by_kind && matches(entry, def),
            Entry::Url(_) | Entry::Command(_) => matches(entry, def),
        });
        (!ok).then_some("not in allowedMcpServers")
    }
}

fn entries(list: &Value, lookup: &dyn Fn(&str) -> Option<String>) -> Vec<Entry> {
    let expand = |text: &str| expand_vars(text, lookup).0;
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            if let Some(name) = entry.get("serverName").and_then(Value::as_str) {
                return Some(Entry::Name(name.to_owned()));
            }
            if let Some(url) = entry.get("serverUrl").and_then(Value::as_str) {
                return Some(Entry::Url(expand(url)));
            }
            let command = entry.get("serverCommand")?.as_array()?;
            Some(Entry::Command(
                command
                    .iter()
                    .filter_map(Value::as_str)
                    .map(&expand)
                    .collect(),
            ))
        })
        .collect()
}

fn matches(entry: &Entry, def: &McpServerDefinition) -> bool {
    match entry {
        Entry::Name(name) => *name == def.name,
        Entry::Command(command) => def.stdio.as_ref().is_some_and(|stdio| {
            command.first() == Some(&stdio.command)
                && command.len() == stdio.args.len() + 1
                && command[1..] == stdio.args[..]
        }),
        Entry::Url(pattern) => def
            .http
            .as_ref()
            .is_some_and(|http| url_matches(pattern, &http.url)),
    }
}

/// `scheme://host[:port]/path` split; the host lowercased without a trailing dot.
fn split_url(url: &str) -> Option<(String, String, Option<String>, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        // An IPv6 literal: the port follows the closing bracket.
        let (inside, after) = rest.split_once(']')?;
        (inside, after.strip_prefix(':').map(str::to_owned))
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port.to_owned())),
            None => (authority, None),
        }
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    Some((scheme.to_ascii_lowercase(), host, port, path.to_owned()))
}

/// Whether `url` matches `pattern` (section 5.5): scheme and host compare without case, the
/// path with case; `*` matches any run; a pattern without a path matches any path; a host
/// written out in full matches only the scheme's default port unless the pattern names one.
fn url_matches(pattern: &str, url: &str) -> bool {
    let (Some(p), Some(u)) = (split_url(pattern), split_url(url)) else {
        return false;
    };
    let default_port = |scheme: &str| match scheme {
        "https" => Some("443"),
        "http" => Some("80"),
        _ => None,
    };
    let port_ok = match (&p.2, &u.2) {
        (Some(pattern), port) => {
            let port = port.as_deref().or(default_port(&u.0)).unwrap_or_default();
            glob(pattern, port)
        }
        (None, _) if p.1.contains('*') => true,
        (None, None) => true,
        (None, Some(port)) => default_port(&u.0) == Some(port.as_str()),
    };
    glob(&p.0, &u.0)
        && glob(&p.1, &u.1)
        && port_ok
        && (p.3.is_empty() || p.3 == "/" && u.3.is_empty() || glob(&p.3, &u.3))
}

/// `*` matches any run of characters (possibly empty); everything else matches itself.
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, rest) = (parts[0], &parts[1..]);
    let Some(mut remaining) = text.strip_prefix(first) else {
        return false;
    };
    let (last, middle) = rest.split_last().map_or(("", &[][..]), |(l, m)| (*l, m));
    for part in middle {
        match remaining.find(part) {
            Some(at) => remaining = &remaining[at + part.len()..],
            None => return false,
        }
    }
    remaining.len() >= last.len() && remaining.ends_with(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use piarc_protocol::mcp::{McpAvailability, McpHttp, McpStdio, McpTransport};

    fn server(
        name: &str,
        scope: McpScope,
        stdio: Option<(&str, &[&str])>,
        url: Option<&str>,
    ) -> McpServerDefinition {
        McpServerDefinition {
            name: name.into(),
            scope,
            source: "s".into(),
            plugin: None,
            transport: if url.is_some() {
                McpTransport::Http
            } else {
                McpTransport::Stdio
            },
            availability: McpAvailability::Ready,
            reason: None,
            stdio: stdio.map(|(command, args)| McpStdio {
                command: command.into(),
                args: args.iter().map(|a| (*a).to_owned()).collect(),
                env: Default::default(),
                cwd: None,
            }),
            http: url.map(|url| McpHttp {
                url: url.into(),
                headers: Default::default(),
                oauth: None,
            }),
            timeout_ms: None,
            description: None,
            always_load: false,
        }
    }

    #[test]
    fn urls_match_by_scheme_host_port_and_path() {
        assert!(url_matches(
            "https://mcp.example.com",
            "https://MCP.example.com./v1/x"
        ));
        assert!(url_matches(
            "https://mcp.example.com/*",
            "https://mcp.example.com/v1"
        ));
        assert!(!url_matches(
            "https://mcp.example.com/*",
            "https://mcp.example.com:8443/v1"
        ));
        assert!(url_matches(
            "https://mcp.example.com:*/*",
            "https://mcp.example.com:8443/v1"
        ));
        assert!(url_matches(
            "https://*.example.com",
            "https://a.example.com:9000/x"
        ));
        assert!(url_matches("*://mcp.example.com", "http://mcp.example.com"));
        assert!(!url_matches(
            "https://mcp.example.com/v1",
            "https://mcp.example.com/V1"
        ));
        assert!(!url_matches(
            "https://example.com",
            "https://evil.com/?https://example.com"
        ));
        assert!(url_matches(
            "https://example.com",
            "https://example.com:443/x"
        ));
    }

    #[test]
    fn deny_wins_the_allowlist_checks_by_kind_and_enterprise_servers_skip_it() {
        let stdio = server(
            "files",
            McpScope::User,
            Some(("npx", &["-y", "fs-server"])),
            None,
        );
        let remote = server(
            "docs",
            McpScope::Project,
            None,
            Some("https://docs.example.com/mcp"),
        );
        let managed = server(
            "corp",
            McpScope::Enterprise,
            None,
            Some("https://corp.example.com"),
        );
        let none = McpPolicy::default();
        assert_eq!(none.refusal(&stdio), None);

        let names = McpPolicy {
            allowed: Some(vec![Entry::Name("files".into())]),
            ..McpPolicy::default()
        };
        assert_eq!(names.refusal(&stdio), None);
        assert_eq!(names.refusal(&remote), Some("not in allowedMcpServers"));
        assert_eq!(names.refusal(&managed), None);

        // A URL entry makes names stop counting for remote servers.
        let urls = McpPolicy {
            allowed: Some(vec![
                Entry::Name("docs".into()),
                Entry::Url("https://other.example.com/*".into()),
                Entry::Command(vec!["npx".into(), "-y".into(), "fs-server".into()]),
            ]),
            ..McpPolicy::default()
        };
        assert_eq!(urls.refusal(&remote), Some("not in allowedMcpServers"));
        assert_eq!(urls.refusal(&stdio), None);

        let empty = McpPolicy {
            allowed: Some(Vec::new()),
            ..McpPolicy::default()
        };
        assert!(empty.refusal(&stdio).is_some());
        assert_eq!(empty.refusal(&managed), None);

        let deny = McpPolicy {
            allowed: Some(vec![
                Entry::Name("corp".into()),
                Entry::Name("files".into()),
            ]),
            denied: vec![
                Entry::Url("https://corp.example.com".into()),
                Entry::Name("files".into()),
            ],
            exclusive: false,
        };
        assert_eq!(deny.refusal(&managed), Some("listed in deniedMcpServers"));
        assert_eq!(deny.refusal(&stdio), Some("listed in deniedMcpServers"));

        let exclusive = McpPolicy {
            exclusive: true,
            ..McpPolicy::default()
        };
        assert!(exclusive.refusal(&stdio).is_some());
        assert_eq!(exclusive.refusal(&managed), None);
    }
}
