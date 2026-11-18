//! The executable configuration a project would enable once trusted, by category, with the
//! file each item comes from (architecture section 10.2). Only keys and entry names are read;
//! what they mean is loaded by the consumers (T24, T25, T36, T40) after the trust check.
//!
//! Scanned, relative to the workspace root: `.piarc/settings.json`,
//! `.piarc/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`
//! (`hooks`, `permissions.allow`, `enabledPlugins`), `.mcp.json` (`mcpServers`),
//! `.claude-plugin/plugin.json` and `marketplace.json` (plugins), `.pi/extensions/` (one item
//! per entry), `.pi/settings.json` (`extensions`, `packages`) and `.pi/mcp.json`
//! (`mcpServers`).

use std::collections::BTreeSet;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What kind of executable configuration an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    /// A hook handler.
    Hook,
    /// An MCP server.
    McpServer,
    /// A permission allow rule.
    AllowRule,
    /// A directory admitted to the workspace permission boundary.
    AdditionalDirectory,
    /// A project setting that requests automatic acceptance of edits.
    PermissionMode,
    /// A plugin.
    Plugin,
    /// A Pi extension or package.
    PiExtension,
}

/// One executable item.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// The category.
    pub category: Category,
    /// The file or directory it comes from, relative to the workspace, with `/`.
    pub source: String,
    /// The entry: a rule, a server name, `Event[matcher] command`, an extension's file name.
    pub name: String,
}

/// A file that could not be read; its items are missing from the inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    /// The file, relative to the workspace.
    pub source: String,
    /// Why.
    pub reason: String,
}

/// The result of [`enumerate`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    /// The items, sorted by category, source and name, without duplicates.
    pub items: Vec<Item>,
    /// Files that exist but could not be read or parsed.
    pub unreadable: Vec<Unreadable>,
}

const SETTINGS_FILES: [&str; 4] = [
    ".piarc/settings.json",
    ".piarc/settings.local.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
];

/// Lists the executable items of the project at `root`.
#[must_use]
pub fn enumerate(root: &Path) -> Inventory {
    let mut items = BTreeSet::new();
    let mut unreadable = Vec::new();
    let mut read = |source: &str| -> Option<Value> {
        match read_json(&root.join(source)) {
            Ok(value) => value,
            Err(reason) => {
                unreadable.push(Unreadable {
                    source: source.to_owned(),
                    reason,
                });
                None
            }
        }
    };
    for source in SETTINGS_FILES {
        if let Some(settings) = read(source) {
            settings_items(source, &settings, &mut items);
        }
    }
    for source in [".mcp.json", ".pi/mcp.json"] {
        if let Some(value) = read(source) {
            keys_of(
                source,
                value.get("mcpServers"),
                Category::McpServer,
                &mut items,
            );
        }
    }
    if let Some(plugin) = read(".claude-plugin/plugin.json") {
        let name = plugin
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(unnamed)");
        items.insert(item(Category::Plugin, ".claude-plugin/plugin.json", name));
    }
    if let Some(market) = read(".claude-plugin/marketplace.json") {
        marketplace_items(&market, &mut items);
    }
    if let Some(pi) = read(".pi/settings.json") {
        pi_settings_items(&pi, &mut items);
    }
    match extension_entries(&root.join(".pi").join("extensions")) {
        Ok(names) => {
            for name in names {
                items.insert(item(Category::PiExtension, ".pi/extensions", &name));
            }
        }
        Err(reason) => unreadable.push(Unreadable {
            source: ".pi/extensions".to_owned(),
            reason,
        }),
    }
    Inventory {
        items: items.into_iter().collect(),
        unreadable,
    }
}

/// The items of `current` that are not in `snapshot` (what changed since the user decided).
#[must_use]
pub fn new_items(current: &[Item], snapshot: &[Item]) -> Vec<Item> {
    let known: BTreeSet<&Item> = snapshot.iter().collect();
    current
        .iter()
        .filter(|i| !known.contains(i))
        .cloned()
        .collect()
}

fn marketplace_items(market: &Value, items: &mut BTreeSet<Item>) {
    for plugin in market
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(name) = plugin.get("name").and_then(Value::as_str) {
            items.insert(item(
                Category::Plugin,
                ".claude-plugin/marketplace.json",
                name,
            ));
        }
    }
}

fn pi_settings_items(pi: &Value, items: &mut BTreeSet<Item>) {
    for key in ["extensions", "packages"] {
        for entry in pi.get(key).and_then(Value::as_array).into_iter().flatten() {
            let name = entry
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    entry
                        .get("source")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| entry.to_string());
            items.insert(item(Category::PiExtension, ".pi/settings.json", &name));
        }
    }
}

pub(crate) fn settings_items(source: &str, settings: &Value, items: &mut BTreeSet<Item>) {
    let hooks = settings.get("hooks").and_then(Value::as_object);
    for (event, groups) in hooks.into_iter().flatten() {
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group.get("matcher").and_then(Value::as_str).unwrap_or("*");
            let matcher = if matcher.is_empty() { "*" } else { matcher };
            for handler in group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let what = ["command", "prompt", "url"]
                    .iter()
                    .find_map(|k| handler.get(*k).and_then(Value::as_str))
                    .unwrap_or("(no command)");
                items.insert(item(
                    Category::Hook,
                    source,
                    &format!("{event}[{matcher}] {what}"),
                ));
            }
        }
    }
    for (pointer, category) in [
        ("/permissions/allow", Category::AllowRule),
        (
            "/permissions/additionalDirectories",
            Category::AdditionalDirectory,
        ),
    ] {
        let values = settings.pointer(pointer).and_then(Value::as_array);
        for name in values.into_iter().flatten().filter_map(Value::as_str) {
            items.insert(item(category, source, name));
        }
    }
    if settings
        .pointer("/permissions/defaultMode")
        .and_then(Value::as_str)
        == Some("acceptEdits")
    {
        items.insert(item(Category::PermissionMode, source, "acceptEdits"));
    }
    let plugins = settings.get("enabledPlugins").and_then(Value::as_object);
    for (name, enabled) in plugins.into_iter().flatten() {
        if enabled.as_bool() != Some(false) {
            items.insert(item(Category::Plugin, source, name));
        }
    }
}

fn keys_of(source: &str, map: Option<&Value>, category: Category, items: &mut BTreeSet<Item>) {
    for name in map
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.keys())
    {
        items.insert(item(category, source, name));
    }
}

fn item(category: Category, source: &str, name: &str) -> Item {
    Item {
        category,
        source: source.to_owned(),
        name: name.to_owned(),
    }
}

/// `Ok(None)` for a missing file.
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            serde_json::from_slice(text)
                .map(Some)
                .map_err(|e| format!("not valid JSON: {e}"))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read: {error}")),
    }
}

/// Entries of `.pi/extensions/` Pi would load: files and directories, hidden ones excluded.
fn extension_entries(dir: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot list: {error}")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot list: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}
