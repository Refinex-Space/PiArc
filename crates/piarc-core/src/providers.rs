//! User-owned provider settings. Only public connection details are serialized here. Credentials
//! go to the supervised settings Host, whose Pi ModelRuntime writes through the vault adapter.
use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::path::Path;

use piarc_protocol::models::{
    CatalogProvider, ModelAlias, ModelOverride, ModelPreferences, ModelsCredentialParams,
    ProviderCredential, ToolReliability,
};
use piarc_protocol::session::ModelRef;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{Error, Result};

/// A settings operation. The write-only secret never participates in serialization or Debug.
pub enum Operation {
    /// Read settings.
    List,
    /// Insert or replace a configuration, retaining the previous key when omitted.
    Save(Box<Provider>, Option<String>),
    /// Delete provider and credentials.
    Delete(String),
    /// Toggle online catalog refresh.
    Refresh(bool),
    /// Replace the per-model settings and the auxiliary model (T29).
    Preferences(Box<ModelPreferences>),
    /// Turn a provider on or off (ADR-0083).
    SetEnabled(String, bool),
    /// One short request to a model of the provider (ADR-0083).
    Test(String),
    /// The model list of an endpoint (ADR-0083).
    Discover(Box<Discover>),
    /// Make a signed-in account the one in use (ADR-0083): provider, account id.
    UseAccount(String, String),
    /// Remove a signed-in account not in use (ADR-0083): provider, account id.
    RemoveAccount(String, String),
}

/// What `models/discover` asks of an endpoint (ADR-0083). The key never appears in Debug.
pub struct Discover {
    pub(crate) api: String,
    pub(crate) base_url: String,
    pub(crate) key: Option<String>,
    /// The saved provider whose stored key may be sent when no key was typed.
    pub(crate) provider: Option<String>,
}

impl Operation {
    /// Parses UI input without exposing credential text in error messages.
    ///
    /// # Errors
    /// Invalid fields or malformed configuration objects.
    pub fn save(config: &str, secret: Option<&str>) -> Result<Self> {
        let provider = serde_json::from_str::<Provider>(config)
            .map_err(|_| invalid("config", "invalid provider fields"))?;
        provider.validate()?;
        Ok(Self::Save(Box::new(provider), secret_key(secret)?))
    }

    /// Parses a model list request (ADR-0083): `{ api, baseUrl, provider? }` and the key typed
    /// in the form, if any, as `{ key }`. A key goes over HTTPS or to a loopback address only.
    ///
    /// # Errors
    /// Malformed JSON, an unsupported protocol, an invalid address or key.
    pub fn discover(request: &str, secret: Option<&str>) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            api: String,
            base_url: String,
            #[serde(default)]
            provider: Option<String>,
        }
        let r = serde_json::from_str::<Request>(request)
            .map_err(|_| invalid("discover", "invalid model list request"))?;
        if !matches!(
            r.api.as_str(),
            "anthropic-messages" | "openai-completions" | "openai-responses"
        ) {
            return Err(invalid("api", "choose a supported wire protocol"));
        }
        endpoint(&r.base_url)?;
        let key = secret_key(secret)?.filter(|k| !k.is_empty());
        if key.is_some() && !secure_for_key(&r.base_url)? {
            return Err(invalid(
                "baseUrl",
                "keys require HTTPS or a loopback address",
            ));
        }
        Ok(Self::Discover(Box::new(Discover {
            api: r.api,
            base_url: r.base_url,
            key,
            provider: r.provider,
        })))
    }

    /// Parses the settings window's per-model settings and auxiliary model (T29).
    ///
    /// # Errors
    /// Malformed JSON or values out of range.
    pub fn preferences(json: &str) -> Result<Self> {
        let prefs = serde_json::from_str::<ModelPreferences>(json)
            .map_err(|_| invalid("preferences", "invalid model settings"))?;
        let text_ok = |s: &str, max: usize| nonempty(s) && s.chars().count() <= max;
        for (key, o) in &prefs.models {
            if !key
                .split_once('/')
                .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
                || !text_ok(key, 600)
            {
                return Err(invalid("models", "expected <provider>/<model> keys"));
            }
            if o.display_name.as_deref().is_some_and(|n| !text_ok(n, 200)) {
                return Err(invalid(
                    "displayName",
                    "enter a name of at most 200 characters",
                ));
            }
            if o.context_window
                .is_some_and(|w| !(1_024..=10_000_000).contains(&w))
            {
                return Err(invalid(
                    "contextWindow",
                    "expected 1,024 to 10,000,000 tokens",
                ));
            }
            if o.tool_reliability.is_some() {
                return Err(invalid("toolReliability", "not a user setting"));
            }
        }
        if prefs
            .auxiliary
            .as_ref()
            .is_some_and(|m| !text_ok(&m.provider, 96) || !text_ok(&m.id, 512))
        {
            return Err(invalid("auxiliary", "choose a configured model"));
        }
        if prefs.aliases.values().any(|target| {
            !text_ok(target, 600)
                || !target
                    .split_once('/')
                    .is_some_and(|(p, m)| !p.is_empty() && !m.is_empty())
        }) {
            return Err(invalid("aliases", "expected <provider>/<model> values"));
        }
        Ok(Self::Preferences(Box::new(prefs)))
    }
}

