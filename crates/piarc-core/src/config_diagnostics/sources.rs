//! The configuration sources besides settings files (T41, architecture section 6.14): the
//! project's `.mcp.json`, memory files with their `@` imports, Claude Code rules, subagent
//! definitions, skills, command files, output styles, extension packages, and the place
//! reserved for enterprise settings (T47). Each is a [`FileReport`] like a settings file's
//! (T24): load state, what applies, what another source overrides (and which), what is not
//! used and why, and parse errors with their position.
//!
//! Every report comes from the loader the feature itself uses (`piarc_config::mcp::merge`
//! through `crate::mcp`, `fs/memory`'s discovery, `piarc_config::{agents, skills, rules}`,
//! the package list), so a report cannot disagree with what a session gets.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use piarc_config::diagnostics::{IgnoreReason, IgnoredKey, KeyReport, SourceKind};
use piarc_config::layers::{Format, Scope};
use piarc_config::settings::Issue;
use piarc_config::{FileReport, FileStatus};
use piarc_protocol::mcp::McpAvailability;
use piarc_protocol::plugins::{PackageScope, PackagesList};
use piarc_protocol::skills::{ResourceSource, ResourceWarning, ResourceWarningKind};
use piarc_protocol::subagent::{AgentSource, AgentWarning, AgentWarningKind};
use serde_json::{Value, json};

/// What the sources are read for.
pub(crate) struct Inputs<'a> {
    pub root: &'a Path,
    pub home: Option<&'a Path>,
    pub data: &'a Path,
    pub settings: &'a piarc_config::Settings,
    /// The installed packages as the workspace sees them.
    pub packages: Option<&'a PackagesList>,
    /// Core's managed settings (T47).
    pub managed: &'a crate::managed::Snapshot,
}

fn report(kind: SourceKind, layer: &'static str, file: PathBuf, scope: Scope) -> FileReport {
    let format = if is_claude(&file) {
        Format::ClaudeCode
    } else {
        Format::Piarc
    };
    FileReport {
        kind,
        layer,
        file,
        format,
        scope,
        precedence: None,
        writable: false,
        status: FileStatus::Loaded,
        effective: Vec::new(),
        overridden: Vec::new(),
        ignored: Vec::new(),
        issues: Vec::new(),
    }
}

/// Claude Code's files: under a `.claude` directory, `CLAUDE*.md`, `.mcp.json`.
fn is_claude(file: &Path) -> bool {
    file.components().any(|c| c.as_os_str() == ".claude")
        || file.file_name().is_some_and(|n| {
            let n = n.to_string_lossy();
            n.starts_with("CLAUDE") || n == ".mcp.json"
        })
}

fn item(pointer: impl Into<String>, value: Value) -> KeyReport {
    KeyReport {
        pointer: pointer.into(),
        final_value: value.clone(),
        value,
        source: None,
        source_file: None,
    }
}

fn overridden(pointer: impl Into<String>, layer: &'static str, by: &str) -> KeyReport {
    KeyReport {
        pointer: pointer.into(),
        value: Value::Null,
        final_value: Value::Null,
        source: Some(layer),
        source_file: Some(PathBuf::from(by)),
    }
}

fn ignored(pointer: impl Into<String>, reason: IgnoreReason, detail: Option<String>) -> IgnoredKey {
    IgnoredKey {
        pointer: pointer.into(),
        reason,
        task: None,
        note: None,
        detail,
    }
}

fn issue(file: &Path, message: String, line: Option<u64>) -> Issue {
    Issue {
        layer: "",
        file: Some(file.to_owned()),
        pointer: String::new(),
        message,
        severity: piarc_config::schema::Severity::Error,
        line: line.and_then(|l| usize::try_from(l).ok()),
        column: None,
    }
}

