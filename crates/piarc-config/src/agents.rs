//! Subagent definition files (T31, architecture section 6.4, ADR-0048): where they are found,
//! what their frontmatter means and which file of a name wins.
//!
//! Sources, highest first (ADR-0005): `.piarc/agents/` of `cwd` and each directory above it,
//! then `.claude/agents/` the same way (nearer directories first; the home directory is the
//! user level and is skipped), PiArc's user `agents/`, then `~/.claude/agents/`. Every `*.md`
//! below a source directory is read ([`crate::rules::rule_files`]); the `name` field, not the
//! file name, identifies a type, and the first file of a name in that order is the one in
//! effect. Built-in types are the Agent Host's; a file may replace one.
//!
//! A file is Markdown with YAML frontmatter: `name` and `description` are required, the body
//! is the subagent's identity. A field PiArc does not support is ignored with a warning; a
//! project file's `bypassPermissions` and `auto` do not apply (architecture section 6.2.1).
//! Problems that make a file unusable come back as [`AgentIssue`]s with the line.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use piarc_protocol::models::EffortLevel;
use piarc_protocol::policy::PermissionMode;
use piarc_protocol::subagent::{
    AgentDefinition, AgentIssue, AgentSource, AgentWarning, AgentWarningKind,
};
use serde_json::Value;

/// Directory name of definitions under `.piarc/`, `.claude/` and the data directory.
pub const AGENTS_DIR: &str = "agents";

/// The largest definition file read.
pub const MAX_DEFINITION_BYTES: u64 = 256 * 1024;

/// Longest `name` (Claude Code's limit).
const MAX_NAME_CHARS: usize = 256;

/// Frontmatter keys PiArc reads.
const FIELDS: &[&str] = &[
    "name",
    "description",
    "tools",
    "disallowedTools",
    "model",
    "permissionMode",
    "maxTurns",
    "skills",
    "mcpServers",
    "hooks",
    "isolation",
    "background",
    "effort",
    "color",
];

/// Where definitions are looked up.
#[derive(Debug, Clone, Copy)]
pub struct AgentDirs<'a> {
    /// The directory project definitions are looked up from (a session's cwd).
    pub cwd: &'a Path,
    /// PiArc's data directory (user definitions in its `agents/`).
    pub data: Option<&'a Path>,
    /// The home directory (`~/.claude/agents/`); `None` reads no user Claude Code files.
    pub home: Option<&'a Path>,
}

/// A definition in effect, with the hooks it defines (Core runs them, scoped to its runs).
#[derive(Debug, Clone, PartialEq)]
pub struct Definition {
    /// What the Agent Host and the client see.
    pub view: AgentDefinition,
    /// The frontmatter `hooks` object, as written.
    pub hooks: Option<Value>,
    /// The servers `mcpServers` defines inline (`{name: definition}`, T36), as written. Core
    /// checks and expands them like other MCP definitions.
    pub mcp_inline: serde_json::Map<String, Value>,
}

/// The definitions of a directory and the files that are not valid ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadedAgents {
    /// In effect, in source order.
    pub definitions: Vec<Definition>,
    /// Files that could not be read as definitions.
    pub issues: Vec<AgentIssue>,
}

impl LoadedAgents {
    /// The definition in effect for `name`.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Definition> {
        self.definitions.iter().find(|d| d.view.name == name)
    }
}

/// The source directories, highest precedence first.
#[must_use]
pub fn source_dirs(dirs: &AgentDirs<'_>) -> Vec<(AgentSource, PathBuf)> {
    let walk: Vec<&Path> = dirs
        .cwd
        .ancestors()
        .filter(|dir| dirs.home != Some(*dir))
        .collect();
    let mut out = Vec::new();
    for (source, parent) in [
        (AgentSource::ProjectPiarc, ".piarc"),
        (AgentSource::ProjectClaude, ".claude"),
    ] {
        for dir in &walk {
            out.push((source, dir.join(parent).join(AGENTS_DIR)));
        }
    }
    if let Some(data) = dirs.data {
        out.push((AgentSource::User, data.join(AGENTS_DIR)));
    }
    if let Some(home) = dirs.home {
        out.push((
            AgentSource::UserClaude,
            home.join(".claude").join(AGENTS_DIR),
        ));
    }
    out
}

