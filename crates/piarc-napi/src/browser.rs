//! Exports of the built-in browser (ADR-0088, ADR-0089). Results are JSON text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// The port on `127.0.0.1` of a browser partition's proxy, started on first use; JSON
    /// `{ partition, localNames, deniedPorts }`. Answers `{ port }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn browser_proxy<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.browserProxy", |core, done| {
            core.browser_proxy(request_json, done)
        })
    }

    /// The app's main process runs `Browser` scripts from now on (ADR-0089): workspaces
    /// started afterwards offer the tool; runs arrive on `core/browser`.
    #[napi(catch_unwind)]
    pub fn attach_browser_client(&self, env: Env) -> napi::Result<()> {
        crate::boundary::call(&env, "CoreRuntime.attachBrowserClient", || {
            self.core.attach_browser_client()
        })
    }

    /// Answers run `runId` with JSON `{ output, images?, error?, blockedHosts? }`; false when
    /// the run already ended.
    #[napi(catch_unwind)]
    pub fn answer_browser_run(
        &self,
        env: Env,
        run_id: String,
        answer_json: String,
    ) -> napi::Result<bool> {
        crate::boundary::call(&env, "CoreRuntime.answerBrowserRun", || {
            self.core.answer_browser_run(&run_id, &answer_json)
        })
    }

    /// Stops a browser partition's proxy. Answers `{ stopped }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn stop_browser_proxy<'env>(
        &self,
        env: &'env Env,
        partition: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.stopBrowserProxy", |core, done| {
            core.stop_browser_proxy(partition, done)
        })
    }
}
