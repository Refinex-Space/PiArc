//! Exports of T40: the settings window's extension packages. Results are JSON text. Turning a
//! package on is only called by the main process after its native confirmation (the renderer
//! cannot reach it directly).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// The installed packages as `workspace` (or, when null, the user settings) sees them, as
    /// JSON text (`PackagesList`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn packages_list<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packagesList", |core, done| {
            core.packages_list(workspace.map(Into::into), done)
        })
    }

    /// Installs a package (off); `request_json` is a `PackageInstallRequest`. Answers a
    /// `PackageInstallResult`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn package_install<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packageInstall", |core, done| {
            core.package_install(&request_json, done)
        })
    }

    /// Updates package `id` to its source's newest version (`PackageInstallResult`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn package_update<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packageUpdate", |core, done| {
            core.package_update(id, workspace.map(Into::into), done)
        })
    }

    /// Turns package `id` on or off in `scope` (`user` or `project`); turning on confirms
    /// `confirm` (the executable items the native confirmation listed). Answers the list.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn package_set_enabled<'env>(
        &self,
        env: &'env Env,
        id: String,
        enabled: bool,
        scope: String,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
        confirm: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packageSetEnabled", |core, done| {
            core.package_set_enabled(
                id,
                enabled,
                &scope,
                workspace.map(Into::into),
                confirm,
                done,
            )
        })
    }

    /// Confirms executable items of package `id` (after the native confirmation). Answers the
    /// list.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn package_confirm<'env>(
        &self,
        env: &'env Env,
        id: String,
        items: Vec<String>,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packageConfirm", |core, done| {
            core.package_confirm(id, items, workspace.map(Into::into), done)
        })
    }

    /// Uninstalls package `id` (its declarations in the user settings and `workspace`'s, its
    /// files unless it is a local directory). Answers the list.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn package_uninstall<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.packageUninstall", |core, done| {
            core.package_uninstall(id, workspace.map(Into::into), done)
        })
    }
}
