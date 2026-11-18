//! Model catalog, provider credentials and session model selection (T21).

use std::collections::BTreeMap;

use crate::method::request;
use crate::session::{ModelRef, SessionId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Selectable Pi thinking level (PiArc omits minimal).
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EffortLevel {
    /// Off.
    Off,
    /// Low.
    Low,
    /// Medium.
    Medium,
    /// High.
    High,
    /// Xhigh.
    Xhigh,
    /// Max.
    Max,
}

/// How thoroughly the model has been exercised with tools.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ToolReliability {
    /// Verified.
    Verified,
    /// Unknown.
    Unknown,
}

/// A selectable chat model and its negotiated capabilities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    /// Provider id.
    pub provider: String,
    /// Model id within its provider.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Context window in tokens.
    pub context_window: u64,
    /// Maximum response tokens.
    pub max_output: u64,
    /// Accepts image input.
    pub vision: bool,
    /// Selectable efforts.
    pub efforts: Vec<EffortLevel>,
    /// Supports prompt caching.
    pub prompt_cache: bool,
    /// Tool calling assessment.
    pub tool_reliability: ToolReliability,
}

/// A built-in provider accepting API key credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    /// Pi provider id.
    pub id: String,
    /// Display name.
    pub name: String,
}

/// Lists available models, optionally for a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsListParams {
    /// Session to report current selection for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

/// Available models and built-in providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsListResult {
    /// Built-in provider catalog.
    pub providers: Vec<CatalogProvider>,
    /// Models for which authentication is available.
    pub models: Vec<CatalogModel>,
    /// Current model for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// Current effort for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
}

/// Estimates a model switch in an open session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitchParams {
    /// Session.
    pub session_id: SessionId,
    /// Target model.
    pub model: ModelRef,
}

/// Changes the session model after confirmation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetModelParams {
    /// Session.
    pub session_id: SessionId,
    /// Target model.
    pub model: ModelRef,
    /// Explicit effort for the target model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
}

/// Changes effort for the current model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetEffortParams {
    /// Session.
    pub session_id: SessionId,
    /// Supported target effort.
    pub effort: EffortLevel,
}

/// Cost of switching before committing it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSwitchPreviewResult {
    /// Estimated context tokens, null when unknown.
    pub context_tokens: Option<u64>,
    /// Cached input loses its identity.
    pub cache_invalidated: bool,
    /// Estimated USD to write the cache, null when unpriced.
    pub cache_write_usd: Option<f64>,
    /// Thinking content may be discarded during conversion.
    pub drops_thinking: bool,
}

/// Model and effort now in effect in Pi.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelSelection {
    /// Active model.
    pub model: ModelRef,
    /// Active effort.
    pub effort: EffortLevel,
}

/// Reloads Pi configuration and controls catalog refresh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsReloadParams {
    /// Enable catalog network requests.
    pub allow_network: bool,
}

/// Acknowledges a successful provider operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsUpdated {}

/// An API credential transported in memory only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    /// Pi credential type (api_key).
    pub r#type: String,
    /// API key when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Request-scoped cloud fields and destination binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

/// Stores or deletes a credential using the settings Host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelsCredentialParams {
    /// Provider id.
    pub provider: String,
    /// Credential to store; absent to delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<ProviderCredential>,
    /// Preserve the stored key when updating metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_key: Option<bool>,
}

/// Reads non-secret credential status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusParams {
    /// Provider id.
    pub provider: String,
}

/// Non-secret status for settings and crash recovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusResult {
    /// A credential exists in the vault.
    pub has_credential: bool,
    /// Id of the last settings write, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
}

request!(
    /// Method marker for `models/list`.
    ModelsList, "models/list", ModelsListParams, ModelsListResult
);
request!(
    /// Method marker for `models/reload`.
    ModelsReload, "models/reload", ModelsReloadParams, ModelsUpdated
);
request!(
    /// Method marker for `session/previewModelSwitch`.
    SessionPreviewModelSwitch, "session/previewModelSwitch", ModelSwitchParams, ModelSwitchPreviewResult
);
request!(
    /// Method marker for `session/setModel`.
    SessionSetModel, "session/setModel", SetModelParams, SessionModelSelection
);
request!(
    /// Method marker for `session/setEffort`.
    SessionSetEffort, "session/setEffort", SetEffortParams, SessionModelSelection
);
request!(
    /// Method marker for `models/credential`.
    ModelsCredential, "models/credential", ModelsCredentialParams, ModelsUpdated
);
request!(
    /// Method marker for `models/credentialStatus`.
    ModelsCredentialStatus, "models/credentialStatus", CredentialStatusParams, CredentialStatusResult
);
