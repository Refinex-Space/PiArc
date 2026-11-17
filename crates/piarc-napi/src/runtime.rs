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
    /// How workspaces start their Agent Host; without it workspaces cannot open.
    pub agent_host: Option<AgentHostOptions>,
    /// Idle time in milliseconds after which a workspace's Agent Host is stopped (default 30
    /// minutes).
    pub idle_timeout_ms: Option<u32>,
}

/// Where the Agent Host comes from: the packaged app's resources, or a Node executable and a
/// bundle (development).
#[napi(object, object_to_js = false)]
pub struct AgentHostOptions {
    /// Electron's `process.resourcesPath` of a packaged app (`agent-host/` below it).
    pub resources_path: Option<String>,
    /// Development: the Node executable.
    pub node: Option<String>,
    /// Development: `agent-host.mjs`.
    pub bundle: Option<String>,
    /// Development: Pi's resources next to the bundle (`pi-assets/`).
    pub pi_package_dir: Option<String>,
}

fn launch(
    options: AgentHostOptions,
) -> piarc_core::Result<piarc_core::agent_host::AgentHostLaunch> {
    use piarc_core::agent_host::AgentHostLaunch;
    match options {
        AgentHostOptions {
            resources_path: Some(resources),
            node: None,
            bundle: None,
            pi_package_dir: None,
        } => Ok(AgentHostLaunch::Bundled {
            resources_dir: PathBuf::from(resources),
        }),
        AgentHostOptions {
            resources_path: None,
            node: Some(node),
            bundle: Some(bundle),
            pi_package_dir,
        } => Ok(AgentHostLaunch::Custom {
            node: PathBuf::from(node),
            bundle: PathBuf::from(bundle),
            pi_package_dir: pi_package_dir.map(PathBuf::from),
            extra_args: Vec::new(),
            extra_env: Vec::new(),
        }),
        _ => Err(piarc_core::Error::InvalidArgument {
            field: "agentHost",
            reason: "give resourcesPath, or node and bundle".into(),
        }),
    }
}

/// Core's settings from `CoreRuntime.create`'s options.
pub(crate) fn config_of(options: CoreOptions) -> piarc_core::Result<piarc_core::CoreConfig> {
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
    if let Some(agent_host) = options.agent_host {
        config.sessions.launch = Some(launch(agent_host)?);
    }
    if let Some(ms) = options.idle_timeout_ms {
        config.sessions.idle_timeout = Duration::from_millis(u64::from(ms));
    }
    Ok(config)
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
            let config = config_of(options)?;
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