/// Public configuration supplied by the user; accepts no arbitrary Pi settings, commands or headers.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub(crate) id: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_path: Option<String>,
}

/// The key of `{ key }` from the settings window, checked without echoing it in errors.
fn secret_key(secret: Option<&str>) -> Result<Option<String>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Secret {
        key: String,
    }
    let key = secret
        .map(|s| {
            serde_json::from_str::<Secret>(s)
                .map(|s| s.key)
                .map_err(|_| invalid("key", "expected a key"))
        })
        .transpose()?;
    if let Some(s) = &key
        && (s.chars().any(char::is_control)
            || s.contains("sk-ant-oat")
            || s.trim() != s
            || s.len() > 32768)
    {
        return Err(invalid("key", "invalid or unsupported credential"));
    }
    Ok(key)
}

fn invalid(field: &'static str, reason: &str) -> Error {
    Error::InvalidArgument {
        field,
        reason: reason.to_owned(),
    }
}
fn nonempty(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && s.trim() == s && !s.chars().any(char::is_control)
}
/// Settings diagnostics remain available when the user file is invalid. Until it is
/// repaired, launching a workspace must not implicitly enable online refresh.
pub(crate) fn network_preference(dir: &Path, default: bool) -> bool {
    match crate::client_settings::read(dir) {
        Ok(user) => user
            .pointer("/modelProviders/catalogRefresh")
            .map_or(default, |v| v.as_bool() == Some(true)),
        Err(_) => false,
    }
}
fn default_refresh() -> bool {
    true
}

