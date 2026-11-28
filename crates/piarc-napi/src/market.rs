//! Exports of ADR-0102: the settings window's Pi package market. Results are JSON text; sync
//! progress, kinds and installs arrive on the `core/market` route.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// One page of the market; `query_json` is a `MarketQuery`. Answers a `MarketPage`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn market_query<'env>(
        &self,
        env: &'env Env,
        query_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.marketQuery", |core, done| {
            core.market_query(&query_json, done)
        })
    }

    /// One package's details (`MarketDetail`) as `workspace` sees its installed state.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn market_detail<'env>(
        &self,
        env: &'env Env,
        name: String,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.marketDetail", |core, done| {
            core.market_detail(name, workspace.map(Into::into), done)
        })
    }

    /// Syncs the catalog now, in the background (`MarketStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn market_refresh<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.marketRefresh", |core, done| {
            core.market_refresh(done)
        })
    }

    /// Installs a market package (off); `request_json` is a `MarketInstallRequest`. Answers a
    /// `PackageInstallResult`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn market_install<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.marketInstall", |core, done| {
            core.market_install(&request_json, done)
        })
    }
}
