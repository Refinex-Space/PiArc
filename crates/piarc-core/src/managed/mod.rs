//! Managed (enterprise) settings on Core's side (T47, design addendum
//! `docs/architecture/addenda/T47-auto-memory-and-managed-settings.md`, sections 5–8).
//!
//! [`ManagedSettings`] reads every administrator document through a
//! [`piarc_ports::PolicyStore`] ([`store::SystemPolicy`] in the app, [`store::FixedPolicy`] in
//! tests), checks and merges them with [`piarc_config::managed::Managed`] and keeps the result
//! as a [`Snapshot`]. [`crate::dirs::DataDirs::layers`] adds the snapshot's `enterprise` layer
//! to every settings table, so each consumer of settings sees it.
//!
//! - **Startup.** [`ManagedSettings::load`] reads synchronously before any workspace opens;
//!   a document that is not a JSON object is [`Error::ManagedSettings`] and Core does not start
//!   (section 8.1).
//! - **Changes.** [`ManagedSettings::spawn_poll`] reads everything again every
//!   [`ManagedConfig::poll`] ([`DEFAULT_POLL`], 60 s); a different fingerprint rebuilds the
//!   snapshot (a document that broke keeps its last content) and advances
//!   [`ManagedSettings::changes`].
//! - **Read order** (highest first, section 6.3): PiArc's policy documents, PiArc's
//!   `managed-settings.d/` (later names first) and `managed-settings.json`, then Claude Code's
//!   in the same order. The managed `CLAUDE.md` of each product is a memory document; Claude
//!   Code's `managed-mcp.json` is the exclusive enterprise MCP set (section 7).

pub mod store;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use piarc_config::managed::{Channel, Family, Managed, RawBody, RawSource};
use piarc_ports::{PolicyBody, PolicyProduct, PolicyStore};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

/// How often the managed documents are read again.
pub const DEFAULT_POLL: Duration = Duration::from_secs(60);

/// The managed settings file of a product's directory.
pub const SETTINGS_FILE: &str = "managed-settings.json";

/// The drop-in directory next to it.
pub const DROP_INS: &str = "managed-settings.d";

/// The managed memory document.
pub const MEMORY_FILE: &str = "CLAUDE.md";

/// Claude Code's exclusive MCP configuration.
pub const MCP_FILE: &str = "managed-mcp.json";

/// Where Core reads managed settings and how often.
#[derive(Clone)]
pub struct ManagedConfig {
    /// The administrator's places; `None` reads nothing (the default, for tests that do not
    /// stand in for an administrator).
    pub store: Option<Arc<dyn PolicyStore>>,
    /// The interval between reads.
    pub poll: Duration,
}

impl std::fmt::Debug for ManagedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedConfig")
            .field("store", &self.store.is_some())
            .field("poll", &self.poll)
            .finish()
    }
}

impl Default for ManagedConfig {
    fn default() -> Self {
        Self {
            store: None,
            poll: DEFAULT_POLL,
        }
    }
}

impl ManagedConfig {
    /// The system's places (the app).
    #[must_use]
    pub fn system() -> Self {
        Self {
            store: Some(Arc::new(store::SystemPolicy)),
            poll: DEFAULT_POLL,
        }
    }
}

/// Claude Code's `managed-mcp.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct ManagedMcp {
    /// The file.
    pub location: PathBuf,
    /// Its `mcpServers` object (`None` when the file is broken: no server runs then, the
    /// exclusive set still applies).
    pub servers: Option<Value>,
    /// Why it could not be used.
    pub problem: Option<String>,
}

/// The managed settings at one moment.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    /// The checked documents and their merge.
    pub managed: Managed,
    /// The managed memory documents that exist: PiArc's, then Claude Code's.
    pub memory: Vec<PathBuf>,
    /// Claude Code's exclusive MCP set.
    pub mcp: Option<ManagedMcp>,
    fingerprint: Vec<u8>,
}

impl Snapshot {
    /// The `enterprise` layer, when the managed settings set anything.
    #[must_use]
    pub fn layer(&self) -> Option<piarc_config::LayerSpec> {
        (!self.managed.is_empty()).then(|| self.managed.layer())
    }

    /// Whether any managed document exists.
    #[must_use]
    pub fn configured(&self) -> bool {
        !self.managed.sources.is_empty() || !self.memory.is_empty() || self.mcp.is_some()
    }