/// Every source report of `inputs`, in the order the settings page lists them.
pub(crate) fn reports(inputs: &Inputs<'_>) -> Vec<FileReport> {
    let mut out = Vec::new();
    out.extend(mcp_json(inputs));
    out.extend(memory(inputs));
    out.extend(rules(inputs));
    out.extend(agents(inputs));
    out.extend(resources(inputs));
    if let Some(list) = inputs.packages {
        out.extend(packages(list, inputs.settings.trust().is_trusted()));
    }
    out.extend(enterprise(inputs.managed));
    out.extend(launch(inputs));
    out
}

/// The launch files (ADR-0092): each configuration applies (with its command line), a
/// `.claude` one hidden by a `.piarc` one of the same name is overridden, problems carry their
/// place; nothing runs until the project is trusted.
fn launch(inputs: &Inputs<'_>) -> Vec<FileReport> {
    use piarc_config::launch::{self, LaunchSource};
    let loaded = launch::load(inputs.root);
    let trusted = inputs.settings.trust().is_trusted();
    let mut out = Vec::new();
    for source in [LaunchSource::Piarc, LaunchSource::Claude] {
        let name = launch::file_of(source);
        if !loaded.files.contains(&name) {
            continue;
        }
        let file = inputs.root.join(name);
        let mut r = report(SourceKind::Launch, "launch", file.clone(), Scope::Project);
        r.writable = source == LaunchSource::Piarc;
        for config in loaded.configs.iter().filter(|c| c.source == source) {
            let pointer = format!("/configurations/{}", config.name);
            let value = json!(config.display(inputs.root));
            if trusted {
                r.effective.push(item(pointer, value));
            } else {
                r.ignored
                    .push(ignored(pointer, IgnoreReason::Untrusted, None));
            }
        }
        for hidden in loaded.hidden.iter().filter(|c| c.source == source) {
            r.overridden.push(overridden(
                format!("/configurations/{}", hidden.name),
                "launch",
                &inputs.root.join(launch::PIARC_LAUNCH).display().to_string(),
            ));
        }
        for found in loaded.issues.iter().filter(|i| i.file == name) {
            let mut problem = issue(&file, found.message.clone(), found.at.map(|(l, _)| l));
            problem.column = found
                .at
                .and_then(|(_, column)| usize::try_from(column).ok());
            r.issues.push(problem);
        }
        if !trusted && !r.ignored.is_empty() {
            r.status = FileStatus::Untrusted;
        } else if !r.issues.is_empty() && r.effective.is_empty() {
            r.status = FileStatus::Invalid;
        }
        out.push(r);
    }
    out
}

/// `.mcp.json`: the servers it defines that apply, those a higher scope replaces, those PiArc
/// cannot run or the user turned off; untrusted as a whole until the project is trusted.
fn mcp_json(inputs: &Inputs<'_>) -> Option<FileReport> {
    let file = inputs.root.join(piarc_config::mcp::MCP_JSON);
    let mut r = report(SourceKind::McpJson, "mcpJson", file.clone(), Scope::Project);
    if !file.exists() {
        r.status = FileStatus::Missing;
        return Some(r);
    }
    let shown = file.display().to_string();
    let config = crate::mcp::merged_config(
        inputs.settings,
        inputs.root,
        inputs.home,
        inputs.managed.mcp.as_ref(),
    );
    for server in config.servers.iter().filter(|s| s.source == shown) {
        let pointer = format!("/mcpServers/{}", server.name);
        match server.availability {
            McpAvailability::Ready => r.effective.push(item(pointer, json!(server.transport))),
            McpAvailability::Disabled => {
                r.ignored.push(ignored(
                    pointer,
                    IgnoreReason::Disabled,
                    server.reason.clone(),
                ));
            }
            McpAvailability::Unsupported => {
                r.ignored.push(ignored(
                    pointer,
                    IgnoreReason::Unsupported,
                    server.reason.clone(),
                ));
            }
            McpAvailability::Untrusted => {
                r.status = FileStatus::Untrusted;
                r.ignored.push(ignored(
                    pointer,
                    IgnoreReason::Untrusted,
                    server.reason.clone(),
                ));
            }
        }
    }
    for o in config.overridden.iter().filter(|o| o.source == shown) {
        r.overridden
            .push(overridden(format!("/mcpServers/{}", o.name), "mcp", &o.by));
    }
    for i in config.issues.iter().filter(|i| i.source == shown) {
        let mut found = issue(&file, i.message.clone(), None);
        found.pointer.clone_from(&i.pointer);
        r.issues.push(found);
    }
    if r.issues.iter().any(|i| i.pointer.is_empty()) && r.effective.is_empty() {
        r.status = FileStatus::Invalid;
    }
    Some(r)
}

