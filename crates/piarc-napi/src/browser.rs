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

    /// Whether a page of a running `Browser` call may reach a host (site cards): JSON
    /// `{ sessionId, toolCallId, url, host, local?, sensitive?, pending? }`. Answers
    /// `{ allowed, scope? }` once Core decided, which may wait for the user.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn browser_site<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.browserSite", |core, done| {
            core.browser_site(request_json, done)
        })
    }

    /// A file request of the agent's browser (B2.6.6): JSON `{ op: "stage", sessionId,
    /// toolCallId, paths }` or `{ op: "save", sessionId, toolCallId, source, path }`. Answers
    /// `{ staged?, saved? }` once Core decided, which may wait for the user.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn browser_files<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.browserFiles", |core, done| {
            core.browser_files(request_json, done)
        })
    }

    /// What the user changed in a session's browser since the agent's last call (B2.7.3): JSON
    /// `{ sessionId, spaces: [{ id, name, controlledBy, tabs, tabCount }], userTabs }`, kept
    /// as the session's next `browserState` reminder.
    #[napi(catch_unwind)]
    pub fn browser_state(&self, env: Env, request_json: String) -> napi::Result<()> {
        crate::boundary::call(&env, "CoreRuntime.browserState", || {
            self.core.browser_state(&request_json)
        })
    }

    /// The directory the downloads of session `sessionId`'s agent tabs go to.
    #[napi(catch_unwind)]
    pub fn browser_downloads_dir(&self, env: Env, session_id: String) -> napi::Result<String> {
        crate::boundary::call(&env, "CoreRuntime.browserDownloadsDir", || {
            self.core.browser_downloads_dir(&session_id)
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
