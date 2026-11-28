//! Reading one package directory: a Claude Code plugin or a Pi package, its components, the
//! components PiArc does not support, and its executable items.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use piarc_protocol::plugins::{PackageComponents, PackageExecutableKind, PackageKind};
use serde_json::{Map, Value};

/// A plugin's manifest, relative to its root.
pub const PLUGIN_MANIFEST: &str = ".claude-plugin/plugin.json";

/// The largest manifest or component JSON file read.
const MAX_JSON_BYTES: u64 = 1024 * 1024;

/// One package as found on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    /// The id: `plugin.json`'s `name` (the directory name without one), or `package.json`'s.
    pub id: String,
    /// Plugin or Pi package.
    pub kind: PackageKind,
    /// The package directory (canonical).
    pub root: PathBuf,
    /// Its data directory (`${CLAUDE_PLUGIN_DATA}`).
    pub data: PathBuf,
    /// `version` of the manifest.
    pub version: Option<String>,
    /// `description` of the manifest.
    pub description: Option<String>,
    /// Directories whose subdirectories hold `SKILL.md` (plugin `skills/`, Pi `skills`).
    pub skill_dirs: Vec<PathBuf>,
    /// A plugin with `SKILL.md` at its root and no other skills: that one skill's directory.
    pub root_skill: Option<PathBuf>,
    /// Command files and directories (plugin `commands`; Pi prompt templates).
    pub command_paths: Vec<PathBuf>,
    /// Subagent definition files and directories (plugins).
    pub agent_paths: Vec<PathBuf>,
    /// The hooks (`hooks/hooks.json` merged with the manifest's), with the plugin variables
    /// substituted; an object of event → matcher groups.
    pub hooks: Option<Value>,
    /// The file the hooks come from (diagnostics, audits).
    pub hooks_file: Option<PathBuf>,
    /// MCP servers by their name in the package, variables substituted.
    pub mcp_servers: Map<String, Value>,
    /// Pi extension entry files (absolute).
    pub extensions: Vec<PathBuf>,
    /// Components PiArc does not support.
    pub unsupported: Vec<String>,
    /// Problems with the manifest or a component file; the rest still loads.
    pub issues: Vec<String>,
}

/// One executable item of a package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Executable {
    /// What it runs.
    pub kind: PackageExecutableKind,
    /// Its identity (the package's fingerprint is the set of these).
    pub name: String,
}

/// Whether `name` can be a plugin's name (Claude Code's rule: no whitespace, `@`, `:`, path
/// separators or control characters), and does not contain `__` (PiArc's MCP tool names).
#[must_use]
pub fn valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && !name.contains("__")
        && name
            .chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && !matches!(c, '@' | ':' | '/' | '\\'))
        && !name.chars().any(is_bidi_control)
}

/// Whether `name` can be a Pi package's id (npm's: optional `@scope/`, no whitespace).
#[must_use]
pub fn valid_package_name(name: &str) -> bool {
    let bare = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, rest)) if !scope.is_empty() => rest,
            _ => return false,
        },
        None => name,
    };
    !bare.is_empty()
        && name.chars().count() <= 214
        && !bare.contains('/')
        && !bare.starts_with('.')
        && name
            .chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && !matches!(c, ':' | '\\'))
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}')
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_JSON_BYTES => {
            return Err(format!("{}: larger than 1 MiB", path.display()));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: cannot read ({e})", path.display())),
    }
    let bytes =
        std::fs::read(path).map_err(|e| format!("{}: cannot read ({e})", path.display()))?;
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(text)
        .map(Some)
        .map_err(|e| format!("{}: not valid JSON ({e})", path.display()))
}

