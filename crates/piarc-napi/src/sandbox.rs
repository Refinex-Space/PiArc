//! Exports of T39: the settings window's sandbox page. Results are JSON text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// The sandbox of a workspace for the settings page (the most recent workspace when
    /// null): on or off, mode, allowed domains and `denyRead` with their sources, writable
    /// places, project values that do not apply, and whether the platform has a sandbox.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn sandbox_settings<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.sandboxSettings", |core, done| {
            core.sandbox_settings(workspace.map(Into::into), done)
        })
    }

    /// Writes the user's sandbox values, JSON `{ enabled?, autoAllow?, allowedDomains?,
    /// denyRead? }`; answers the new view of `workspace`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_sandbox_settings<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
        change_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setSandboxSettings", |core, done| {
            core.set_sandbox_settings(workspace.map(Into::into), change_json, done)
        })
    }
}
