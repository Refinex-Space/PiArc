//! Model catalog, provider credentials and session model selection (T21); sign-in, per-model
//! settings and the auxiliary model (T29).

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

/// A name in the model alias table (T31, architecture section 6.13): PiArc's tiers, and Claude
/// Code's names that follow them unless set on their own (`haiku` → `fast`, `sonnet` →
/// `balanced`, `opus` → `strong`).
#[derive(
    Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ModelAlias {
    /// A cheap, quick model (exploration).
    Fast,
    /// The everyday model.
    Balanced,
    /// The most capable model.
    Strong,
    /// Claude Code's `haiku`.
    Haiku,
    /// Claude Code's `sonnet`.
    Sonnet,
    /// Claude Code's `opus`.
    Opus,
}

impl ModelAlias {
    /// The tier a Claude Code name follows when it is not set on its own.
    #[must_use]
    pub const fn follows(self) -> Option<Self> {
        match self {
            Self::Haiku => Some(Self::Fast),
            Self::Sonnet => Some(Self::Balanced),
            Self::Opus => Some(Self::Strong),
            Self::Fast | Self::Balanced | Self::Strong => None,
        }
    }

    /// The `provider/model` an alias names in `table`: its own entry, else the tier it follows.
    #[must_use]
    pub fn target(self, table: &std::collections::BTreeMap<Self, String>) -> Option<&str> {
        table
            .get(&self)
            .or_else(|| self.follows().and_then(|tier| table.get(&tier)))
            .map(String::as_str)
    }
}

/// How thoroughly the model has been exercised with tools.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ToolReliability {
    /// Verified.
    Verified,
    /// Unknown.
    Unknown,
    /// Known to call tools unreliably: the model gets the conservative Tool Profile (T29).
    Low,
}

/// The Tool Profile a model sees (architecture section 6.13): the default one, or the
/// conservative one with fewer tools, more explicit descriptions and task list reminders.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ToolProfileKind {
    /// The full tool set with the default descriptions.
    Default,
    /// The conservative subset.
    Conservative,
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
    /// The effort applied when the model is selected without one (per-model setting, T29).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<EffortLevel>,
    /// The Tool Profile in effect for the model (T29); absent: the default one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_profile: Option<ToolProfileKind>,
    /// The provider's own web search can serve `WebSearch` (T38, ADR-0055).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub native_web_search: bool,
}

/// The user's settings for one model (T29), each replacing the catalog value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    /// Display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Context window in tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Whether image input is accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// Effort applied when the model is selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<EffortLevel>,
    /// Tool Profile; absent: chosen by the tool reliability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_profile: Option<ToolProfileKind>,
    /// Whether the provider's own web search serves `WebSearch` (T38); absent: the catalog's
    /// answer (Anthropic's own models).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_web_search: Option<bool>,
    /// Tool reliability Core derives from the provider configuration (keyless local
    /// endpoints are `low`); not a user setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_reliability: Option<ToolReliability>,
}

/// Model preferences Core gives the Agent Host (T29): per-model settings and the auxiliary
/// model for one-off calls such as WebFetch's extraction.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreferences {
    /// The auxiliary model; absent: the session's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auxiliary: Option<ModelRef>,
    /// Per-model settings keyed by `<provider>/<model id>`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub models: BTreeMap<String, ModelOverride>,
    /// The auxiliary model as an alias (T31), instead of `auxiliary`; Core resolves it with the
    /// user's alias table before the Agent Host gets the preferences.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auxiliary_alias: Option<ModelAlias>,
    /// The user's model alias table (T31): alias → `<provider>/<model id>`. The settings window
    /// sends the whole table with every change.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub aliases: BTreeMap<ModelAlias, String>,
}

/// A provider that offers sign-in (OAuth or device code) in the settings window (T29).
/// Anthropic's subscription sign-in is never listed (ADR-0006).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginProvider {
    /// Pi provider id.
    pub id: String,
    /// Provider display name.
    pub name: String,
    /// The sign-in method's label.
    pub label: String,
    /// Whether access through it is backed by a subscription.
    pub subscription: bool,
    /// Whether a signed-in credential is stored in the vault.
    pub signed_in: bool,
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
    /// Providers with sign-in (T29).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub login_providers: Vec<LoginProvider>,
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
    /// Current model preferences (T29); absent: unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<ModelPreferences>,
}