/// The memory files a session starts with: each import it reads applies, an import outside
/// the workspace without the user's approval (or past the depth limit) does not.
fn memory(inputs: &Inputs<'_>) -> Vec<FileReport> {
    let read_both = inputs
        .settings
        .get("/memory/readBoth")
        .and_then(Value::as_bool)
        == Some(true);
    let files = match crate::tool_io::memory_documents(
        inputs.root,
        inputs.home,
        inputs.data,
        &inputs.managed.memory,
        read_both,
    ) {
        Ok(files) => files,
        Err(error) => {
            let mut r = report(
                SourceKind::Memory,
                "memory",
                inputs.root.join("CLAUDE.md"),
                Scope::Project,
            );
            r.status = FileStatus::Invalid;
            r.issues.push(issue(
                inputs.root,
                format!("cannot read memory: {error}"),
                None,
            ));
            return vec![r];
        }
    };
    files
        .into_iter()
        // Rules have their own reports.
        .filter(|f| !is_rule(Path::new(&f.path)))
        .map(|f| {
            let path = PathBuf::from(&f.path);
            let scope = if path.starts_with(inputs.root) {
                Scope::Project
            } else {
                Scope::User
            };
            let mut r = report(SourceKind::Memory, "memory", path, scope);
            for (marker, reason) in [
                ("[Memory source: ", None),
                ("[Memory import not approved: ", Some(IgnoreReason::NotApproved)),
                ("[Memory import denied: ", Some(IgnoreReason::NotApproved)),
                ("[Memory import depth limit: ", Some(IgnoreReason::Unsupported)),
            ] {
                for target in markers(&f.content, marker) {
                    match reason {
                        None => r.effective.push(item(format!("@{target}"), json!(target))),
                        Some(reason) => r.ignored.push(ignored(
                            format!("@{target}"),
                            reason,
                            (reason == IgnoreReason::Unsupported)
                                .then(|| "deeper than four levels of imports".to_owned()),
                        )),
                    }
                }
            }
            r
        })
        .collect()
}

/// The `<target>` of every `<marker><target>]` line in `text`.
fn markers<'a>(text: &'a str, marker: &'a str) -> impl Iterator<Item = &'a str> {
    text.lines().filter_map(move |line| {
        line.trim()
            .strip_prefix(marker)
            .and_then(|rest| rest.strip_suffix(']'))
    })
}

fn is_rule(path: &Path) -> bool {
    path.parent()
        .is_some_and(|dir| dir.ancestors().any(|d| d.ends_with(".claude/rules")))
}

/// Claude Code rules (`~/.claude/rules/`, the workspace root's `.claude/rules/`): one with
/// `paths:` loads only once a matching file is read or written.
fn rules(inputs: &Inputs<'_>) -> Vec<FileReport> {
    let mut dirs = vec![(inputs.root.join(".claude").join("rules"), Scope::Project)];
    if let Some(home) = inputs.home {
        dirs.insert(0, (home.join(".claude").join("rules"), Scope::User));
    }
    let mut out = Vec::new();
    for (dir, scope) in dirs {
        let Ok(files) = piarc_config::rules::rule_files(&dir) else {
            continue;
        };
        for file in files {
            let mut r = report(SourceKind::Rule, "rule", file.clone(), scope);
            match std::fs::read_to_string(&file) {
                Ok(text) => {
                    let rule = piarc_config::rules::parse(&text);
                    match rule.paths {
                        Some(globs) => r.ignored.push(ignored(
                            "/paths",
                            IgnoreReason::Conditional,
                            Some(globs.join(", ")),
                        )),
                        None => r.effective.push(item("/", json!("always loaded"))),
                    }
                }
                Err(error) => {
                    r.status = FileStatus::Invalid;
                    r.issues.push(issue(&file, error.to_string(), None));
                }
            }
            out.push(r);
        }
    }
    out
}

