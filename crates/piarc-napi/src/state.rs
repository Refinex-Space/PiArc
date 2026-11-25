//! Exports over Core's state (T13): rebuilding the session index and project trust; the
//! client's preferences in the user's settings file (T18). Results are JSON text; their
//! shapes are `piarc_core::storage::report_json`, `piarc_core::trust::TrustView` (camelCase)
//! and the settings file's object.

use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::boundary;
use crate::runtime::CoreRuntime;

type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;

fn settle_json<T: serde::Serialize>(result: piarc_core::Result<T>) -> Settle {
    // Encode on Core's thread; only the text crosses to the JavaScript thread.
    let encoded = result.and_then(|value| {
        serde_json::to_string(&value).map_err(|e| piarc_core::Error::Internal {
            reason: format!("cannot encode the result: {e}"),
        })
    });
    Box::new(move |env| encoded.map_err(|error| boundary::js_error(&env, &error.to_error_object())))
}

#[napi]
impl CoreRuntime {
    /// Rebuilds the session index from Pi's session files (the "rebuild index" diagnostic
    /// action). Resolves with the report as JSON: `files`, `rescanned`, `appended`,
    /// `unchanged`, `removed`, `unavailable`, `failed`, `skippedLines`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn rebuild_session_index<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.rebuildSessionIndex", || {
            self.core
                .rebuild_session_index(move |result| deferred.resolve(settle_json(result)))
        })?;
        Ok(promise)
    }

    /// The project trust of an absolute directory as JSON (`TrustView`: `checkout`, `kind`,
    /// `decision`, `trusted`, `items`, `newItems`, ...).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn project_trust<'env>(&self, env: &'env Env, path: String) -> napi::Result<Object<'env>> {
        self.trust_call(env, "CoreRuntime.projectTrust", path, None)
    }

    /// Records the user's trust decision for the project containing an absolute directory,
    /// with the executable items listed now as its snapshot; resolves with the new
    /// `TrustView` as JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn decide_project_trust<'env>(
        &self,
        env: &'env Env,
        path: String,
        trusted: bool,
        version: String,
    ) -> napi::Result<Object<'env>> {
        self.trust_call(
            env,
            "CoreRuntime.decideProjectTrust",
            path,
            Some((trusted, version)),
        )
    }

    /// Revokes the trust decision of the project containing an absolute directory; resolves
    /// with the new `TrustView` as JSON. The workspace's Agent Host restarts without project
    /// resources.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn revoke_project_trust<'env>(
        &self,
        env: &'env Env,
        path: String,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.revokeProjectTrust", || {
            self.core.revoke_trust(PathBuf::from(path), move |result| {
                deferred.resolve(settle_json(result));
            })
        })?;
        Ok(promise)
    }
}

#[napi]
impl CoreRuntime {
    /// The user's settings file (`<data>/settings.json`) as JSON; `{}` when it does not exist.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn user_settings<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.userSettings", || {
            self.core
                .user_settings(move |result| deferred.resolve(settle_json(result)))
        })?;
        Ok(promise)
    }

    /// Records the system's proxy as the main process resolved it (`null`: direct). With the
    /// proxy choice at `auto`, the workspaces' Agent Hosts restart with it once idle (ADR-0082).
    #[napi(catch_unwind)]
    pub fn set_system_proxy(
        &self,
        env: Env,
        #[napi(ts_arg_type = "string | null")] url: Option<String>,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.setSystemProxy", || {
            self.core.set_system_proxy(url)
        })
    }

    /// Sets one client preference in the user's settings file: `pointer` is `/memory/readBoth`
    /// or lies under `/language`, `/appearance`, `/keybindings`, `/notifications` or `/proxy`;
    /// `value` is JSON text, `null` removes the key. Resolves with the file's new content as JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn write_client_setting<'env>(
        &self,
        env: &'env Env,
        pointer: String,
        #[napi(ts_arg_type = "string | null")] value: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let value = match value.map(|text| serde_json::from_str::<serde_json::Value>(&text)) {
            None => None,
            Some(Ok(value)) => Some(value),
            Some(Err(_)) => {
                let error = piarc_core::Error::InvalidArgument {
                    field: "value",
                    reason: "must be JSON text".into(),
                };
                return Err(boundary::js_error(env, &error.to_error_object()));
            }
        };
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.writeClientSetting", || {
            self.core
                .write_client_setting(pointer, value, move |result| {
                    deferred.resolve(settle_json(result));
                })
        })?;
        Ok(promise)
    }
}

impl CoreRuntime {
    fn trust_call<'env>(
        &self,
        env: &'env Env,
        location: &'static str,
        path: String,
        decide: Option<(bool, String)>,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, location, || {
            self.core
                .trust_view(PathBuf::from(path), decide, move |result| {
                    deferred.resolve(settle_json(result));
                })
        })?;
        Ok(promise)
    }
}