/// What a directory is: a plugin (manifest or standard layout) or a Pi package.
fn detect(root: &Path) -> Option<PackageKind> {
    if root.join(PLUGIN_MANIFEST).is_file() {
        return Some(PackageKind::ClaudePlugin);
    }
    let package = root.join("package.json");
    if package.is_file() {
        let has_pi = read_json(&package)
            .ok()
            .flatten()
            .is_some_and(|v| v.get("pi").is_some_and(Value::is_object));
        let pi_dirs = ["extensions", "skills", "prompts", "themes"]
            .iter()
            .any(|d| root.join(d).is_dir());
        if has_pi || pi_dirs {
            return Some(PackageKind::PiPackage);
        }
    }
    let plugin_layout = [
        "commands",
        "agents",
        "skills",
        "hooks/hooks.json",
        ".mcp.json",
        "SKILL.md",
    ]
    .iter()
    .any(|p| root.join(p).exists());
    plugin_layout.then_some(PackageKind::ClaudePlugin)
}

/// Reads the package at `root`; `data` is the package's data directory
/// (`${CLAUDE_PLUGIN_DATA}`).
///
/// # Errors
///
/// The directory is neither a plugin nor a Pi package, or its name is missing or invalid.
pub fn read(root: &Path, data: &Path) -> Result<Manifest, String> {
    let root = real_path(root).map_err(|e| format!("{}: cannot open ({e})", root.display()))?;
    match detect(&root) {
        Some(PackageKind::ClaudePlugin) => read_plugin(&root, data),
        Some(PackageKind::PiPackage) => read_pi(&root, data),
        None => Err(format!(
            "{} is neither a Claude Code plugin (.claude-plugin/plugin.json) nor a Pi package \
             (package.json with a \"pi\" field)",
            root.display()
        )),
    }
}

fn empty(id: String, kind: PackageKind, root: &Path, data: &Path) -> Manifest {
    Manifest {
        id,
        kind,
        root: root.to_owned(),
        data: data.to_owned(),
        version: None,
        description: None,
        skill_dirs: Vec::new(),
        root_skill: None,
        command_paths: Vec::new(),
        agent_paths: Vec::new(),
        hooks: None,
        hooks_file: None,
        mcp_servers: Map::new(),
        extensions: Vec::new(),
        unsupported: Vec::new(),
        issues: Vec::new(),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A component path of the manifest: relative, starting with `./`, inside the root.
fn component_path(root: &Path, raw: &str, issues: &mut Vec<String>) -> Option<PathBuf> {
    let rest = if raw == "." {
        ""
    } else if let Some(rest) = raw.strip_prefix("./") {
        rest
    } else {
        issues.push(format!("{raw:?}: component paths start with \"./\""));
        return None;
    };
    let path = root.join(rest);
    match real_path(&path) {
        Ok(real) if real.starts_with(root) => Some(real),
        Ok(_) => {
            issues.push(format!("{raw:?}: leaves the plugin directory"));
            None
        }
        Err(_) => {
            issues.push(format!("{raw:?}: does not exist"));
            None
        }
    }
}

/// A manifest field that is a path or a list of paths.
fn paths_of(root: &Path, value: Option<&Value>, issues: &mut Vec<String>) -> Option<Vec<PathBuf>> {
    let value = value?;
    let raw: Vec<&str> = match value {
        Value::String(s) => vec![s.as_str()],
        Value::Array(list) => list.iter().filter_map(Value::as_str).collect(),
        _ => {
            issues.push(format!(
                "component field {value}: expected a path or a list"
            ));
            return Some(Vec::new());
        }
    };
    Some(
        raw.into_iter()
            .filter_map(|p| component_path(root, p, issues))
            .collect(),
    )
}

/// `path` resolved like `canonicalize` but without Windows' verbatim prefix (`\\?\C:\…` →
/// `C:\…`): hook commands and server arguments are built from it by text, and in a verbatim
/// path `/` is not a separator, nor can Git Bash run one (W3).
pub(crate) fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = path.canonicalize()?;
    let Some(text) = real.to_str() else {
        return Ok(real);
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{unc}")));
    }
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => real,
    })
}

/// Replaces the plugin variables in every string of `value`.
pub(crate) fn substitute(value: &mut Value, root: &Path, data: &Path) {
    match value {
        Value::String(s) => *s = substitute_text(s, root, data),
        Value::Array(list) => list.iter_mut().for_each(|v| substitute(v, root, data)),
        Value::Object(map) => map.values_mut().for_each(|v| substitute(v, root, data)),
        _ => {}
    }
}