/// One report per file, keyed by path, created on first use.
struct ByFile(BTreeMap<String, FileReport>);

impl ByFile {
    fn at(
        &mut self,
        path: &str,
        kind: SourceKind,
        layer: &'static str,
        scope: Scope,
    ) -> &mut FileReport {
        self.0
            .entry(path.to_owned())
            .or_insert_with(|| report(kind, layer, PathBuf::from(path), scope))
    }
}

fn agent_scope(source: AgentSource) -> Scope {
    match source {
        AgentSource::ProjectPiarc | AgentSource::ProjectClaude => Scope::Project,
        _ => Scope::User,
    }
}

fn agent_warning(w: &AgentWarning) -> Option<IgnoredKey> {
    let field = w.field.clone().unwrap_or_default();
    let (reason, detail) = match w.kind {
        AgentWarningKind::IgnoredField | AgentWarningKind::AliasFallback => {
            (IgnoreReason::Ignored, w.value.clone())
        }
        AgentWarningKind::InactiveField | AgentWarningKind::EffortUnsupported => {
            (IgnoreReason::Planned, w.task.clone())
        }
        AgentWarningKind::ProjectModeIgnored => (IgnoreReason::ProjectMode, w.value.clone()),
        AgentWarningKind::UnsupportedMode | AgentWarningKind::ModeClamped => {
            (IgnoreReason::Unsupported, w.value.clone())
        }
        AgentWarningKind::HooksUntrusted => (IgnoreReason::Untrusted, None),
        #[expect(
            unreachable_patterns,
            reason = "a later warning kind is reported as ignored"
        )]
        _ => (IgnoreReason::Ignored, w.value.clone()),
    };
    Some(ignored(format!("/{field}"), reason, detail))
}

/// Subagent definitions: the type each file defines, the files a nearer one overrides, the
/// fields PiArc ignores, and the files that are not valid definitions.
fn agents(inputs: &Inputs<'_>) -> Vec<FileReport> {
    let loaded = piarc_config::agents::load(&piarc_config::agents::AgentDirs {
        cwd: inputs.root,
        data: Some(inputs.data),
        home: inputs.home,
        packages: &inputs.settings.packages().active,
    });
    let mut files = ByFile(BTreeMap::new());
    for def in &loaded.definitions {
        let view = &def.view;
        let Some(path) = &view.path else {
            continue;
        };
        if view.plugin.is_some() {
            // A package's definitions are listed under the package.
            continue;
        }
        let scope = agent_scope(view.source);
        let r = files.at(path, SourceKind::Agent, "agent", scope);
        r.effective
            .push(item(format!("/{}", view.name), json!(view.description)));
        r.ignored
            .extend(view.warnings.iter().filter_map(agent_warning));
        for other in &view.overrides {
            let o = files.at(other, SourceKind::Agent, "agent", scope);
            o.status = FileStatus::Ignored;
            o.overridden
                .push(overridden(format!("/{}", view.name), "agent", path));
        }
    }
    for i in &loaded.issues {
        let r = files.at(&i.path, SourceKind::Agent, "agent", Scope::Project);
        r.status = FileStatus::Invalid;
        r.issues
            .push(issue(Path::new(&i.path), i.message.clone(), i.line));
    }
    files.0.into_values().collect()
}

fn resource_scope(source: ResourceSource) -> Scope {
    match source {
        ResourceSource::ProjectPiarc
        | ResourceSource::ProjectClaude
        | ResourceSource::ProjectPi => Scope::Project,
        _ => Scope::User,
    }
}

