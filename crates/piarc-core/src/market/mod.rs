//! The Pi package market on Core's side (ADR-0102): the npm registry's packages with the
//! `pi-package` keyword, cached in `core.sqlite` (`piarc-store`'s `market_*`), classified by
//! their keywords and then by their `pi` manifests, searched live when there are words, and
//! installed through [`crate::plugins::PluginManager::install_market`].
//!
//! - **Network**: only the configured registry ([`MarketConfig::registry`],
//!   `https://registry.npmjs.org` in a release build), through the user's proxy whenever there
//!   is one ([`net::Registry`]); nothing is requested before the settings window opens the
//!   market.
//! - **Sync**: the popularity index (at most 21 pages of 250, the registry's search stops at
//!   `from` 5000) refreshes in the background when it is older than
//!   [`MarketLimits::stale_after`]; a failed sync keeps the previous index. Afterwards the
//!   manifests of index packages are read, [`MarketLimits::classify_concurrency`] at a time,
//!   once per version.
//! - **Events** go to `core/market` ([`MARKET_ROUTE`], `MarketEvent`).

mod detail;
pub(crate) mod net;
pub mod npm;
mod sync;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use piarc_protocol::market::{
    MarketCategory, MarketCounts, MarketEntry, MarketEvent, MarketInstalled, MarketKind,
    MarketPage, MarketProblem, MarketQuery, MarketSort, MarketStatus, MarketSyncState,
};
use piarc_store::market::kind;
use piarc_store::{MarketFilter, MarketRow};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::storage::{Storage, now_ms};

pub use detail::DetailCache;

/// The route of market events.
pub const MARKET_ROUTE: &str = "core/market";

/// The bounds of the market. The only place these values are defined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketLimits {
    /// Packages per search page.
    pub page_size: u64,
    /// Pages of the popularity index (the registry answers the first page past `from` 5000).
    pub pages: u64,
    /// An index older than this refreshes when the market opens.
    pub stale_after: Duration,
    /// After a failed sync, opening or reading the market starts no new one for this long (a
    /// refresh the user asks for always does): the page reads after every sync event.
    pub failure_backoff: Duration,
    pub search_bytes: usize,
    pub version_bytes: usize,
    pub packument_bytes: usize,
    /// One request, redirects included.
    pub request_timeout: Duration,
    pub classify_concurrency: usize,
    /// Retries of one request (network failure, timeout, `429`, `5xx`).
    pub retries: usize,
    pub retry_wait: [Duration; 2],
    pub retry_after_max: Duration,
    /// Results a live search asks the registry for.
    pub live_results: u64,
}

impl Default for MarketLimits {
    fn default() -> Self {
        Self {
            page_size: 250,
            pages: 21,
            stale_after: Duration::from_secs(6 * 3600),
            failure_backoff: Duration::from_secs(120),
            search_bytes: 4 << 20,
            version_bytes: 1 << 20,
            packument_bytes: 8 << 20,
            request_timeout: Duration::from_secs(60),
            classify_concurrency: 4,
            retries: 2,
            retry_wait: net::RETRY_WAIT,
            retry_after_max: Duration::from_secs(30),
            live_results: 250,
        }
    }
}

/// A test network for the market (development builds and tests only): a CA to trust instead
/// of the platform's, and names that resolve to loopback.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarketTestNet {
    /// PEM of the CA the mock registry's certificate chains to.
    pub ca_pem: Vec<u8>,
    /// The same CA as a file, for npm (`NODE_EXTRA_CA_CERTS`).
    pub ca_file: Option<PathBuf>,
    /// Host names that resolve to `127.0.0.1`.
    pub loopback: Vec<String>,
}

/// Where the market's data comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketConfig {
    /// The registry's base URL (`https://…`, no trailing slash needed).
    pub registry: String,
    pub limits: MarketLimits,
    pub test_net: Option<MarketTestNet>,
}

impl Default for MarketConfig {
    fn default() -> Self {
        Self {
            registry: "https://registry.npmjs.org".to_owned(),
            limits: MarketLimits::default(),
            test_net: None,
        }
    }
}