    /// The location of the highest document, for `ConfigChange`'s `file_path`.
    #[must_use]
    pub fn primary(&self) -> Option<&Path> {
        self.managed
            .sources
            .first()
            .map(|s| s.location.as_path())
            .or_else(|| self.mcp.as_ref().map(|m| m.location.as_path()))
    }
}

struct Inner {
    store: Option<Arc<dyn PolicyStore>>,
    poll: Duration,
    current: RwLock<Arc<Snapshot>>,
    version: watch::Sender<u64>,
}

/// Core's managed settings: the current snapshot and its changes. Cheap to clone.
#[derive(Clone)]
pub struct ManagedSettings {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ManagedSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedSettings")
            .field("configured", &self.snapshot().configured())
            .finish_non_exhaustive()
    }
}

impl PartialEq for ManagedSettings {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for ManagedSettings {}

impl Default for ManagedSettings {
    fn default() -> Self {
        Self::none()
    }
}

impl ManagedSettings {
    /// No managed settings, never changing.
    #[must_use]
    pub fn none() -> Self {
        Self::with(None, DEFAULT_POLL, Snapshot::default())
    }

    fn with(store: Option<Arc<dyn PolicyStore>>, poll: Duration, snapshot: Snapshot) -> Self {
        let (version, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                store,
                poll,
                current: RwLock::new(Arc::new(snapshot)),
                version,
            }),
        }
    }

    /// Reads the managed documents of `config` (blocking).
    ///
    /// # Errors
    ///
    /// [`Error::ManagedSettings`] when a document is not a JSON object (section 8.1).
    pub fn load(config: &ManagedConfig) -> Result<Self> {
        let Some(store) = config.store.clone() else {
            return Ok(Self::none());
        };
        let snapshot = read(store.as_ref(), None);
        if let Some(bad) = snapshot.managed.errors().next() {
            let issue = bad.issues.first();
            return Err(Error::ManagedSettings {
                location: bad.location.display().to_string(),
                reason: issue.map_or_else(|| "not valid".to_owned(), |i| i.message.clone()),
                line: issue.and_then(|i| i.line),
                column: issue.and_then(|i| i.column),
            });
        }
        Ok(Self::with(Some(store), config.poll, snapshot))
    }

    /// The current snapshot.
    #[must_use]
    pub fn snapshot(&self) -> Arc<Snapshot> {
        Arc::clone(
            &self
                .inner
                .current
                .read()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// Advances after every change of the snapshot.
    #[must_use]
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.inner.version.subscribe()
    }

    /// Reads the documents again (blocking); returns whether the snapshot changed.
    pub fn refresh(&self) -> bool {
        let Some(store) = &self.inner.store else {
            return false;
        };
        let before = self.snapshot();
        let next = read(store.as_ref(), Some(&before));
        if next.fingerprint == before.fingerprint {
            return false;
        }
        if let Some(bad) = next.managed.sources.iter().find(|s| {
            s.status == piarc_config::managed::SourceStatus::Stale
                && !before
                    .managed
                    .sources
                    .iter()
                    .any(|b| b.location == s.location && b.status == s.status)
        }) {
            tracing::warn!(target: "piarc_core::managed", location = %bad.location.display(), "a managed settings document is not valid; its last content stays in effect");
        }
        *self
            .inner
            .current
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(next);
        self.inner.version.send_modify(|n| *n += 1);
        true
    }

    /// Reads the documents again every poll interval until `cancel`.
    pub fn spawn_poll(&self, handle: &Handle, cancel: CancellationToken) {
        if self.inner.store.is_none() {
            return;
        }
        let this = self.clone();
        handle.spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(this.inner.poll) => {}
                }
                let reader = this.clone();
                if let Err(error) = tokio::task::spawn_blocking(move || reader.refresh()).await {
                    tracing::error!(target: "piarc_core::managed", "reading managed settings failed: {error}");
                }
            }
        });
    }
}