/// `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in `text`.
#[must_use]
pub fn substitute_text(text: &str, root: &Path, data: &Path) -> String {
    text.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy())
        .replace("${CLAUDE_PLUGIN_DATA}", &data.to_string_lossy())
}

fn read_plugin(root: &Path, data: &Path) -> Result<Manifest, String> {
    let mut issues = Vec::new();
    let manifest = read_json(&root.join(PLUGIN_MANIFEST))?.unwrap_or(Value::Object(Map::new()));
    if !manifest.is_object() {
        return Err(format!("{PLUGIN_MANIFEST}: not a JSON object"));
    }
    let id = match text(&manifest, "name") {
        Some(name) => name,
        None => root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    if !valid_plugin_name(&id) {
        return Err(format!(
            "{id:?} is not a plugin name: no spaces, \"@\", \":\", \"__\" or path separators"
        ));
    }
    let mut out = empty(id, PackageKind::ClaudePlugin, root, data);
    out.version = text(&manifest, "version");
    out.description = text(&manifest, "description");
    // Skills: `skills/` plus the manifest's directories; a lone root SKILL.md is one skill.
    let mut skill_dirs = Vec::new();
    if root.join("skills").is_dir() {
        skill_dirs.push(root.join("skills"));
    }
    let declared = paths_of(root, manifest.get("skills"), &mut issues);
    skill_dirs.extend(declared.clone().unwrap_or_default());
    if skill_dirs.is_empty() && declared.is_none() && root.join(crate::skills::SKILL_FILE).is_file()
    {
        out.root_skill = Some(root.to_owned());
    }
    out.skill_dirs = skill_dirs;
    // Commands and agents: the manifest's paths replace the default directory.
    out.command_paths = match manifest.get("commands") {
        Some(Value::Object(_)) => {
            out.unsupported.push("commands (inline map)".to_owned());
            Vec::new()
        }
        other => paths_of(root, other, &mut issues).unwrap_or_else(|| {
            let dir = root.join("commands");
            if dir.is_dir() { vec![dir] } else { Vec::new() }
        }),
    };
    out.agent_paths = paths_of(root, manifest.get("agents"), &mut issues).unwrap_or_else(|| {
        let dir = root.join("agents");
        if dir.is_dir() { vec![dir] } else { Vec::new() }
    });
    read_plugin_hooks(root, data, &manifest, &mut out, &mut issues);
    read_plugin_mcp(root, data, &manifest, &mut out, &mut issues);
    plugin_unsupported(root, &manifest, &mut out.unsupported);
    out.issues = issues;
    Ok(out)
}

/// `hooks/hooks.json` first, then the manifest's `hooks` (paths or inline), merged by event.
fn read_plugin_hooks(
    root: &Path,
    data: &Path,
    manifest: &Value,
    out: &mut Manifest,
    issues: &mut Vec<String>,
) {
    let mut merged = Map::new();
    let add = |hooks: Option<&Value>, merged: &mut Map<String, Value>| {
        for (event, groups) in hooks.and_then(Value::as_object).into_iter().flatten() {
            let list = merged
                .entry(event.clone())
                .or_insert_with(|| Value::Array(Vec::new()));
            if let (Value::Array(list), Some(groups)) = (list, groups.as_array()) {
                list.extend(groups.iter().cloned());
            }
        }
    };
    let default = root.join("hooks").join("hooks.json");
    match read_json(&default) {
        Ok(Some(file)) => {
            if file.get("modules").is_some() {
                out.unsupported.push("mods".to_owned());
            }
            add(file.get("hooks"), &mut merged);
            out.hooks_file = Some(default);
        }
        Ok(None) => {}
        Err(e) => issues.push(e),
    }
    let declared: Vec<&Value> = match manifest.get("hooks") {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    };
    for entry in declared {
        match entry {
            Value::String(raw) => {
                let Some(path) = component_path(root, raw, issues) else {
                    continue;
                };
                match read_json(&path) {
                    Ok(Some(file)) => {
                        if file.get("modules").is_some()
                            && !out.unsupported.iter().any(|u| u == "mods")
                        {
                            out.unsupported.push("mods".to_owned());
                        }
                        add(file.get("hooks"), &mut merged);
                        out.hooks_file.get_or_insert(path);
                    }
                    Ok(None) => issues.push(format!("{raw:?}: does not exist")),
                    Err(e) => issues.push(e),
                }
            }
            Value::Object(_) => {
                add(Some(entry), &mut merged);
                out.hooks_file
                    .get_or_insert_with(|| root.join(PLUGIN_MANIFEST));
            }
            other => issues.push(format!("hooks entry {other}: expected a path or an object")),
        }
    }
    if !merged.is_empty() {
        let mut hooks = Value::Object(merged);
        substitute(&mut hooks, root, data);
        out.hooks = Some(hooks);
    }
}

/// `.mcp.json` first, then the manifest's `mcpServers` (paths or inline); later names win.
fn read_plugin_mcp(
    root: &Path,
    data: &Path,
    manifest: &Value,
    out: &mut Manifest,
    issues: &mut Vec<String>,
) {
    fn servers_of(file: &Value) -> Option<&Map<String, Value>> {
        // The `mcpServers` wrapper is optional in a plugin's file.
        match file.get("mcpServers") {
            Some(Value::Object(map)) => Some(map),
            _ => file.as_object(),
        }
    }
    let add = |map: Option<&Map<String, Value>>, out: &mut Manifest| {
        for (name, entry) in map.into_iter().flatten() {
            let mut entry = entry.clone();
            substitute(&mut entry, root, data);
            out.mcp_servers.insert(name.clone(), entry);
        }
    };
    match read_json(&root.join(crate::mcp::MCP_JSON)) {
        Ok(Some(file)) => add(servers_of(&file), out),
        Ok(None) => {}
        Err(e) => issues.push(e),
    }
    let declared: Vec<&Value> = match manifest.get("mcpServers") {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    };
    for entry in declared {
        match entry {
            Value::String(raw)
                if raw.starts_with("https://")
                    || raw.ends_with(".mcpb")
                    || raw.ends_with(".dxt") =>
            {
                out.unsupported.push(format!("mcpServers bundle {raw}"));
            }
            Value::String(raw) => {
                let Some(path) = component_path(root, raw, issues) else {
                    continue;
                };
                match read_json(&path) {
                    Ok(Some(file)) => add(servers_of(&file), out),
                    Ok(None) => issues.push(format!("{raw:?}: does not exist")),
                    Err(e) => issues.push(e),
                }
            }
            Value::Object(map) => add(Some(map), out),
            other => issues.push(format!(
                "mcpServers entry {other}: expected a path or an object"
            )),
        }
    }
}

/// Components of Claude Code plugins PiArc does not load (architecture section 6.14).
fn plugin_unsupported(root: &Path, manifest: &Value, unsupported: &mut Vec<String>) {
    let mut add = |name: &str| {
        if !unsupported.iter().any(|u| u == name) {
            unsupported.push(name.to_owned());
        }
    };
    let experimental = manifest.get("experimental");
    let has =
        |key: &str| manifest.get(key).is_some() || experimental.and_then(|e| e.get(key)).is_some();
    if has("lspServers") || root.join(".lsp.json").is_file() {
        add("lspServers");
    }
    if has("monitors") || root.join("monitors").join("monitors.json").is_file() {
        add("monitors");
    }
    if has("channels") {
        add("channels");
    }
    if has("themes") || root.join("themes").is_dir() {
        add("themes");
    }
    if has("outputStyles") || root.join("output-styles").is_dir() {
        add("outputStyles");
    }
    if has("workflows") || root.join("workflows").is_dir() {
        add("workflows");
    }
    if root.join("bin").is_dir() {
        add("bin");
    }
    if has("userConfig") {
        add("userConfig");
    }
    if has("dependencies") {
        add("dependencies");
    }
}

fn read_pi(root: &Path, data: &Path) -> Result<Manifest, String> {
    let package = read_json(&root.join("package.json"))?.unwrap_or(Value::Object(Map::new()));
    let id = text(&package, "name").ok_or_else(|| "package.json has no \"name\"".to_owned())?;
    if !valid_package_name(&id) {
        return Err(format!("{id:?} is not an npm package name"));
    }
    let mut out = empty(id, PackageKind::PiPackage, root, data);
    out.version = text(&package, "version");
    out.description = text(&package, "description");
    let mut issues = Vec::new();
    let pi = package.get("pi");
    // Pi's rule: the `pi` field's lists, else the conventional directories.
    let entries = |field: &str, issues: &mut Vec<String>| -> Vec<PathBuf> {
        match pi.and_then(|p| p.get(field)).and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|raw| {
                    if raw.contains(['*', '?', '[', '!']) {
                        issues.push(format!("pi.{field} {raw:?}: patterns are not supported"));
                        return None;
                    }
                    let path = root.join(raw.trim_start_matches("./"));
                    match real_path(&path) {
                        Ok(real) if real.starts_with(root) => Some(real),
                        Ok(_) => {
                            issues.push(format!("pi.{field} {raw:?}: leaves the package"));
                            None
                        }
                        Err(_) => {
                            issues.push(format!("pi.{field} {raw:?}: does not exist"));
                            None
                        }
                    }
                })
                .collect(),
            None => {
                let dir = root.join(field);
                if dir.is_dir() { vec![dir] } else { Vec::new() }
            }
        }
    };
    let extension_paths = entries("extensions", &mut issues);
    let skills = entries("skills", &mut issues);
    let prompts = entries("prompts", &mut issues);
    let themes = entries("themes", &mut issues);
    for path in extension_paths {
        if path.is_file() {
            out.extensions.push(path);
        } else {
            out.extensions.extend(extension_entries(&path));
        }
    }
    out.skill_dirs = skills;
    out.command_paths = prompts;
    if !themes.is_empty() {
        out.unsupported.push("themes".to_owned());
    }
    out.issues = issues;
    Ok(out)
}