impl Provider {
    fn cloud_auth(&self) -> &str {
        self.auth
            .as_deref()
            .unwrap_or(if self.id == "amazon-bedrock" {
                "bearer"
            } else {
                "apiKey"
            })
    }
    fn custom(&self) -> bool {
        matches!(self.kind.as_str(), "custom" | "local")
    }
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 96
            || !self.id.as_bytes()[0].is_ascii_alphanumeric()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        {
            return Err(invalid("id", "expected a lowercase provider identifier"));
        }
        if !matches!(self.kind.as_str(), "builtin" | "cloud" | "custom" | "local") {
            return Err(invalid("kind", "unknown configuration type"));
        }
        if self.custom() {
            let url = self
                .base_url
                .as_deref()
                .ok_or_else(|| invalid("baseUrl", "enter an HTTP(S) base URL"))?;
            endpoint(url)?;
            if !matches!(
                self.api.as_deref(),
                Some("anthropic-messages" | "openai-completions" | "openai-responses")
            ) {
                return Err(invalid("api", "choose a supported wire protocol"));
            }
            let mut seen = HashSet::new();
            if self.models.is_empty()
                || self.models.len() > 512
                || self.models.iter().any(|m| !nonempty(m) || !seen.insert(m))
            {
                return Err(invalid("models", "enter unique, nonempty model IDs"));
            }
        } else if self.api.is_some() || self.base_url.is_some() || !self.models.is_empty() {
            return Err(invalid(
                "kind",
                "endpoints and model lists require a custom provider",
            ));
        }
        let allowed = match (self.kind.as_str(), self.id.as_str(), self.cloud_auth()) {
            ("cloud", "amazon-bedrock", "bearer") => vec!["region"],
            ("cloud", "amazon-bedrock", "profile") => vec!["region", "profile"],
            ("cloud", "google-vertex", "apiKey") => vec![],
            ("cloud", "google-vertex", "adc") => vec!["project", "region"],
            ("cloud", "google-vertex", "serviceAccount") => {
                vec!["project", "region", "credentialPath"]
            }
            ("cloud", _, _) => {
                return Err(invalid(
                    "auth",
                    "choose a supported cloud authentication method",
                ));
            }
            _ if self.auth.is_some() => {
                return Err(invalid(
                    "auth",
                    "only cloud providers have cloud authentication methods",
                ));
            }
            _ => vec![],
        };
        for (field, v) in [
            ("region", &self.region),
            ("project", &self.project),
            ("profile", &self.profile),
            ("credentialPath", &self.credential_path),
        ] {
            if let Some(s) = v {
                if !allowed.contains(&field) || !nonempty(s) {
                    return Err(invalid(field, "unexpected or invalid cloud setting"));
                }
                if field == "credentialPath" && !Path::new(s).is_absolute() {
                    return Err(invalid(field, "expected an absolute credential file path"));
                }
            } else if allowed.contains(&field)
                && !(field == "region" && self.id == "amazon-bedrock")
            {
                return Err(invalid(field, "required for this authentication method"));
            }
        }
        Ok(())
    }

    fn credential(
        &self,
        key: Option<String>,
        before: Option<&Stored>,
        change: &str,
    ) -> Result<Option<ProviderCredential>> {
        let no_key_mode = self.kind == "cloud"
            && matches!(self.cloud_auth(), "profile" | "adc" | "serviceAccount");
        let old_key = before.is_some_and(|v| {
            v.has_credential
                && !(v.provider.kind == "cloud"
                    && matches!(
                        v.provider.cloud_auth(),
                        "profile" | "adc" | "serviceAccount"
                    ))
        });
        if no_key_mode && key.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err(invalid(
                "key",
                "this authentication method does not use an API key",
            ));
        }
        if key.is_none()
            && old_key
            && let Some(old) = before
            && (old.provider.base_url != self.base_url || old.provider.api != self.api)
        {
            return Err(invalid(
                "key",
                "re-enter or clear the key for the new destination",
            ));
        }
        let has_key = !no_key_mode && key.as_ref().map_or(old_key, |s| !s.is_empty());
        if !has_key && !no_key_mode && !self.custom() {
            return Err(invalid("key", "an API key is required"));
        }
        if self.custom()
            && has_key
            && let Some(url) = &self.base_url
            && !secure_for_key(url)?
        {
            return Err(invalid(
                "baseUrl",
                "keys require HTTPS or a loopback address",
            ));
        }
        if !has_key && !no_key_mode {
            return Ok(None);
        }
        let mut env = BTreeMap::from([("PIARC_CHANGE_ID".to_owned(), change.to_owned())]);
        for (name, value) in [
            ("PIARC_BOUND_API", &self.api),
            ("PIARC_BOUND_BASE_URL", &self.base_url),
            ("GOOGLE_CLOUD_PROJECT", &self.project),
            ("AWS_PROFILE", &self.profile),
            ("GOOGLE_APPLICATION_CREDENTIALS", &self.credential_path),
            (
                if self.id == "amazon-bedrock" {
                    "AWS_REGION"
                } else {
                    "GOOGLE_CLOUD_LOCATION"
                },
                &self.region,
            ),
        ] {
            if let Some(value) = value {
                env.insert(name.to_owned(), value.clone());
            }
        }
        Ok(Some(ProviderCredential {
            r#type: "api_key".into(),
            key: key.filter(|s| !s.is_empty()),
            env: Some(env),
        }))
    }
}