/// Reads every source and merges the definitions by name.
#[must_use]
pub fn load(dirs: &AgentDirs<'_>) -> LoadedAgents {
    let mut loaded = LoadedAgents::default();
    let mut by_name: BTreeMap<String, usize> = BTreeMap::new();
    for (source, dir) in source_dirs(dirs) {
        let files = match crate::rules::rule_files(&dir) {
            Ok(files) => files,
            Err(error) => {
                loaded
                    .issues
                    .push(issue(&dir, None, format!("cannot list: {error}")));
                continue;
            }
        };
        for path in files {
            let definition = match read(&path).and_then(|text| parse(&path, source, &text)) {
                Ok(definition) => definition,
                Err(problem) => {
                    loaded.issues.push(problem);
                    continue;
                }
            };
            if let Some(&index) = by_name.get(&definition.view.name) {
                if let Some(winner) = loaded.definitions.get_mut(index) {
                    winner.view.overrides.push(path.display().to_string());
                }
                continue;
            }
            by_name.insert(definition.view.name.clone(), loaded.definitions.len());
            loaded.definitions.push(definition);
        }
    }
    loaded
}

fn issue(path: &Path, line: Option<u64>, message: impl Into<String>) -> AgentIssue {
    AgentIssue {
        path: path.display().to_string(),
        line,
        message: message.into(),
    }
}

fn read(path: &Path) -> Result<String, AgentIssue> {
    let size = std::fs::metadata(path)
        .map_err(|e| issue(path, None, format!("cannot read: {e}")))?
        .len();
    if size > MAX_DEFINITION_BYTES {
        return Err(issue(
            path,
            None,
            format!("larger than {MAX_DEFINITION_BYTES} bytes"),
        ));
    }
    std::fs::read_to_string(path).map_err(|e| issue(path, None, format!("cannot read: {e}")))
}

/// Whether definitions from `source` are project configuration (trust and mode limits).
#[must_use]
pub fn is_project(source: AgentSource) -> bool {
    matches!(
        source,
        AgentSource::ProjectPiarc | AgentSource::ProjectClaude
    )
}

/// Parses one definition file.
///
/// # Errors
///
/// The file has no frontmatter, its YAML is invalid, a required field is missing or a field
/// has a value of the wrong kind; the issue names the line when it has one.
pub fn parse(path: &Path, source: AgentSource, text: &str) -> Result<Definition, AgentIssue> {
    let (yaml, body, front) = frontmatter(path, text)?;
    let fields = Fields {
        path,
        yaml,
        front: &front,
    };
    let mut warnings = Vec::new();
    let name = fields.required_text("name")?;
    if name.chars().count() > MAX_NAME_CHARS || name.contains(':') {
        return Err(fields.problem("name", "name must be at most 256 characters without \":\""));
    }
    let description = fields.required_text("description")?;
    let permission_mode = fields.mode(source, &mut warnings)?;
    let (mcp_servers, mcp_inline) = fields.servers()?;
    let skills = fields.list("skills")?.unwrap_or_default();
    let isolation = fields.text("isolation")?;
    if let Some(value) = &isolation
        && value != "worktree"
    {
        return Err(fields.problem("isolation", "isolation must be worktree"));
    }
    if !skills.is_empty() {
        warnings.push(warning(
            AgentWarningKind::InactiveField,
            Some("skills"),
            None,
            Some("T48"),
        ));
    }
    warnings.extend(
        front
            .keys()
            .filter(|k| !FIELDS.contains(&k.as_str()))
            .map(|key| warning(AgentWarningKind::IgnoredField, Some(key), None, None)),
    );
    let hooks = match front.get("hooks") {
        None | Some(Value::Null) => None,
        Some(value @ Value::Object(_)) => Some(value.clone()),
        Some(_) => return Err(fields.problem("hooks", "hooks must be a mapping of events")),
    };
    let view = AgentDefinition {
        name,
        description,
        source,
        path: Some(path.display().to_string()),
        prompt: body.trim().to_owned(),
        tools: fields.list("tools")?.map(|t| tool_names(&t)),
        disallowed_tools: fields
            .list("disallowedTools")?
            .map(|t| tool_names(&t))
            .unwrap_or_default(),
        model: fields.text("model")?,
        permission_mode,
        max_turns: fields.max_turns()?,
        skills,
        mcp_servers,
        mcp_inline: Vec::new(),
        hooks: hooks.is_some(),
        isolation,
        background: fields.flag("background")?,
        effort: fields.effort()?,
        color: fields.text("color")?,
        omit_project_context: false,
        overrides: Vec::new(),
        warnings,
        denied: false,
        resolved_model: None,
    };
    Ok(Definition {
        view,
        hooks,
        mcp_inline,
    })
}

