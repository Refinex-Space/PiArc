//! The settings layers: an ordered table of sources and precedences.
//!
//! The merge code iterates the table from the lowest precedence to the highest and never
//! names a layer, so a new layer (the three Claude Code layers of T24, the session and
//! enterprise layers) is one [`LayerSpec`] inserted with [`LayerTable::insert`].

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::{PIARC_SETTINGS, Shape};

/// Precedences (higher wins) in the order of ADR-0005 rule 3.
pub mod precedence {
    /// Built-in defaults.
    pub const DEFAULTS: u16 = 0;
    /// `~/.claude/settings.json`.
    pub const CLAUDE_USER: u16 = 10;
    /// PiArc's user settings, `<data>/settings.json`.
    pub const USER: u16 = 20;
    /// `.claude/settings.json`.
    pub const CLAUDE_PROJECT: u16 = 30;
    /// `.claude/settings.local.json`.
    pub const CLAUDE_PROJECT_LOCAL: u16 = 40;
    /// `.piarc/settings.json`.
    pub const PROJECT: u16 = 50;
    /// `.piarc/settings.local.json`.
    pub const PROJECT_LOCAL: u16 = 60;
    /// Values set for one session (CLI flags, the session's own choices).
    pub const SESSION: u16 = 70;
    /// Enterprise policy (M5).
    pub const ENTERPRISE: u16 = 80;
}

/// Who a layer belongs to; project-scope layers are subject to project trust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// Built-in.
    Defaults,
    /// The user's own files.
    User,
    /// Files in the workspace.
    Project,
    /// Values of one session.
    Session,
    /// Enterprise policy.
    Enterprise,
}

/// Where a layer's value comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// A JSON file; a missing file is an empty layer.
    File(PathBuf),
    /// A value held in memory (defaults, session values).
    Value(Value),
}

/// The format of a layer's file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// PiArc's own settings.
    Piarc,
    /// A Claude Code `settings.json`: only the keys the mapping table marks active are merged
    /// ([`crate::claude::project`]); the file is never written.
    ClaudeCode,
}

/// One layer.
#[derive(Debug)]
pub struct LayerSpec {
    /// Stable identifier, for reports and the write interface (`user`, `project`, ...).
    pub id: &'static str,
    /// Higher wins.
    pub precedence: u16,
    /// Who it belongs to.
    pub scope: Scope,
    /// Where its value comes from.
    pub source: Source,
    /// The file's format.
    pub format: Format,
    /// The schema its (projected) value is checked against.
    pub schema: &'static Shape,
    /// Whether PiArc may write it ([`crate::write`]): only `.piarc/` and the user file.
    pub writable: bool,
    /// JSON Pointers of the values that enable executable configuration. For a
    /// [`Scope::Project`] layer they are left out of the merge while the project is not
    /// trusted (architecture section 10.2: deny and ask rules still apply, allow rules and
    /// hooks do not).
    pub executable: &'static [&'static str],
}

/// The executable values of PiArc's settings files.
pub const PIARC_EXECUTABLE: &[&str] = &[
    "/hooks",
    "/permissions/allow",
    "/permissions/additionalDirectories",
    "/mcpServers",
    "/plugins",
];

/// The executable values of a Claude Code settings file. Only the active keys reach the merge;
/// the planned ones are listed so they stay behind trust once their task makes them active.
pub const CLAUDE_EXECUTABLE: &[&str] = &[
    "/hooks",
    "/permissions/allow",
    "/permissions/additionalDirectories",
    "/enabledPlugins",
];

impl LayerSpec {
    /// The file of a file layer.
    #[must_use]
    pub fn file(&self) -> Option<&Path> {
        match &self.source {
            Source::File(path) => Some(path),
            Source::Value(_) => None,
        }
    }
}

/// Layer ids of the PiArc layers.
pub mod ids {
    /// Built-in defaults.
    pub const DEFAULTS: &str = "defaults";
    /// `<data>/settings.json`.
    pub const USER: &str = "user";
    /// `.piarc/settings.json`.
    pub const PROJECT: &str = "project";
    /// `.piarc/settings.local.json`.
    pub const PROJECT_LOCAL: &str = "projectLocal";
    /// Session values.
    pub const SESSION: &str = "session";
    /// Enterprise policy.
    pub const ENTERPRISE: &str = "enterprise";
    /// `~/.claude/settings.json`.
    pub const CLAUDE_USER: &str = "claudeUser";
    /// `.claude/settings.json`.
    pub const CLAUDE_PROJECT: &str = "claudeProject";
    /// `.claude/settings.local.json`.
    pub const CLAUDE_PROJECT_LOCAL: &str = "claudeProjectLocal";
}

