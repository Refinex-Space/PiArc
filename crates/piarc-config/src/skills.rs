//! Skills, slash command files, Pi prompt templates and output styles (T37, architecture
//! section 6.7, ADR-0054): where they are found, what their frontmatter means and which file
//! of a name wins.
//!
//! Sources, highest first (ADR-0054 rule 2): project before user; within a level `.piarc`,
//! then `.claude`, then Pi's directories. Project directories are looked up from `cwd` upward
//! (nearer first; the home directory is the user level and is skipped), like subagent
//! definitions ([`crate::agents`]).
//!
//! | Kind | Project | User |
//! |---|---|---|
//! | skills | `.piarc/skills/`, `.claude/skills/`, `.pi/skills/` + `.agents/skills/` | `<data>/skills/`, `~/.claude/skills/`, `<data>/pi/skills/` + `~/.agents/skills/` |
//! | commands | `.piarc/commands/`, `.claude/commands/`, `.pi/prompts/` | `<data>/commands/`, `~/.claude/commands/`, `<data>/pi/prompts/` |
//! | output styles | `.piarc/output-styles/`, `.claude/output-styles/` | `<data>/output-styles/`, `~/.claude/output-styles/` |
//!
//! Every source is read whether or not the project is trusted (skills are instructions, like
//! memory files); Core withholds an untrusted project's `allowed-tools` and hooks.

pub mod args;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use piarc_protocol::skills::{
    CommandInfo, CommandKind, OutputStyleInfo, ResourceIssue, ResourceSource, ResourceWarning,
    ResourceWarningKind, SkillInfo, SkillVisibility,
};
use serde_json::{Map, Value};

use crate::frontmatter;

/// The largest file read.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;

/// Longest name.
const MAX_NAME_CHARS: usize = 64;

/// The skill file of a skill directory.
pub const SKILL_FILE: &str = "SKILL.md";

/// Built-in output styles (Claude Code's setting values; `Default` adds no instructions).
pub const BUILT_IN_STYLES: &[&str] = &["Default", "Concise", "Explanatory", "Proactive"];

/// The style used when the setting names none.
pub const DEFAULT_STYLE: &str = "Default";

/// A built-in command: name, aliases, argument hint (ADR-0054 rule 13).
pub const BUILT_IN_COMMANDS: &[(&str, &[&str], Option<&str>)] = &[
    ("compact", &[], Some("[focus]")),
    ("clear", &["reset", "new"], None),
    ("model", &[], Some("[model]")),
    ("rewind", &["checkpoint"], None),
    ("context", &[], None),
    ("output-style", &[], Some("[style]")),
    ("help", &[], None),
];

/// Skill frontmatter fields PiArc applies.
const SKILL_FIELDS: &[&str] = &[
    "name",
    "description",
    "when_to_use",
    "argument-hint",
    "arguments",
    "disable-model-invocation",
    "user-invocable",
    "allowed-tools",
    "paths",
    "hooks",
];

/// Fields read but not supported yet, with the task that will.
const UNSUPPORTED_FIELDS: &[(&str, &str)] = &[
    ("context", "T48"),
    ("agent", "T48"),
    ("background", "T48"),
    ("model", "T48"),
    ("effort", "T48"),
];

/// Where files are looked up.
#[derive(Debug, Clone, Copy)]
pub struct ResourceDirs<'a> {
    /// The directory project files are looked up from (a session's cwd).
    pub cwd: &'a Path,
    /// PiArc's data directory (user files; Pi's agent directory is its `pi/`).
    pub data: Option<&'a Path>,
    /// The home directory (`~/.claude/`, `~/.agents/`); `None` reads no user files there.
    pub home: Option<&'a Path>,
}

/// A skill in effect, with its body and hooks.
#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    /// What the Agent Host and the client see.
    pub info: SkillInfo,
    /// The text after the frontmatter.
    pub body: String,
    /// The frontmatter `hooks` object, as written.
    pub hooks: Option<Value>,
}

/// A command file or Pi prompt template in effect.
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    /// What the client sees.
    pub info: CommandInfo,
    /// The text after the frontmatter.
    pub body: String,
    /// The frontmatter `hooks` object, as written.
    pub hooks: Option<Value>,
}

