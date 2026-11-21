//! Exports of T41: the usage report, a session's usage and the user's model prices. Results
//! are JSON text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// Usage by model and by session, for every workspace or `workspace`'s, as JSON text
    /// (`UsageReport`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn usage_report<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.usageReport", |core, done| {
            core.usage_report(workspace.map(Into::into), done)
        })
    }

    /// One main session's usage with its subagents and auxiliary calls, as JSON text
    /// (`SessionUsage`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn session_usage<'env>(
        &self,
        env: &'env Env,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.sessionUsage", |core, done| {
            core.session_usage(session_id, done)
        })
    }

    /// Sets the user's price of `provider/model` (`priceJson`: `{input, output, cacheRead,
    /// cacheWrite}`, USD per million tokens); null removes it.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_model_price<'env>(
        &self,
        env: &'env Env,
        provider: String,
        model: String,
        #[napi(ts_arg_type = "string | null")] price_json: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setModelPrice", |core, done| {
            core.set_model_price(provider, model, price_json.as_deref(), done)
        })
    }
}
