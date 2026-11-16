//! `CoreRuntime`: the JavaScript face of `piarc_core::CoreRuntime`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::boundary;
use crate::sink::{EventListener, JsEventSink};

/// Options of `CoreRuntime.create`.
#[napi(object, object_to_js = false)]
pub struct CoreOptions {
    /// Coalescing interval in milliseconds (1 to 1000). Default 16.
    pub coalesce_interval_ms: Option<u32>,
    /// Absolute data directory (architecture section 9.1). With `cacheDir`, Core opens its
    /// database, settings, project trust and log files there; without both, none of them.
    pub data_dir: Option<String>,
    /// Absolute cache directory (discardable).
    pub cache_dir: Option<String>,
}

/// Lifecycle state of a runtime.
#[napi(string_enum = "camelCase")]
pub enum CoreState {
    /// Accepting requests.
    Running,
    /// `shutdown()` was called; requests fail with kind `shuttingDown`.
    ShuttingDown,
    /// Shutdown finished: `onEvents` is released and will not be called again.
    Stopped,
}

/// PiArc Core, loaded once in the Electron main process (ADR-0014).
#[napi]
pub struct CoreRuntime {
    pub(crate) core: piarc_core::CoreRuntime,
}

#[napi]
impl CoreRuntime {
    /// Starts Core. `onEvents` receives the coalesced event batches, at most once per
    /// coalescing interval, until `shutdown()` resolves.
    ///
    /// Throws a structured error (`data.kind` is `invalidParams` for bad options).
    #[napi(factory, catch_unwind)]
    pub fn create(
        env: Env,
        options: CoreOptions,
        #[napi(ts_arg_type = "(batches: CoreEventBatch[]) => void")] on_events: EventListener,
    ) -> napi::Result<Self> {
        boundary::call(&env, "CoreRuntime.create", move || {
            let mut config = piarc_core::CoreConfig::default();
            if let Some(ms) = options.coalesce_interval_ms {
                config.coalesce_interval = Duration::from_millis(u64::from(ms));
            }
            config.dirs = match (options.data_dir, options.cache_dir) {
                (Some(data), Some(cache)) => Some(piarc_core::DataDirs::new(
                    PathBuf::from(data),
                    PathBuf::from(cache),
                )?),
                (None, None) => None,
                _ => {
                    return Err(piarc_core::Error::InvalidArgument {
                        field: "dataDir",
                        reason: "dataDir and cacheDir go together".into(),
                    });
                }
            };
            let sink = Arc::new(JsEventSink::new(on_events));
            piarc_core::CoreRuntime::start(config, sink).map(|core| Self { core })
        })
    }

    /// The lifecycle state.
    #[napi(getter, catch_unwind)]
    pub fn state(&self) -> CoreState {
        match self.core.state() {
            piarc_core::RuntimeState::Running => CoreState::Running,
            piarc_core::RuntimeState::ShuttingDown => CoreState::ShuttingDown,
            piarc_core::RuntimeState::Stopped => CoreState::Stopped,
        }
    }

    /// Ordered shutdown: refuses new requests, stops event sources, delivers the last batch,
    /// releases `onEvents` and stops Core's threads. Resolves once all of that is done; after
    /// that `onEvents` is never called again. Safe to call more than once.
    #[napi(ts_return_type = "Promise<void>", catch_unwind)]
    pub fn shutdown<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<(), fn(Env) -> napi::Result<()>>()?;
        boundary::call(env, "CoreRuntime.shutdown", || {
            self.core.shutdown(move || deferred.resolve(|_| Ok(())))
        })?;
        Ok(promise)
    }
}
