//! A scenario's extension packages (T40): installed through Core's public package API before
//! the workspace opens, as a user would from the settings window.

use serde::Deserialize;

/// Where a package comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageSourceSpec {
    /// The directory itself.
    #[default]
    Directory,
    /// The directory made a git repository (one commit) and cloned from `file://`.
    Git,
}

/// Where a package is declared.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageScopeSpec {
    /// The user settings: every workspace.
    #[default]
    User,
    /// The workspace's `.piarc/settings.json`.
    Project,
}

/// One package of a scenario.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageSpec {
    /// The package directory, relative to the run's temporary root.
    pub path: String,
    /// Where it comes from.
    #[serde(default)]
    pub source: PackageSourceSpec,
    /// Where it is declared.
    #[serde(default)]
    pub scope: PackageScopeSpec,
    /// Turn it on after installing.
    #[serde(default = "yes")]
    pub enable: bool,
    /// When turning it on, confirm every executable item (as the native dialog's OK does).
    #[serde(default = "yes")]
    pub confirm: bool,
}

const fn yes() -> bool {
    true
}