/// Whether a key may be sent to `url`: HTTPS, or plain HTTP to a loopback address.
fn secure_for_key(url: &str) -> Result<bool> {
    let uri = endpoint(url)?;
    let host = uri.host().unwrap_or_default().trim_matches(['[', ']']);
    Ok(uri.scheme_str() != Some("http")
        || host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|a| a.is_loopback()))
}

fn endpoint(url: &str) -> Result<http::Uri> {
    let bad = || {
        invalid(
            "baseUrl",
            "enter an HTTP(S) base URL without credentials, query or fragment",
        )
    };
    let uri = url.parse::<http::Uri>().map_err(|_| bad())?;
    let auth = uri.authority().ok_or_else(bad)?;
    let host = auth.host();
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || host.is_empty()
        || auth.as_str().contains('@')
        || url.contains(['?', '#', '\\'])
        || url.chars().any(char::is_whitespace)
        || auth
            .as_str()
            .strip_prefix(host)
            .is_some_and(|p| !p.is_empty() && uri.port_u16().is_none())
    {
        return Err(bad());
    }
    Ok(uri)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(flatten)]
    provider: Provider,
    has_credential: bool,
}

/// Prior state remains authoritative until the vault confirms the matching change id.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    id: String,
    change_id: String,
    #[serde(default)]
    next: Option<Stored>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    #[serde(default)]
    providers: Vec<Stored>,
    #[serde(default = "default_refresh")]
    pub(crate) catalog_refresh: bool,
    /// Per-model settings keyed by `<provider>/<model id>` (T29).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) models: BTreeMap<String, ModelOverride>,
    /// The auxiliary model (T29); absent: the session's model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) auxiliary: Option<ModelRef>,
    /// The auxiliary model as an alias (T31), resolved with `aliases`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) auxiliary_alias: Option<ModelAlias>,
    /// The user's model alias table: `modelAliases` of the same file (T31), written with these
    /// settings.
    #[serde(skip)]
    pub(crate) aliases: BTreeMap<ModelAlias, String>,
    /// Providers the user turned off (ADR-0083): configured ones and sign-in ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) disabled: Vec<String>,
    /// The signed-in accounts (ADR-0083): public details only, the tokens are in the vault.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) accounts: Vec<crate::provider_accounts::Account>,
    #[serde(skip)]
    pending: Option<Pending>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            providers: vec![],
            catalog_refresh: true,
            models: BTreeMap::new(),
            auxiliary: None,
            auxiliary_alias: None,
            aliases: BTreeMap::new(),
            disabled: vec![],
            accounts: vec![],
            pending: None,
        }
    }
}
impl Settings {
    pub(crate) fn journal(dir: &Path) -> std::path::PathBuf {
        dir.join("agent-host").join("provider-change.json")
    }
    pub(crate) fn read(dir: &Path, default_refresh: bool) -> Result<Self> {
        let file = crate::client_settings::read(dir)?;
        let aliases = alias_table(file.get("modelAliases"));
        let mut settings = file
            .get("modelProviders")
            .cloned()
            .map(serde_json::from_value::<Self>)
            .transpose()
            .map_err(|_| invalid("modelProviders", "invalid saved settings"))?
            .unwrap_or_else(|| Self {
                catalog_refresh: default_refresh,
                ..Self::default()
            });
        settings.aliases = aliases;
        settings.pending = match std::fs::read(Self::journal(dir)) {
            Ok(bytes) => Some(
                serde_json::from_slice::<Pending>(&bytes)
                    .map_err(|_| invalid("modelProviders", "invalid provider recovery record"))?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_error(e)),
        };
        Ok(settings)
    }
    pub(crate) fn write_pending(&self, dir: &Path) -> Result<()> {
        let pending = self.pending.as_ref().expect("a prepared update");
        if self.providers.iter().all(|p| p.provider.id != pending.id)
            && read_models(dir)?
                .get("providers")
                .is_some_and(|defs| defs.get(&pending.id).is_some())
        {
            return Err(invalid(
                "id",
                "this provider ID already exists in models.json",
            ));
        }
        let bytes = serde_json::to_vec_pretty(pending)
            .map_err(|_| invalid("modelProviders", "cannot encode provider recovery record"))?;
        piarc_config::write::replace_file(&Self::journal(dir), &bytes)?;
        Ok(())
    }
    pub(crate) fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub(crate) fn persist(
        &self,
        dir: &Path,
        managed: &crate::managed::ManagedSettings,
    ) -> Result<()> {
        crate::client_settings::write_user_value(
            dir,
            managed,
            "/modelProviders",
            Some(json!(self)),
        )?;
        let aliases = (!self.aliases.is_empty()).then(|| json!(self.aliases));
        crate::client_settings::write_user_value(dir, managed, "/modelAliases", aliases)?;
        match std::fs::remove_file(Self::journal(dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e)),
        }
    }
    pub(crate) fn view(&self, builtins: &[CatalogProvider]) -> Value {
        json!({"catalogRefresh":self.catalog_refresh,"providers":self.providers,"builtinProviders":builtins,"models":self.models,"auxiliary":self.auxiliary,"auxiliaryAlias":self.auxiliary_alias,"aliases":self.aliases,"disabled":self.disabled})
    }

    /// What the Agent Hosts get (T29): the user's per-model settings, and low tool reliability
    /// for the models of keyless local endpoints (small local models call tools unreliably; the
    /// user can choose the default Tool Profile for a model).
    pub(crate) fn preferences(&self) -> ModelPreferences {
        let mut models = self.models.clone();
        for stored in self.providers.iter().filter(|s| s.provider.kind == "local") {
            for model in &stored.provider.models {
                models
                    .entry(format!("{}/{model}", stored.provider.id))
                    .or_default()
                    .tool_reliability
                    .get_or_insert(ToolReliability::Low);
            }
        }
        // An auxiliary alias that is not set leaves the session's model (T31).
        let auxiliary = match self.auxiliary_alias {
            Some(alias) => resolve_alias(alias, &self.aliases),
            None => self.auxiliary.clone(),
        };
        ModelPreferences {
            auxiliary,
            models,
            auxiliary_alias: None,
            aliases: BTreeMap::new(),
            disabled_providers: self.disabled.clone(),
        }
    }

    /// Turns `id` on or off (ADR-0083). `known` tells whether a provider of that id exists to
    /// be turned off (configured or offering sign-in).
    pub(crate) fn set_enabled(&mut self, id: &str, enabled: bool, known: bool) -> Result<()> {
        if !enabled && !known {
            return Err(invalid("id", "provider does not exist"));
        }
        self.disabled.retain(|d| d != id);
        if !enabled {
            self.disabled.push(id.to_owned());
            self.disabled.sort();
        }
        Ok(())
    }

    /// The saved provider whose stored key a model list request may use: a custom one with a
    /// key, saved for the same address and protocol (ADR-0083).
    pub(crate) fn stored_key_for(&self, d: &Discover) -> Option<String> {
        let id = d.provider.as_deref()?;
        self.providers
            .iter()
            .find(|s| {
                s.provider.id == id
                    && s.provider.custom()
                    && s.has_credential
                    && s.provider.base_url.as_deref() == Some(d.base_url.as_str())
                    && s.provider.api.as_deref() == Some(d.api.as_str())
            })
            .map(|s| s.provider.id.clone())
    }

    /// Whether `id` is a configured provider.
    pub(crate) fn configured(&self, id: &str) -> bool {
        self.providers.iter().any(|s| s.provider.id == id)
    }

    /// Writes the `models.json` entry of custom provider `id` as its settings say: present when
    /// turned on, absent when off (ADR-0083). Other entries stay as they are.
    pub(crate) fn project_one(&self, dir: &Path, id: &str) -> Result<()> {
        let Some(stored) = self.providers.iter().find(|s| s.provider.id == id) else {
            return Ok(());
        };
        if !stored.provider.custom() {
            return Ok(());
        }
        let mut models = read_models(dir)?;
        let providers = providers_of(&mut models)?;
        if self.disabled.iter().any(|d| d == id) {
            providers.remove(id);
        } else {
            providers.insert(id.to_owned(), definition(stored));
        }
        write_models(dir, &models)
    }
    pub(crate) fn prepare(
        &mut self,
        op: Operation,
        builtins: &[CatalogProvider],
    ) -> Result<ModelsCredentialParams> {
        let change_id = crate::sessions::new_session_id()?;
        let (id, next, credential, keep_key) = match op {
            Operation::Save(provider, key) => {
                if provider.custom() == builtins.iter().any(|b| b.id == provider.id)
                    || provider.id == "openai-codex"
                {
                    return Err(invalid(
                        "id",
                        "choose a built-in provider or a unique custom ID",
                    ));
                }
                let old = self.providers.iter().find(|v| v.provider.id == provider.id);
                let keep_key = key.is_none()
                    && old.is_some_and(|v| v.has_credential)
                    && !(provider.kind == "cloud"
                        && matches!(provider.cloud_auth(), "profile" | "adc" | "serviceAccount"));
                let credential = provider.credential(key, old, &change_id)?;
                let id = provider.id.clone();
                (
                    id,
                    Some(Stored {
                        provider: *provider,
                        has_credential: credential.is_some(),
                    }),
                    credential,
                    keep_key,
                )
            }
            Operation::Delete(id) => {
                if !self.providers.iter().any(|p| p.provider.id == id) {
                    return Err(invalid("id", "provider does not exist"));
                }
                (id, None, None, false)
            }
            _ => {
                return Err(Error::Internal {
                    reason: "expected a provider change".into(),
                });
            }
        };
        self.pending = Some(Pending {
            id: id.clone(),
            change_id,
            next,
        });
        Ok(ModelsCredentialParams {
            provider: id,
            credential,
            keep_key: keep_key.then_some(true),
        })
    }
    pub(crate) fn saving(&self) -> bool {
        self.pending.as_ref().is_some_and(|p| p.next.is_some())
    }
    pub(crate) fn pending_id(&self) -> Option<&str> {
        self.pending.as_ref().map(|p| p.id.as_str())
    }
    pub(crate) fn committed(
        &self,
        status: &piarc_protocol::models::CredentialStatusResult,
    ) -> bool {
        self.pending.as_ref().is_some_and(|p| {
            if p.next.as_ref().is_some_and(|s| s.has_credential) {
                status.change_id.as_ref() == Some(&p.change_id)
            } else {
                !status.has_credential
            }
        })
    }

    // Preserve unrelated, pre-existing model definitions such as imported endpoints. Only the
    // affected provider is replaced. The retry derives the same definition after interruption.
    pub(crate) fn project(&self, dir: &Path, apply: bool) -> Result<()> {
        let Some(p) = &self.pending else {
            return Ok(());
        };
        let old = self.providers.iter().find(|s| s.provider.id == p.id);
        if !old.is_some_and(|s| s.provider.custom())
            && !p.next.as_ref().is_some_and(|s| s.provider.custom())
        {
            return Ok(());
        }
        let mut models = read_models(dir)?;
        let providers = providers_of(&mut models)?;
        let target = if apply { p.next.as_ref() } else { old };
        // A provider the user turned off stays out of Pi's catalog (ADR-0083).
        let off = self.disabled.iter().any(|d| d == &p.id);
        if let Some(stored) = target.filter(|s| s.provider.custom() && !off) {
            providers.insert(p.id.clone(), definition(stored));
        } else {
            providers.remove(&p.id);
        }
        write_models(dir, &models)
    }
    pub(crate) fn finish(&mut self, apply: bool) {
        if let Some(p) = self.pending.take()
            && apply
        {
            self.providers.retain(|s| s.provider.id != p.id);
            if p.next.is_none() {
                self.disabled.retain(|d| d != &p.id);
            }
            if let Some(next) = p.next {
                self.providers.push(next);
                self.providers
                    .sort_by(|a, b| a.provider.id.cmp(&b.provider.id));
            }
        }
    }
}
/// The model preferences saved in the user's settings (none when they cannot be read).
pub(crate) fn preferences(dir: &Path) -> ModelPreferences {
    Settings::read(dir, true)
        .map(|s| s.preferences())
        .unwrap_or_default()
}

