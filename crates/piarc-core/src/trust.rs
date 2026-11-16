//! Project trust (architecture section 10.2): decisions per repository main checkout
//! (`piarc-git`), stored in `project_trust` (`piarc-store`), queried through
//! `piarc_config::project_trust` (the one trust query), and the executable items a decision
//! covers (`piarc_config::executables`).
//!
//! `trust/get` is a security boundary: every failure — the directory cannot be resolved, the
//! database fails, a task panics, the parameters are malformed — answers "not trusted".

use std::path::{Path, PathBuf};
use std::sync::Arc;

use piarc_config::{Inventory, Item, TrustLookup, TrustState};
use piarc_git::CheckoutKind;
use piarc_protocol::trust::{TrustGetParams, TrustStatus};
use piarc_protocol::{ErrorKind, ErrorObject};
use piarc_store::{TrustDecision, TrustRecord};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::error::{Error, Result};
use crate::storage::{Storage, now_ms};

/// A trust decision changed for a main checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustChange {
    /// The main checkout (trust key).
    pub checkout: PathBuf,
    /// Whether it is trusted now.
    pub trusted: bool,
}

/// What the client shows about a directory's trust (T18's dialog).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustView {
    /// The directory asked about.
    pub path: String,
    /// The main checkout the decision belongs to.
    pub checkout: String,
    /// The working tree root the executable items were read from.
    pub root: String,
    /// How the directory relates to git: `repository`, `linkedWorktree`, `independent`,
    /// `notGit`.
    pub kind: &'static str,
    /// `trusted`, `denied`, or absent when the user has not decided.
    pub decision: Option<&'static str>,
    /// When the decision was made (Unix ms).
    pub decided_at: Option<i64>,
    /// Whether project-level executable configuration may be used now.
    pub trusted: bool,
    /// Every executable item the project would enable.
    pub items: Vec<Item>,
    /// Items added since the user trusted the project; they need another confirmation.
    pub new_items: Vec<Item>,
    /// Files that could not be read while listing the items.
    pub unreadable: Vec<piarc_config::executables::Unreadable>,
}

/// The trust decisions of one Core. Clones share it.
#[derive(Clone)]
pub struct TrustService {
    storage: Storage,
    changes: broadcast::Sender<TrustChange>,
}

impl std::fmt::Debug for TrustService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustService").finish_non_exhaustive()
    }
}

/// The store-backed [`TrustLookup`]: main checkout, then the recorded decision.
struct StoreLookup(Storage);

impl TrustLookup for StoreLookup {
    fn lookup(&self, dir: &Path) -> std::result::Result<bool, String> {
        let checkout = piarc_git::resolve(dir).map_err(|e| e.to_string())?;
        let key = checkout_key(&checkout.main).map_err(|e| e.to_string())?;
        let record = self
            .0
            .with(|store| store.trust(&key))
            .map_err(|e| e.to_string())?;
        Ok(record.is_some_and(|r| r.decision == TrustDecision::Trusted))
    }
}

impl TrustService {
    /// Decisions in `storage`.
    #[must_use]
    pub fn new(storage: Storage) -> Self {
        let (changes, _) = broadcast::channel(64);
        Self { storage, changes }
    }

    /// The lookup that [`piarc_config::project_trust`] consults.
    #[must_use]
    pub fn lookup(&self) -> Arc<dyn TrustLookup> {
        Arc::new(StoreLookup(self.storage.clone()))
    }

    /// Change notifications (for restarting a workspace's Agent Host, re-merging settings).
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<TrustChange> {
        self.changes.subscribe()
    }

    /// The trust state of `dir` through the one trust query; failures are untrusted.
    pub async fn state(&self, dir: &Path) -> TrustState {
        query(self.lookup(), dir.to_owned()).await
    }

    /// What the client shows about `dir`.
    ///
    /// # Errors
    ///
    /// [`Error::Feature`] when the directory cannot be resolved or the store fails.
    pub async fn view(&self, dir: &Path) -> Result<TrustView> {
        let dir = dir.to_owned();
        let storage = self.storage.clone();
        blocking(move || build_view(&storage, &dir)).await
    }

    /// Records the user's decision for the project containing `dir`, with the executable
    /// items it covers as the snapshot, and notifies subscribers.
    ///
    /// # Errors
    ///
    /// As [`TrustService::view`].
    pub async fn decide(&self, dir: &Path, trusted: bool) -> Result<TrustView> {
        let dir_owned = dir.to_owned();
        let storage = self.storage.clone();
        let (view, checkout) = blocking(move || {
            let checkout = piarc_git::resolve(&dir_owned)?;
            let key = checkout_key(&checkout.main)?;
            let inventory = piarc_config::enumerate(&checkout.root);
            let snapshot =
                serde_json::to_string(&inventory.items).map_err(|e| Error::Internal {
                    reason: format!("cannot encode the trust snapshot: {e}"),
                })?;
            storage.with(|store| {
                store.set_trust(&TrustRecord {
                    checkout: key,
                    decision: if trusted {
                        TrustDecision::Trusted
                    } else {
                        TrustDecision::Denied
                    },
                    decided_at: now_ms(),
                    snapshot,
                })
            })?;
            Ok((build_view(&storage, &dir_owned)?, checkout.main))
        })
        .await?;
        tracing::info!(target: "piarc_core::trust", checkout = %checkout.display(), trusted, "trust decided");
        // No subscriber is fine.
        let _ = self.changes.send(TrustChange { checkout, trusted });
        Ok(view)
    }

