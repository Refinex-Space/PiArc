//! Skills, slash commands and output styles (architecture section 6.7, T37, ADR-0054). Needs
//! the handshake capability `skills`.
//!
//! - `skills/list` (Agent Host → Core): the skills, commands and custom output styles found
//!   from a session's directory (project `.piarc/`, `.claude/` and Pi directories from the
//!   directory upward, then the user's), merged by name, with the current output style. Core
//!   reads the files: it owns the home directory, project trust and the permission rules.
//! - `skills/invoke` (Agent Host → Core): the `Skill` tool loads a skill. Core consumes the
//!   call's approval, substitutes the arguments, grants `allowed-tools` for the current turn
//!   and scopes the skill's hooks to the session.
//! - `skills/match` (Agent Host → Core): which `paths` skills a file the session touched
//!   activates.
//! - `resources/listSkills`, `resources/listCommands` (Core → Agent Host): the lists the
//!   client shows, with the Agent Host's own sources merged in (plugins and MCP prompts, T40).
//! - `resources/reload` (Core → Agent Host): skill, command, style or settings files changed.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::request;

/// Where a skill, command or output style came from, highest precedence first (ADR-0054).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResourceSource {
    /// Shipped with PiArc (built-in commands and output styles).
    BuiltIn,
    /// `.piarc/` of the directory or one above it.
    ProjectPiarc,
    /// `.claude/` of the directory or one above it.
    ProjectClaude,
    /// Pi's project directories: `.pi/skills/`, `.agents/skills/`, `.pi/prompts/`.
    ProjectPi,
    /// PiArc's data directory (`skills/`, `commands/`, `output-styles/`).
    User,
    /// `~/.claude/`.
    UserClaude,
    /// Pi's user directories: `<data>/pi/skills/`, `~/.agents/skills/`, `<data>/pi/prompts/`.
    UserPi,
    /// A plugin (T40).
    Plugin,
    /// An MCP server's prompt (T40).
    Mcp,
}

/// What a slash command runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommandKind {
    /// A command the client carries out (`/compact`, `/model`, ...).
    BuiltIn,
    /// A command file or a Pi prompt template: its body is the prompt.
    Command,
    /// A skill the user may invoke.
    Skill,
    /// An MCP prompt (T40).
    McpPrompt,
}

/// Something about a skill, command or style the user should know; the client words it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResourceWarningKind {
    /// A frontmatter field PiArc does not use (`field`).
    IgnoredField,
    /// A field PiArc reads but does not support yet (`field`, `task`).
    UnsupportedField,
    /// The body has `` !`command` `` or a ```` ```! ```` block: PiArc does not run it and
    /// passes the text as written.
    DynamicCommand,
    /// The frontmatter is not valid YAML: every field is unset (`value` says why).
    InvalidFrontmatter,
    /// A field has a value of the wrong kind and is unset (`field`).
    InvalidField,
    /// `allowed-tools` and `hooks` do not apply: the project is not trusted.
    Untrusted,
    /// A `Skill` or `Skill(<name>)` deny rule hides it from the model.
    Denied,
    /// A higher-precedence entry of the same name replaces it (`value` is the winner's path or
    /// `builtIn`).
    Overridden,
}

/// One warning about a skill, a command or an output style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceWarning {
    /// What it is about.
    pub kind: ResourceWarningKind,
    /// The frontmatter field concerned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// The value concerned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The task that makes an unsupported field work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

/// A file that could not be read as a skill, command or style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIssue {
    /// The file or directory.
    pub path: String,
    /// Its line (1-based), when the problem has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    /// What is wrong.
    pub message: String,
}

/// How much of a skill the model sees (Claude Code's `skillOverrides`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SkillVisibility {
    /// Name and description in the index; the user may invoke it.
    #[default]
    On,
    /// Name only in the index.
    NameOnly,
    /// Not in the index; the user may still invoke it.
    UserInvocableOnly,
    /// Neither in the index nor among the commands.
    Off,
}

/// A skill in effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// Its name (`/name`, `Skill(name)`).
    pub name: String,
    /// What it does and when to use it (`description`, then `when_to_use`), not truncated.
    pub description: String,
    /// Where it came from.
    pub source: ResourceSource,
    /// Its `SKILL.md` (or Pi's single-file skill).
    pub path: String,
    /// The directory holding it: readable without asking (`${CLAUDE_SKILL_DIR}`).
    pub dir: String,
    /// `argument-hint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Names of `arguments`, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    /// The model may load it (not `disable-model-invocation`, not hidden, not denied).
    pub model_invocable: bool,
    /// The user may invoke it as `/name`.
    pub user_invocable: bool,
    /// How much of it the model sees.
    #[serde(default)]
    pub visibility: SkillVisibility,
    /// Rules the turn that invokes it allows (`allowed-tools`), as written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// File globs that make it available (`paths`); empty: always.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Whether it defines hooks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hooks: bool,
    /// Files of the same name it replaces.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<String>,
    /// What the user should know.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ResourceWarning>,
}

