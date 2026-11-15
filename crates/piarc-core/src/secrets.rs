//! Serves the credential vault to every Agent Host (`secrets/*`, architecture section 5.4).
//!
//! One [`SecretsService`] per Core is shared by all Agent Hosts (one per workspace). Core is
//! the vault's only writer; Agent Hosts keep a copy in memory:
//!
//! - **Opening.** The vault opens on the first request and stays open. When opening fails
//!   (master key missing, credential store denied or locked, damaged file) the request fails
//!   with the vault's structured error and the next request tries again: after the user
//!   grants Keychain access, the next request succeeds.
//! - **Change push.** A connection that called `secrets/getAll` is subscribed; every write
//!   is pushed to every subscribed connection as `secrets/changed`, with the vault-wide
//!   revision so receivers drop stale notifications.
//! - **Locks.** `secrets/lock` takes a set of keys for one read-modify-write (an OAuth refresh)
//!   and returns their current entries. While a key is locked, other locks and unlocked
//!   writes of it wait. A lock ends with `secrets/unlock`, after its lease
//!   ([`SecretsConfig::lock_lease`]), or when the holder's connection ends. Two Agent Hosts
//!   refreshing the same token are thereby serialized: the second sees the first one's new
//!   token under the lock and does not refresh again.
//!
//! Vault operations (file I/O and the system credential store, which may show a prompt) run
//! on the blocking thread pool. Nothing here logs credential values.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use piarc_host::{InboundHandler, Peer};
use piarc_ports::{BoxFuture, SecretName, SecretStore};
use piarc_protocol::secrets::{
    SecretEntry, SecretsChanged, SecretsChangedParams, SecretsDeleteParams, SecretsDeleteResult,
    SecretsGetAllResult, SecretsGetParams, SecretsGetResult, SecretsLockParams, SecretsLockResult,
    SecretsSetParams, SecretsSetResult, SecretsUnlockParams, SecretsUnlockResult,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_secrets::{EntryView, Vault, VaultConfig};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::sync::{Notify, broadcast};
use tokio_util::sync::CancellationToken;

/// Default lease of a credential lock: longer than pi-ai's 15 s OAuth refresh timeout plus the
/// write that follows it.
pub const DEFAULT_LOCK_LEASE: Duration = Duration::from_secs(30);

/// Where the vault lives and how long locks last.
#[derive(Debug, Clone)]
pub struct SecretsConfig {
    /// The vault file and its master key item.
    pub vault: VaultConfig,
    /// How long a lock lasts unless released earlier.
    pub lock_lease: Duration,
}

impl SecretsConfig {
    /// The production layout: `<data_dir>/secrets.vault`, master key named after the
    /// application identifier ([`crate::identity::master_key_name`]).
    #[must_use]
    pub fn new(data_dir: &Path) -> Self {
        Self::with_master_key(data_dir, crate::identity::master_key_name())
    }

    /// `<data_dir>/secrets.vault` with the master key under `master_key` (tests use a
    /// `piarc-test.` service name).
    #[must_use]
    pub fn with_master_key(data_dir: &Path, master_key: SecretName) -> Self {
        Self {
            vault: VaultConfig {
                path: data_dir.join("secrets.vault"),
                master_key,
            },
            lock_lease: DEFAULT_LOCK_LEASE,
        }
    }
}

/// A vault change, for observers inside Core (no value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretChange {
    /// The credential key.
    pub key: String,
    /// The revision of the change.
    pub revision: u64,
    /// Whether the key was deleted.
    pub deleted: bool,
}

#[derive(Default)]
struct Locks {
    /// key → lock id.
    held: HashMap<String, String>,
    /// lock id → keys and the token ending its lease task.
    by_id: HashMap<String, (Vec<String>, CancellationToken)>,
}

struct Inner {
    config: SecretsConfig,
    store: Arc<dyn SecretStore>,
    vault: Arc<Mutex<Option<Vault>>>,
    locks: Mutex<Locks>,
    released: Notify,
    subscribers: Mutex<Vec<Peer>>,
    changes: broadcast::Sender<SecretChange>,
}

