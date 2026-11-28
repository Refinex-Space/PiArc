//! Exports of T45: the diagnostic bundle's preview and export; and the data export (settings,
//! Data management). Results are JSON text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::runtime::CoreRuntime;

#[napi]
impl CoreRuntime {
    /// Assembles the diagnostic bundle in memory and answers its manifest as JSON text:
    /// `{id, files: [{name, bytes}], redactions: {<kind>: n}, excluded}`. `appJson` holds the
    /// client's versions; `workspace` whose configuration diagnostics to add (the most recent
    /// workspace when null).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn prepare_diagnostics<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
        app_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.prepareDiagnostics", move |core, done| {
            core.prepare_diagnostics(workspace.map(Into::into), &app_json, done)
        })
    }

    /// Writes the prepared bundle `id` to the absolute `path` as a ZIP archive; answers
    /// `{path, bytes}` as JSON text.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn export_diagnostics<'env>(
        &self,
        env: &'env Env,
        id: String,
        path: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.exportDiagnostics", move |core, done| {
            core.export_diagnostics(id, path.into(), done)
        })
    }

    /// Writes every session to the absolute `path` as a ZIP archive (each conversation as
    /// Markdown in the words of `labelsJson`, its original records, and an index); answers
    /// `{path, bytes, sessions}` as JSON text.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn export_sessions<'env>(
        &self,
        env: &'env Env,
        path: String,
        labels_json: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.exportSessions", move |core, done| {
            core.export_sessions(path.into(), &labels_json, done)
        })
    }
}
