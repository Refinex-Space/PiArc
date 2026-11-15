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
