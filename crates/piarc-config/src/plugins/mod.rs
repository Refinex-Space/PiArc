//! Extension packages (architecture section 6.7, T40, ADR-0058): Claude Code plugins
//! (`.claude-plugin/plugin.json` or its standard layout) and Pi packages (`package.json`'s
//! `pi` field). This module reads a package directory ([`manifest`]), decides which installed
//! packages apply to a workspace ([`active`]) and what of each may run.
//!
//! - **Declared in the settings.** `plugins` maps a package id to on (`true`) or off
//!   (`false`): in the user's `settings.json` for every workspace (user scope), in
//!   `.piarc/settings.json` (or `.local`) for one workspace (project scope). Project files are
//!   executable configuration: an untrusted project's `plugins` is left out of the merge, so
//!   its packages do not load (architecture section 10.2).
//! - **Installed by Core.** Core records each package's directory and the executable items
//!   the user confirmed ([`Installed`]); a declared id that is not installed is reported.
//! - **Confirmed item by item.** Hooks, MCP servers, Pi extensions, and the hooks and inline
//!   servers of a package's subagent definitions run only when their item name is among the
//!   confirmed ones: an update or a change that adds one leaves it off until the user
//!   confirms it again. Commands, skills and subagent definitions are instructions and load
//!   once the package is on.
//! - **Namespaced.** A plugin's commands, skills and subagent types are `<plugin>:<name>`; its
//!   MCP servers are `plugin_<plugin>_<server>` (Claude Code's tool name form). They come
//!   after every project and user source: a plugin never replaces a project's or the user's
//!   component of the same name. Pi packages are not namespaced, as in Pi.

pub mod manifest;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use piarc_protocol::plugins::PackageScope;
use serde_json::{Map, Value};

pub use manifest::{
    Executable, Manifest, read, substitute_text, valid_package_name, valid_plugin_name,
};

use crate::Settings;
use crate::layers::ids;

/// The settings key: package id → on or off.
pub const SETTINGS_KEY: &str = "plugins";

/// What Core installed: one package's directory and confirmed items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    /// The package id.
    pub id: String,
    /// Its directory.
    pub path: PathBuf,
    /// Names of the executable items the user confirmed.
    pub confirmed: BTreeSet<String>,
}

/// A package in effect for a workspace.
#[derive(Debug, Clone, PartialEq)]
pub struct Active {
    /// What it contains.
    pub manifest: Manifest,
    /// Where it is declared.
    pub scope: PackageScope,
    /// The executable items the user confirmed.
    pub confirmed: BTreeSet<String>,
}

/// The packages a workspace's settings turn on.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Packages {
    /// On and readable, in id order.
    pub active: Vec<Active>,
    /// Declared on but not installed.
    pub missing: Vec<String>,
    /// Installed and on, but unreadable: `(id, reason)`.
    pub broken: Vec<(String, String)>,
}

/// `${CLAUDE_PLUGIN_DATA}` of package `id`: `<data>/plugins/data/<id>` with every character
/// other than `[A-Za-z0-9_-]` replaced by `-` (Claude Code's rule).
#[must_use]
pub fn data_dir(data: &Path, id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    data.join("plugins").join("data").join(safe)
}