/// The frontmatter's YAML text, the body and the frontmatter as a mapping.
fn frontmatter<'t>(
    path: &Path,
    text: &'t str,
) -> Result<(&'t str, &'t str, serde_json::Map<String, Value>), AgentIssue> {
    let document = crate::frontmatter::split(text);
    let Some(yaml) = document.yaml else {
        return Err(issue(path, Some(1), "no YAML frontmatter (--- ... ---)"));
    };
    let front = crate::frontmatter::mapping(yaml)
        .map_err(|invalid| issue(path, invalid.line, invalid.message))?;
    Ok((yaml, document.body, front))
}

fn warning(
    kind: AgentWarningKind,
    field: Option<&str>,
    value: Option<&str>,
    task: Option<&str>,
) -> AgentWarning {
    AgentWarning {
        kind,
        field: field.map(str::to_owned),
        value: value.map(str::to_owned),
        task: task.map(str::to_owned),
    }
}

/// `Tool(specifier)` reduced to `Tool`: a list names whole tools (a disallowed entry with a
/// specifier removes the whole tool, as in Claude Code).
fn tool_names(entries: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let name = entry.split('(').next().unwrap_or_default().trim();
        if !name.is_empty() && !names.iter().any(|n| n == name) {
            names.push(name.to_owned());
        }
    }
    names
}

struct Fields<'a> {
    path: &'a Path,
    yaml: &'a str,
    front: &'a serde_json::Map<String, Value>,
}

