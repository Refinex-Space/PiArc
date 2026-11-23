//! The Bash sandbox's settings (T39, architecture section 6.10): which values apply from which
//! layer, and the paths and domains they resolve to.
//!
//! The keys are Claude Code's, with the same meaning (`crate::claude::SETTINGS_KEYS`):
//! `sandbox.enabled`, `sandbox.autoAllowBashIfSandboxed`, `sandbox.filesystem.denyRead` and
//! `sandbox.network.allowedDomains`.
//!
//! A project file may only tighten the sandbox: turning it on and adding `denyRead` paths
//! apply; adding allowed domains, turning on auto-approval and turning the sandbox off do not
//! ([`loosening`] lists them, the merge leaves them out and the diagnostics report them as
//! `projectSandbox`), for the reason project files cannot choose `bypassPermissions`
//! (architecture section 6.2.1): a cloned repository must not widen what its commands reach.
//!
//! The allowed domains are the user's (both user files) and the enterprise's (T47 connects
//! the managed source; until then [`Enterprise`] is filled by tests only), in that order,
//! each entry with its source so the settings page can show the enterprise's as read-only.
//!
//! Paths in `denyRead`: `/…` and `//…` are absolute, `~/…` is in the home directory, others are
//! relative to the project root for a project file and to the file's directory for a user file
//! (`~/.claude/` for Claude Code's, PiArc's data directory for PiArc's).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::layers::Scope;
use crate::settings::Settings;

/// `sandbox.enabled`.
pub const ENABLED: &str = "/sandbox/enabled";
/// `sandbox.autoAllowBashIfSandboxed`.
pub const AUTO_ALLOW: &str = "/sandbox/autoAllowBashIfSandboxed";
/// `sandbox.filesystem.denyRead`.
pub const DENY_READ: &str = "/sandbox/filesystem/denyRead";
/// `sandbox.network.allowedDomains`.
pub const ALLOWED_DOMAINS: &str = "/sandbox/network/allowedDomains";
/// Managed settings only (T47): the proxy allows the managed domains alone.
pub const MANAGED_DOMAINS_ONLY: &str = "/sandbox/network/allowManagedDomainsOnly";

/// Where an allowed domain or a `denyRead` path comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// PiArc's user settings file: the settings page edits these.
    User,
    /// Claude Code's user settings file (read only).
    ClaudeUser,
    /// A project settings file (`denyRead` only).
    Project,
    /// Managed (enterprise) settings: read only.
    Enterprise,
}

impl Origin {
    /// Whether the settings page may change the entry.
    #[must_use]
    pub fn editable(self) -> bool {
        self == Self::User
    }
}

/// One allowed domain or `denyRead` path with its origin.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry<T> {
    /// The value: a domain pattern, or an absolute path.
    pub value: T,
    /// Where it comes from.
    pub origin: Origin,
    /// The layer id (`user`, `claudeUser`, `project`, …; `enterprise`).
    pub layer: &'static str,
}

/// The enterprise's sandbox values (T47 fills this from managed settings; tests until then).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Enterprise {
    /// Domains the enterprise allows for every user.
    pub allowed_domains: Vec<String>,
}

/// What the sandbox settings resolve to for one workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    /// The sandbox is on.
    pub enabled: bool,
    /// Sandboxed Bash commands skip the approval (step 7, architecture section 6.2.3).
    pub auto_allow: bool,
    /// Paths no sandboxed command may read, absolute, without duplicates.
    pub deny_read: Vec<Entry<PathBuf>>,
    /// Domains the proxy lets through: the user's, then the enterprise's; without duplicates.
    pub allowed_domains: Vec<Entry<String>>,
    /// Managed settings' `sandbox.network.allowManagedDomainsOnly` (T47): only the managed
    /// domains (and managed `WebFetch(domain:…)` allow rules) count, and a domain outside them
    /// is refused without a network card.
    pub managed_domains_only: bool,
}

impl Resolved {
    /// The allowed domain patterns.
    #[must_use]
    pub fn domains(&self) -> Vec<String> {
        self.allowed_domains
            .iter()
            .map(|e| e.value.clone())
            .collect()
    }