/// Pi's rule for an extension directory: its `package.json` `pi.extensions`, `index.ts`,
/// `index.js`; otherwise its `*.ts`/`*.js` files and subdirectories that resolve.
fn extension_entries(dir: &Path) -> Vec<PathBuf> {
    if let Some(entries) = resolve_extension_dir(dir) {
        return entries;
    }
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut children: Vec<_> = read.flatten().map(|e| e.path()).collect();
    children.sort();
    for path in children {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if path.is_file()
            && (name.ends_with(".ts") || name.ends_with(".js"))
            && !name.ends_with(".d.ts")
        {
            out.push(path);
        } else if path.is_dir()
            && let Some(entries) = resolve_extension_dir(&path)
        {
            out.extend(entries);
        }
    }
    out
}

fn resolve_extension_dir(dir: &Path) -> Option<Vec<PathBuf>> {
    if let Ok(Some(package)) = read_json(&dir.join("package.json"))
        && let Some(list) = package.pointer("/pi/extensions").and_then(Value::as_array)
    {
        let entries: Vec<PathBuf> = list
            .iter()
            .filter_map(Value::as_str)
            .map(|p| dir.join(p.trim_start_matches("./")))
            .filter(|p| p.exists())
            .collect();
        if !entries.is_empty() {
            return Some(entries);
        }
    }
    ["index.ts", "index.js"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
        .map(|p| vec![p])
}

impl Manifest {
    /// The name an MCP server of this package has in the pool and in tool names
    /// (`plugin_<plugin>_<server>`, Claude Code's tool name form).
    #[must_use]
    pub fn mcp_name(&self, server: &str) -> String {
        format!("plugin_{}_{server}", self.id)
    }

    /// The name of a component in this package's namespace (`<plugin>:<name>`); Pi packages
    /// have none.
    #[must_use]
    pub fn namespaced(&self, name: &str) -> String {
        match self.kind {
            PackageKind::ClaudePlugin => format!("{}:{name}", self.id),
            PackageKind::PiPackage => name.to_owned(),
        }
    }

    /// The executable items: hooks, MCP servers, Pi extensions, and the hooks and inline
    /// servers of the package's subagent definitions.
    #[must_use]
    pub fn executables(&self) -> Vec<Executable> {
        let mut out = BTreeSet::new();
        for name in hook_names(self.hooks.as_ref()) {
            out.insert((0u8, name));
        }
        for (server, entry) in &self.mcp_servers {
            out.insert((
                1,
                crate::mcp::trust_item_name(&self.mcp_name(server), entry),
            ));
        }
        for path in &self.extensions {
            out.insert((2, self.relative(path)));
        }
        for agent in self.agents() {
            let name = self.namespaced(&agent.view.name);
            for hook in hook_names(agent.hooks.as_ref()) {
                out.insert((3, format!("{name}: {hook}")));
            }
            for (server, entry) in &agent.mcp_inline {
                out.insert((
                    4,
                    format!("{name}: {}", crate::mcp::trust_item_name(server, entry)),
                ));
            }
        }
        out.into_iter()
            .map(|(kind, name)| Executable {
                kind: match kind {
                    0 => PackageExecutableKind::Hook,
                    1 => PackageExecutableKind::McpServer,
                    2 => PackageExecutableKind::PiExtension,
                    3 => PackageExecutableKind::AgentHook,
                    _ => PackageExecutableKind::AgentMcpServer,
                },
                name,
            })
            .collect()
    }

    /// `path` relative to the package, with `/`.
    #[must_use]
    pub fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// The package's subagent definitions (plugins), parsed; invalid files are left out.
    #[must_use]
    pub fn agents(&self) -> Vec<crate::agents::Definition> {
        let mut out = Vec::new();
        for path in &self.agent_paths {
            let files = if path.is_dir() {
                crate::rules::rule_files(path).unwrap_or_default()
            } else {
                vec![path.clone()]
            };
            for file in files {
                let Ok(text) = std::fs::read_to_string(&file) else {
                    continue;
                };
                if let Ok(definition) = crate::agents::parse(
                    &file,
                    piarc_protocol::subagent::AgentSource::Plugin,
                    &text,
                ) {
                    out.push(definition);
                }
            }
        }
        out
    }

    /// What the settings window lists.
    #[must_use]
    pub fn components(&self) -> PackageComponents {
        let catalog = crate::skills::load_package(self);
        PackageComponents {
            commands: catalog
                .commands
                .iter()
                .map(|c| c.info.name.clone())
                .collect(),
            skills: catalog.skills.iter().map(|s| s.info.name.clone()).collect(),
            agents: self
                .agents()
                .iter()
                .map(|a| self.namespaced(&a.view.name))
                .collect(),
            hooks: self
                .hooks
                .as_ref()
                .and_then(Value::as_object)
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default(),
            mcp_servers: self.mcp_servers.keys().map(|s| self.mcp_name(s)).collect(),
            extensions: self.extensions.iter().map(|p| self.relative(p)).collect(),
        }
    }
}

/// The item names of a `hooks` object (event → matcher groups), as the trust inventory names
/// them.
pub(crate) fn hook_names(hooks: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (event, groups) in hooks.and_then(Value::as_object).into_iter().flatten() {
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group.get("matcher").and_then(Value::as_str).unwrap_or("*");
            let matcher = if matcher.is_empty() { "*" } else { matcher };
            for handler in group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                out.push(crate::executables::hook_item_name(event, matcher, handler));
            }
        }
    }
    out
}

/// `hooks` with only the handlers whose item name `keep` accepts; `None` when none is left.
pub(crate) fn filter_hooks(hooks: Option<&Value>, keep: &dyn Fn(&str) -> bool) -> Option<Value> {
    let mut out = Map::new();
    for (event, groups) in hooks.and_then(Value::as_object).into_iter().flatten() {
        let mut kept_groups = Vec::new();
        for group in groups.as_array().into_iter().flatten() {
            let matcher = group.get("matcher").and_then(Value::as_str).unwrap_or("*");
            let matcher = if matcher.is_empty() { "*" } else { matcher };
            let handlers: Vec<Value> = group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|h| keep(&crate::executables::hook_item_name(event, matcher, h)))
                .cloned()
                .collect();
            if !handlers.is_empty() {
                let mut group = group.clone();
                if let Some(map) = group.as_object_mut() {
                    map.insert("hooks".to_owned(), Value::Array(handlers));
                }
                kept_groups.push(group);
            }
        }
        if !kept_groups.is_empty() {
            out.insert(event.clone(), Value::Array(kept_groups));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}