/// A custom output style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputStyle {
    /// What the client sees; `instructions` holds the body.
    pub info: OutputStyleInfo,
}

/// Everything found from one directory, merged by name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Catalog {
    /// Skills in effect, in precedence order.
    pub skills: Vec<Skill>,
    /// Command files and templates in effect, in precedence order.
    pub commands: Vec<Command>,
    /// Custom output styles in effect (a name of a built-in style is overridden by it).
    pub styles: Vec<OutputStyle>,
    /// Files that are not valid skills, commands or styles.
    pub issues: Vec<ResourceIssue>,
}

impl Catalog {
    /// The skill in effect for `name`.
    #[must_use]
    pub fn skill(&self, name: &str) -> Option<&Skill> {
        self.skills.iter().find(|s| s.info.name == name)
    }

    /// The command file in effect for `name`.
    #[must_use]
    pub fn command(&self, name: &str) -> Option<&Command> {
        self.commands.iter().find(|c| c.info.name == name)
    }
}

/// Whether files from `source` are project configuration (trust).
#[must_use]
pub fn is_project(source: ResourceSource) -> bool {
    matches!(
        source,
        ResourceSource::ProjectPiarc | ResourceSource::ProjectClaude | ResourceSource::ProjectPi
    )
}

/// One directory to read and how.
struct SourceDir {
    source: ResourceSource,
    dir: PathBuf,
    /// Pi's skill directories also take `*.md` files at their top as skills.
    pi_root_files: bool,
}

fn ancestors<'a>(dirs: &ResourceDirs<'a>) -> Vec<&'a Path> {
    dirs.cwd
        .ancestors()
        .filter(|dir| dirs.home != Some(*dir))
        .collect()
}

fn source(source: ResourceSource, dir: PathBuf, pi_root_files: bool) -> SourceDir {
    SourceDir {
        source,
        dir,
        pi_root_files,
    }
}

/// The skill directories, highest precedence first.
fn skill_dirs(dirs: &ResourceDirs<'_>) -> Vec<SourceDir> {
    let walk = ancestors(dirs);
    let mut out = Vec::new();
    for (kind, parent) in [
        (ResourceSource::ProjectPiarc, ".piarc"),
        (ResourceSource::ProjectClaude, ".claude"),
    ] {
        for dir in &walk {
            out.push(source(kind, dir.join(parent).join("skills"), false));
        }
    }
    // Pi reads `.pi/skills/` of the directory itself and `.agents/skills/` upward.
    out.push(source(
        ResourceSource::ProjectPi,
        dirs.cwd.join(".pi").join("skills"),
        true,
    ));
    for dir in &walk {
        out.push(source(
            ResourceSource::ProjectPi,
            dir.join(".agents").join("skills"),
            false,
        ));
    }
    if let Some(data) = dirs.data {
        out.push(source(ResourceSource::User, data.join("skills"), false));
    }
    if let Some(home) = dirs.home {
        out.push(source(
            ResourceSource::UserClaude,
            home.join(".claude").join("skills"),
            false,
        ));
    }
    if let Some(data) = dirs.data {
        out.push(source(
            ResourceSource::UserPi,
            data.join("pi").join("skills"),
            true,
        ));
    }
    if let Some(home) = dirs.home {
        out.push(source(
            ResourceSource::UserPi,
            home.join(".agents").join("skills"),
            false,
        ));
    }
    out
}

/// The command directories, highest precedence first.
fn command_dirs(dirs: &ResourceDirs<'_>) -> Vec<SourceDir> {
    let walk = ancestors(dirs);
    let mut out = Vec::new();
    for (kind, parent) in [
        (ResourceSource::ProjectPiarc, ".piarc"),
        (ResourceSource::ProjectClaude, ".claude"),
    ] {
        for dir in &walk {
            out.push(source(kind, dir.join(parent).join("commands"), false));
        }
    }
    out.push(source(
        ResourceSource::ProjectPi,
        dirs.cwd.join(".pi").join("prompts"),
        false,
    ));
    if let Some(data) = dirs.data {
        out.push(source(ResourceSource::User, data.join("commands"), false));
    }
    if let Some(home) = dirs.home {
        out.push(source(
            ResourceSource::UserClaude,
            home.join(".claude").join("commands"),
            false,
        ));
    }
    if let Some(data) = dirs.data {
        out.push(source(
            ResourceSource::UserPi,
            data.join("pi").join("prompts"),
            false,
        ));
    }
    out
}

