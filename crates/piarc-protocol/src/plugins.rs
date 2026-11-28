//! Extension packages: Claude Code plugins and Pi packages (architecture section 6.7, T40,
//! ADR-0058). Core installs, enables, scopes and audits them; their components join the
//! sources of skills, commands, subagents, hooks and MCP servers, and a Pi package's
//! extensions load in the Agent Host. Needs the handshake capability `plugins`.
//!
//! - `plugins/extensions` (Agent Host → Core): the Pi extension entry files of the packages in
//!   effect for a directory, the ones the user confirmed only. The Agent Host hands them to
//!   Pi's resource loader; Pi never installs or resolves a package itself.
//!
//! The other types are the Core API of the settings window (`packages*` functions of the
//! NAPI module).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::request;

/// What kind of package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageKind {
    /// A Claude Code plugin (`.claude-plugin/plugin.json` or its standard layout).
    ClaudePlugin,
    /// A Pi package (`package.json` with a `pi` field, or Pi's conventional directories).
    PiPackage,
}

/// Where a package was installed from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageSourceKind {
    /// A local directory, used in place.
    Directory,
    /// A git repository, cloned and pinned to a commit.
    Git,
    /// An npm package (name, spec or tarball), installed with the bundled npm and no
    /// lifecycle scripts.
    Npm,
}

/// A package's origin and the version installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageSource {
    /// The kind of source.
    pub kind: PackageSourceKind,
    /// The directory, git URL or npm spec as given.
    pub location: String,
    /// The git commit checked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The package version (`plugin.json` or `package.json`; npm's resolved version).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// npm's integrity value of the installed tarball.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    /// The npm package name installed (npm sources; may differ from the id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_name: Option<String>,
    /// Install scripts the package declares; PiArc never runs them (ADR-0102).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub install_scripts: Vec<String>,
}

/// Where a package is declared (and so where it applies).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageScope {
    /// PiArc's user settings: every workspace.
    User,
    /// The workspace's `.piarc/settings.json`: that workspace only, once trusted.
    Project,
}

/// What an executable item runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageExecutableKind {
    /// A hook of the package (`hooks/hooks.json`, the manifest's `hooks`).
    Hook,
    /// An MCP server the package starts or connects.
    McpServer,
    /// A Pi extension: code loaded into the Agent Host process.
    PiExtension,
    /// A hook of one of the package's subagent definitions.
    AgentHook,
    /// An inline MCP server of one of the package's subagent definitions.
    AgentMcpServer,
}

/// One executable item: it runs only once the user confirmed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageExecutable {
    /// What it runs.
    pub kind: PackageExecutableKind,
    /// The item's identity (part of the package's fingerprint): a hook's event, matcher and
    /// command, a server's name and command line or URL, an extension's entry file.
    pub name: String,
    /// Whether the user confirmed it (enabling, confirming, or trusting the project).
    pub confirmed: bool,
}

/// The components a package brings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageComponents {
    /// Slash commands, with their namespace (`plugin:command`) or Pi prompt templates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
    /// Skills, with their namespace for plugins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// Subagent types, with their namespace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    /// Hook events with handlers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<String>,
    /// MCP server names as the pool knows them (`plugin_<plugin>_<server>`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<String>,
    /// Pi extension entry files, relative to the package.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<String>,
}

/// An installed package as the settings window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    /// Its identifier: the plugin or package name; the key under `plugins` in settings.
    pub id: String,
    /// Plugin or Pi package.
    pub kind: PackageKind,
    /// Its description, when the manifest has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Where it came from.
    pub source: PackageSource,
    /// Its directory.
    pub path: String,
    /// Where it is declared for the workspace asked about; absent when neither the user
    /// settings nor the workspace's declare it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PackageScope>,
    /// Whether it is on for the workspace asked about (declared and set to `true`).
    pub enabled: bool,
    /// Whether its components apply now: on, and the project trusted for the project scope.
    pub active: bool,
    /// What it brings.
    pub components: PackageComponents,
    /// Components PiArc does not support (`mods`, `themes`, `lspServers`, ...), still listed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsupported: Vec<String>,
    /// The executable items and whether each one is confirmed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executables: Vec<PackageExecutable>,
    /// Problems reading it (manifest errors, missing directory).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<String>,
    /// When it was installed (Unix ms).
    pub installed_at: i64,
    /// When it was last installed again or updated (Unix ms).
    pub updated_at: i64,
}

/// The packages installed, as one workspace (or no workspace) sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackagesList {
    /// Installed packages, by id.
    pub packages: Vec<PackageInfo>,
    /// Ids declared in the settings that are not installed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

/// What installing does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallRequest {
    /// The kind of source.
    pub kind: PackageSourceKind,
    /// An absolute directory, a git URL, or an npm spec (name, `name@version`, a tarball path).
    pub location: String,
    /// Where to declare it.
    pub scope: PackageScope,
    /// The workspace for the project scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

/// What installing or updating produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallResult {
    /// The package (installed off; enabling asks for confirmation).
    pub package: PackageInfo,
    /// The commit before an update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_commit: Option<String>,
    /// The version before an update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_version: Option<String>,
    /// What the user should know (lifecycle scripts not run, packages that declared them).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// Parameters of `plugins/extensions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginsExtensionsParams {
    /// The session's directory; inside the connection's workspace.
    pub cwd: String,
}

/// A Pi extension to load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginExtension {
    /// The package it belongs to.
    pub package: String,
    /// The entry file (absolute).
    pub path: String,
}

/// Result of `plugins/extensions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginsExtensions {
    /// The confirmed extension entries of the packages in effect, in package order.
    #[serde(default)]
    pub extensions: Vec<PluginExtension>,
}

request!(
    /// Method marker for `plugins/extensions` (Agent Host → Core).
    PluginsExtensionsMethod, "plugins/extensions", PluginsExtensionsParams, PluginsExtensions
);