/// Reads every document of `store` and builds a snapshot (`previous` keeps broken documents'
/// last content).
fn read(store: &dyn PolicyStore, previous: Option<&Snapshot>) -> Snapshot {
    let mut sources = Vec::new();
    let mut memory = Vec::new();
    let mut mcp = None;
    let mut digest = Sha256::new();
    for (product, family) in [
        (PolicyProduct::Piarc, Family::Piarc),
        (PolicyProduct::ClaudeCode, Family::ClaudeCode),
    ] {
        for document in store.documents(product) {
            sources.push(RawSource {
                family,
                channel: Channel::Policy,
                location: document.location,
                body: policy_body(document.body),
            });
        }
        let Some(dir) = store.files_dir(product) else {
            continue;
        };
        for file in settings_files(&dir) {
            if let Some(body) = file_body(&file) {
                sources.push(RawSource {
                    family,
                    channel: Channel::File,
                    location: file,
                    body,
                });
            }
        }
        let instructions = dir.join(MEMORY_FILE);
        if let Ok(bytes) = std::fs::read(&instructions) {
            digest.update(instructions.as_os_str().as_encoded_bytes());
            digest.update(&bytes);
            memory.push(instructions);
        }
        if product == PolicyProduct::ClaudeCode {
            mcp = managed_mcp(&dir.join(MCP_FILE), &mut digest);
        }
    }
    for source in &sources {
        digest.update(source.location.as_os_str().as_encoded_bytes());
        match &source.body {
            RawBody::Text(bytes) => digest.update(bytes),
            RawBody::Value(value) => digest.update(value.to_string()),
            RawBody::Invalid(reason) | RawBody::Unreadable(reason) => digest.update(reason),
        }
    }
    let managed = Managed::build(sources, previous.map(|p| &p.managed));
    Snapshot {
        managed,
        memory,
        mcp,
        fingerprint: digest.finalize().to_vec(),
    }
}

/// `managed-settings.d/*.json` (later names first, hidden files skipped), then
/// `managed-settings.json`.
fn settings_files(dir: &Path) -> Vec<PathBuf> {
    let mut drop_ins: Vec<PathBuf> = std::fs::read_dir(dir.join(DROP_INS))
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !n.starts_with('.') && n.ends_with(".json"))
                && path.is_file()
        })
        .collect();
    drop_ins.sort();
    drop_ins.reverse();
    drop_ins.push(dir.join(SETTINGS_FILE));
    drop_ins
}

fn file_body(path: &Path) -> Option<RawBody> {
    match std::fs::read(path) {
        Ok(bytes) => Some(RawBody::Text(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => Some(RawBody::Unreadable(error.to_string())),
    }
}

fn policy_body(body: PolicyBody) -> RawBody {
    match body {
        PolicyBody::Json(bytes) => RawBody::Text(bytes),
        PolicyBody::Unreadable(reason) => RawBody::Unreadable(reason),
        PolicyBody::PropertyList(bytes) => property_list(&bytes),
    }
}

/// A property list as JSON: dictionaries, arrays, strings, booleans and numbers convert; dates,
/// data and identifiers become `null`, which the checks then drop with an issue.
#[cfg(target_os = "macos")]
fn property_list(bytes: &[u8]) -> RawBody {
    fn convert(value: plist::Value) -> Value {
        match value {
            plist::Value::Dictionary(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, convert(value)))
                    .collect(),
            ),
            plist::Value::Array(list) => Value::Array(list.into_iter().map(convert).collect()),
            plist::Value::Boolean(b) => Value::Bool(b),
            plist::Value::String(s) => Value::String(s),
            plist::Value::Integer(i) => i
                .as_signed()
                .map(Value::from)
                .or_else(|| i.as_unsigned().map(Value::from))
                .unwrap_or(Value::Null),
            plist::Value::Real(f) => {
                serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
            }
            _ => Value::Null,
        }
    }
    match plist::Value::from_reader(io::Cursor::new(bytes)) {
        Ok(value) => RawBody::Value(convert(value)),
        Err(error) => RawBody::Invalid(error.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn property_list(_bytes: &[u8]) -> RawBody {
    RawBody::Invalid("property lists are read on macOS only".into())
}

fn managed_mcp(file: &Path, digest: &mut Sha256) -> Option<ManagedMcp> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            digest.update(error.to_string());
            return Some(ManagedMcp {
                location: file.to_owned(),
                servers: None,
                problem: Some(format!("cannot read it: {error}")),
            });
        }
    };
    digest.update(file.as_os_str().as_encoded_bytes());
    digest.update(&bytes);
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let (servers, problem) = match serde_json::from_slice::<Value>(text) {
        Ok(value) => match value.get("mcpServers") {
            Some(servers) if servers.is_object() => (Some(servers.clone()), None),
            Some(_) => (None, Some("mcpServers is not an object".to_owned())),
            None => (
                Some(Value::Object(serde_json::Map::new())),
                Some("no mcpServers: no MCP server runs".to_owned()),
            ),
        },
        Err(error) => (None, Some(format!("not valid JSON: {error}"))),
    };
    Some(ManagedMcp {
        location: file.to_owned(),
        servers,
        problem,
    })
}

#[cfg(test)]
mod tests;
