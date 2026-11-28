//! Voice dictation exports (ADR-0094, voice dictation addendum 4.6). Requests and results are
//! JSON text with the shapes of `piarc_protocol::dictation`; the main process fills the
//! window id from the sending `webContents` and never takes it from the page.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use piarc_protocol::dictation::{DictationStart, StopMode};

use crate::boundary;
use crate::runtime::CoreRuntime;

type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;

fn settle_json<T: serde::Serialize>(result: piarc_core::Result<T>) -> Settle {
    let encoded = result.and_then(|value| {
        serde_json::to_string(&value).map_err(|e| piarc_core::Error::Internal {
            reason: format!("cannot encode the result: {e}"),
        })
    });
    Box::new(move |env| encoded.map_err(|error| boundary::js_error(&env, &error.to_error_object())))
}

fn parse<T: serde::de::DeserializeOwned>(field: &'static str, text: &str) -> piarc_core::Result<T> {
    serde_json::from_str(text).map_err(|_| piarc_core::Error::InvalidArgument {
        field,
        reason: "has the wrong shape".into(),
    })
}

fn window(id: f64) -> piarc_core::Result<u64> {
    if id.is_finite() && id >= 0.0 && id.fract() == 0.0 && id < 9_007_199_254_740_992.0 {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "checked: a non-negative safe integer"
        )]
        #[expect(clippy::cast_sign_loss, reason = "checked: non-negative")]
        Ok(id as u64)
    } else {
        Err(piarc_core::Error::InvalidArgument {
            field: "windowId",
            reason: "must be a non-negative integer".into(),
        })
    }
}

#[napi]
impl CoreRuntime {
    /// Starts a dictation. `requestJson` is a `DictationStart` (`windowId`, `composer`,
    /// `workspace?`, `test?`). Resolves with `DictationStarted` (`sessionId`, `route`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn dictation_start<'env>(
        &self,
        env: &'env Env,
        request_json: String,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.dictationStart", || {
            let request: DictationStart = parse("request", &request_json)?;
            self.core
                .dictation_start(request, move |result| deferred.resolve(settle_json(result)))
        })?;
        Ok(promise)
    }

    /// Stops a dictation of window `windowId`; `mode` is `keep` or `send`.
    #[napi(catch_unwind)]
    pub fn dictation_stop(
        &self,
        env: Env,
        window_id: f64,
        session_id: String,
        mode: String,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.dictationStop", || {
            let mode: StopMode = parse("mode", &format!("\"{}\"", mode.escape_default()))?;
            self.core
                .dictation_stop(window(window_id)?, &session_id, mode)
        })
    }

    /// Cancels a dictation of window `windowId`.
    #[napi(catch_unwind)]
    pub fn dictation_cancel(
        &self,
        env: Env,
        window_id: f64,
        session_id: String,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.dictationCancel", || {
            self.core.dictation_cancel(window(window_id)?, &session_id)
        })
    }

    /// Window `windowId` is gone; its dictation ends without text.
    #[napi(catch_unwind)]
    pub fn dictation_release(&self, env: Env, window_id: f64) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.dictationRelease", || {
            self.core.dictation_release(window(window_id)?);
            Ok(())
        })
    }

    /// The running dictation as `DictationStatus` JSON.
    #[napi(catch_unwind)]
    pub fn dictation_status(&self, env: Env) -> napi::Result<String> {
        boundary::call(&env, "CoreRuntime.dictationStatus", || {
            serde_json::to_string(&self.core.dictation_status()).map_err(|e| {
                piarc_core::Error::Internal {
                    reason: format!("cannot encode the status: {e}"),
                }
            })
        })
    }

    /// Resolves with the input devices as a JSON array of `InputDevice`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn speech_devices<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.speechDevices", || {
            self.core
                .speech_devices(move |result| deferred.resolve(settle_json(result)))
        })?;
        Ok(promise)
    }

    /// Resolves with `SpeechModels` JSON and broadcasts it on `core/speech`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn speech_models<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.speechModels", || {
            self.core
                .speech_models(move |result| deferred.resolve(settle_json(result)))
        })?;
        Ok(promise)
    }

    /// One action on a speech model (`download`, `cancel`, `delete`, `verify`); resolves with
    /// `SpeechModels` JSON. The main process asks natively before `delete`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn speech_model_action<'env>(
        &self,
        env: &'env Env,
        model_id: String,
        action: String,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.speechModelAction", || {
            self.core
                .speech_model_action(&model_id, &action, move |result| {
                    deferred.resolve(settle_json(result));
                })
        })?;
        Ok(promise)
    }
}