/// The output style directories, highest precedence first.
fn style_dirs(dirs: &ResourceDirs<'_>) -> Vec<SourceDir> {
    let walk = ancestors(dirs);
    let mut out = Vec::new();
    for (kind, parent) in [
        (ResourceSource::ProjectPiarc, ".piarc"),
        (ResourceSource::ProjectClaude, ".claude"),
    ] {
        for dir in &walk {
            out.push(source(kind, dir.join(parent).join("output-styles"), false));
        }
    }
    if let Some(data) = dirs.data {
        out.push(source(
            ResourceSource::User,
            data.join("output-styles"),
            false,
        ));
    }
    if let Some(home) = dirs.home {
        out.push(source(
            ResourceSource::UserClaude,
            home.join(".claude").join("output-styles"),
            false,
        ));
    }
    out
}

/// The directories whose changes can change the catalog: every source directory and the
/// directories below it (skill directories, command namespaces), at most `MAX_WATCH_DEPTH`
/// levels down. A source that does not exist is listed as it is (the caller watches its
/// nearest existing ancestor).
#[must_use]
pub fn watch_dirs(dirs: &ResourceDirs<'_>) -> Vec<PathBuf> {
    const MAX_WATCH_DEPTH: usize = 3;
    fn below(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if !hidden && path.is_dir() && entry.file_name() != "node_modules" {
                out.push(path.clone());
                below(&path, depth - 1, out);
            }
        }
    }
    let mut out = Vec::new();
    for source in skill_dirs(dirs)
        .into_iter()
        .chain(command_dirs(dirs))
        .chain(style_dirs(dirs))
    {
        below(&source.dir, MAX_WATCH_DEPTH, &mut out);
        out.push(source.dir);
    }
    out.sort();
    out.dedup();
    out
}

/// Reads every source and merges each kind by name.
#[must_use]
pub fn load(dirs: &ResourceDirs<'_>) -> Catalog {
    let mut catalog = Catalog::default();
    let mut seen_files = BTreeSet::new();
    for dir in skill_dirs(dirs) {
        for path in skill_files(&dir, &mut catalog.issues) {
            if !seen_files.insert(path.clone()) {
                continue;
            }
            let text = match read(&path, &dir) {
                Ok(text) => text,
                Err(issue) => {
                    catalog.issues.push(issue);
                    continue;
                }
            };
            // Pi takes a top-level `*.md` file as a skill only when it has a description.
            if path.file_name().is_some_and(|n| n != SKILL_FILE) && !declares_description(&text) {
                continue;
            }
            match parse_skill(&path, dir.source, &text) {
                Ok(skill) => add_skill(&mut catalog.skills, skill),
                Err(issue) => catalog.issues.push(issue),
            }
        }
    }
    for dir in command_dirs(dirs) {
        let files = match crate::rules::rule_files(&dir.dir) {
            Ok(files) => files,
            Err(error) => {
                catalog
                    .issues
                    .push(issue(&dir.dir, None, format!("cannot list: {error}")));
                continue;
            }
        };
        for path in files {
            let name = command_name(&dir.dir, &path, dir.source == ResourceSource::ProjectPi);
            match read(&path, &dir).and_then(|text| parse_command(&path, dir.source, &name, &text))
            {
                Ok(command) => add_command(&mut catalog.commands, command),
                Err(issue) => catalog.issues.push(issue),
            }
        }
    }
    for dir in style_dirs(dirs) {
        let files = match crate::rules::rule_files(&dir.dir) {
            Ok(files) => files,
            Err(error) => {
                catalog
                    .issues
                    .push(issue(&dir.dir, None, format!("cannot list: {error}")));
                continue;
            }
        };
        for path in files {
            match read(&path, &dir).and_then(|text| parse_style(&path, dir.source, &text)) {
                Ok(style) => add_style(&mut catalog.styles, style),
                Err(issue) => catalog.issues.push(issue),
            }
        }
    }
    catalog
}