/// Answers `secrets/*` for every Agent Host. Cheap to clone.
#[derive(Clone)]
pub struct SecretsService {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SecretsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretsService")
            .field("vault", &self.inner.config.vault.path)
            .finish_non_exhaustive()
    }
}

impl SecretsService {
    /// A service over the vault in `config`, its master key in `store`.
    #[must_use]
    pub fn new(config: SecretsConfig, store: Arc<dyn SecretStore>) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                store,
                vault: Arc::default(),
                locks: Mutex::default(),
                released: Notify::new(),
                subscribers: Mutex::default(),
                changes: broadcast::channel(256).0,
            }),
        }
    }

    /// Whether `method` is one this service answers.
    #[must_use]
    pub fn handles(method: &str) -> bool {
        method.starts_with("secrets/")
    }

    /// Vault changes as they happen (key and revision, no value).
    #[must_use]
    pub fn changes(&self) -> broadcast::Receiver<SecretChange> {
        self.inner.changes.subscribe()
    }

    /// Answers one request from the Agent Host on `peer`.
    pub async fn dispatch(
        &self,
        method: &str,
        params: Map<String, Value>,
        peer: Peer,
    ) -> Result<Value, ErrorObject> {
        match method {
            "secrets/getAll" => {
                let entries: Vec<Result<SecretEntry, ErrorObject>> = self
                    .with_vault(|v| Ok(v.entries().map(entry).collect()))
                    .await?;
                let entries = entries.into_iter().collect::<Result<Vec<_>, _>>()?;
                self.subscribe(peer);
                to_value(&SecretsGetAllResult { entries })
            }
            "secrets/get" => {
                let p: SecretsGetParams = parse(method, params)?;
                piarc_secrets::validate_key(&p.key).map_err(|e| e.to_error_object())?;
                let found = self
                    .with_vault(move |v| Ok(v.get(&p.key).map(entry)))
                    .await?;
                to_value(&SecretsGetResult {
                    entry: found.transpose()?,
                })
            }
            "secrets/set" => {
                let p: SecretsSetParams = parse(method, params)?;
                self.set(p, &peer).await
            }
            "secrets/delete" => {
                let p: SecretsDeleteParams = parse(method, params)?;
                self.delete(p, &peer).await
            }
            "secrets/lock" => {
                let p: SecretsLockParams = parse(method, params)?;
                self.lock(p, peer).await
            }
            "secrets/unlock" => {
                let p: SecretsUnlockParams = parse(method, params)?;
                to_value(&SecretsUnlockResult {
                    released: self.release(&p.lock_id),
                })
            }
            _ => Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not handle {method}"),
                false,
            )),
        }
    }

    async fn set(&self, p: SecretsSetParams, peer: &Peer) -> Result<Value, ErrorObject> {
        piarc_secrets::validate_key(&p.key).map_err(|e| e.to_error_object())?;
        let guard = self.write_guard(&p.key, p.lock_id.as_deref(), peer).await?;
        let SecretsSetParams { key, value, .. } = p;
        let pushed = value.clone();
        let written_key = key.clone();
        let result = self
            .with_vault(move |v| v.set(&written_key, &Value::Object(value)))
            .await;
        drop(guard);
        let revision = result?;
        self.publish(key, revision, Some(pushed));
        to_value(&SecretsSetResult { revision })
    }

    async fn delete(&self, p: SecretsDeleteParams, peer: &Peer) -> Result<Value, ErrorObject> {
        piarc_secrets::validate_key(&p.key).map_err(|e| e.to_error_object())?;
        let guard = self.write_guard(&p.key, p.lock_id.as_deref(), peer).await?;
        let key = p.key.clone();
        let result = self.with_vault(move |v| v.delete(&key)).await;
        drop(guard);
        let revision = result?;
        if let Some(revision) = revision {
            self.publish(p.key, revision, None);
        }
        to_value(&SecretsDeleteResult { revision })
    }

    async fn lock(&self, p: SecretsLockParams, peer: Peer) -> Result<Value, ErrorObject> {
        if p.keys.is_empty() {
            return Err(ErrorObject::new(
                ErrorKind::InvalidParams,
                "secrets/lock: keys must not be empty",
                false,
            ));
        }
        for key in &p.keys {
            piarc_secrets::validate_key(key).map_err(|e| e.to_error_object())?;
        }
        let lock_id = self.acquire(&p.keys, &peer).await?;
        let keys = p.keys.clone();
        let entries = self
            .with_vault(move |v| Ok(keys.iter().filter_map(|k| v.get(k)).map(entry).collect()))
            .await;
        let entries = match entries.and_then(|e: Vec<_>| e.into_iter().collect()) {
            Ok(entries) => entries,
            Err(error) => {
                self.release(&lock_id);
                return Err(error);
            }
        };
        self.watch_lease(lock_id.clone(), peer);
        to_value(&SecretsLockResult {
            lock_id,
            entries,
            expires_in_ms: u64::try_from(self.inner.config.lock_lease.as_millis())
                .unwrap_or(u64::MAX),
        })
    }

    /// Before a write: with a lock id, checks that the lock covers `key`; without one, takes a
    /// transient lock on `key` (waiting for any holder), released when the guard drops.
    async fn write_guard(
        &self,
        key: &str,
        lock_id: Option<&str>,
        peer: &Peer,
    ) -> Result<Option<TransientLock>, ErrorObject> {
        if let Some(lock_id) = lock_id {
            let locks = lock(&self.inner.locks);
            return match locks.by_id.get(lock_id) {
                Some((keys, _)) if keys.iter().any(|k| k == key) => Ok(None),
                Some(_) => Err(ErrorObject::new(
                    ErrorKind::SecretLockLost,
                    format!("lock {lock_id} does not cover {key}"),
                    false,
                )),
                None => Err(ErrorObject::new(
                    ErrorKind::SecretLockLost,
                    format!("lock {lock_id} is no longer held (expired or released)"),
                    false,
                )),
            };
        }
        let id = self.acquire(&[key.to_owned()], peer).await?;
        Ok(Some(TransientLock {
            service: self.clone(),
            id,
        }))
    }

    /// Waits until none of `keys` is locked, then locks them all.
    async fn acquire(&self, keys: &[String], peer: &Peer) -> Result<String, ErrorObject> {
        loop {
            let released = self.inner.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            {
                let mut locks = lock(&self.inner.locks);
                if keys.iter().all(|k| !locks.held.contains_key(k)) {
                    let id = format!("lock-{}", random_id()?);
                    for key in keys {
                        locks.held.insert(key.clone(), id.clone());
                    }
                    locks
                        .by_id
                        .insert(id.clone(), (keys.to_vec(), CancellationToken::new()));
                    return Ok(id);
                }
            }
            tokio::select! {
                () = released => {}
                () = peer.closed() => {
                    return Err(ErrorObject::new(
                        ErrorKind::Uncertain,
                        "the connection ended while waiting for a credential lock",
                        false,
                    ));
                }
            }
        }
    }

    /// Releases the lock after its lease or when `peer`'s connection ends.
    fn watch_lease(&self, lock_id: String, peer: Peer) {
        let Some(token) = lock(&self.inner.locks)
            .by_id
            .get(&lock_id)
            .map(|(_, token)| token.clone())
        else {
            return;
        };
        let service = self.clone();
        let lease = self.inner.config.lock_lease;
        tokio::spawn(async move {
            tokio::select! {
                () = token.cancelled() => {}
                () = tokio::time::sleep(lease) => { service.release(&lock_id); }
                () = peer.closed() => { service.release(&lock_id); }
            }
        });
    }

    /// Releases `lock_id`; false when it was not held.
    fn release(&self, lock_id: &str) -> bool {
        let released = {
            let mut locks = lock(&self.inner.locks);
            match locks.by_id.remove(lock_id) {
                Some((keys, token)) => {
                    for key in keys {
                        locks.held.remove(&key);
                    }
                    token.cancel();
                    true
                }
                None => false,
            }
        };
        if released {
            self.inner.released.notify_waiters();
        }
        released
    }

    fn subscribe(&self, peer: Peer) {
        let mut subscribers = lock(&self.inner.subscribers);
        subscribers.retain(|p| !p.is_closed());
        if !subscribers.iter().any(|p| p.same_connection(&peer)) {
            subscribers.push(peer);
        }
    }

    /// Pushes a change to every subscribed connection and to in-process observers.
    fn publish(&self, key: String, revision: u64, value: Option<Map<String, Value>>) {
        let _ = self.inner.changes.send(SecretChange {
            key: key.clone(),
            revision,
            deleted: value.is_none(),
        });
        let subscribers: Vec<Peer> = {
            let mut subscribers = lock(&self.inner.subscribers);
            subscribers.retain(|p| !p.is_closed());
            subscribers.clone()
        };
        let params = SecretsChangedParams {
            key,
            revision,
            value,
        };
        // One task per connection: an Agent Host that stops reading delays only itself.
        // Receivers order notifications by revision, so their arrival order does not matter.
        for peer in subscribers {
            let params = params.clone();
            tokio::spawn(async move {
                // A closed connection is dropped from the list on the next publish.
                let _ = peer.notify::<SecretsChanged>(params).await;
            });
        }
    }

    /// Runs `operation` on the open vault on the blocking pool, opening it first if needed.
    async fn with_vault<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Vault) -> piarc_secrets::Result<T> + Send + 'static,
    ) -> Result<T, ErrorObject> {
        let slot = Arc::clone(&self.inner.vault);
        let config = self.inner.config.vault.clone();
        let store = Arc::clone(&self.inner.store);
        let result = tokio::task::spawn_blocking(move || {
            let mut slot = lock(&slot);
            if slot.is_none() {
                let (vault, _) = Vault::open(&config, store.as_ref())?;
                *slot = Some(vault);
            }
            match slot.as_mut() {
                Some(vault) => operation(vault),
                None => Err(piarc_secrets::Error::Integrity {
                    reason: "the vault was not opened",
                    key_id_matches: None,
                }),
            }
        })
        .await
        .map_err(|e| {
            ErrorObject::new(
                ErrorKind::InternalError,
                format!("credential vault task failed: {e}"),
                false,
            )
        })?;
        result.map_err(|e| e.to_error_object())
    }
}