fn resource_warning(w: &ResourceWarning) -> Option<IgnoredKey> {
    let field = w.field.clone().unwrap_or_default();
    let (reason, detail) = match w.kind {
        ResourceWarningKind::IgnoredField => (IgnoreReason::Ignored, w.value.clone()),
        ResourceWarningKind::UnsupportedField => (IgnoreReason::Planned, w.task.clone()),
        ResourceWarningKind::DynamicCommand => {
            (IgnoreReason::Unsupported, Some("!command".to_owned()))
        }
        ResourceWarningKind::InvalidFrontmatter | ResourceWarningKind::InvalidField => {
            (IgnoreReason::Invalid, w.value.clone())
        }
        ResourceWarningKind::Untrusted => (IgnoreReason::Untrusted, None),
        ResourceWarningKind::Denied => (IgnoreReason::Disabled, w.value.clone()),
        // A source that wins over others: the others list it in their own reports.
        ResourceWarningKind::Overridden => return None,
    };
    Some(ignored(format!("/{field}"), reason, detail))
}

/// One skill, command file or output style as `resources` reports it.
struct Resource<'a> {
    kind: SourceKind,
    layer: &'static str,
    name: &'a str,
    path: Option<&'a str>,
    source: ResourceSource,
    overrides: &'a [String],
    warnings: &'a [ResourceWarning],
    /// It has `allowed-tools` or hooks, which need the project's trust.
    executable: bool,
}

fn add_resource(files: &mut ByFile, trusted: bool, e: &Resource<'_>) {
    let Some(path) = e.path else {
        return;
    };
    if e.source == ResourceSource::Plugin {
        // A package's components are listed under the package.
        return;
    }
    let scope = resource_scope(e.source);
    let r = files.at(path, e.kind, e.layer, scope);
    r.effective
        .push(item(format!("/{}", e.name), json!(e.name)));
    r.ignored
        .extend(e.warnings.iter().filter_map(resource_warning));
    if e.executable && scope == Scope::Project && !trusted {
        r.ignored.push(ignored(
            "/allowed-tools",
            IgnoreReason::Untrusted,
            Some("allowed-tools and hooks apply once the project is trusted".to_owned()),
        ));
    }
    for other in e.overrides {
        let o = files.at(other, e.kind, e.layer, scope);
        o.status = FileStatus::Ignored;
        o.overridden
            .push(overridden(format!("/{}", e.name), e.layer, path));
    }
}

/// Skills, command files and output styles: what each file provides, the files a nearer
/// source of the same name overrides, the fields PiArc ignores, the files that are not valid.
fn resources(inputs: &Inputs<'_>) -> Vec<FileReport> {
    let catalog = piarc_config::skills::load(&piarc_config::skills::ResourceDirs {
        cwd: inputs.root,
        data: Some(inputs.data),
        home: inputs.home,
        packages: &inputs.settings.packages().active,
    });
    let trusted = inputs.settings.trust().is_trusted();
    let mut files = ByFile(BTreeMap::new());
    for s in &catalog.skills {
        let i = &s.info;
        add_resource(
            &mut files,
            trusted,
            &Resource {
                kind: SourceKind::Skill,
                layer: "skill",
                name: &i.name,
                path: Some(&i.path),
                source: i.source,
                overrides: &i.overrides,
                warnings: &i.warnings,
                executable: !i.allowed_tools.is_empty() || s.hooks.is_some(),
            },
        );
    }
    for c in &catalog.commands {
        let i = &c.info;
        add_resource(
            &mut files,
            trusted,
            &Resource {
                kind: SourceKind::Command,
                layer: "command",
                name: &i.name,
                path: i.path.as_deref(),
                source: i.source,
                overrides: &i.overrides,
                warnings: &i.warnings,
                executable: !i.allowed_tools.is_empty() || c.hooks.is_some(),
            },
        );
    }
    for st in &catalog.styles {
        let i = &st.info;
        add_resource(
            &mut files,
            trusted,
            &Resource {
                kind: SourceKind::OutputStyle,
                layer: "outputStyle",
                name: &i.name,
                path: i.path.as_deref(),
                source: i.source,
                overrides: &i.overrides,
                warnings: &i.warnings,
                executable: false,
            },
        );
    }
    for i in &catalog.issues {
        let r = files.at(&i.path, SourceKind::Skill, "skill", Scope::Project);
        r.status = FileStatus::Invalid;
        r.issues
            .push(issue(Path::new(&i.path), i.message.clone(), i.line));
    }
    files.0.into_values().collect()
}

