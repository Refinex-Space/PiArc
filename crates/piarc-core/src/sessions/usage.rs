//! The usage report (T41): the settings window's "Usage" page and the session rail's card ask
//! Core; the arithmetic is `crate::usage`. Catalog prices come from every `models/list` Core
//! sees (recorded in `model_prices`), refreshed from the running Agent Hosts before a report.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use piarc_protocol::models::{ModelsList, ModelsListParams, ModelsListResult};
use piarc_protocol::usage::{ModelPrice, SessionUsage, UsageTokens};
use serde_json::{Value, json};

use super::{Hub, canonical_dir, lock, path_text};
use crate::error::{Error, Result};
use crate::usage::{Inputs, PriceBook, catalog_prices, report, tiered_models, user_price};

/// How long a running Agent Host gets to list its models before a report.
const PRICE_REFRESH: Duration = Duration::from_secs(5);

fn internal(what: &str, error: impl std::fmt::Display) -> Error {
    Error::Internal {
        reason: format!("{what}: {error}"),
    }
}

impl Hub {
    /// Records the catalog prices of a `models/list` answer.
    pub(crate) async fn record_prices(&self, list: &ModelsListResult) {
        let (priced, unpriced) = catalog_prices(&list.models);
        let now = crate::storage::now_ms();
        let written = self
            .ctx
            .storage
            .run(move |db| {
                db.put_model_prices(&priced, now)?;
                db.remove_model_prices(&unpriced)
            })
            .await;
        if !matches!(written, Ok(Ok(()))) {
            tracing::warn!(target: "piarc_core::usage", "cannot record catalog prices");
        }
    }

    /// Asks every running Agent Host for its catalog and records the prices.
    async fn refresh_prices(&self) {
        let workspaces: Vec<_> = lock(&self.routes).workspaces.values().cloned().collect();
        for workspace in workspaces {
            let Some(host) = workspace.peek().await else {
                continue;
            };
            let listed = tokio::time::timeout(
                PRICE_REFRESH,
                host.call::<ModelsList>(ModelsListParams { session_id: None }),
            )
            .await;
            if let Ok(Ok(list)) = listed {
                self.record_prices(&list).await;
            }
        }
    }

    /// The prices in effect: recorded catalog prices and the user's `modelPrices`.
    async fn price_book(&self) -> Result<PriceBook> {
        let catalog = self
            .ctx
            .storage
            .run(|db| db.model_prices())
            .await?
            .map_err(|e| internal("reading catalog prices", e))?;
        let data = self.ctx.storage.dirs().data().to_owned();
        let user = tokio::task::spawn_blocking(move || crate::client_settings::read(&data))
            .await
            .map_err(|e| internal("reading the user settings", e))??;
        Ok(PriceBook::new(&catalog, user.get("modelPrices")))
    }

    /// The report for every session, or `workspace`'s.
    async fn build_report(
        &self,
        keep: impl Fn(&piarc_store::UsageSession) -> bool + Send + 'static,
    ) -> Result<piarc_protocol::usage::UsageReport> {
        self.refresh_prices().await;
        // A turn that just ended may not be indexed yet: catch up first (incremental).
        if let Err(error) = self.ctx.storage.sync_sessions().await {
            tracing::warn!(target: "piarc_core::usage", "syncing the session index failed: {error}");
        }
        let book = self.price_book().await?;
        let report = self
            .ctx
            .storage
            .run(move |db| -> piarc_store::Result<_> {
                let groups = db.usage_groups()?;
                let sessions = db.usage_sessions()?;
                let mut requests = HashMap::new();
                for key in tiered_models(&groups, &book) {
                    let rows = db.usage_requests(&key.0, &key.1)?;
                    requests.insert(key, rows);
                }
                let inputs = Inputs {
                    groups: &groups,
                    requests: &requests,
                    sessions: &sessions,
                    book: &book,
                };
                Ok(report(&inputs, &keep))
            })
            .await?
            .map_err(|e| internal("reading usage", e))?;
        Ok(report)
    }

    /// Usage by model and by session, for every workspace or one.
    pub async fn usage_report(&self, workspace: Option<PathBuf>) -> Result<Value> {
        let workspace = match workspace {
            Some(path) => Some(path_text(&canonical_dir(path, "workspace").await?)),
            None => None,
        };
        let report = self
            .build_report(move |s| {
                workspace
                    .as_deref()
                    .is_none_or(|w| s.workspace.as_deref() == Some(w))
            })
            .await?;
        Ok(json!(report))
    }

    /// One main session's usage (its subagents and auxiliary calls included); zero when it
    /// has none yet.
    pub async fn session_usage(&self, session_id: String) -> Result<Value> {
        let id = session_id.clone();
        let report = self.build_report(move |s| s.id == id).await?;
        let usage = report
            .sessions
            .into_iter()
            .next()
            .unwrap_or_else(|| SessionUsage {
                session_id,
                title: None,
                workspace: None,
                tokens: UsageTokens::default(),
                cost: Some(0.0),
                partial: false,
                models: Vec::new(),
                subagents: Vec::new(),
                auxiliary: Vec::new(),
            });
        Ok(json!(usage))
    }

    /// Sets (`Some`) or removes the user's price of `provider/model` (USD per million tokens).
    pub async fn set_model_price(
        &self,
        provider: String,
        model: String,
        price: Option<Value>,
    ) -> Result<Value> {
        let valid_id =
            |s: &str| !s.is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control);
        if !valid_id(&provider) || provider.contains('/') || !valid_id(&model) {
            return Err(Error::InvalidArgument {
                field: "model",
                reason: "a provider id without '/' and a model id, 1-256 characters each".into(),
            });
        }
        let price = match price {
            Some(value) => {
                let parsed: ModelPrice =
                    user_price(&value).ok_or_else(|| Error::InvalidArgument {
                        field: "price",
                        reason: "input, output, cacheRead and cacheWrite: non-negative numbers"
                            .into(),
                    })?;
                Some(json!({
                    "input": parsed.input,
                    "output": parsed.output,
                    "cacheRead": parsed.cache_read,
                    "cacheWrite": parsed.cache_write,
                }))
            }
            None => None,
        };
        // RFC 6901: `/` in the key is `~1`, `~` is `~0`.
        let key = format!("{provider}/{model}")
            .replace('~', "~0")
            .replace('/', "~1");
        let pointer = format!("/modelPrices/{key}");
        let data = self.ctx.storage.dirs().data().to_owned();
        let managed = self.ctx.storage.dirs().managed().clone();
        tokio::task::spawn_blocking(move || {
            crate::client_settings::write_user_value(&data, &managed, &pointer, price)
        })
        .await
        .map_err(|e| internal("writing the price", e))??;
        Ok(Value::Null)
    }
}