/// Supplies PiArc defaults without discarding other Pi SDK settings or explicit preferences.
/// In particular, configuring an API key must not enable paid cache-warming by itself.
pub(crate) fn ensure_pi_defaults(dir: &Path) -> Result<()> {
    let path = dir.join("pi").join("settings.json");
    let mut settings: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| invalid("pi/settings.json", "expected a settings object"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(io_error(e)),
    };
    let fields = settings
        .as_object_mut()
        .ok_or_else(|| invalid("pi/settings.json", "expected an object"))?;
    let cache_missing = !fields.contains_key("cacheWarming");
    fields.entry("cacheWarming").or_insert_with(|| json!("off"));
    let images = fields
        .entry("images")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| invalid("pi/settings.json", "expected an images settings object"))?;
    let resize_missing = !images.contains_key("autoResize");
    images.entry("autoResize").or_insert(Value::Bool(true));
    if cache_missing || resize_missing {
        let bytes = serde_json::to_vec_pretty(&settings)
            .map_err(|_| invalid("pi/settings.json", "cannot encode settings"))?;
        piarc_config::write::replace_file(&path, &bytes)?;
    }
    Ok(())
}
/// The `models.json` definition of a custom provider.
fn definition(stored: &Stored) -> Value {
    let config = &stored.provider;
    let mut def = json!({"api":config.api,"baseUrl":config.base_url,"models":config.models.iter().map(|id|json!({"id":id})).collect::<Vec<_>>()});
    if !stored.has_credential {
        def["apiKey"] = json!("piarc-no-key");
    }
    def
}