impl Fields<'_> {
    /// The file line of `key` in the frontmatter (which starts on line 2).
    fn line(&self, key: &str) -> Option<u64> {
        crate::frontmatter::line_of(self.yaml, key)
    }

    fn problem(&self, key: &str, message: &str) -> AgentIssue {
        issue(self.path, self.line(key).or(Some(1)), message)
    }

    fn text(&self, key: &str) -> Result<Option<String>, AgentIssue> {
        match self.front.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => {
                let text = text.trim();
                Ok((!text.is_empty()).then(|| text.to_owned()))
            }
            Some(_) => Err(self.problem(key, &format!("{key} must be text"))),
        }
    }

    fn required_text(&self, key: &str) -> Result<String, AgentIssue> {
        self.text(key)?
            .ok_or_else(|| self.problem(key, &format!("{key} is required")))
    }

    /// A list of strings, or one comma-separated string.
    fn list(&self, key: &str) -> Result<Option<Vec<String>>, AgentIssue> {
        let items = match self.front.get(key) {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(text)) => text
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            Some(Value::Array(values)) => {
                let mut items = Vec::new();
                for value in values {
                    let Value::String(text) = value else {
                        return Err(self.problem(key, &format!("{key} must list text")));
                    };
                    if !text.trim().is_empty() {
                        items.push(text.trim().to_owned());
                    }
                }
                items
            }
            Some(_) => return Err(self.problem(key, &format!("{key} must be a list"))),
        };
        Ok(Some(items))
    }

    fn flag(&self, key: &str) -> Result<bool, AgentIssue> {
        match self.front.get(key) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(flag)) => Ok(*flag),
            Some(_) => Err(self.problem(key, &format!("{key} must be true or false"))),
        }
    }

    fn max_turns(&self) -> Result<Option<u64>, AgentIssue> {
        match self.front.get("maxTurns") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .filter(|n| *n > 0)
                .map(Some)
                .ok_or_else(|| self.problem("maxTurns", "maxTurns must be a positive number")),
        }
    }

    fn effort(&self) -> Result<Option<EffortLevel>, AgentIssue> {
        let Some(text) = self.text("effort")? else {
            return Ok(None);
        };
        match text.as_str() {
            "low" => Ok(Some(EffortLevel::Low)),
            "medium" => Ok(Some(EffortLevel::Medium)),
            "high" => Ok(Some(EffortLevel::High)),
            "xhigh" => Ok(Some(EffortLevel::Xhigh)),
            "max" => Ok(Some(EffortLevel::Max)),
            _ => Err(self.problem("effort", "effort must be low, medium, high, xhigh or max")),
        }
    }

    /// The mode it asks for; a project file's `bypassPermissions` and `auto` and the modes
    /// PiArc does not have yet leave it to the parent's, with a warning.
    fn mode(
        &self,
        source: AgentSource,
        warnings: &mut Vec<AgentWarning>,
    ) -> Result<Option<PermissionMode>, AgentIssue> {
        let Some(text) = self.text("permissionMode")? else {
            return Ok(None);
        };
        let field = Some("permissionMode");
        let project_ignored = |warnings: &mut Vec<AgentWarning>| {
            warnings.push(warning(
                AgentWarningKind::ProjectModeIgnored,
                field,
                Some(&text),
                None,
            ));
        };
        match text.as_str() {
            "default" => Ok(Some(PermissionMode::Default)),
            "acceptEdits" => Ok(Some(PermissionMode::AcceptEdits)),
            "plan" => Ok(Some(PermissionMode::Plan)),
            "bypassPermissions" | "auto" if is_project(source) => {
                project_ignored(warnings);
                Ok(Some(PermissionMode::Default))
            }
            "bypassPermissions" => Ok(Some(PermissionMode::BypassPermissions)),
            "auto" | "dontAsk" => {
                warnings.push(warning(
                    AgentWarningKind::UnsupportedMode,
                    field,
                    Some(&text),
                    None,
                ));
                Ok(None)
            }
            _ => Err(self.problem(
                "permissionMode",
                "permissionMode must be default, acceptEdits, plan, bypassPermissions, auto or dontAsk",
            )),
        }
    }

    /// `mcpServers`: names of configured servers, or `{name: config}` entries (inline). Returns
    /// every name and the inline definitions.
    fn servers(&self) -> Result<(Vec<String>, serde_json::Map<String, Value>), AgentIssue> {
        let invalid = || {
            self.problem(
                "mcpServers",
                "mcpServers must list server names or definitions",
            )
        };
        let mut inline = serde_json::Map::new();
        let values = match self.front.get("mcpServers") {
            None | Some(Value::Null) => return Ok((Vec::new(), inline)),
            Some(Value::Array(values)) => values.clone(),
            Some(Value::Object(map)) => {
                return Ok((map.keys().cloned().collect(), map.clone()));
            }
            Some(Value::String(text)) => vec![Value::String(text.clone())],
            Some(_) => return Err(invalid()),
        };
        let mut names = Vec::new();
        for value in values {
            match value {
                Value::String(name) => names.push(name),
                Value::Object(map) => {
                    names.extend(map.keys().cloned());
                    inline.extend(map);
                }
                _ => return Err(invalid()),
            }
        }
        Ok((names, inline))
    }
}

#[cfg(test)]
mod tests;
