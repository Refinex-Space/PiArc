//! Exports of ADR-0111: in-app updates for the About page. Results are JSON text
//! (`UpdateStatus`, `UpdateInstall`); status changes and download progress arrive on the
//! `core/updates` route.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// The update status (`UpdateStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn update_status<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.updateStatus", |core, done| {
            core.update_status(done)
        })
    }

    /// Reads the latest release through the effective proxy (`UpdateStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn check_for_updates<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.checkForUpdates", |core, done| {
            core.check_for_updates(done)
        })
    }

    /// Starts downloading the newer release in the background (`UpdateStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn download_update<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.downloadUpdate", |core, done| {
            core.download_update(done)
        })
    }

    /// Cancels the running download (`UpdateStatus`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn cancel_update_download<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.cancelUpdateDownload", |core, done| {
            core.cancel_update_download(done)
        })
    }

    /// The verified files of the ready release, checked once more (`UpdateInstall`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn update_install_plan<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.updateInstallPlan", |core, done| {
            core.update_install_plan(done)
        })
    }
}