fn declares_description(text: &str) -> bool {
    frontmatter::split(text)
        .yaml
        .and_then(|yaml| frontmatter::mapping(yaml).ok())
        .and_then(|map| {
            map.get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|d| !d.trim().is_empty())
}

fn add_skill(skills: &mut Vec<Skill>, skill: Skill) {
    match skills.iter_mut().find(|s| s.info.name == skill.info.name) {
        Some(winner) => winner.info.overrides.push(skill.info.path),
        None => skills.push(skill),
    }
}

fn add_command(commands: &mut Vec<Command>, command: Command) {
    match commands
        .iter_mut()
        .find(|c| c.info.name == command.info.name)
    {
        Some(winner) => winner.info.overrides.extend(command.info.path),
        None => commands.push(command),
    }
}

fn add_style(styles: &mut Vec<OutputStyle>, mut style: OutputStyle) {
    if BUILT_IN_STYLES.contains(&style.info.name.as_str()) {
        style.info.warnings.push(warning(
            ResourceWarningKind::Overridden,
            None,
            Some("builtIn"),
            None,
        ));
    }
    match styles.iter_mut().find(|s| s.info.name == style.info.name) {
        Some(winner) => winner.info.overrides.extend(style.info.path),
        None => styles.push(style),
    }
}

fn issue(path: &Path, line: Option<u64>, message: impl Into<String>) -> ResourceIssue {
    ResourceIssue {
        path: path.display().to_string(),
        line,
        message: message.into(),
    }
}

fn warning(
    kind: ResourceWarningKind,
    field: Option<&str>,
    value: Option<&str>,
    task: Option<&str>,
) -> ResourceWarning {
    ResourceWarning {
        kind,
        field: field.map(str::to_owned),
        value: value.map(str::to_owned),
        task: task.map(str::to_owned),
    }
}

/// Reads a resource file of `dir`. A project's file must stay within the project directory
/// that holds the source (`<dir>/../..`) once links are resolved: a link to a file elsewhere
/// would put that file into the system prompt or a `Skill` result without the approval reading
/// it takes (R4 E2). The user's own sources may link anywhere.
fn read(path: &Path, dir: &SourceDir) -> Result<String, ResourceIssue> {
    if is_project(dir.source) && !crate::executables::stays_in_project(&dir.dir, path) {
        return Err(issue(
            path,
            None,
            "links to a file outside the project directory".to_owned(),
        ));
    }
    let size = std::fs::metadata(path)
        .map_err(|e| issue(path, None, format!("cannot read: {e}")))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(issue(
            path,
            None,
            format!("larger than {MAX_FILE_BYTES} bytes"),
        ));
    }
    std::fs::read_to_string(path).map_err(|e| issue(path, None, format!("cannot read: {e}")))
}

/// The skill files below a skill directory: each `SKILL.md` (not looking further below a
/// directory that has one), and for Pi's directories the `*.md` files at the top.
fn skill_files(dir: &SourceDir, issues: &mut Vec<ResourceIssue>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut visited = BTreeSet::new();
    if let Err(error) = find_skills(&dir.dir, true, dir.pi_root_files, &mut visited, &mut out) {
        issues.push(issue(&dir.dir, None, format!("cannot list: {error}")));
    }
    out
}

fn find_skills(
    dir: &Path,
    top: bool,
    root_files: bool,
    visited: &mut BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    let canonical = match dir.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if top && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) if !top => return Ok(()),
        Err(error) => return Err(error),
    };
    if !visited.insert(canonical) {
        return Ok(());
    }
    let skill = dir.join(SKILL_FILE);
    if !top && skill.is_file() {
        out.push(skill);
        return Ok(());
    }
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(error) if top && error.kind() == std::io::ErrorKind::NotADirectory => return Ok(()),
        Err(error) => return Err(error),
    };
    entries.sort();
    for path in entries {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        if name
            .as_deref()
            .is_none_or(|n| n.starts_with('.') || n == "node_modules")
        {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            find_skills(&path, false, root_files, visited, out)?;
        } else if top
            && root_files
            && meta.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
    Ok(())
}

/// A command's name: its path below `dir` without the extension, `/` replaced by `:`; a Pi
/// template's file stem.
fn command_name(dir: &Path, path: &Path, flat: bool) -> String {
    let stem = path.with_extension("");
    if flat {
        return stem
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    let relative = stem.strip_prefix(dir).unwrap_or(&stem);
    relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

/// Whether `name` may name a skill, command or style.
#[must_use]
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        && !name.starts_with([':', '.'])
}

/// The parts of a frontmatter every kind reads, and its warnings.
struct Front<'t> {
    yaml: Option<&'t str>,
    map: Map<String, Value>,
    body: &'t str,
    warnings: Vec<ResourceWarning>,
}

