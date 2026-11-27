//! One package's details (ADR-0102): the package document (README, the current version's
//! manifest, deprecation, scripts, dependencies) read when the settings window opens it, kept
//! in memory for the most recent few, never stored. Offline, the cached entry is answered with
//! the problem.

use std::collections::VecDeque;
use std::sync::Mutex;

use piarc_protocol::market::{MarketDetail, MarketProblem};
use serde_json::Value;

use super::{InstalledByName, Market, net, npm};
use crate::error::{Error, Result};

/// Recent package documents, newest last: `(name@version, detail without installed state)`.
#[derive(Default)]
pub struct DetailCache {
    entries: Mutex<VecDeque<(String, MarketDetail)>>,
}

/// How many details stay in memory.
const KEEP: usize = 32;

impl DetailCache {
    fn get(&self, key: &str) -> Option<MarketDetail> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, d)| d.clone())
    }

    fn put(&self, key: String, detail: MarketDetail) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|(k, _)| *k != key);
        entries.push_back((key, detail));
        while entries.len() > KEEP {
            entries.pop_front();
        }
    }
}

impl Market {
    /// The raw document of `name@version` (when the package document is too large to read).
    async fn version_document(
        &self,
        name: &str,
        version: &str,
        proxy: Option<&str>,
    ) -> std::result::Result<Value, MarketProblem> {
        let path = format!("{}/{version}", npm::package_path(name));
        self.inner
            .registry
            .json(
                &path,
                self.inner.config.limits.version_bytes,
                proxy,
                &self.inner.cancel,
            )
            .await
            .map_err(|e| net::problem(&e))
    }

    /// The details of package `name` (cached in the market).
    ///
    /// # Errors
    ///
    /// `invalidParams` for a bad name, `notFound` for a package the market has not seen; the
    /// database failed.
    pub async fn detail(
        &self,
        name: &str,
        installed: &InstalledByName,
        proxy: Option<String>,
    ) -> Result<MarketDetail> {
        if !npm::valid_name(name) {
            return Err(Error::InvalidArgument {
                field: "name",
                reason: "not an npm package name".into(),
            });
        }
        let row = self.row(name).await?.ok_or_else(|| Error::Feature {
            kind: piarc_protocol::ErrorKind::NotFound,
            retryable: false,
            message: format!("the market has no package {name}"),
            details: None,
        })?;
        let key = format!("{name}@{}", row.listing.version);
        let mut detail = match self.inner.details.get(&key) {
            Some(detail) => detail,
            None => {
                let fetched = self.fetch_detail(&row, proxy.as_deref()).await;
                if fetched.problem.is_none() {
                    self.inner.details.put(key, fetched.clone());
                }
                fetched
            }
        };
        // The installed state and kinds as they are now.
        if let Ok(Some(row)) = self.row(name).await {
            detail.entry = self.entry(&row, installed);
        }
        Ok(detail)
    }

    async fn fetch_detail(
        &self,
        row: &piarc_store::MarketRow,
        proxy: Option<&str>,
    ) -> MarketDetail {
        let l = &row.listing;
        let mut detail = MarketDetail {
            entry: self.entry(row, &InstalledByName::new()),
            keywords: l.keywords.clone(),
            license: l.license.clone(),
            npm_url: l.npm_url.clone(),
            repository_url: l.repo_url.clone(),
            homepage_url: l.homepage_url.clone(),
            readme: None,
            readme_truncated: false,
            readme_too_large: false,
            deprecated_message: None,
            install_scripts: Vec::new(),
            foreign_dependencies: Vec::new(),
            dependencies: Vec::new(),
            problem: None,
        };
        let limits = &self.inner.config.limits;
        let path = npm::package_path(&l.name);
        let doc = match self
            .inner
            .registry
            .json(&path, limits.packument_bytes, proxy, &self.inner.cancel)
            .await
        {
            Ok(doc) => Some(doc),
            Err(error) if error.code() == "tooLarge" => {
                detail.readme_too_large = true;
                None
            }
            Err(error) => {
                detail.problem = Some(net::problem(&error));
                return detail;
            }
        };
        let version_doc = match &doc {
            Some(doc) => doc
                .get("versions")
                .and_then(|v| v.get(&l.version))
                .cloned()
                .unwrap_or(Value::Null),
            None => match self.version_document(&l.name, &l.version, proxy).await {
                Ok(doc) => doc,
                Err(problem) => {
                    detail.problem = Some(problem);
                    Value::Null
                }
            },
        };
        if let Some((text, truncated)) = doc.as_ref().and_then(npm::readme) {
            detail.readme = Some(text);
            detail.readme_truncated = truncated;
        }
        if let Some(info) = npm::version_info(&version_doc) {
            detail.deprecated_message.clone_from(&info.deprecated);
            detail.install_scripts.clone_from(&info.install_scripts);
            detail.foreign_dependencies.clone_from(&info.foreign);
            detail.dependencies.clone_from(&info.dependencies);
            let kinds = info.kinds.unwrap_or(l.kw_kinds);
            let (name, version, deprecated) =
                (l.name.clone(), l.version.clone(), info.deprecated.is_some());
            let _ = self
                .inner
                .storage
                .run(move |s| s.market_set_manifest(&name, &version, kinds, deprecated))
                .await;
            if let Ok(Some(row)) = self.row(&l.name).await {
                detail.entry = self.entry(&row, &InstalledByName::new());
            }
        } else if detail.problem.is_none() && !detail.readme_too_large {
            detail.problem = Some(MarketProblem {
                code: "notFound".into(),
                message: format!("{}@{} is not in the package document", l.name, l.version),
            });
        }
        detail
    }
}