/// The installed package a market entry corresponds to, by npm name.
pub type InstalledByName = HashMap<String, MarketInstalled>;

/// The market. One per Core; cheap to clone.
#[derive(Clone)]
pub struct Market {
    inner: Arc<Inner>,
}

struct Inner {
    config: MarketConfig,
    registry: net::Registry,
    storage: Storage,
    events: EventSender,
    cancel: CancellationToken,
    syncing: AtomicBool,
    installing: Mutex<HashSet<String>>,
    /// Why the last sync or live search failed (cleared by the next success).
    problem: Mutex<Option<MarketProblem>>,
    details: DetailCache,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn kinds_of(bits: i64) -> Vec<MarketKind> {
    [
        (kind::EXTENSION, MarketKind::Extension),
        (kind::SKILL, MarketKind::Skill),
        (kind::PROMPT, MarketKind::Prompt),
        (kind::THEME, MarketKind::Theme),
    ]
    .into_iter()
    .filter(|(bit, _)| bits & bit != 0)
    .map(|(_, k)| k)
    .collect()
}

fn category_bit(category: MarketCategory) -> Option<i64> {
    match category {
        MarketCategory::All => None,
        MarketCategory::Extension => Some(kind::EXTENSION),
        MarketCategory::Skill => Some(kind::SKILL),
        MarketCategory::Prompt => Some(kind::PROMPT),
    }
}

fn to_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// Whether `candidate` is a newer version than `installed` (numeric core, then any
/// prerelease is older than its release).
pub(crate) fn newer(candidate: &str, installed: &str) -> bool {
    let parse = |v: &str| {
        let (core, pre) = v.split_once('-').map_or((v, ""), |(c, p)| (c, p));
        let core = core.split('+').next().unwrap_or(core);
        let numbers: Vec<u64> = core.split('.').filter_map(|n| n.parse().ok()).collect();
        (numbers, pre.is_empty())
    };
    let (a, a_release) = parse(candidate);
    let (b, b_release) = parse(installed);
    a > b || (a == b && a_release && !b_release)
}

impl Market {
    #[must_use]
    pub(crate) fn new(
        config: MarketConfig,
        storage: Storage,
        events: EventSender,
        cancel: CancellationToken,
    ) -> Self {
        let registry = net::Registry::new(&config);
        Self {
            inner: Arc::new(Inner {
                config,
                registry,
                storage,
                events,
                cancel,
                syncing: AtomicBool::new(false),
                installing: Mutex::default(),
                problem: Mutex::default(),
                details: DetailCache::default(),
            }),
        }
    }

    pub(crate) fn config(&self) -> &MarketConfig {
        &self.inner.config
    }

    pub(crate) fn registry_base(&self) -> &str {
        self.inner.registry.base()
    }

    async fn emit(&self, event: &MarketEvent) {
        let Ok(payload) = serde_json::to_value(event) else {
            return;
        };
        if let Ok(event) = Event::from_json(RouteKey::market(), &payload) {
            let _ = self.inner.events.send(event).await;
        }
    }

    fn set_problem(&self, problem: Option<MarketProblem>) {
        *lock(&self.inner.problem) = problem;
    }

    /// Where the catalog stands.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub async fn status(&self) -> Result<MarketStatus> {
        let (sync, (classified, indexed)) = self
            .inner
            .storage
            .run(|s| Ok::<_, piarc_store::Error>((s.market_sync()?, s.market_classified()?)))
            .await??;
        let syncing = self.inner.syncing.load(Ordering::SeqCst);
        Ok(MarketStatus {
            state: if syncing {
                MarketSyncState::Syncing
            } else if sync.state == "failed" {
                MarketSyncState::Failed
            } else {
                MarketSyncState::Idle
            },
            done: to_u64(sync.done),
            total: to_u64(sync.total),
            synced_at: (sync.ok_ms > 0).then_some(sync.ok_ms),
            classified: to_u64(classified),
            indexed: to_u64(indexed),
            problem: lock(&self.inner.problem).clone(),
        })
    }

