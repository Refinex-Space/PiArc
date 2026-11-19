//! Scenario format for T27's context engineering: the session's context usage. The schema is
//! in `tests/scenarios/schema.json`.

use serde::Deserialize;
use serde_json::Value;

/// Checks a session's context usage (Core's `contextUsage`): a field subset, categories that
/// add up to `tokens` (always checked), and categories that must be above zero.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckUsageAction {
    /// The session; the only one when absent.
    #[serde(default)]
    pub session: Option<String>,
    /// A field subset of the usage.
    #[serde(default)]
    pub fields: Option<Value>,
    /// Categories (`systemPrompt`, `unclassified`, …) that must be above zero.
    #[serde(default)]
    pub positive: Vec<String>,
}
