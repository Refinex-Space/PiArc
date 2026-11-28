//! The popularity index and the manifests of its packages (ADR-0102). One sync at a time
//! (`Inner::syncing`). Pages are fetched in order and written as they arrive, so the list grows
//! while the user watches; only a complete sync retires the previous generation, a failed one
//! keeps it. Manifests are then read for index packages whose current version was not read
//! yet, a few at a time, most downloaded first; a failure stops reading (the next sync
//! continues).

use piarc_protocol::market::{MarketEvent, MarketProblem};
use piarc_store::MarketSync;
use tokio::task::JoinSet;

use super::{Market, net, npm};
use crate::storage::now_ms;

/// Manifests read per round of classification.
const CLASSIFY_BATCH: i64 = 64;

impl Market {
    /// Syncs the index pages; answers whether the whole index is in.
    pub(super) async fn run_sync(&self, proxy: Option<String>) -> bool {
        let storage = &self.inner.storage;
        let Ok(Ok(previous)) = storage.run(|s| s.market_sync()).await else {
            return false;
        };
        let limits = self.inner.config.limits.clone();
        let mut sync = MarketSync {
            generation: previous.generation + 1,
            state: "running".into(),
            done: 0,
            total: i64::try_from(limits.pages).unwrap_or(0),
            started_ms: now_ms(),
            finished_ms: 0,
            ok_ms: previous.ok_ms,
            last_error: None,
        };
        let generation = sync.generation;
        let _ = self.write_sync(&sync).await;
        let mut failure = None;
        for page in 0..limits.pages {
            let from = page * limits.page_size;
            let (listings, total) = match self.index_page(from, proxy.as_deref()).await {
                Ok(page) => page,
                Err(problem) => {
                    failure = Some(problem);
                    break;
                }
            };
            let got = listings.len() as u64;
            let now = now_ms();
            if storage
                .run(move |s| s.market_put(&listings, Some(generation), now))
                .await
                .is_err()
            {
                break;
            }
            sync.done = i64::try_from(page + 1).unwrap_or(0);
            let pages_needed = total.div_ceil(limits.page_size).min(limits.pages);
            sync.total = i64::try_from(pages_needed.max(page + 1)).unwrap_or(0);
            let _ = self.write_sync(&sync).await;
            if let Ok(status) = self.status().await {
                self.emit(&MarketEvent::Sync { status }).await;
            }
            if got < limits.page_size || from + limits.page_size >= total {
                break;
            }
        }
        sync.finished_ms = now_ms();
        match failure {
            Some(problem) => {
                sync.state = "failed".into();
                sync.last_error = Some(problem.message.clone());
                self.set_problem(Some(problem));
            }
            None => {
                sync.state = "idle".into();
                sync.ok_ms = sync.finished_ms;
                let _ = storage.run(move |s| s.market_end_index(generation)).await;
                self.set_problem(None);
            }
        }
        let _ = self.write_sync(&sync).await;
        sync.state == "idle"
    }

    /// One page of the popularity index.
    async fn index_page(
        &self,
        from: u64,
        proxy: Option<&str>,
    ) -> Result<(Vec<piarc_store::MarketListing>, u64), MarketProblem> {
        let limits = &self.inner.config.limits;
        let path = format!(
            "-/v1/search?{}",
            npm::search_query(&[], limits.page_size, from)
        );
        let body = self
            .inner
            .registry
            .json(&path, limits.search_bytes, proxy, &self.inner.cancel)
            .await
            .map_err(|e| net::problem(&e))?;
        let bytes = serde_json::to_vec(&body).unwrap_or_default();
        npm::search_page(&bytes).ok_or_else(|| MarketProblem {
            code: "network".into(),
            message: "the registry's search answer is not readable".into(),
        })
    }

    async fn write_sync(&self, sync: &MarketSync) -> crate::error::Result<()> {
        let sync = sync.clone();
        self.inner
            .storage
            .run(move |s| s.set_market_sync(&sync))
            .await??;
        Ok(())
    }

    /// Reads manifests of index packages until none is left or a request fails.
    pub(super) async fn classify(&self, proxy: Option<String>) {
        let concurrency = self.inner.config.limits.classify_concurrency.max(1);
        loop {
            if self.inner.cancel.is_cancelled() {
                return;
            }
            let Ok(Ok(batch)) = self
                .inner
                .storage
                .run(|s| s.market_unclassified(CLASSIFY_BATCH))
                .await
            else {
                return;
            };
            if batch.is_empty() {
                return;
            }
            let mut names = Vec::new();
            let mut failed = false;
            for chunk in batch.chunks(concurrency) {
                let mut set = JoinSet::new();
                for (name, version) in chunk.iter().cloned() {
                    let market = self.clone();
                    let proxy = proxy.clone();
                    set.spawn(async move {
                        let info = market.version(&name, &version, proxy.as_deref()).await;
                        (name, version, info)
                    });
                }
                while let Some(Ok((name, version, info))) = set.join_next().await {
                    let (kinds, deprecated) = match info {
                        Ok(info) => (info.kinds, info.deprecated.is_some()),
                        // Gone from the registry, or not a readable version: no kinds.
                        Err(problem) if problem.code == "notFound" => (Some(0), false),
                        Err(_) => {
                            failed = true;
                            continue;
                        }
                    };
                    let row = self.row(&name).await.ok().flatten();
                    // Without a `pi` field the keywords stay the best answer.
                    let kinds = kinds
                        .or_else(|| row.map(|r| r.listing.kw_kinds))
                        .unwrap_or(0);
                    let key = name.clone();
                    let _ = self
                        .inner
                        .storage
                        .run(move |s| s.market_set_manifest(&key, &version, kinds, deprecated))
                        .await;
                    names.push(name);
                }
                if failed {
                    break;
                }
            }
            if !names.is_empty() {
                self.emit(&MarketEvent::Kinds { names }).await;
            }
            if failed {
                return;
            }
        }
    }
}