    /// The `denyRead` paths.
    #[must_use]
    pub fn deny_read_paths(&self) -> Vec<PathBuf> {
        self.deny_read.iter().map(|e| e.value.clone()).collect()
    }
}

/// The values of a project layer that would loosen the sandbox, as JSON Pointers: allowed
/// domains, auto-approval turned on, the sandbox turned off.
#[must_use]
pub fn loosening(value: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    if value.pointer(ALLOWED_DOMAINS).is_some() {
        out.push(ALLOWED_DOMAINS);
    }
    if value.pointer(AUTO_ALLOW) == Some(&Value::Bool(true)) {
        out.push(AUTO_ALLOW);
    }
    if value.pointer(ENABLED) == Some(&Value::Bool(false)) {
        out.push(ENABLED);
    }
    out
}

/// The sandbox settings of `settings` (merged for one workspace) and the enterprise's values;
/// `home` resolves `~/` (no home: such paths are left out).
#[must_use]
pub fn resolve(
    settings: &Settings,
    enterprise: Option<&Enterprise>,
    home: Option<&Path>,
) -> Resolved {
    let flag = |pointer: &str| settings.get(pointer).and_then(Value::as_bool) == Some(true);
    let managed_only = flag(MANAGED_DOMAINS_ONLY);
    let mut resolved = Resolved {
        enabled: flag(ENABLED),
        auto_allow: flag(AUTO_ALLOW),
        managed_domains_only: managed_only,
        ..Resolved::default()
    };
    for spec in settings.table().layers().iter().rev() {
        let Some(value) = settings.layer(spec.id) else {
            continue;
        };
        let origin = match (spec.scope, spec.id) {
            (Scope::User, crate::layers::ids::CLAUDE_USER) => Origin::ClaudeUser,
            (Scope::User, _) => Origin::User,
            (Scope::Project, _) => Origin::Project,
            (Scope::Enterprise, _) => Origin::Enterprise,
            (Scope::Defaults | Scope::Session, _) => continue,
        };
        let base = spec.file().and_then(|file| relative_base(file, spec.scope));
        for text in strings(value, DENY_READ) {
            let Some(path) = resolve_path(text, base.as_deref(), home) else {
                continue;
            };
            if !resolved.deny_read.iter().any(|e| e.value == path) {
                resolved.deny_read.push(Entry {
                    value: path,
                    origin,
                    layer: spec.id,
                });
            }
        }
        if spec.scope == Scope::Enterprise {
            for domain in strings(value, ALLOWED_DOMAINS) {
                push_domain(&mut resolved, domain, origin, spec.id);
            }
            if managed_only {
                for rule in strings(value, "/permissions/allow") {
                    if let Some(domain) = rule
                        .strip_prefix("WebFetch(domain:")
                        .and_then(|r| r.strip_suffix(')'))
                    {
                        push_domain(&mut resolved, domain, origin, spec.id);
                    }
                }
            }
        }
        if spec.scope == Scope::User && !managed_only {
            for domain in strings(value, ALLOWED_DOMAINS) {
                push_domain(&mut resolved, domain, origin, spec.id);
            }
        }
    }
    for domain in enterprise.iter().flat_map(|e| &e.allowed_domains) {
        push_domain(&mut resolved, domain, Origin::Enterprise, "enterprise");
    }
    resolved
}

fn push_domain(resolved: &mut Resolved, domain: &str, origin: Origin, layer: &'static str) {
    let domain = domain.trim();
    if domain.is_empty()
        || resolved
            .allowed_domains
            .iter()
            .any(|e| e.value.eq_ignore_ascii_case(domain))
    {
        return;
    }
    resolved.allowed_domains.push(Entry {
        value: domain.to_owned(),
        origin,
        layer,
    });
}

fn strings<'a>(value: &'a Value, pointer: &str) -> impl Iterator<Item = &'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// What a relative path in a file of `scope` is relative to: the project root for a project
/// file (`<root>/.piarc/settings.json`), the file's directory for a user file.
fn relative_base(file: &Path, scope: Scope) -> Option<PathBuf> {
    let dir = file.parent()?;
    match scope {
        Scope::Project => dir.parent().map(Path::to_path_buf),
        _ => Some(dir.to_path_buf()),
    }
}