    /// Revokes the decision for the project containing `dir`: it is untrusted until the user
    /// decides again. Subscribers are notified (Core restarts the workspace's Agent Host).
    ///
    /// # Errors
    ///
    /// As [`TrustService::view`].
    pub async fn revoke(&self, dir: &Path) -> Result<TrustView> {
        let dir_owned = dir.to_owned();
        let storage = self.storage.clone();
        let (view, checkout) = blocking(move || {
            let checkout = piarc_git::resolve(&dir_owned)?;
            let key = checkout_key(&checkout.main)?;
            storage.with(|store| store.remove_trust(&key))?;
            Ok((build_view(&storage, &dir_owned)?, checkout.main))
        })
        .await?;
        tracing::info!(target: "piarc_core::trust", checkout = %checkout.display(), "trust revoked");
        let _ = self.changes.send(TrustChange {
            checkout,
            trusted: false,
        });
        Ok(view)
    }

    /// Whether `method` is answered here.
    #[must_use]
    pub fn handles(method: &str) -> bool {
        method == "trust/get"
    }

    /// Answers `trust/get` from the Agent Host.
    ///
    /// # Errors
    ///
    /// `invalidParams` for malformed parameters (the Agent Host treats any error as not
    /// trusted). Lookup failures are not errors: they answer `trusted: false`.
    pub async fn trust_get(&self, params: Map<String, Value>) -> Result<Value, ErrorObject> {
        answer_trust_get(self.lookup(), params).await
    }
}

/// `trust/get` over any lookup (tests inject failing ones).
///
/// # Errors
///
/// `invalidParams` for malformed parameters; never for a failed lookup.
pub async fn answer_trust_get(
    lookup: Arc<dyn TrustLookup>,
    params: Map<String, Value>,
) -> Result<Value, ErrorObject> {
    let params: TrustGetParams = serde_json::from_value(Value::Object(params)).map_err(|_| {
        ErrorObject::new(
            ErrorKind::InvalidParams,
            "trust/get takes { path: string }",
            false,
        )
    })?;
    let state = query(lookup, PathBuf::from(params.path)).await;
    serde_json::to_value(TrustStatus {
        trusted: state.is_trusted(),
    })
    .map_err(|_| ErrorObject::new(ErrorKind::InternalError, "cannot encode trust/get", false))
}

/// The trust query on the blocking pool (it reads `.git` files and the database).
async fn query(lookup: Arc<dyn TrustLookup>, dir: PathBuf) -> TrustState {
    let shown = dir.display().to_string();
    let result = tokio::task::spawn_blocking(move || {
        piarc_config::project_trust(lookup.as_ref(), &dir, &mut |reason| {
            tracing::warn!(target: "piarc_core::trust", dir = %dir.display(),
                "trust lookup failed, treating the project as untrusted: {reason}");
        })
    })
    .await;
    result.unwrap_or_else(|error| {
        tracing::warn!(target: "piarc_core::trust", dir = %shown,
            "the trust lookup task failed, treating the project as untrusted: {error}");
        TrustState::Untrusted
    })
}

fn build_view(storage: &Storage, dir: &Path) -> Result<TrustView> {
    let checkout = piarc_git::resolve(dir)?;
    let key = checkout_key(&checkout.main)?;
    let record = storage.with(|store| store.trust(&key))?;
    let Inventory { items, unreadable } = piarc_config::enumerate(&checkout.root);
    let trusted = record
        .as_ref()
        .is_some_and(|r| r.decision == TrustDecision::Trusted);
    let new_items = match &record {
        Some(record) if trusted => {
            let snapshot: Vec<Item> = serde_json::from_str(&record.snapshot).unwrap_or_default();
            piarc_config::new_items(&items, &snapshot)
        }
        _ => Vec::new(),
    };
    Ok(TrustView {
        path: dir.to_string_lossy().into_owned(),
        checkout: key,
        root: checkout.root.to_string_lossy().into_owned(),
        kind: match checkout.kind {
            CheckoutKind::Repository => "repository",
            CheckoutKind::LinkedWorktree => "linkedWorktree",
            CheckoutKind::Independent => "independent",
            CheckoutKind::NotGit => "notGit",
        },
        decision: record.as_ref().map(|r| match r.decision {
            TrustDecision::Trusted => "trusted",
            TrustDecision::Denied => "denied",
        }),
        decided_at: record.as_ref().map(|r| r.decided_at),
        trusted,
        items,
        new_items,
        unreadable,
    })
}

/// The store key of a main checkout: its canonical path as UTF-8.
fn checkout_key(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::InvalidArgument {
            field: "path",
            reason: "must be valid UTF-8".into(),
        })
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> Result<R> + Send + 'static) -> Result<R> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|error| Error::Internal {
            reason: format!("a trust task failed: {error}"),
        })?
}