    /// Starts a sync in the background unless one runs or the index is fresh (`force`: even
    /// when fresh). Answers whether one started.
    ///
    /// # Errors
    ///
    /// The database failed.
    pub async fn refresh(&self, proxy: Option<String>, force: bool) -> Result<bool> {
        let sync = self.inner.storage.run(|s| s.market_sync()).await??;
        let stale_ms =
            i64::try_from(self.inner.config.limits.stale_after.as_millis()).unwrap_or(i64::MAX);
        let now = now_ms();
        let fresh = sync.ok_ms > 0 && now.saturating_sub(sync.ok_ms) < stale_ms;
        let backoff_ms =
            i64::try_from(self.inner.config.limits.failure_backoff.as_millis()).unwrap_or(i64::MAX);
        let failed_lately =
            sync.state == "failed" && now.saturating_sub(sync.finished_ms) < backoff_ms;
        if (fresh || failed_lately) && !force {
            return Ok(false);
        }
        if self.inner.syncing.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        let market = self.clone();
        tokio::spawn(async move {
            market.run_sync(proxy).await;
            market.inner.syncing.store(false, Ordering::SeqCst);
            if let Ok(status) = market.status().await {
                market.emit(&MarketEvent::Sync { status }).await;
            }
        });
        Ok(true)
    }

    fn entry(&self, row: &MarketRow, installed: &InstalledByName) -> MarketEntry {
        let l = &row.listing;
        let from_manifest = row.manifest_version.as_deref() == Some(l.version.as_str())
            && row.manifest_kinds.is_some();
        let mut installed = installed.get(&l.name).cloned();
        if let Some(i) = installed.as_mut() {
            i.update = i
                .version
                .as_deref()
                .filter(|v| newer(&l.version, v))
                .map(|_| l.version.clone());
        }
        MarketEntry {
            name: l.name.clone(),
            version: l.version.clone(),
            description: l.description.clone(),
            publisher: l.publisher.clone(),
            downloads_monthly: to_u64(l.downloads_monthly),
            updated: l.updated_ms,
            kinds: kinds_of(row.kinds()),
            kinds_from_manifest: from_manifest,
            insecure: l.insecure,
            deprecated: row.deprecated,
            installed,
            installing: lock(&self.inner.installing).contains(&l.name),
        }
    }

    /// One page of the market for `query`; starts a background sync when the index is stale.
    ///
    /// # Errors
    ///
    /// `invalidParams` for a bad query; the database failed.
    pub async fn query(
        &self,
        query: MarketQuery,
        installed: &InstalledByName,
        proxy: Option<String>,
    ) -> Result<MarketPage> {
        if query.query.chars().count() > 200 || query.query.chars().any(char::is_control) {
            return Err(Error::InvalidArgument {
                field: "query",
                reason: "at most 200 characters, no control characters".into(),
            });
        }
        if !(1..=100).contains(&query.limit) || query.offset > 20_000 {
            return Err(Error::InvalidArgument {
                field: "limit",
                reason: "limit 1–100, offset at most 20000".into(),
            });
        }
        self.refresh(proxy.clone(), false).await?;
        let words: Vec<String> = query
            .query
            .split_whitespace()
            .map(str::to_lowercase)
            .take(8)
            .collect();
        let mut live = false;
        let mut names = None;
        if !words.is_empty() {
            match self.search_live(&words, proxy.as_deref()).await {
                Ok(found) => {
                    live = true;
                    names = Some(found);
                    self.set_problem(None);
                }
                Err(problem) => self.set_problem(Some(problem)),
            }
        }
        let exact = (words.len() == 1 && npm::valid_name(&words[0])).then(|| words[0].clone());
        let filter = MarketFilter {
            kind: category_bit(query.category.unwrap_or_default()),
            // A live answer already matched the words.
            words: if live { Vec::new() } else { words },
            names,
            deprecated_named: exact,
            sort: match query.sort.unwrap_or_default() {
                MarketSort::Popular => piarc_store::MarketSort::Popular,
                MarketSort::Updated => piarc_store::MarketSort::Updated,
            },
            offset: i64::try_from(query.offset).unwrap_or(0),
            limit: i64::try_from(query.limit).unwrap_or(50),
        };
        let (rows, total, counts) = self
            .inner
            .storage
            .run(move |s| {
                let (rows, total) = s.market_query(&filter)?;
                let counts = s.market_counts(&filter)?;
                Ok::<_, piarc_store::Error>((rows, total, counts))
            })
            .await??;
        Ok(MarketPage {
            entries: rows.iter().map(|r| self.entry(r, installed)).collect(),
            total: to_u64(total),
            counts: MarketCounts {
                all: to_u64(counts.all),
                extension: to_u64(counts.extension),
                skill: to_u64(counts.skill),
                prompt: to_u64(counts.prompt),
            },
            status: self.status().await?,
            live,
        })
    }