fn providers_of(models: &mut Value) -> Result<&mut serde_json::Map<String, Value>> {
    models
        .as_object_mut()
        .ok_or_else(|| invalid("models.json", "expected an object"))?
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| invalid("models.json", "expected providers object"))
}

fn write_models(dir: &Path, models: &Value) -> Result<()> {
    piarc_config::write::replace_file(
        &dir.join("pi").join("models.json"),
        &serde_json::to_vec_pretty(models)
            .map_err(|_| invalid("models.json", "cannot encode models"))?,
    )?;
    Ok(())
}

fn read_models(dir: &Path) -> Result<Value> {
    match std::fs::read(dir.join("pi").join("models.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| invalid("models.json", "malformed model configuration")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"providers":{}})),
        Err(e) => Err(io_error(e)),
    }
}
pub(crate) fn io_error(error: std::io::Error) -> Error {
    Error::Feature {
        kind: piarc_protocol::ErrorKind::IoError,
        retryable: false,
        message: error.to_string(),
        details: None,
    }
}

/// The `modelAliases` object of the user's file, keeping only known aliases with text values.
fn alias_table(value: Option<&Value>) -> BTreeMap<ModelAlias, String> {
    let Some(Value::Object(table)) = value else {
        return BTreeMap::new();
    };
    table
        .iter()
        .filter_map(|(alias, target)| {
            let alias = serde_json::from_value(Value::String(alias.clone())).ok()?;
            let target = target.as_str()?.trim();
            (!target.is_empty()).then(|| (alias, target.to_owned()))
        })
        .collect()
}

/// The model an alias names: its own setting, else the tier it follows (`haiku` → `fast`,
/// `sonnet` → `balanced`, `opus` → `strong`).
fn resolve_alias(alias: ModelAlias, table: &BTreeMap<ModelAlias, String>) -> Option<ModelRef> {
    let (provider, id) = alias.target(table)?.split_once('/')?;
    Some(ModelRef {
        provider: provider.to_owned(),
        id: id.to_owned(),
    })
}

#[cfg(test)]
#[path = "providers_tests.rs"]
mod tests;