impl<'t> Front<'t> {
    fn new(text: &'t str) -> Self {
        let document = frontmatter::split(text);
        let mut warnings = Vec::new();
        let map = match document.yaml.map(frontmatter::mapping) {
            None => Map::new(),
            Some(Ok(map)) => map,
            Some(Err(invalid)) => {
                warnings.push(warning(
                    ResourceWarningKind::InvalidFrontmatter,
                    None,
                    Some(&invalid.message),
                    None,
                ));
                Map::new()
            }
        };
        Self {
            yaml: document.yaml,
            map,
            body: document.body,
            warnings,
        }
    }

    fn invalid(&mut self, key: &str) {
        self.warnings.push(warning(
            ResourceWarningKind::InvalidField,
            Some(key),
            None,
            None,
        ));
    }

    fn text(&mut self, key: &str) -> Option<String> {
        match self.map.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                let text = text.trim();
                (!text.is_empty()).then(|| text.to_owned())
            }
            Some(Value::Number(n)) => Some(n.to_string()),
            Some(_) => {
                self.invalid(key);
                None
            }
        }
    }

    /// A boolean; Claude Code also accepts `yes`, `no`, `on`, `off`, `1`, `0`.
    fn flag(&mut self, key: &str) -> Option<bool> {
        match self.map.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::Bool(flag)) => Some(*flag),
            Some(Value::Number(n)) if n.as_u64() == Some(0) => Some(false),
            Some(Value::Number(n)) if n.as_u64() == Some(1) => Some(true),
            Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" | "1" => Some(true),
                "false" | "no" | "off" | "0" => Some(false),
                _ => {
                    self.invalid(key);
                    None
                }
            },
            Some(_) => {
                self.invalid(key);
                None
            }
        }
    }

    /// A YAML list of strings, or one string split by `split`.
    fn list(&mut self, key: &str, split: fn(&str) -> Vec<String>) -> Vec<String> {
        match self.map.get(key) {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::String(text)) => split(text),
            Some(Value::Array(values)) => {
                let mut items = Vec::new();
                for value in values {
                    match value {
                        Value::String(text) if !text.trim().is_empty() => {
                            items.push(text.trim().to_owned());
                        }
                        Value::String(_) => {}
                        _ => {
                            self.invalid(key);
                            return Vec::new();
                        }
                    }
                }
                items
            }
            Some(_) => {
                self.invalid(key);
                Vec::new()
            }
        }
    }

    fn hooks(&mut self) -> Option<Value> {
        match self.map.get("hooks") {
            None | Some(Value::Null) => None,
            Some(value @ Value::Object(_)) => Some(value.clone()),
            Some(_) => {
                self.invalid("hooks");
                None
            }
        }
    }

    /// Warns about the fields outside `applied`.
    fn remaining(&mut self, applied: &[&str]) {
        let keys: Vec<String> = self
            .map
            .keys()
            .filter(|k| !applied.contains(&k.as_str()))
            .cloned()
            .collect();
        for key in keys {
            let unsupported = UNSUPPORTED_FIELDS.iter().find(|(field, _)| *field == key);
            self.warnings.push(match unsupported {
                Some((_, task)) => warning(
                    ResourceWarningKind::UnsupportedField,
                    Some(&key),
                    None,
                    Some(task),
                ),
                None => warning(ResourceWarningKind::IgnoredField, Some(&key), None, None),
            });
        }
        if has_dynamic_command(self.body) {
            self.warnings.push(warning(
                ResourceWarningKind::DynamicCommand,
                None,
                None,
                None,
            ));
        }
    }

    fn description(&mut self) -> String {
        self.text("description")
            .unwrap_or_else(|| first_line(self.body))
    }

    fn line(&self, key: &str) -> Option<u64> {
        self.yaml.and_then(|yaml| frontmatter::line_of(yaml, key))
    }
}

/// The first non-empty line of `body`, without Markdown heading marks.
fn first_line(body: &str) -> String {
    body.lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(250)
        .collect()
}