    /// Asks the registry for `words`; caches the answer and returns its names.
    async fn search_live(
        &self,
        words: &[String],
        proxy: Option<&str>,
    ) -> std::result::Result<Vec<String>, MarketProblem> {
        let limits = &self.inner.config.limits;
        let path = format!(
            "-/v1/search?{}",
            npm::search_query(words, limits.live_results, 0)
        );
        let body = self
            .inner
            .registry
            .json(&path, limits.search_bytes, proxy, &self.inner.cancel)
            .await
            .map_err(|e| net::problem(&e))?;
        let bytes = serde_json::to_vec(&body).unwrap_or_default();
        let (listings, _) = npm::search_page(&bytes).ok_or_else(|| MarketProblem {
            code: "network".into(),
            message: "the registry's search answer is not readable".into(),
        })?;
        let names: Vec<String> = listings.iter().map(|l| l.name.clone()).collect();
        let now = now_ms();
        self.inner
            .storage
            .run(move |s| s.market_put(&listings, None, now))
            .await
            .map_err(|e| MarketProblem {
                code: "internal".into(),
                message: e.to_string(),
            })?
            .map_err(|e| MarketProblem {
                code: "internal".into(),
                message: e.to_string(),
            })?;
        Ok(names)
    }

    /// Marks `name` as installing; `false` when it already was.
    pub(crate) fn begin_install(&self, name: &str) -> bool {
        lock(&self.inner.installing).insert(name.to_owned())
    }

    pub(crate) async fn end_install(&self, name: &str, problem: Option<MarketProblem>) {
        lock(&self.inner.installing).remove(name);
        let state = if problem.is_some() {
            "failed"
        } else {
            "finished"
        };
        self.emit(&MarketEvent::Install {
            name: name.to_owned(),
            state: state.to_owned(),
            problem,
        })
        .await;
    }

    pub(crate) async fn started_install(&self, name: &str) {
        self.emit(&MarketEvent::Install {
            name: name.to_owned(),
            state: "started".to_owned(),
            problem: None,
        })
        .await;
    }

    /// The cached row of `name`.
    pub(crate) async fn row(&self, name: &str) -> Result<Option<MarketRow>> {
        let key = name.to_owned();
        Ok(self
            .inner
            .storage
            .run(move |s| s.market_package(&key))
            .await??)
    }

    /// The document of `name@version`.
    pub(crate) async fn version(
        &self,
        name: &str,
        version: &str,
        proxy: Option<&str>,
    ) -> std::result::Result<npm::VersionInfo, MarketProblem> {
        let path = format!("{}/{version}", npm::package_path(name));
        let doc = self
            .inner
            .registry
            .json(
                &path,
                self.inner.config.limits.version_bytes,
                proxy,
                &self.inner.cancel,
            )
            .await
            .map_err(|e| net::problem(&e))?;
        npm::version_info(&doc).ok_or_else(|| MarketProblem {
            code: "notFound".into(),
            message: format!("{name}@{version} is not a readable version"),
        })
    }
}
