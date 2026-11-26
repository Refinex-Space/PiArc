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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use piarc_host::{InboundHandler, Peer};
use piarc_ports::{BoxFuture, SecretName, SecretStore};
use piarc_protocol::secrets::{
    SecretEntry, SecretsChanged, SecretsChangedParams, SecretsDeleteParams, SecretsDeleteResult,
    SecretsGetAllParams, SecretsGetAllResult, SecretsGetParams, SecretsGetResult,
    SecretsLockParams, SecretsLockResult, SecretsRenewResult, SecretsSetParams, SecretsSetResult,
    SecretsUnlockParams, SecretsUnlockResult,
};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_secrets::EntryView;
pub use piarc_secrets::{
    MemorySecretStore, OpenOutcome, SystemSecretStore, Vault, VaultConfig, test_master_key_name,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::sync::{Notify, broadcast, watch};
use tokio::time::Instant;

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

/// The system credential store, or, where it cannot be opened, a store that answers every
/// call with that error (the vault then reports `credentialStoreUnavailable` per request and
/// retries on the next one).
#[must_use]
pub fn system_store() -> Arc<dyn SecretStore> {
    match SystemSecretStore::new() {
        Ok(store) => Arc::new(store),
        Err(error) => {
            tracing::warn!(target: "piarc_core::secrets", "the system credential store cannot be opened: {error}");
            Arc::new(UnavailableStore(error))
        }
    }
}

struct UnavailableStore(piarc_ports::SecretStoreError);

impl SecretStore for UnavailableStore {
    fn read(&self, _: &SecretName) -> Result<Option<Vec<u8>>, piarc_ports::SecretStoreError> {
        Err(self.0.clone())
    }

    fn write(&self, _: &SecretName, _: &[u8]) -> Result<(), piarc_ports::SecretStoreError> {
        Err(self.0.clone())
    }

    fn delete(&self, _: &SecretName) -> Result<bool, piarc_ports::SecretStoreError> {
        Err(self.0.clone())
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

struct HeldLock {
    keys: Vec<String>,
    owner: Peer,
    deadline: watch::Sender<Instant>,
    writes: usize,
    closing: bool,
}

fn lost() -> ErrorObject {
    ErrorObject::new(
        ErrorKind::SecretLockLost,
        "credential lock is absent, expired or owned by another connection",
        false,
    )
}

fn deadline_elapsed() -> ErrorObject {
    ErrorObject::new(ErrorKind::Timeout, "credential lock deadline elapsed", true)
}

#[derive(Default)]
struct Locks {
    /// key → lock id.
    held: HashMap<String, String>,
    /// lock id → owner, lease and writes already admitted.
    by_id: HashMap<String, HeldLock>,
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

/// Keys only Core reads (T38: search services' API keys; ADR-0083: the signed-in accounts not in
/// use): an Agent Host can neither read, write nor lock them, `secrets/getAll` leaves them out
/// and changes to them are not pushed.
const CORE_ONLY_PREFIXES: &[&str] = &["websearch/", "account/"];

fn core_only(key: &str) -> bool {
    CORE_ONLY_PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Whether a request's `key` or `keys` names a Core-only key.
fn names_core_only(params: &Map<String, Value>) -> bool {
    let named = |v: &Value| v.as_str().is_some_and(core_only);
    params.get("key").is_some_and(named)
        || params
            .get("keys")
            .and_then(Value::as_array)
            .is_some_and(|keys| keys.iter().any(named))
}

fn core_only_error(method: &str) -> ErrorObject {
    ErrorObject::new(
        ErrorKind::PermissionDenied,
        format!("{method}: the key is kept for Core"),
        false,
    )
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
        if names_core_only(&params) {
            return Err(core_only_error(method));
        }
        match method {
            "secrets/getAll" => self.get_all(parse(method, params)?, peer).await,
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
            "secrets/renew" => {
                let p: SecretsUnlockParams = parse(method, params)?;
                let mut locks = lock(&self.inner.locks);
                let held = locks.by_id.get_mut(&p.lock_id).ok_or_else(lost)?;
                if !held.owner.same_connection(&peer)
                    || held.closing
                    || *held.deadline.borrow() <= Instant::now()
                {
                    return Err(lost());
                }
                held.deadline
                    .send_replace(Instant::now() + self.inner.config.lock_lease);
                to_value(&SecretsRenewResult {
                    expires_in_ms: self.lease_ms(),
                })
            }
            "secrets/unlock" => {
                let p: SecretsUnlockParams = parse(method, params)?;
                to_value(&SecretsUnlockResult {
                    released: self.release_if(&p.lock_id, |held| {
                        if held.owner.same_connection(&peer) {
                            Ok(true)
                        } else {
                            Err(lost())
                        }
                    })?,
                })
            }
            _ => Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not handle {method}"),
                false,
            )),
        }
    }

    /// The value Core itself stored under `key` (T38: a search service's API key), or `None`.
    pub(crate) async fn value_of(
        &self,
        key: &str,
    ) -> Result<Option<Map<String, Value>>, ErrorObject> {
        piarc_secrets::validate_key(key).map_err(|e| e.to_error_object())?;
        let key = key.to_owned();
        let found = self.with_vault(move |v| Ok(v.get(&key).map(entry))).await?;
        Ok(found.transpose()?.map(|e| e.value))
    }

    /// Stores `value` under `key` for Core itself, under the same per-key lock as an Agent
    /// Host's write; `None` deletes the key.
    pub(crate) async fn store_value(
        &self,
        key: &str,
        value: Option<Map<String, Value>>,
    ) -> Result<(), ErrorObject> {
        // Core's own writes hold the lock through a peer of their own.
        let (peer, _frames) = Peer::channel(1);
        match value {
            Some(value) => {
                let params = SecretsSetParams {
                    key: key.to_owned(),
                    value,
                    lock_id: None,
                };
                self.set(params, &peer).await.map(drop)
            }
            None => {
                let params = SecretsDeleteParams {
                    key: key.to_owned(),
                    lock_id: None,
                };
                self.delete(params, &peer).await.map(drop)
            }
        }
    }

    /// `secrets/getAll`: the entries with the requested prefixes, Core-only keys left out; the
    /// connection then hears of every change.
    async fn get_all(&self, p: SecretsGetAllParams, peer: Peer) -> Result<Value, ErrorObject> {
        let prefixes = p.prefixes;
        let wanted = move |key: &str| {
            let listed = |list: &Vec<String>| list.iter().any(|x| key.starts_with(x.as_str()));
            !core_only(key) && prefixes.as_ref().is_none_or(listed)
        };
        // Subscribe first: writes between subscription and the snapshot are harmless
        // duplicates. A subscription after the snapshot could permanently miss a write.
        self.subscribe(peer);
        let (revision, entries) = self
            .with_vault(move |v| {
                let entries: Vec<_> = v.entries().filter(|e| wanted(e.key)).map(entry).collect();
                Ok((v.revision(), entries))
            })
            .await?;
        let entries = entries.into_iter().collect::<Result<Vec<_>, _>>()?;
        to_value(&SecretsGetAllResult {
            entries,
            revision: Some(revision),
        })
    }

    async fn set(&self, p: SecretsSetParams, peer: &Peer) -> Result<Value, ErrorObject> {
        piarc_secrets::validate_key(&p.key).map_err(|e| e.to_error_object())?;
        let guard = self.write_guard(&p.key, p.lock_id.as_deref(), peer).await?;
        let SecretsSetParams { key, value, .. } = p;
        let pushed = value.clone();
        let written_key = key.clone();
        let result = self
            .with_vault(move |v| {
                let _guard = guard;
                v.set(&written_key, &Value::Object(value))
            })
            .await;
        let revision = result?;
        self.publish(key, revision, Some(pushed));
        to_value(&SecretsSetResult { revision })
    }

    async fn delete(&self, p: SecretsDeleteParams, peer: &Peer) -> Result<Value, ErrorObject> {
        piarc_secrets::validate_key(&p.key).map_err(|e| e.to_error_object())?;
        let guard = self.write_guard(&p.key, p.lock_id.as_deref(), peer).await?;
        let key = p.key.clone();
        let result = self
            .with_vault(move |v| {
                let _guard = guard;
                v.delete(&key)
            })
            .await;
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
        let grant = async {
            let id = self.acquire(&p.keys, &peer).await?;
            // Dropping a timed-out grant releases it, including while the keychain is opening.
            let mut grant = WriteGuard {
                service: self.clone(),
                id,
                kind: GuardKind::Temporary,
            };
            let entries = self
                .with_vault(move |v| {
                    Ok(p.keys
                        .iter()
                        .filter_map(|k| v.get(k))
                        .map(entry)
                        .collect::<Vec<_>>())
                })
                .await?;
            let entries = entries.into_iter().collect::<Result<Vec<_>, _>>()?;
            let lock_id = grant.id.clone();
            self.watch_lease(&lock_id, peer)?;
            grant.kind = GuardKind::Granted;
            to_value(&SecretsLockResult {
                lock_id,
                entries,
                expires_in_ms: self.lease_ms(),
            })
        };
        if let Some(deadline_ms) = p.deadline_ms {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| deadline_elapsed())?;
            let remaining = Duration::from_millis(deadline_ms)
                .checked_sub(now)
                .ok_or_else(deadline_elapsed)?;
            tokio::time::timeout(remaining.min(DEFAULT_LOCK_LEASE), grant)
                .await
                .map_err(|_| deadline_elapsed())?
        } else {
            grant.await
        }
    }

    fn lease_ms(&self) -> u64 {
        u64::try_from(self.inner.config.lock_lease.as_millis()).unwrap_or(u64::MAX)
    }

    /// Before a write: with a lock id, checks that the lock covers `key`; without one, takes a
    /// transient lock on `key` (waiting for any holder), released when the guard drops.
    async fn write_guard(
        &self,
        key: &str,
        lock_id: Option<&str>,
        peer: &Peer,
    ) -> Result<WriteGuard, ErrorObject> {
        let (id, kind) = if let Some(id) = lock_id {
            let mut locks = lock(&self.inner.locks);
            let held = locks.by_id.get_mut(id).ok_or_else(lost)?;
            if !held.owner.same_connection(peer)
                || held.closing
                || *held.deadline.borrow() <= Instant::now()
                || !held.keys.iter().any(|k| k == key)
            {
                return Err(lost());
            }
            // A started write remains exclusive until its durable write finishes, even if the
            // connection closes or a lease expires while the vault is on the blocking pool.
            held.writes += 1;
            (id.to_owned(), GuardKind::Writing)
        } else {
            (
                self.acquire(&[key.to_owned()], peer).await?,
                GuardKind::Temporary,
            )
        };
        Ok(WriteGuard {
            service: self.clone(),
            id,
            kind,
        })
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
                    locks.by_id.insert(
                        id.clone(),
                        HeldLock {
                            keys: keys.to_vec(),
                            owner: peer.clone(),
                            deadline: watch::channel(Instant::now() + self.inner.config.lock_lease)
                                .0,
                            writes: 0,
                            closing: false,
                        },
                    );
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
    fn watch_lease(&self, id: &str, peer: Peer) -> Result<(), ErrorObject> {
        let mut deadline = {
            let locks = lock(&self.inner.locks);
            let held = locks.by_id.get(id).ok_or_else(lost)?;
            held.deadline
                .send_replace(Instant::now() + self.inner.config.lock_lease);
            held.deadline.subscribe()
        };
        let service = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            loop {
                let until = *deadline.borrow_and_update();
                tokio::select! {
                    change = deadline.changed() => if change.is_err() { break; },
                    () = tokio::time::sleep_until(until) => {
                        // A renewal may have arrived in the same poll as the old timeout.
                        if service.close_when(&id, |held| *held.deadline.borrow() <= Instant::now()) { break; }
                    }
                    () = peer.closed() => { service.close_when(&id, |_| true); break; }
                }
            }
        });
        Ok(())
    }

    fn close_when(&self, id: &str, condition: impl FnOnce(&mut HeldLock) -> bool) -> bool {
        self.release_if(id, |held| Ok(condition(held)))
            .expect("infallible condition")
    }

    fn release_if(
        &self,
        id: &str,
        condition: impl FnOnce(&mut HeldLock) -> Result<bool, ErrorObject>,
    ) -> Result<bool, ErrorObject> {
        let mut locks = lock(&self.inner.locks);
        let Some(held) = locks.by_id.get_mut(id) else {
            return Ok(false);
        };
        if !condition(held)? {
            return Ok(false);
        }
        held.closing = true;
        if held.writes == 0 {
            let held = locks.by_id.remove(id).expect("entry under the same mutex");
            for key in held.keys {
                locks.held.remove(&key);
            }
            self.inner.released.notify_waiters();
        }
        Ok(true)
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
        // Fails only when no in-process observer is subscribed, which is the common case.
        let _ = self.inner.changes.send(SecretChange {
            key: key.clone(),
            revision,
            deleted: value.is_none(),
        });
        if core_only(&key) {
            return;
        }
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
                Some(vault) => {
                    let result = operation(vault);
                    remember_values(vault);
                    result
                }
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

enum GuardKind {
    Temporary,
    Writing,
    Granted,
}

struct WriteGuard {
    service: SecretsService,
    id: String,
    kind: GuardKind,
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        match self.kind {
            GuardKind::Temporary => {
                self.service.close_when(&self.id, |_| true);
            }
            GuardKind::Writing => {
                self.service.close_when(&self.id, |held| {
                    held.writes -= 1;
                    held.closing
                });
            }
            GuardKind::Granted => {}
        }
    }
}

/// Lets the log writer and the diagnostic bundle hide every credential the vault holds (T45,
/// `piarc_telemetry::redact`): run after each vault operation, so a value is known before any
/// line could carry it.
fn remember_values(vault: &Vault) {
    for view in vault.entries() {
        if let Ok(value) = serde_json::from_str::<Value>(view.value) {
            piarc_telemetry::remember_secrets_in(&value);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::{Context, Waker};

    #[tokio::test]
    async fn get_all_subscribes_before_reading_the_vault_snapshot() {
        let dir = std::env::temp_dir().join(format!("piarc-snapshot-{}", random_id().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let config = SecretsConfig::with_master_key(&dir, test_master_key_name("snapshot"));
        let service = SecretsService::new(config, Arc::new(MemorySecretStore::new()));
        let (peer, _frames) = Peer::channel(4);
        let mut call = Box::pin(service.dispatch("secrets/getAll", Map::new(), peer.clone()));
        {
            // Holding the same mutex used by the snapshot makes this first poll deterministic.
            let _vault = lock(&service.inner.vault);
            assert!(
                call.as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending()
            );
            assert!(
                lock(&service.inner.subscribers)
                    .iter()
                    .any(|p| p.same_connection(&peer))
            );
        }
        assert_eq!(call.await.unwrap()["revision"], 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// ADR-0083: the signed-in accounts not in use stay with Core.
    #[tokio::test]
    async fn accounts_not_in_use_are_for_core_only() {
        let dir = std::env::temp_dir().join(format!("piarc-accounts-{}", random_id().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let config = SecretsConfig::with_master_key(&dir, test_master_key_name("accounts"));
        let service = SecretsService::new(config, Arc::new(MemorySecretStore::new()));
        let token =
            serde_json::json!({"type": "oauth", "access": "a-1", "refresh": "r-1", "expires": 1});
        let value = token.as_object().unwrap().clone();
        service
            .store_value("account/openai-codex/a1", Some(value.clone()))
            .await
            .unwrap();
        assert_eq!(
            service.value_of("account/openai-codex/a1").await.unwrap(),
            Some(value)
        );
        let (peer, _frames) = Peer::channel(8);
        let all = service
            .dispatch("secrets/getAll", Map::new(), peer.clone())
            .await
            .unwrap();
        assert!(!all.to_string().contains("r-1"), "{all}");
        for (method, params) in [
            (
                "secrets/get",
                serde_json::json!({"key": "account/openai-codex/a1"}),
            ),
            (
                "secrets/set",
                serde_json::json!({"key": "account/openai-codex/a1", "value": {"type": "oauth"}}),
            ),
            (
                "secrets/delete",
                serde_json::json!({"key": "account/openai-codex/a1"}),
            ),
            (
                "secrets/lock",
                serde_json::json!({"keys": ["oauth/openai-codex", "account/openai-codex/a1"]}),
            ),
        ] {
            let refused = service
                .dispatch(method, params.as_object().unwrap().clone(), peer.clone())
                .await
                .unwrap_err();
            assert_eq!(refused.data.kind, ErrorKind::PermissionDenied, "{method}");
        }
        service
            .store_value("account/openai-codex/a1", None)
            .await
            .unwrap();
        assert_eq!(
            service.value_of("account/openai-codex/a1").await.unwrap(),
            None
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
