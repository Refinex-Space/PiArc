//! The settings window's Pi package market (ADR-0102): pages, details, refreshing and installs.
//! The installed state comes from the extension package manager; an install is checked against
//! the registry's own document of the version before npm runs, and every running Agent Host
//! reads its resources again afterwards.

use std::path::PathBuf;

use piarc_protocol::ErrorKind;
use piarc_protocol::market::{MarketInstallRequest, MarketInstalled, MarketProblem, MarketQuery};
use serde::Serialize;
use serde_json::Value;

use super::Hub;
use crate::error::{Error, Result};
use crate::market::{InstalledByName, npm};
use crate::plugins::MarketSpec;

fn encode(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::Internal {
        reason: format!("cannot encode the market: {e}"),
    })
}

fn refused(message: impl Into<String>) -> Error {
    Error::Feature {
        kind: ErrorKind::InvalidParams,
        retryable: false,
        message: message.into(),
        details: None,
    }
}

impl Hub {
    fn proxy_now(&self) -> Option<String> {
        self.ctx.proxy.effective(self.ctx.storage.dirs().data())
    }

    /// The installed packages a market entry may correspond to, by npm name, as `workspace`
    /// sees them.
    async fn market_installed(
        &self,
        workspace: Option<&std::path::Path>,
    ) -> Result<InstalledByName> {
        let plugins = self.plugins();
        let names = plugins.npm_names().await?;
        let list = plugins.list(workspace).await?;
        Ok(list
            .packages
            .into_iter()
            .filter_map(|p| {
                let name = names.get(&p.id)?.clone();
                Some((
                    name,
                    MarketInstalled {
                        id: p.id,
                        version: p.source.version,
                        update: None,
                        scope: p.scope,
                        enabled: p.enabled,
                    },
                ))
            })
            .collect())
    }

    /// One page of the market.
    pub async fn market_query(&self, query: MarketQuery) -> Result<Value> {
        let workspace = query.workspace.as_deref().map(PathBuf::from);
        let installed = self.market_installed(workspace.as_deref()).await?;
        encode(
            &self
                .ctx
                .market
                .query(query, &installed, self.proxy_now())
                .await?,
        )
    }

    /// One package's details.
    pub async fn market_detail(&self, name: String, workspace: Option<PathBuf>) -> Result<Value> {
        let installed = self.market_installed(workspace.as_deref()).await?;
        encode(
            &self
                .ctx
                .market
                .detail(&name, &installed, self.proxy_now())
                .await?,
        )
    }

    /// Syncs the catalog now (in the background); answers its status.
    pub async fn market_refresh(&self) -> Result<Value> {
        self.ctx.market.refresh(self.proxy_now(), true).await?;
        encode(&self.ctx.market.status().await?)
    }

    /// Installs a market package (off).
    pub async fn market_install(&self, request: MarketInstallRequest) -> Result<Value> {
        if !npm::valid_name(&request.name) || !npm::valid_version(&request.version) {
            return Err(Error::InvalidArgument {
                field: "name",
                reason: "an npm package name and an exact version".into(),
            });
        }
        let market = &self.ctx.market;
        if !market.begin_install(&request.name) {
            return Err(Error::Feature {
                kind: ErrorKind::Busy,
                retryable: true,
                message: format!("{} is being installed", request.name),
                details: None,
            });
        }
        market.started_install(&request.name).await;
        let result = self.install_from_market(&request).await;
        let problem = result.as_ref().err().map(|e| MarketProblem {
            code: serde_json::to_value(e.kind())
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "internalError".into()),
            message: e.to_string(),
        });
        market.end_install(&request.name, problem).await;
        let result = result?;
        self.packages_changed().await;
        encode(&result)
    }

    async fn install_from_market(
        &self,
        request: &MarketInstallRequest,
    ) -> Result<piarc_protocol::plugins::PackageInstallResult> {
        let market = &self.ctx.market;
        let row = market
            .row(&request.name)
            .await?
            .ok_or_else(|| refused(format!("the market has no package {}", request.name)))?;
        if row.listing.version != request.version {
            return Err(refused(format!(
                "the market lists {}@{}, not {}",
                request.name, row.listing.version, request.version
            )));
        }
        let proxy = self.proxy_now();
        let info = market
            .version(&request.name, &request.version, proxy.as_deref())
            .await
            .map_err(|p| Error::Feature {
                kind: ErrorKind::IoError,
                retryable: true,
                message: p.message,
                details: Some(serde_json::json!({ "reason": p.code }).to_string()),
            })?;
        let integrity = info
            .integrity
            .clone()
            .ok_or_else(|| refused("the registry gives no sha512 integrity for this version"))?;
        if !info.foreign.is_empty() {
            return Err(refused(format!(
                "dependencies outside the registry: {}",
                info.foreign.join(", ")
            )));
        }
        if info.kinds == Some(piarc_store::market::kind::THEME) {
            return Err(refused(
                "the package only brings themes, which PiArc does not use",
            ));
        }
        let spec = MarketSpec {
            name: request.name.clone(),
            version: request.version.clone(),
            integrity,
            registry: market.registry_base().to_owned(),
            ca_file: market
                .config()
                .test_net
                .as_ref()
                .and_then(|t| t.ca_file.clone()),
        };
        self.plugins()
            .install_market(spec, request.scope, request.workspace.as_deref())
            .await
    }
}