/// `text` as an absolute path (see the module docs); `None` when it needs a base or home that
/// is not there, or is empty.
fn resolve_path(text: &str, base: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let trimmed = text
        .strip_suffix('/')
        .filter(|t| !t.is_empty())
        .unwrap_or(text);
    let path = if trimmed == "~" {
        home?.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home?.join(rest)
    } else if let Some(rest) = trimmed.strip_prefix("//") {
        PathBuf::from(format!("/{rest}"))
    } else if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        base?.join(trimmed.strip_prefix("./").unwrap_or(trimmed))
    };
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::LayerTable;
    use crate::trust::TrustState;
    use serde_json::json;

    struct Dirs {
        root: PathBuf,
        data: PathBuf,
        workspace: PathBuf,
        home: PathBuf,
    }

    impl Dirs {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "piarc-config-sandbox {name} {}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let dirs = Self {
                data: root.join("data"),
                workspace: root.join("ws 工作"),
                home: root.join("home"),
                root,
            };
            for dir in [&dirs.data, &dirs.workspace, &dirs.home] {
                std::fs::create_dir_all(dir).expect("dir");
            }
            dirs
        }

        fn write(&self, path: PathBuf, value: &Value) {
            std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            std::fs::write(path, value.to_string()).expect("write");
        }

        fn settings(&self, trust: TrustState) -> Settings {
            Settings::load(
                LayerTable::workspace(&self.data, &self.workspace, Some(&self.home)),
                trust,
            )
        }
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// T39-A06: allowed domains are the user's and the enterprise's; a project's domains and
    /// auto-approval do not apply and the diagnostics say so. (POSIX paths: the sandbox is
    /// macOS only.)
    #[cfg(unix)]
    #[test]
    fn domains_merge_user_and_enterprise_and_projects_only_tighten() {
        let dirs = Dirs::new("merge");
        dirs.write(
            dirs.data.join("settings.json"),
            &json!({ "sandbox": { "enabled": false, "network": { "allowedDomains": ["registry.npmjs.org", "*.github.com"] } } }),
        );
        dirs.write(
            dirs.home.join(".claude/settings.json"),
            &json!({ "sandbox": { "network": { "allowedDomains": ["pypi.org", "REGISTRY.npmjs.org"] } } }),
        );
        dirs.write(
            dirs.workspace.join(".piarc/settings.json"),
            &json!({ "sandbox": { "enabled": true, "autoAllowBashIfSandboxed": true,
                "network": { "allowedDomains": ["evil.test"] },
                "filesystem": { "denyRead": ["secrets", "~/.aws/", "//etc/shadow"] } } }),
        );
        dirs.write(
            dirs.workspace.join(".claude/settings.json"),
            &json!({ "sandbox": { "network": { "allowedDomains": ["evil2.test"] } } }),
        );
        let settings = dirs.settings(TrustState::Trusted);
        let enterprise = Enterprise {
            allowed_domains: vec!["artifacts.corp.example".into(), "pypi.org".into()],
        };
        let resolved = resolve(&settings, Some(&enterprise), Some(&dirs.home));
        assert!(resolved.enabled, "a project may turn the sandbox on");
        assert!(
            !resolved.auto_allow,
            "a project cannot turn on auto-approval"
        );
        let domains: Vec<(&str, Origin)> = resolved
            .allowed_domains
            .iter()
            .map(|e| (e.value.as_str(), e.origin))
            .collect();
        assert_eq!(
            domains,
            [
                ("registry.npmjs.org", Origin::User),
                ("*.github.com", Origin::User),
                ("pypi.org", Origin::ClaudeUser),
                ("artifacts.corp.example", Origin::Enterprise),
            ]
        );
        assert!(
            resolved
                .allowed_domains
                .iter()
                .all(|e| e.origin.editable() == (e.origin == Origin::User))
        );
        assert_eq!(
            resolved.deny_read_paths(),
            [
                dirs.workspace.join("secrets"),
                dirs.home.join(".aws"),
                PathBuf::from("/etc/shadow"),
            ]
        );
        let reports = settings.diagnostics();
        let ignored = |layer: &str| -> Vec<(String, crate::diagnostics::IgnoreReason)> {
            reports
                .iter()
                .find(|r| r.layer == layer)
                .expect("report")
                .ignored
                .iter()
                .map(|k| (k.pointer.clone(), k.reason))
                .collect()
        };
        use crate::diagnostics::IgnoreReason::ProjectSandbox;
        assert_eq!(
            ignored("project"),
            [
                (AUTO_ALLOW.to_owned(), ProjectSandbox),
                (ALLOWED_DOMAINS.to_owned(), ProjectSandbox),
            ]
        );
        assert_eq!(
            ignored("claudeProject"),
            [(ALLOWED_DOMAINS.to_owned(), ProjectSandbox)]
        );
    }

    /// A project cannot turn the user's sandbox off, but may turn auto-approval off.
    /// T47: managed domains come with the user's; under `allowManagedDomainsOnly` only the
    /// managed domains and managed `WebFetch(domain:…)` allow rules count.
    #[test]
    fn managed_domains_and_the_managed_only_lock() {
        let dirs = Dirs::new("managed");
        dirs.write(
            dirs.data.join("settings.json"),
            &json!({ "sandbox": { "network": { "allowedDomains": ["user.example"] } } }),
        );
        let layer = |value: Value| {
            crate::managed::Managed::build(
                vec![crate::managed::RawSource {
                    family: crate::managed::Family::Piarc,
                    channel: crate::managed::Channel::File,
                    location: "managed-settings.json".into(),
                    body: crate::managed::RawBody::Value(value),
                }],
                None,
            )
            .layer()
        };
        let load = |value: Value| {
            let mut table = LayerTable::workspace(&dirs.data, &dirs.workspace, Some(&dirs.home));
            table.insert(layer(value));
            Settings::load(table, TrustState::Trusted)
        };
        let open = resolve(
            &load(json!({ "sandbox": { "network": { "allowedDomains": ["corp.example"] } } })),
            None,
            Some(&dirs.home),
        );
        assert_eq!(open.domains(), ["corp.example", "user.example"]);
        assert_eq!(open.allowed_domains[0].origin, Origin::Enterprise);
        assert!(!open.managed_domains_only);
        let only = resolve(
            &load(json!({
                "sandbox": { "network": { "allowedDomains": ["corp.example"], "allowManagedDomainsOnly": true } },
                "permissions": { "allow": ["WebFetch(domain:docs.corp.example)", "Bash(ls)"] }
            })),
            None,
            Some(&dirs.home),
        );
        assert_eq!(only.domains(), ["corp.example", "docs.corp.example"]);
        assert!(only.managed_domains_only);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn a_project_cannot_turn_the_sandbox_off() {
        let dirs = Dirs::new("off");
        dirs.write(
            dirs.data.join("settings.json"),
            &json!({ "sandbox": { "enabled": true, "autoAllowBashIfSandboxed": true } }),
        );
        dirs.write(
            dirs.workspace.join(".piarc/settings.local.json"),
            &json!({ "sandbox": { "enabled": false, "autoAllowBashIfSandboxed": false } }),
        );
        let resolved = resolve(
            &dirs.settings(TrustState::Untrusted),
            None,
            Some(&dirs.home),
        );
        assert!(resolved.enabled);
        assert!(!resolved.auto_allow);
        assert!(resolved.allowed_domains.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn paths_resolve_against_their_file() {
        let base = Path::new("/w");
        let home = Path::new("/h");
        assert_eq!(
            resolve_path("a/b", Some(base), Some(home)),
            Some(PathBuf::from("/w/a/b"))
        );
        assert_eq!(
            resolve_path("./a/", Some(base), Some(home)),
            Some(PathBuf::from("/w/a"))
        );
        assert_eq!(
            resolve_path("~", Some(base), Some(home)),
            Some(PathBuf::from("/h"))
        );
        assert_eq!(resolve_path("~/.ssh", Some(base), None), None);
        assert_eq!(resolve_path("//x", None, None), Some(PathBuf::from("/x")));
        assert_eq!(resolve_path(" ", Some(base), Some(home)), None);
    }
}
