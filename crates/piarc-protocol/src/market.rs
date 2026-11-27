//! The Pi package market (ADR-0102): the Core API of the settings window's market view
//! (`market*` functions of the NAPI module) and its events on `core/market`. Core finds Pi
//! packages in the npm registry (keyword `pi-package`), caches them, and installs one through
//! the extension package manager (ADR-0058) as a structured request.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::plugins::PackageScope;

/// The categories of the market (themes are not one: PiArc does not use Pi's themes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MarketCategory {
    #[default]
    All,
    Extension,
    Skill,
    Prompt,
}

/// A resource kind a package brings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MarketKind {
    Extension,
    Skill,
    Prompt,
    /// Pi's terminal themes: listed in a package's details, never used by PiArc.
    Theme,
}

/// How the list is ordered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MarketSort {
    /// Monthly downloads, then name.
    #[default]
    Popular,
    /// Latest publish, then name.
    Updated,
}

/// One page of the market.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketQuery {
    /// Words to search for (at most 200 characters); empty to browse.
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub category: MarketCategory,
    #[serde(default)]
    pub sort: MarketSort,
    #[serde(default)]
    pub offset: u64,
    /// 1–100.
    pub limit: u64,
    /// The workspace the installed state is reported for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

/// An installed package a market entry corresponds to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstalled {
    /// The package id (its npm name).
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// A newer version in the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
    /// Where it is declared for the workspace asked about (`None`: not declared there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PackageScope>,
    pub enabled: bool,
}

/// A package in the market.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    /// The npm name.
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher: String,
    pub downloads_monthly: u64,
    /// Unix ms of the latest publish.
    pub updated: i64,
    /// What it brings (empty: not known yet).
    pub kinds: Vec<MarketKind>,
    /// `kinds` come from the package's manifest (otherwise from its keywords).
    pub kinds_from_manifest: bool,
    /// npm flags it as insecure.
    pub insecure: bool,
    /// Its current version is deprecated.
    pub deprecated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<MarketInstalled>,
    /// An install of it is running.
    pub installing: bool,
}

/// Entries per category of a query (theme-only and deprecated packages left out).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketCounts {
    pub all: u64,
    pub extension: u64,
    pub skill: u64,
    pub prompt: u64,
}

/// The state of the catalog sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MarketSyncState {
    #[default]
    Idle,
    Syncing,
    Failed,
}

/// A failure the market shows: a stable code (`network`, `proxy`, `tls`, `timeout`,
/// `tooLarge`, `status`, `notFound`, `refused`) and a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketProblem {
    pub code: String,
    pub message: String,
}

/// Where the catalog stands.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketStatus {
    pub state: MarketSyncState,
    /// Pages synced and pages to sync (a sync in progress).
    pub done: u64,
    pub total: u64,
    /// Unix ms of the last complete sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<i64>,
    /// Index packages whose manifest was read, and all index packages.
    pub classified: u64,
    pub indexed: u64,
    /// Why the last sync or search failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<MarketProblem>,
}

/// One page of the market.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketPage {
    pub entries: Vec<MarketEntry>,
    /// Entries the query selects in its category.
    pub total: u64,
    pub counts: MarketCounts,
    pub status: MarketStatus,
    /// The search words were answered by the registry (otherwise from the cache only).
    pub live: bool,
}

/// One package's details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    pub entry: MarketEntry,
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage_url: Option<String>,
    /// The README (Markdown, at most 256 KiB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    pub readme_truncated: bool,
    /// The package document was too large to read; see npm.
    pub readme_too_large: bool,
    /// The deprecation message of the current version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deprecated_message: Option<String>,
    /// Install scripts the package declares (PiArc never runs them).
    pub install_scripts: Vec<String>,
    /// Dependencies not from the registry (the market refuses to install the package).
    pub foreign_dependencies: Vec<String>,
    /// Runtime dependencies by name.
    pub dependencies: Vec<String>,
    /// Why the details are incomplete (offline: the cached entry only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<MarketProblem>,
}

/// Installs one market package (off) through the extension package manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallRequest {
    /// The npm name.
    pub name: String,
    /// An exact version the catalog lists.
    pub version: String,
    pub scope: PackageScope,
    /// Required for the project scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

/// An event on `core/market`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MarketEvent {
    /// The catalog sync advanced, finished or failed.
    Sync { status: MarketStatus },
    /// Manifests of these packages were read: their kinds may have changed.
    Kinds { names: Vec<String> },
    /// An install started, finished or failed.
    Install {
        name: String,
        /// `started`, `finished` or `failed`.
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        problem: Option<MarketProblem>,
    },
}