/// The layers, sorted by precedence.
#[derive(Debug, Default)]
pub struct LayerTable {
    layers: Vec<LayerSpec>,
}

/// PiArc's project directory inside a workspace.
pub const PROJECT_DIR: &str = ".piarc";

impl LayerTable {
    /// PiArc's four layers: built-in defaults, `<data_dir>/settings.json`,
    /// `<workspace>/.piarc/settings.json` and `<workspace>/.piarc/settings.local.json`.
    #[must_use]
    pub fn piarc(data_dir: &Path, workspace: &Path) -> Self {
        let mut table = Self::default();
        table.insert(LayerSpec {
            id: ids::DEFAULTS,
            precedence: precedence::DEFAULTS,
            scope: Scope::Defaults,
            source: Source::Value(crate::defaults()),
            format: Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: false,
            executable: PIARC_EXECUTABLE,
        });
        table.insert(LayerSpec {
            id: ids::USER,
            precedence: precedence::USER,
            scope: Scope::User,
            source: Source::File(data_dir.join("settings.json")),
            format: Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: true,
            executable: PIARC_EXECUTABLE,
        });
        let dir = workspace.join(PROJECT_DIR);
        table.insert(LayerSpec {
            id: ids::PROJECT,
            precedence: precedence::PROJECT,
            scope: Scope::Project,
            source: Source::File(dir.join("settings.json")),
            format: Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: true,
            executable: PIARC_EXECUTABLE,
        });
        table.insert(LayerSpec {
            id: ids::PROJECT_LOCAL,
            precedence: precedence::PROJECT_LOCAL,
            scope: Scope::Project,
            source: Source::File(dir.join("settings.local.json")),
            format: Format::Piarc,
            schema: &PIARC_SETTINGS,
            writable: true,
            executable: PIARC_EXECUTABLE,
        });
        table
    }

    /// A workspace's layers: PiArc's four ([`Self::piarc`]) and Claude Code's
    /// `<workspace>/.claude/settings.json`, `<workspace>/.claude/settings.local.json` and, with
    /// a home directory, `<home>/.claude/settings.json`. Core always uses this table; tests
    /// inject a temporary `home` (`None` reads no user-level Claude Code file).
    #[must_use]
    pub fn workspace(data_dir: &Path, workspace: &Path, home: Option<&Path>) -> Self {
        let mut table = Self::piarc(data_dir, workspace);
        let claude = workspace.join(crate::claude::CLAUDE_DIR);
        let mut layers = vec![
            (
                ids::CLAUDE_PROJECT,
                precedence::CLAUDE_PROJECT,
                Scope::Project,
                claude.join("settings.json"),
            ),
            (
                ids::CLAUDE_PROJECT_LOCAL,
                precedence::CLAUDE_PROJECT_LOCAL,
                Scope::Project,
                claude.join("settings.local.json"),
            ),
        ];
        if let Some(home) = home {
            layers.push((
                ids::CLAUDE_USER,
                precedence::CLAUDE_USER,
                Scope::User,
                home.join(crate::claude::CLAUDE_DIR).join("settings.json"),
            ));
        }
        for (id, precedence, scope, file) in layers {
            table.insert(LayerSpec {
                id,
                precedence,
                scope,
                source: Source::File(file),
                format: Format::ClaudeCode,
                schema: &PIARC_SETTINGS,
                writable: false,
                executable: CLAUDE_EXECUTABLE,
            });
        }
        table
    }

    /// Adds a layer, keeping the table sorted; a layer with the same id is replaced. Layers
    /// with equal precedence keep their insertion order (the later one wins).
    pub fn insert(&mut self, spec: LayerSpec) {
        self.layers.retain(|l| l.id != spec.id);
        let at = self
            .layers
            .iter()
            .position(|l| l.precedence > spec.precedence)
            .unwrap_or(self.layers.len());
        self.layers.insert(at, spec);
    }

    /// Removes the layer with `id`.
    pub fn remove(&mut self, id: &str) {
        self.layers.retain(|l| l.id != id);
    }

    /// The layers from the lowest precedence to the highest.
    #[must_use]
    pub fn layers(&self) -> &[LayerSpec] {
        &self.layers
    }

    /// The layer with `id`.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&LayerSpec> {
        self.layers.iter().find(|l| l.id == id)
    }

    /// The files of all file layers.
    pub fn files(&self) -> impl Iterator<Item = &Path> {
        self.layers.iter().filter_map(LayerSpec::file)
    }
}
