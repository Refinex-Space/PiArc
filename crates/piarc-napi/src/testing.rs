//! Exports of the `testing` build: demo event sources, the synchronous echo call, event
//! counters and panic triggers (T04 benchmarks and tests). Shipping builds leave them out.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::boundary;
use crate::runtime::CoreRuntime;

/// Settings of a demo event source.
#[napi(object, object_to_js = false)]
pub struct DemoSourceOptions {
    /// Route key of every event.
    pub route: String,
    /// Target rate in events per second, fractions allowed (above 0, at most 1,000,000).
    pub events_per_second: f64,
    /// Length of each event's `pad` string, to control the payload size. Default 0.
    pub pad_bytes: Option<u32>,
    /// Stop after this many events. Default: run until stopped.
    pub max_events: Option<u32>,
}

/// The result of a stopped demo source.
#[napi(object, object_from_js = false)]
pub struct DemoSourceReport {
    /// The source id.
    pub id: u32,
    /// Events queued; each one is delivered unless the listener's environment is gone.
    pub emitted: i64,
}

/// Counters of the event path.
#[napi(object, object_from_js = false)]
pub struct CoreEventStats {
    /// Events accepted into the queue.
    pub queued: i64,
    /// Calls of `onEvents`.
    pub deliveries: i64,
    /// Batches passed to `onEvents`.
    pub batches: i64,
    /// Events passed to `onEvents`.
    pub delivered: i64,
    /// Events dropped because the listener's environment was gone.
    pub lost: i64,
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[napi]
impl CoreRuntime {
    /// Like `create`, with the vault's master key in memory under a `piarc-test.` name instead
    /// of the system credential store: tests that open workspaces never touch the keychain
    /// (T14). L4 (T29) may also set `PIARC_TEST_WEB_ALLOWLIST` (comma-separated hosts or
    /// ranges WebFetch may reach, for its local test server) and `PIARC_TEST_OAUTH_PROVIDER`
    /// (a `--test-oauth-provider` file every Agent Host registers, for the mock sign-in).
    #[napi(factory, catch_unwind)]
    pub fn create_for_tests(
        env: Env,
        options: crate::runtime::CoreOptions,
        #[napi(ts_arg_type = "(batches: CoreEventBatch[]) => void")]
        on_events: crate::sink::EventListener,
    ) -> napi::Result<Self> {
        boundary::call(&env, "CoreRuntime.createForTests", move || {
            let mut config = crate::runtime::config_of(options)?;
            config.home = config
                .dirs
                .as_ref()
                .map(|dirs| dirs.data().join("test-home"));
            config.secret_store = Some(piarc_core::SecretStoreSetup {
                master_key: piarc_core::secrets::test_master_key_name("napi"),
                store: std::sync::Arc::new(piarc_core::secrets::MemorySecretStore::new()),
            });
            if let Ok(list) = std::env::var("PIARC_TEST_WEB_ALLOWLIST") {
                config.web.allowlist = list
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            if let Some(file) = std::env::var_os("PIARC_TEST_OAUTH_PROVIDER") {
                config.sessions.tune_host = Some(std::sync::Arc::new(move |host| {
                    host.extra_args.push("--test-oauth-provider".into());
                    host.extra_args.push(file.clone());
                }));
            }
            let sink = std::sync::Arc::new(crate::sink::JsEventSink::new(on_events));
            piarc_core::CoreRuntime::start(config, sink).map(|core| Self { core })
        })
    }
}

#[napi]
impl CoreRuntime {
    /// Starts a demo event source and returns its id. Each event is
    /// `{"source":id,"seq":n,"pad":"x…"}` with `seq` counting from 1.
    #[napi(catch_unwind)]
    pub fn start_demo_source(&self, env: Env, options: DemoSourceOptions) -> napi::Result<u32> {
        boundary::call(&env, "CoreRuntime.startDemoSource", || {
            let config = piarc_core::DemoSourceConfig {
                route: piarc_core::RouteKey::parse(&options.route)?,
                events_per_second: options.events_per_second,
                pad_bytes: options.pad_bytes.unwrap_or(0),
                max_events: options.max_events.map(u64::from),
            };
            self.core.start_demo_source(config)
        })
    }