/// Splits on commas, or on whitespace outside parentheses (`Bash(git add *) Read`).
#[must_use]
pub fn split_tools(text: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut item = String::new();
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '(' => {
                depth += 1;
                item.push(c);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                item.push(c);
            }
            ',' if depth == 0 => items.push(std::mem::take(&mut item)),
            c if c.is_whitespace() && depth == 0 => items.push(std::mem::take(&mut item)),
            c => item.push(c),
        }
    }
    items.push(item);
    items
        .into_iter()
        .map(|i| i.trim().to_owned())
        .filter(|i| !i.is_empty())
        .collect()
}

fn split_commas(text: &str) -> Vec<String> {
    text.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn split_spaces(text: &str) -> Vec<String> {
    text.split([' ', ',', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether `body` has a `` !`command` `` (at a line start or after whitespace) or a
/// ```` ```! ```` block, which Claude Code runs while loading and PiArc does not.
#[must_use]
pub fn has_dynamic_command(body: &str) -> bool {
    body.lines().any(|line| {
        if line.trim_start().starts_with("```!") {
            return true;
        }
        let bytes = line.as_bytes();
        line.match_indices("!`").any(|(at, _)| {
            let after_space = at == 0 || bytes.get(at - 1).is_some_and(u8::is_ascii_whitespace);
            after_space && line[at + 2..].contains('`')
        })
    })
}

/// Parses one skill file of `source`.
///
/// # Errors
///
/// Its name is not valid.
pub fn parse_skill(
    path: &Path,
    source: ResourceSource,
    text: &str,
) -> Result<Skill, ResourceIssue> {
    let mut front = Front::new(text);
    let dir = path.parent().unwrap_or(path);
    let default_name = if path.file_name().is_some_and(|n| n == SKILL_FILE) {
        dir.file_name()
    } else {
        path.file_stem()
    }
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_default();
    let name = front.text("name").unwrap_or(default_name);
    if !valid_name(&name) {
        return Err(issue(
            path,
            front.line("name").or(Some(1)),
            format!("invalid skill name {name:?}: 1-64 letters, digits, '-', '_', '.' or ':'"),
        ));
    }
    let mut description = front.description();
    if let Some(when) = front.text("when_to_use") {
        description = if description.is_empty() {
            when
        } else {
            format!("{description}\n{when}")
        };
    }
    let argument_hint = front.text("argument-hint");
    let arguments = front.list("arguments", split_spaces);
    let disabled = front.flag("disable-model-invocation").unwrap_or(false);
    let user_invocable = front.flag("user-invocable").unwrap_or(true);
    let allowed_tools = front.list("allowed-tools", split_tools);
    let paths = front.list("paths", split_commas);
    let hooks = front.hooks();
    front.remaining(SKILL_FIELDS);
    let info = SkillInfo {
        name,
        description,
        source,
        path: path.display().to_string(),
        dir: dir.display().to_string(),
        argument_hint,
        arguments,
        model_invocable: !disabled,
        user_invocable,
        visibility: SkillVisibility::On,
        allowed_tools,
        paths,
        hooks: hooks.is_some(),
        overrides: Vec::new(),
        warnings: std::mem::take(&mut front.warnings),
    };
    Ok(Skill {
        info,
        body: front.body.to_owned(),
        hooks,
    })
}

/// Parses one command file (or Pi template) named `name`.
///
/// # Errors
///
/// Its name is not valid.
pub fn parse_command(
    path: &Path,
    source: ResourceSource,
    name: &str,
    text: &str,
) -> Result<Command, ResourceIssue> {
    if !valid_name(name) {
        return Err(issue(
            path,
            None,
            format!("invalid command name {name:?}: 1-64 letters, digits, '-', '_', '.' or ':'"),
        ));
    }
    let mut front = Front::new(text);
    let description = front.description();
    let argument_hint = front.text("argument-hint");
    let arguments = front.list("arguments", split_spaces);
    let allowed_tools = front.list("allowed-tools", split_tools);
    let hooks = front.hooks();
    // Claude Code reads `disable-model-invocation` and `user-invocable` on command files as
    // on skills; a command is not in the model's index, so only `user-invocable` matters.
    let user_invocable = front.flag("user-invocable").unwrap_or(true);
    let _ = front.flag("disable-model-invocation");
    front.remaining(&[
        "description",
        "argument-hint",
        "arguments",
        "allowed-tools",
        "hooks",
        "user-invocable",
        "disable-model-invocation",
    ]);
    if !user_invocable {
        return Err(issue(
            path,
            front.line("user-invocable"),
            "user-invocable is false: a command file nobody can run",
        ));
    }
    let info = CommandInfo {
        name: name.to_owned(),
        kind: CommandKind::Command,
        source,
        description,
        path: Some(path.display().to_string()),
        argument_hint,
        arguments,
        aliases: Vec::new(),
        allowed_tools,
        overrides: Vec::new(),
        warnings: std::mem::take(&mut front.warnings),
    };
    Ok(Command {
        info,
        body: front.body.to_owned(),
        hooks,
    })
}

/// Parses one output style file.
///
/// # Errors
///
/// Its name is not valid.
pub fn parse_style(
    path: &Path,
    source: ResourceSource,
    text: &str,
) -> Result<OutputStyle, ResourceIssue> {
    let mut front = Front::new(text);
    let default_name = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = front.text("name").unwrap_or(default_name);
    if name.trim().is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(issue(
            path,
            front.line("name").or(Some(1)),
            format!("invalid style name {name:?}"),
        ));
    }
    let description = front.text("description").unwrap_or_default();
    // PiArc's identity section always stays; plugins' forced styles come with T40.
    let _ = front.flag("keep-coding-instructions");
    if front.map.contains_key("force-for-plugin") {
        front.warnings.push(warning(
            ResourceWarningKind::UnsupportedField,
            Some("force-for-plugin"),
            None,
            Some("T40"),
        ));
    }
    front.remaining(&["name", "description", "force-for-plugin"]);
    let info = OutputStyleInfo {
        name,
        description,
        source,
        path: Some(path.display().to_string()),
        instructions: Some(front.body.trim().to_owned()),
        overrides: Vec::new(),
        warnings: std::mem::take(&mut front.warnings),
    };
    Ok(OutputStyle { info })
}

/// Applies Claude Code's `skillOverrides` (`{name: "on" | "name-only" | "user-invocable-only"
/// | "off"}`); unknown values are left out.
pub fn apply_visibility(skills: &mut [Skill], overrides: Option<&Value>) {
    let Some(Value::Object(map)) = overrides else {
        return;
    };
    for skill in skills {
        let visibility = match map.get(&skill.info.name).and_then(Value::as_str) {
            Some("on") => SkillVisibility::On,
            Some("name-only") => SkillVisibility::NameOnly,
            Some("user-invocable-only") => SkillVisibility::UserInvocableOnly,
            Some("off") => SkillVisibility::Off,
            _ => continue,
        };
        skill.info.visibility = visibility;
        if matches!(
            visibility,
            SkillVisibility::UserInvocableOnly | SkillVisibility::Off
        ) {
            skill.info.model_invocable = false;
        }
        if visibility == SkillVisibility::Off {
            skill.info.user_invocable = false;
        }
    }
}

/// The merged slash command list (ADR-0054 rules 2 and 13): built-in commands first, then
/// command files and the skills the user may invoke by source precedence (a skill before a
/// command file of the same source). A later entry of a taken name records itself on the
/// winner.
#[must_use]
pub fn commands(catalog: &Catalog) -> Vec<CommandInfo> {
    let mut out: Vec<CommandInfo> = BUILT_IN_COMMANDS
        .iter()
        .map(|(name, aliases, hint)| CommandInfo {
            name: (*name).to_owned(),
            kind: CommandKind::BuiltIn,
            source: ResourceSource::BuiltIn,
            description: String::new(),
            path: None,
            argument_hint: hint.map(str::to_owned),
            arguments: Vec::new(),
            aliases: aliases.iter().map(|a| (*a).to_owned()).collect(),
            allowed_tools: Vec::new(),
            overrides: Vec::new(),
            warnings: Vec::new(),
        })
        .collect();
    let mut entries: Vec<(u8, u8, CommandInfo)> = Vec::new();
    for skill in catalog.skills.iter().filter(|s| s.info.user_invocable) {
        entries.push((
            rank(skill.info.source),
            0,
            CommandInfo {
                name: skill.info.name.clone(),
                kind: CommandKind::Skill,
                source: skill.info.source,
                description: skill.info.description.clone(),
                path: Some(skill.info.path.clone()),
                argument_hint: skill.info.argument_hint.clone(),
                arguments: skill.info.arguments.clone(),
                aliases: Vec::new(),
                allowed_tools: skill.info.allowed_tools.clone(),
                overrides: Vec::new(),
                warnings: Vec::new(),
            },
        ));
    }
    for command in &catalog.commands {
        entries.push((rank(command.info.source), 1, command.info.clone()));
    }
    // Stable: within a source and kind the catalog's order (nearer directories first) stays.
    entries.sort_by_key(|(rank, kind, _)| (*rank, *kind));
    let mut taken: BTreeMap<String, usize> = BTreeMap::new();
    for (index, command) in out.iter().enumerate() {
        taken.insert(command.name.clone(), index);
        for alias in &command.aliases {
            taken.insert(alias.clone(), index);
        }
    }
    for (_, _, command) in entries {
        if let Some(&index) = taken.get(&command.name) {
            let loser = command.path.clone().unwrap_or_else(|| command.name.clone());
            if let Some(winner) = out.get_mut(index) {
                winner.overrides.push(loser);
            }
            continue;
        }
        taken.insert(command.name.clone(), out.len());
        out.push(command);
    }
    out
}

/// Precedence rank of a source (lower first).
#[must_use]
pub fn rank(source: ResourceSource) -> u8 {
    match source {
        ResourceSource::BuiltIn => 0,
        ResourceSource::ProjectPiarc => 1,
        ResourceSource::ProjectClaude => 2,
        ResourceSource::ProjectPi => 3,
        ResourceSource::User => 4,
        ResourceSource::UserClaude => 5,
        ResourceSource::UserPi => 6,
        ResourceSource::Plugin => 7,
        ResourceSource::Mcp => 8,
    }
}

/// The output styles: built-in ones, then the custom ones not named like a built-in style.
#[must_use]
pub fn styles(catalog: &Catalog) -> Vec<OutputStyleInfo> {
    let mut out: Vec<OutputStyleInfo> = BUILT_IN_STYLES
        .iter()
        .map(|name| OutputStyleInfo {
            name: (*name).to_owned(),
            description: String::new(),
            source: ResourceSource::BuiltIn,
            path: None,
            instructions: None,
            overrides: catalog
                .styles
                .iter()
                .filter(|s| s.info.name == *name)
                .filter_map(|s| s.info.path.clone())
                .collect(),
            warnings: Vec::new(),
        })
        .collect();
    out.extend(
        catalog
            .styles
            .iter()
            .filter(|s| !BUILT_IN_STYLES.contains(&s.info.name.as_str()))
            .map(|s| s.info.clone()),
    );
    out
}

/// The style the setting `value` names: `(name in effect, missing setting value)`.
#[must_use]
pub fn current_style(
    styles: &[OutputStyleInfo],
    value: Option<&Value>,
) -> (String, Option<String>) {
    match value.and_then(Value::as_str) {
        None => (DEFAULT_STYLE.to_owned(), None),
        Some(name) if styles.iter().any(|s| s.name == name) => (name.to_owned(), None),
        Some(name) => (DEFAULT_STYLE.to_owned(), Some(name.to_owned())),
    }
}

/// `/name arguments` at the start of `text`: the name and the arguments as typed.
#[must_use]
pub fn slash_command(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim_start().strip_prefix('/')?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let name = &rest[..end];
    valid_name(name).then(|| (name, rest[end..].trim()))
}

/// Variables a body may use (`${CLAUDE_SKILL_DIR}` and the like).
#[must_use]
pub fn variables<'a>(
    dir: Option<&Path>,
    session_id: &str,
    project: &Path,
) -> Vec<(&'a str, String)> {
    let mut vars = vec![
        ("CLAUDE_SESSION_ID", session_id.to_owned()),
        ("CLAUDE_PROJECT_DIR", project.display().to_string()),
    ];
    if let Some(dir) = dir {
        vars.push(("CLAUDE_SKILL_DIR", dir.display().to_string()));
    }
    vars
}

#[cfg(test)]
mod tests;