impl InboundHandler for SecretsService {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let service = self.clone();
        Box::pin(async move { service.dispatch(&method, params, peer).await })
    }
}

/// A lock taken for one unlocked write; released on drop.
struct TransientLock {
    service: SecretsService,
    id: String,
}

impl Drop for TransientLock {
    fn drop(&mut self) {
        self.service.release(&self.id);
    }
}

/// The wire entry of a stored credential.
fn entry(view: EntryView<'_>) -> Result<SecretEntry, ErrorObject> {
    let value: Map<String, Value> = serde_json::from_str(view.value).map_err(|_| {
        ErrorObject::new(
            ErrorKind::VaultIntegrity,
            format!("the stored value of {} is not a JSON object", view.key),
            false,
        )
    })?;
    Ok(SecretEntry {
        key: view.key.to_owned(),
        revision: view.revision,
        value,
    })
}

fn random_id() -> Result<String, ErrorObject> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("the system random number generator failed: {e}"),
            false,
        )
    })?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn parse<T: DeserializeOwned>(method: &str, params: Map<String, Value>) -> Result<T, ErrorObject> {
    // serde's message can quote the offending value, which may be a credential.
    serde_json::from_value(Value::Object(params)).map_err(|_| {
        ErrorObject::new(
            ErrorKind::InvalidParams,
            format!("{method}: invalid params (a member is missing or has the wrong type)"),
            false,
        )
    })
}

fn to_value<T: Serialize>(result: &T) -> Result<Value, ErrorObject> {
    serde_json::to_value(result).map_err(|e| {
        ErrorObject::new(
            ErrorKind::InternalError,
            format!("cannot serialize the result: {e}"),
            false,
        )
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