    /// Stops a demo source (or collects one that reached `maxEvents`) and resolves with the
    /// number of events it emitted.
    #[napi(ts_return_type = "Promise<DemoSourceReport>", catch_unwind)]
    pub fn stop_demo_source<'env>(&self, env: &'env Env, id: u32) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<DemoSourceReport> + Send>;
        let (deferred, promise) = env.create_deferred::<DemoSourceReport, Settle>()?;
        boundary::call(env, "CoreRuntime.stopDemoSource", || {
            self.core.stop_demo_source(id, move |report| {
                deferred.resolve(Box::new(move |env| match report {
                    Ok(report) => Ok(DemoSourceReport {
                        id: report.id,
                        emitted: to_i64(report.emitted),
                    }),
                    Err(error) => Err(boundary::js_error(&env, &error.to_error_object())),
                }));
            })
        })?;
        Ok(promise)
    }

    /// Validates and queues the event `{"echo": payload}` without waiting: the lightweight
    /// synchronous call whose cost the S2 benchmark measures.
    #[napi(catch_unwind)]
    pub fn echo(&self, env: Env, route: String, payload: String) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.echo", || {
            self.core.echo(&route, &payload)
        })
    }

    /// Counters of the event path.
    #[napi(catch_unwind)]
    pub fn event_stats(&self) -> CoreEventStats {
        let stats = self.core.event_stats();
        CoreEventStats {
            queued: to_i64(stats.queued),
            deliveries: to_i64(stats.deliveries),
            batches: to_i64(stats.batches),
            delivered: to_i64(stats.delivered),
            lost: to_i64(stats.lost),
        }
    }

    /// Panics inside the export. The boundary must turn it into a thrown error of kind
    /// `internalError` and leave the runtime usable.
    #[napi(catch_unwind)]
    pub fn trigger_panic(&self, env: Env) -> napi::Result<()> {
        boundary::call(
            &env,
            "CoreRuntime.triggerPanic",
            || -> piarc_core::Result<()> { panic!("panic requested by a test") },
        )
    }

    /// Spawns a Core task that panics. The panic must arrive as an error event on the
    /// `core/errors` route.
    #[napi(catch_unwind)]
    pub fn spawn_panicking_task(&self, env: Env) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.spawnPanickingTask", || {
            self.core.spawn_panicking_task()
        })
    }
}

/// Counters of one terminal (T10 measurements).
#[napi(object, object_from_js = false)]
pub struct TerminalStats {
    /// Bytes read from the PTY.
    pub bytes_read: i64,
    /// Reads from the PTY.
    pub reads: i64,
    /// Time spent parsing output (`vt_write`), in microseconds.
    pub vt_write_micros: i64,
    /// Frames produced, empty ones included.
    pub frames: i64,
    /// Empty frames.
    pub empty_frames: i64,
    /// Bytes of all frames.
    pub frame_bytes: i64,
    /// Time spent producing frames, in microseconds.
    pub frame_micros: i64,
    /// Rows sent with cells.
    pub rows_with_cells: i64,
    /// Rows sent as references.
    pub rows_reused: i64,
}

#[napi]
impl CoreRuntime {
    /// Counters of a terminal.
    #[napi(catch_unwind)]
    pub fn terminal_stats(&self, env: Env, id: u32) -> napi::Result<TerminalStats> {
        boundary::call(&env, "CoreRuntime.terminalStats", || {
            let s = self.core.terminal_stats(id)?;
            Ok(TerminalStats {
                bytes_read: to_i64(s.bytes_read),
                reads: to_i64(s.reads),
                vt_write_micros: to_i64(s.vt_write_nanos / 1000),
                frames: to_i64(s.frames),
                empty_frames: to_i64(s.empty_frames),
                frame_bytes: to_i64(s.frame_bytes),
                frame_micros: to_i64(s.frame_nanos / 1000),
                rows_with_cells: to_i64(s.rows_with_cells),
                rows_reused: to_i64(s.rows_reused),
            })
        })
    }