/// The declarations of `settings`: `(id, on, scope)` by id. A project layer's value decides
/// over the user's; the scope is the layer that declares it (a project layer when both do).
#[must_use]
pub fn declarations(settings: &Settings) -> Vec<(String, bool, PackageScope)> {
    let mut out: Vec<(String, bool, PackageScope)> = Vec::new();
    let project: BTreeSet<String> = [ids::PROJECT, ids::PROJECT_LOCAL]
        .iter()
        .filter_map(|id| settings.layer(id))
        .filter_map(|v| v.get(SETTINGS_KEY).and_then(Value::as_object))
        .flat_map(|m| m.keys().cloned())
        .collect();
    for (id, on) in settings
        .get(&format!("/{SETTINGS_KEY}"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let scope = if project.contains(id) {
            PackageScope::Project
        } else {
            PackageScope::User
        };
        out.push((id.clone(), on.as_bool() == Some(true), scope));
    }
    out
}

/// The declarations as the files hold them, trusted or not: what the settings window lists
/// (an untrusted project's packages show as declared there and do not load).
#[must_use]
pub fn listed(settings: &Settings) -> Vec<(String, bool, PackageScope)> {
    let mut out: Vec<(String, bool, PackageScope)> = Vec::new();
    for (layer, scope) in [
        (ids::USER, PackageScope::User),
        (ids::PROJECT, PackageScope::Project),
        (ids::PROJECT_LOCAL, PackageScope::Project),
    ] {
        let declared = settings
            .loaded(layer)
            .and_then(|v| v.get(SETTINGS_KEY))
            .and_then(Value::as_object);
        for (id, on) in declared.into_iter().flatten() {
            let on = on.as_bool() == Some(true);
            match out.iter_mut().find(|(known, _, _)| known == id) {
                Some(entry) => *entry = (id.clone(), on, scope),
                None => out.push((id.clone(), on, scope)),
            }
        }
    }
    out
}

/// The packages `settings` turn on, among `installed`.
#[must_use]
pub fn active(settings: &Settings, installed: &[Installed], data: &Path) -> Packages {
    let mut out = Packages::default();
    for (id, on, scope) in declarations(settings) {
        if !on {
            continue;
        }
        let Some(record) = installed.iter().find(|i| i.id == id) else {
            out.missing.push(id);
            continue;
        };
        // A package the managed settings turn on is the administrator's choice: its executable
        // items count as confirmed (T47, design addendum section 5.3).
        let managed_on = settings
            .managed()
            .and_then(|m| m.get(SETTINGS_KEY))
            .and_then(|p| p.get(&id))
            == Some(&Value::Bool(true));
        match manifest::read(&record.path, &data_dir(data, &id)) {
            Ok(manifest) if manifest.id == id => out.active.push(Active {
                confirmed: if managed_on {
                    manifest.executables().into_iter().map(|e| e.name).collect()
                } else {
                    record.confirmed.clone()
                },
                manifest,
                scope,
            }),
            Ok(manifest) => out.broken.push((
                id,
                format!("the package now names itself {:?}", manifest.id),
            )),
            Err(reason) => out.broken.push((id, reason)),
        }
    }
    out
}

impl Active {
    /// The package id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    /// Whether the executable item `name` was confirmed.
    #[must_use]
    pub fn allows(&self, name: &str) -> bool {
        self.confirmed.contains(name)
    }

    /// The confirmed hooks.
    #[must_use]
    pub fn hooks(&self) -> Option<Value> {
        manifest::filter_hooks(self.manifest.hooks.as_ref(), &|name| self.allows(name))
    }

    /// The confirmed MCP servers, by their pool name.
    #[must_use]
    pub fn mcp_servers(&self) -> Map<String, Value> {
        self.manifest
            .mcp_servers
            .iter()
            .map(|(server, entry)| (self.manifest.mcp_name(server), entry))
            .filter(|(name, entry)| self.allows(&crate::mcp::trust_item_name(name, entry)))
            .map(|(name, entry)| (name, entry.clone()))
            .collect()
    }

    /// The confirmed Pi extension entries.
    #[must_use]
    pub fn extensions(&self) -> Vec<PathBuf> {
        self.manifest
            .extensions
            .iter()
            .filter(|p| self.allows(&self.manifest.relative(p)))
            .cloned()
            .collect()
    }

    /// A subagent definition's hooks and inline servers, keeping the confirmed ones
    /// (`agent` is the namespaced type name).
    pub fn restrict_agent(
        &self,
        agent: &str,
        hooks: &mut Option<Value>,
        inline: &mut Map<String, Value>,
    ) {
        *hooks = manifest::filter_hooks(hooks.as_ref(), &|name| {
            self.allows(&format!("{agent}: {name}"))
        });
        inline.retain(|server, entry| {
            self.allows(&format!(
                "{agent}: {}",
                crate::mcp::trust_item_name(server, entry)
            ))
        });
    }

    /// Executable items not confirmed yet.
    #[must_use]
    pub fn pending(&self) -> Vec<Executable> {
        self.manifest
            .executables()
            .into_iter()
            .filter(|e| !self.allows(&e.name))
            .collect()
    }
}

#[cfg(test)]
mod tests;