/// Parameters of `models/login/start` (Core → settings Agent Host, T29): sign in to a
/// provider. The request answers when the sign-in finished; interactions go through
/// `ui/loginInteraction` tagged with `loginId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartParams {
    /// Core's id of this sign-in.
    pub login_id: String,
    /// Provider id.
    pub provider: String,
}

/// Parameters of `models/login/cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginCancelParams {
    /// The sign-in to stop.
    pub login_id: String,
}

/// Parameters of `models/logout`: remove a provider's stored credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogoutParams {
    /// Provider id.
    pub provider: String,
}

/// What a sign-in prompt asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LoginPromptKind {
    /// Free text.
    Text,
    /// Hidden text.
    Secret,
    /// One of `options`.
    Select,
    /// A code or redirect URL pasted by hand.
    ManualCode,
}

/// A choice of a `select` prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginOption {
    /// Value returned when chosen.
    pub id: String,
    /// Label.
    pub label: String,
    /// Explanation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A link shown with an `info` interaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginLink {
    /// URL, opened in the system browser after confirmation.
    pub url: String,
    /// Label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One step of a sign-in shown to the user. A later prompt of the same sign-in replaces the
/// prompt on screen, which is answered with `cancelled`; status lines and links do not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LoginInteraction {
    /// Open the authorization page in the system browser; the result comes back through the
    /// loopback callback.
    #[serde(rename_all = "camelCase")]
    AuthUrl {
        /// The authorization URL.
        url: String,
        /// Extra instructions.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
    /// Enter `userCode` at `verificationUri`.
    #[serde(rename_all = "camelCase")]
    DeviceCode {
        /// The code to enter.
        user_code: String,
        /// Where to enter it.
        verification_uri: String,
        /// Seconds until the code expires.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_in_seconds: Option<u64>,
    },
    /// A status line.
    #[serde(rename_all = "camelCase")]
    Progress {
        /// Message.
        message: String,
    },
    /// Information with optional links.
    #[serde(rename_all = "camelCase")]
    Info {
        /// Message.
        message: String,
        /// Links.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        links: Vec<LoginLink>,
    },
    /// A question; the result's `value` is the answer.
    #[serde(rename_all = "camelCase")]
    Prompt {
        /// What is asked for.
        kind: LoginPromptKind,
        /// Message.
        message: String,
        /// Placeholder.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        /// Choices of a `select` prompt.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<LoginOption>,
    },
}

/// Parameters of `ui/loginInteraction` (settings Agent Host → Core, T29).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginInteractionParams {
    /// The sign-in it belongs to.
    pub login_id: String,
    /// The provider signing in.
    pub provider: String,
    /// What to show.
    pub interaction: LoginInteraction,
}

/// Result of `ui/loginInteraction`: the answer of a prompt, nothing for the other kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginInteractionResult {
    /// The prompt's answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
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
    /// Method marker for `models/login/start`.
    ModelsLoginStart, "models/login/start", LoginStartParams, ModelsUpdated
);
request!(
    /// Method marker for `models/login/cancel`.
    ModelsLoginCancel, "models/login/cancel", LoginCancelParams, ModelsUpdated
);
request!(
    /// Method marker for `models/logout`.
    ModelsLogout, "models/logout", LogoutParams, ModelsUpdated
);
request!(
    /// Method marker for `ui/loginInteraction` (Agent Host → Core).
    UiLoginInteraction, "ui/loginInteraction", LoginInteractionParams, LoginInteractionResult
);
request!(
    /// Method marker for `models/credentialStatus`.
    ModelsCredentialStatus, "models/credentialStatus", CredentialStatusParams, CredentialStatusResult
);

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::ModelAlias;

    #[test]
    fn claude_code_names_follow_their_tier_unless_set() {
        let table = BTreeMap::from([
            (ModelAlias::Fast, "cheap/small".to_owned()),
            (ModelAlias::Opus, "big/large".to_owned()),
        ]);
        assert_eq!(ModelAlias::Haiku.target(&table), Some("cheap/small"));
        assert_eq!(ModelAlias::Opus.target(&table), Some("big/large"));
        assert_eq!(ModelAlias::Strong.target(&table), None);
        assert_eq!(ModelAlias::Sonnet.target(&table), None);
    }
}