/// Installed packages: on and in use, off, or waiting for the project's trust; their
/// components, the executable items nobody confirmed, and what PiArc does not support.
fn packages(list: &PackagesList, trusted: bool) -> Vec<FileReport> {
    list.packages
        .iter()
        .map(|p| {
            let scope = match p.scope {
                Some(PackageScope::Project) => Scope::Project,
                _ => Scope::User,
            };
            let mut r = report(SourceKind::Plugin, "plugin", PathBuf::from(&p.path), scope);
            r.status = if p.active {
                FileStatus::Loaded
            } else if p.enabled && scope == Scope::Project && !trusted {
                FileStatus::Untrusted
            } else {
                FileStatus::Ignored
            };
            let c = &p.components;
            for (kind, names) in [
                ("skills", &c.skills),
                ("commands", &c.commands),
                ("agents", &c.agents),
                ("hooks", &c.hooks),
                ("mcpServers", &c.mcp_servers),
                ("extensions", &c.extensions),
            ] {
                for name in names {
                    r.effective
                        .push(item(format!("/{kind}/{name}"), json!(p.id)));
                }
            }
            if !p.enabled {
                r.ignored
                    .push(ignored("/", IgnoreReason::Disabled, Some(p.id.clone())));
            }
            for e in p.executables.iter().filter(|e| !e.confirmed) {
                r.ignored.push(ignored(
                    format!("/{}", e.name),
                    IgnoreReason::Unconfirmed,
                    None,
                ));
            }
            for part in &p.unsupported {
                r.ignored
                    .push(ignored(format!("/{part}"), IgnoreReason::Unsupported, None));
            }
            for message in &p.issues {
                r.issues
                    .push(issue(Path::new(&p.path), message.clone(), None));
            }
            r
        })
        .collect()
}

/// The managed settings (T47, design addendum section 8.3): one report per document, then
/// Claude Code's `managed-mcp.json`; "not configured" when the administrator placed nothing.
fn enterprise(managed: &crate::managed::Snapshot) -> Vec<FileReport> {
    let mut out = managed.managed.reports();
    if let Some(mcp) = &managed.mcp {
        let mut r = report(
            SourceKind::Enterprise,
            "enterprise",
            mcp.location.clone(),
            Scope::Enterprise,
        );
        r.format = Format::ClaudeCode;
        r.status = if mcp.servers.is_some() {
            FileStatus::Loaded
        } else {
            FileStatus::Invalid
        };
        for name in mcp
            .servers
            .iter()
            .filter_map(Value::as_object)
            .flat_map(|m| m.keys())
        {
            let mut pointer = "/mcpServers".to_owned();
            piarc_config::schema::push_token(&mut pointer, name);
            r.effective.push(item(pointer, json!("exclusive")));
        }
        if let Some(problem) = &mcp.problem {
            r.issues.push(issue(&mcp.location, problem.clone(), None));
        }
        out.push(r);
    }
    if out.is_empty() && managed.memory.is_empty() {
        let mut r = report(
            SourceKind::Enterprise,
            "enterprise",
            PathBuf::new(),
            Scope::Enterprise,
        );
        r.status = FileStatus::NotConfigured;
        out.push(r);
    }
    out
}

#[cfg(test)]
#[path = "sources_tests.rs"]
mod tests;