    /// Writes the ASCII byte `byte` straight to the terminal's PTY and resolves with the time
    /// until the PTY echoed it back, in microseconds: the baseline of the echo budget.
    #[napi(ts_return_type = "Promise<number>", catch_unwind)]
    pub fn terminal_probe_echo<'env>(
        &self,
        env: &'env Env,
        id: u32,
        byte: u32,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<f64> + Send>;
        let (deferred, promise) = env.create_deferred::<f64, Settle>()?;
        boundary::call(env, "CoreRuntime.terminalProbeEcho", || {
            let byte = u8::try_from(byte)
                .ok()
                .filter(u8::is_ascii_graphic)
                .ok_or_else(|| piarc_core::Error::InvalidArgument {
                    field: "byte",
                    reason: "must be a printable ASCII character code".into(),
                })?;
            self.core.terminal_probe_echo(id, byte, move |elapsed| {
                deferred.resolve(Box::new(move |env| match elapsed {
                    Ok(elapsed) => Ok(elapsed.as_secs_f64() * 1e6),
                    Err(error) => Err(boundary::js_error(&env, &error.to_error_object())),
                }));
            })
        })?;
        Ok(promise)
    }
}

/// What `agentHostProbe` runs (S6, T12): see `piarc_core::host_probe`.
#[napi(object, object_to_js = false)]
pub struct AgentHostProbeOptions {
    /// The app's resources directory (`process.resourcesPath`).
    pub resources_dir: String,
    /// Workspace root (absolute, existing).
    pub workspace: String,
    /// Data directory for the Agent Host (absolute, existing; `pi/models.json` inside).
    pub data_dir: String,
    /// Provider id of the session's model.
    pub provider: String,
    /// Model id.
    pub model: String,
    /// The prompt.
    pub prompt: String,
    /// Upper bound of the conversation in milliseconds. Default 60,000.
    pub timeout_ms: Option<u32>,
}

#[napi]
impl CoreRuntime {
    /// Starts the packaged app's Agent Host as production does, runs one conversation and
    /// resolves with the report as JSON (`piarc_core::host_probe::ProbeReport`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn agent_host_probe<'env>(
        &self,
        env: &'env Env,
        options: AgentHostProbeOptions,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.agentHostProbe", || {
            let options = piarc_core::host_probe::ProbeOptions {
                resources_dir: options.resources_dir.into(),
                workspace: options.workspace.into(),
                data_dir: options.data_dir.into(),
                model: piarc_protocol::session::ModelRef {
                    provider: options.provider,
                    id: options.model,
                },
                prompt: options.prompt,
                timeout: std::time::Duration::from_millis(u64::from(
                    options.timeout_ms.unwrap_or(60_000),
                )),
            };
            self.core.run_agent_host_probe(options, move |report| {
                deferred.resolve(Box::new(move |env| match report {
                    Ok(report) => serde_json::to_string(&report).map_err(|e| {
                        napi::Error::from_reason(format!("cannot serialize the report: {e}"))
                    }),
                    Err(error) => Err(boundary::js_error(&env, &error.to_error_object())),
                }));
            })
        })?;
        Ok(promise)
    }
}

#[napi]
impl CoreRuntime {
    /// The keychain half of the S6 checklist (`piarc_core::keychain_probe`): `action` is
    /// `write`, `read` or `delete`, `dir` the probe vault's directory. Resolves with the report
    /// as JSON; it may wait while macOS asks the user for keychain access.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn keychain_probe<'env>(
        &self,
        env: &'env Env,
        action: String,
        dir: String,
    ) -> napi::Result<Object<'env>> {
        type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, "CoreRuntime.keychainProbe", || {
            let action = piarc_core::keychain_probe::KeychainProbeAction::parse(&action)
                .ok_or_else(|| piarc_core::Error::InvalidArgument {
                    field: "action",
                    reason: format!("expected write, read or delete, got {action:?}"),
                })?;
            self.core
                .run_keychain_probe(action, dir.into(), move |report| {
                    deferred.resolve(Box::new(move |_env| {
                        serde_json::to_string(&report).map_err(|e| {
                            napi::Error::from_reason(format!("cannot serialize the report: {e}"))
                        })
                    }));
                })
        })?;
        Ok(promise)
    }
}