/// A slash command in the merged list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    /// Its name, without the slash.
    pub name: String,
    /// What it runs.
    pub kind: CommandKind,
    /// Where it came from.
    pub source: ResourceSource,
    /// Its description; empty for built-in commands (the client words them).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Its file; absent for built-in commands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `argument-hint`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Names of `arguments`, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<String>,
    /// Other names it answers to (built-in commands).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Rules the turn it starts allows (`allowed-tools`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Files or built-in commands of the same name it replaces.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<String>,
    /// What the user should know.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ResourceWarning>,
}

/// An output style.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputStyleInfo {
    /// Its name (the `outputStyle` setting's value).
    pub name: String,
    /// Its description; empty for built-in styles (the client words them).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Where it came from.
    pub source: ResourceSource,
    /// Its file; absent for built-in styles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Its instructions (custom styles in `skills/list`; the Agent Host has the built-in
    /// ones).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Files of the same name it replaces.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<String>,
    /// What the user should know.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ResourceWarning>,
}

/// The output style in effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentOutputStyle {
    /// The style that applies (`Default` when the setting names none that exists).
    pub name: String,
    /// The setting's value when it names no style.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
}

/// Parameters of `skills/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListParams {
    /// The session asking: its directory is where project files are looked up from, and its
    /// file tools may read the skills' directories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The directory to look up from when no session asks; inside the connection's workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Result of `skills/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsCatalog {
    /// The skills in effect, by name (hidden ones included, with their visibility).
    pub skills: Vec<SkillInfo>,
    /// The slash commands in effect: built-in commands, command files, Pi templates and the
    /// skills the user may invoke.
    pub commands: Vec<CommandInfo>,
    /// The output styles: built-in ones (without instructions) and custom ones.
    pub output_styles: Vec<OutputStyleInfo>,
    /// The style in effect.
    pub output_style: CurrentOutputStyle,
    /// Files that are not valid skills, commands or styles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ResourceIssue>,
}

request!(
    /// Method marker for `skills/list` (Agent Host → Core).
    SkillsListMethod, "skills/list", SkillsListParams, SkillsCatalog
);

/// Parameters of `skills/invoke`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsInvokeParams {
    /// The session whose `Skill` call loads it.
    pub session_id: String,
    /// The `Skill` call (its approval is consumed).
    pub tool_call_id: String,
    /// The skill's name.
    pub name: String,
    /// The call's `args`, as written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}

/// Result of `skills/invoke`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsInvokeResult {
    /// The skill's name.
    pub name: String,
    /// Its body with the arguments substituted.
    pub content: String,
    /// Its directory.
    pub dir: String,
    /// Rules the current turn now allows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Whether its hooks now apply to the session.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hooks: bool,
    /// What did not apply (an untrusted project's `allowed-tools` and hooks).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ResourceWarning>,
}

request!(
    /// Method marker for `skills/invoke` (Agent Host → Core).
    SkillsInvoke, "skills/invoke", SkillsInvokeParams, SkillsInvokeResult
);

/// Parameters of `skills/match`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsMatchParams {
    /// The session that touched the files.
    pub session_id: String,
    /// Absolute paths of files the session read or wrote.
    pub files: Vec<String>,
    /// The `paths` skills not yet available, by name.
    pub skills: Vec<String>,
}

/// Result of `skills/match`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsMatchResult {
    /// The skills one of the files activates.
    #[serde(default)]
    pub matched: Vec<String>,
}

request!(
    /// Method marker for `skills/match` (Agent Host → Core).
    SkillsMatch, "skills/match", SkillsMatchParams, SkillsMatchResult
);

/// Parameters of `resources/listSkills` and `resources/listCommands`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesListParams {
    /// The directory to look up from; the workspace root when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Result of `resources/listSkills`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsList {
    /// The skills in effect.
    pub skills: Vec<SkillInfo>,
    /// Files that are not valid skills, commands or styles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ResourceIssue>,
}

request!(
    /// Method marker for `resources/listSkills` (Core → Agent Host).
    ResourcesListSkills, "resources/listSkills", ResourcesListParams, SkillsList
);

/// Result of `resources/listCommands`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandsList {
    /// The slash commands in effect, in precedence order.
    pub commands: Vec<CommandInfo>,
    /// The output styles (`/output-style` lists them).
    pub output_styles: Vec<OutputStyleInfo>,
    /// The style in effect.
    pub output_style: CurrentOutputStyle,
    /// Files that are not valid skills, commands or styles.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<ResourceIssue>,
}

request!(
    /// Method marker for `resources/listCommands` (Core → Agent Host).
    ResourcesListCommands, "resources/listCommands", ResourcesListParams, CommandsList
);

/// Parameters of `resources/reload`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesReloadParams {}

/// Result of `resources/reload`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesReloadResult {}

request!(
    /// Method marker for `resources/reload` (Core → Agent Host).
    ResourcesReload, "resources/reload", ResourcesReloadParams, ResourcesReloadResult
);

/// A slash command the user's input invoked (`session/prompt`, `session/steer`,
/// `session/followUp`): the text the Agent Host receives is its expansion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PromptCommand {
    /// The command's name.
    pub name: String,
    /// A command file, a template or a skill.
    pub kind: CommandKind,
    /// Where it came from.
    pub source: ResourceSource,
    /// The arguments as typed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arguments: String,
    /// What the user typed (`/name arguments`), shown in the transcript.
    pub input: String,
}
