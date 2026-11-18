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
    /// Whether project-level executable configuration may be used now: trusted, and no item
    /// waits for confirmation.
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

/// The store-backed [`TrustLookup`]: main checkout, then the recorded decision. A trusted
/// project with executable items the user has not seen yet (added after the decision, for
/// example by `git pull`) is not trusted until the user confirms them (I63).
struct StoreLookup {
    storage: Storage,
    /// Project settings items read by the caller, also bound to the stored snapshot.
    loaded: Vec<Item>,
}

impl TrustLookup for StoreLookup {
    fn lookup(&self, dir: &Path) -> std::result::Result<bool, String> {
        let checkout = piarc_git::resolve(dir).map_err(|e| e.to_string())?;
        let key = checkout_key(&checkout.main).map_err(|e| e.to_string())?;
        let record = self
            .storage
            .with(|store| store.trust(&key))
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let Some(record) = record.filter(|r| r.decision == TrustDecision::Trusted) else {
            return Ok(false);
        };
        let directory = piarc_git::canonical(dir).map_err(|e| e.to_string())?;
        let inventory = inventory_at(&checkout.root, &directory);
        let mut items = inventory.items;
        items.extend_from_slice(&self.loaded);
        Ok(unconfirmed(&items, &record.snapshot).is_empty())
    }
}

/// Items of `items` missing from a decision's snapshot. A snapshot that cannot be read
/// confirms nothing.
fn unconfirmed(items: &[Item], snapshot: &str) -> Vec<Item> {
    let snapshot: Vec<Item> = serde_json::from_str(snapshot).unwrap_or_default();
    piarc_config::new_items(items, &snapshot)
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
        Arc::new(StoreLookup {
            storage: self.storage.clone(),
            loaded: Vec::new(),
        })
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

    /// Load one consistent permission input: the trust check covers the actual values
    /// used for this decision as well as the project's current executable inventory.
    ///
    /// # Errors
    ///
    /// A path, trust lookup or settings task failed. A preflight cannot allow on an error.
    pub async fn permission_settings(&self, dir: &Path) -> Result<piarc_config::Settings> {
        let dir = dir.to_owned();
        let storage = self.storage.clone();
        blocking(move || {
            let workspace = piarc_git::canonical(&dir)?;
            let checkout = piarc_git::resolve(&workspace)?;
            let table = piarc_config::LayerTable::piarc(storage.dirs().data(), &workspace);
            let mut settings = piarc_config::Settings::load(table, TrustState::Untrusted);
            let lookup = StoreLookup {
                storage,
                loaded: settings.project_items(&checkout.root),
            };
            let mut failure = None;
            let trust = piarc_config::project_trust(&lookup, &workspace, &mut |reason| {
                failure = Some(reason.to_owned());
            });
            if let Some(reason) = failure {
                return Err(Error::Internal {
                    reason: format!("permission trust lookup failed: {reason}"),
                });
            }
            settings.set_trust(trust);
            Ok(settings)
        })
        .await
    }

    /// Extend a prior trust decision with only the entries from the native confirmation.
    /// Never upgrade an undecided or denied checkout or confirm unrelated edits on disk.
    ///
    /// # Errors
    ///
    /// A checkout, database, or snapshot error. A malformed snapshot cannot be extended.
    pub async fn confirm_items(&self, dir: &Path, mut items: Vec<Item>) -> Result<()> {
        let dir = dir.to_owned();
        let storage = self.storage.clone();
        blocking(move || {
            let directory = piarc_git::canonical(&dir)?;
            let checkout = piarc_git::resolve(&directory)?;
            let key = checkout_key(&checkout.main)?;
            let prefix = workspace_prefix(&checkout.root, &directory);
            for item in &mut items {
                item.source.insert_str(0, &prefix);
            }
            storage.with(|store| -> Result<()> {
                let Some(mut record) = store
                    .trust(&key)?
                    .filter(|r| r.decision == TrustDecision::Trusted)
                else {
                    return Ok(());
                };
                let mut snapshot: Vec<Item> =
                    serde_json::from_str(&record.snapshot).map_err(|e| Error::Internal {
                        reason: format!("invalid project trust snapshot: {e}"),
                    })?;
                snapshot.extend(items);
                snapshot.sort();
                snapshot.dedup();
                record.snapshot =
                    serde_json::to_string(&snapshot).map_err(|e| Error::Internal {
                        reason: format!("cannot encode trust snapshot: {e}"),
                    })?;
                store.set_trust(&record)?;
                Ok(())
            })?
        })
        .await
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
            let inventory = inventory_at(&checkout.root, &piarc_git::canonical(&dir_owned)?);
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
            })??;
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
            storage.with(|store| store.remove_trust(&key))??;
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

// A subdirectory can itself be opened as a workspace. Bind its settings to their path
// inside the checkout; a grant for the root must not silently approve a sibling file.
fn workspace_prefix(root: &Path, dir: &Path) -> String {
    let mut prefix = String::new();
    for component in dir.strip_prefix(root).unwrap_or(dir).components() {
        prefix.push_str(&component.as_os_str().to_string_lossy());
        prefix.push('/');
    }
    prefix
}

fn inventory_at(root: &Path, dir: &Path) -> Inventory {
    let mut inventory = piarc_config::enumerate(root);
    if dir != root {
        let prefix = workspace_prefix(root, dir);
        let workspace = piarc_config::enumerate(dir);
        inventory
            .items
            .extend(workspace.items.into_iter().map(|mut item| {
                item.source.insert_str(0, &prefix);
                item
            }));
        inventory.items.sort();
        inventory
            .unreadable
            .extend(workspace.unreadable.into_iter().map(|mut file| {
                file.source.insert_str(0, &prefix);
                file
            }));
    }
    inventory
}

fn build_view(storage: &Storage, dir: &Path) -> Result<TrustView> {
    let checkout = piarc_git::resolve(dir)?;
    let key = checkout_key(&checkout.main)?;
    let record = storage.with(|store| store.trust(&key))??;
    let Inventory { items, unreadable } = inventory_at(&checkout.root, &piarc_git::canonical(dir)?);
    let decided_trusted = record
        .as_ref()
        .is_some_and(|r| r.decision == TrustDecision::Trusted);
    let new_items = match &record {
        Some(record) if decided_trusted => unconfirmed(&items, &record.snapshot),
        _ => Vec::new(),
    };
    // The same answer as `StoreLookup`: new items wait for the user's confirmation.
    let trusted = decided_trusted && new_items.is_empty();
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
