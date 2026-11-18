//! User-owned provider settings. Only public connection details are serialized here. Credentials
//! go to the supervised settings Host, whose Pi ModelRuntime writes through the vault adapter.
use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::path::Path;

use piarc_protocol::models::{CatalogProvider, ModelsCredentialParams, ProviderCredential};
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
}

impl Operation {
    /// Parses UI input without exposing credential text in error messages.
    ///
    /// # Errors
    /// Invalid fields or malformed configuration objects.
    pub fn save(config: &str, secret: Option<&str>) -> Result<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Secret {
            key: String,
        }
        let provider = serde_json::from_str::<Provider>(config)
            .map_err(|_| invalid("config", "invalid provider fields"))?;
        provider.validate()?;
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
        Ok(Self::Save(Box::new(provider), key))
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
        {
            let uri = endpoint(url)?;
            let host = uri.host().unwrap_or_default().trim_matches(['[', ']']);
            if uri.scheme_str() == Some("http")
                && !(host.eq_ignore_ascii_case("localhost")
                    || host.parse::<IpAddr>().is_ok_and(|a| a.is_loopback()))
            {
                return Err(invalid(
                    "baseUrl",
                    "keys require HTTPS or a loopback address",
                ));
            }
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
    #[serde(skip)]
    pending: Option<Pending>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            providers: vec![],
            catalog_refresh: true,
            pending: None,
        }
    }
}
impl Settings {
    pub(crate) fn journal(dir: &Path) -> std::path::PathBuf {
        dir.join("agent-host").join("provider-change.json")
    }
    pub(crate) fn read(dir: &Path, default_refresh: bool) -> Result<Self> {
        let mut settings = crate::client_settings::read(dir)?
            .get("modelProviders")
            .cloned()
            .map(serde_json::from_value::<Self>)
            .transpose()
            .map_err(|_| invalid("modelProviders", "invalid saved settings"))?
            .unwrap_or_else(|| Self {
                catalog_refresh: default_refresh,
                ..Self::default()
            });
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
    pub(crate) fn persist(&self, dir: &Path) -> Result<()> {
        crate::client_settings::write_user_value(dir, "/modelProviders", Some(json!(self)))?;
        match std::fs::remove_file(Self::journal(dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e)),
        }
    }
    pub(crate) fn view(&self, builtins: &[CatalogProvider]) -> Value {
        json!({"catalogRefresh":self.catalog_refresh,"providers":self.providers,"builtinProviders":builtins})
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
        let path = dir.join("pi").join("models.json");
        let mut models = read_models(dir)?;
        let providers = models
            .as_object_mut()
            .ok_or_else(|| invalid("models.json", "expected an object"))?
            .entry("providers")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| invalid("models.json", "expected providers object"))?;
        let target = if apply { p.next.as_ref() } else { old };
        if let Some(stored) = target.filter(|s| s.provider.custom()) {
            let config = &stored.provider;
            let mut def = json!({"api":config.api,"baseUrl":config.base_url,"models":config.models.iter().map(|id|json!({"id":id})).collect::<Vec<_>>()});
            if !stored.has_credential {
                def["apiKey"] = json!("piarc-no-key");
            }
            providers.insert(p.id.clone(), def);
        } else {
            providers.remove(&p.id);
        }
        piarc_config::write::replace_file(
            &path,
            &serde_json::to_vec_pretty(&models)
                .map_err(|_| invalid("models.json", "cannot encode models"))?,
        )?;
        Ok(())
    }
    pub(crate) fn finish(&mut self, apply: bool) {
        if let Some(p) = self.pending.take()
            && apply
        {
            self.providers.retain(|s| s.provider.id != p.id);
            if let Some(next) = p.next {
                self.providers.push(next);
                self.providers
                    .sort_by(|a, b| a.provider.id.cmp(&b.provider.id));
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use piarc_protocol::models::CredentialStatusResult;

    fn dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "piarc-provider-{}",
            crate::sessions::new_session_id().unwrap()
        ));
        for child in ["pi", "agent-host"] {
            std::fs::create_dir_all(dir.join(child)).unwrap();
        }
        dir
    }
    fn relay(url: &str) -> Value {
        json!({"kind":"custom","id":"relay","api":"anthropic-messages","baseUrl":url,"models":["one"]})
    }
    fn save(config: Value, key: Option<&str>) -> Operation {
        Operation::save(
            &config.to_string(),
            key.map(|s| json!({"key":s}).to_string()).as_deref(),
        )
        .unwrap()
    }

    #[test]
    fn recovery_keeps_the_matching_credential_and_reverts_an_uncommitted_edit() {
        let dir = dir();
        let mut s = Settings::read(&dir, true).unwrap();
        let first = relay("https://first.example/v1");
        let req = s
            .prepare(save(first.clone(), Some("fake-first")), &[])
            .unwrap();
        s.write_pending(&dir).unwrap();
        s.project(&dir, true).unwrap();
        let status = CredentialStatusResult {
            has_credential: true,
            change_id: req
                .credential
                .unwrap()
                .env
                .unwrap()
                .remove("PIARC_CHANGE_ID"),
        };
        let mut restarted = Settings::read(&dir, true).unwrap();
        assert!(restarted.committed(&status));
        restarted.finish(true);
        restarted.persist(&dir).unwrap();
        let second = relay("https://other.example/v1");
        assert!(restarted.prepare(save(second.clone(), None), &[]).is_err());
        restarted
            .prepare(save(second, Some("fake-second")), &[])
            .unwrap();
        restarted.write_pending(&dir).unwrap();
        restarted.project(&dir, true).unwrap();
        let mut interrupted = Settings::read(&dir, true).unwrap();
        assert!(!interrupted.committed(&status));
        interrupted.project(&dir, false).unwrap();
        interrupted.finish(false);
        interrupted.persist(&dir).unwrap();
        assert_eq!(
            read_models(&dir).unwrap()["providers"]["relay"]["baseUrl"],
            first["baseUrl"]
        );
        assert!(!Settings::journal(&dir).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn imported_id_conflict_never_changes_existing_configuration() {
        let dir = dir();
        let existing = json!({"providers":{"relay":{"models":[{"id":"existing"}],"api":"openai-responses","baseUrl":"https://original.example/"}}});
        let path = dir.join("pi/models.json");
        std::fs::write(&path, existing.to_string()).unwrap();
        let mut s = Settings::read(&dir, true).unwrap();
        s.prepare(save(relay("https://other.example"), Some("example")), &[])
            .unwrap();
        assert!(matches!(
            s.write_pending(&dir),
            Err(Error::InvalidArgument { field: "id", .. })
        ));
        assert!(!Settings::journal(&dir).exists());
        assert_eq!(std::fs::read_to_string(path).unwrap(), existing.to_string());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn authenticated_remote_urls_reject_userinfo_plaintext_and_lookalike_hosts() {
        for url in [
            "http://127.example.org/v1",
            "http://localhost.example",
            "http://[::2]",
            "https://localhost@somewhere.example",
            "https://host.example?token=hidden",
            "https://host.example:wrong/v1",
        ] {
            let result = Operation::save(&relay(url).to_string(), Some(r#"{"key":"example"}"#))
                .and_then(|op| Settings::default().prepare(op, &[]));
            assert!(
                matches!(
                    result,
                    Err(Error::InvalidArgument {
                        field: "baseUrl",
                        ..
                    })
                ),
                "{url}"
            );
        }
        for url in [
            "http://127.0.0.2",
            "http://[::1]:12345/v1",
            "https://example.org",
        ] {
            Settings::default()
                .prepare(save(relay(url), Some("example")), &[])
                .expect("valid endpoint");
        }
    }
    #[test]
    fn paid_cache_warming_is_opt_in_and_existing_preferences_are_preserved() {
        let dir = dir();
        ensure_pi_defaults(&dir).unwrap();
        let path = dir.join("pi/settings.json");
        let data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            data,
            json!({"cacheWarming":"off","images":{"autoResize":true}})
        );
        let settings =
            json!({"cacheWarming":"idle","images":{"autoResize":false},"retry":{"enabled":false}});
        std::fs::write(&path, settings.to_string()).unwrap();
        ensure_pi_defaults(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), settings.to_string());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
