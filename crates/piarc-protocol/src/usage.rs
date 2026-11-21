//! Usage and cost (T41, FR-MD-06): a model's prices as the catalog (pi-ai's `cost`) or the
//! user gives them, and Core's report of tokens and estimated cost by model and by session.
//!
//! Prices are US dollars per million tokens. Costs are estimates: Core multiplies each
//! request's tokens by the price in effect now (catalog, or the user's override), in integer
//! picodollars, as pi-ai's `calculateCost` does for the catalog price (tiers by the request's
//! input tokens, one-hour cache writes at twice the input price). A model without a price has no
//! cost (`None`), never zero.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Rates above an input size (pi-ai's `ModelCostTier`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PriceTier {
    /// The tier applies when a request's input, cache reads and cache writes exceed this.
    pub input_tokens_above: u64,
    /// USD per million input tokens.
    pub input: f64,
    /// USD per million output tokens.
    pub output: f64,
    /// USD per million cache-read tokens.
    pub cache_read: f64,
    /// USD per million cache-write tokens.
    pub cache_write: f64,
}

/// A model's prices (pi-ai's `ModelCost`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    /// USD per million input tokens.
    pub input: f64,
    /// USD per million output tokens.
    pub output: f64,
    /// USD per million cache-read tokens.
    pub cache_read: f64,
    /// USD per million cache-write tokens.
    pub cache_write: f64,
    /// Rates for larger requests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<PriceTier>,
}

/// Where a model's price comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PriceSource {
    /// pi-ai's catalog.
    Catalog,
    /// The user's `modelPrices` setting.
    User,
    /// Neither: the cost is unknown.
    Unknown,
}

/// Summed tokens of some requests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    /// Model requests.
    pub requests: u64,
    /// Input tokens, excluding cache reads and writes.
    pub input: u64,
    /// Output tokens (reasoning included).
    pub output: u64,
    /// Tokens read from the prompt cache.
    pub cache_read: u64,
    /// Tokens written to the prompt cache.
    pub cache_write: u64,
    /// Reasoning tokens where the provider reports them (part of `output`).
    pub reasoning: u64,
}

/// One model's usage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// Provider id.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// The tokens.
    pub tokens: UsageTokens,
    /// Estimated USD; absent when the model has no price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Where the price comes from.
    pub price_source: PriceSource,
    /// The price in effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<ModelPrice>,
}

/// Usage of a kind of auxiliary call (WebFetch extraction, native web search, `prompt` hooks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuxiliaryUsage {
    /// `webFetch`, `webSearch`, `hookPrompt`, ...
    pub purpose: String,
    /// The tokens.
    pub tokens: UsageTokens,
    /// Estimated USD; absent when a model used has no price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

/// A subagent's usage, counted in its main session too.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUsage {
    /// The subagent's session.
    pub session_id: String,
    /// Its type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The tokens.
    pub tokens: UsageTokens,
    /// Estimated USD; absent when a model used has no price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

/// One main session's usage: its own requests, its subagents' and its auxiliary calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// The session.
    pub session_id: String,
    /// Its title, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Its workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// Everything counted for the session.
    pub tokens: UsageTokens,
    /// Estimated USD of everything with a price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Some requests used a model without a price: `cost` leaves them out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    /// By model, the session's own requests, its subagents' and auxiliary calls together.
    pub models: Vec<ModelUsage>,
    /// Its subagents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subagents: Vec<SubagentUsage>,
    /// Its auxiliary calls.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auxiliary: Vec<AuxiliaryUsage>,
}

/// Usage of every session (or one workspace's).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// All of it.
    pub tokens: UsageTokens,
    /// Estimated USD of everything with a price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Some requests used a model without a price.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    /// By model.
    pub models: Vec<ModelUsage>,
    /// By main session, most recently updated first.
    pub sessions: Vec<SessionUsage>,
}
