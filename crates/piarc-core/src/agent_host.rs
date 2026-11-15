//! Agent Host supervision with production I/O (architecture section 7.5).
//!
//! `piarc-host` holds the supervision logic behind the `ProcessSpawner` and `Clock` ports;
//! this module injects the real ones: [`TokioProcessSpawner`] from `piarc-exec` and
//! [`SystemClock`]. It is also the headless entry the Agent Host tests drive.

use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_exec::TokioProcessSpawner;
use piarc_ports::{BoxFuture, Clock};
use tokio::sync::mpsc;

pub use piarc_host::{
    CallRecord, CallState, DEFAULT_ENV_PASSTHROUGH, Error, ExitReason, HostConfig, HostDeps,
    HostEvent, HostSupervisor, InboundHandler, NoInbound, RestartConfig, SharedInbound,
    SupervisorState,
};

/// The operating system's monotonic clock; sleeps on the tokio timer.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// Starts supervising the Agent Host described by `config` on the current tokio runtime.
/// `inbound` answers the Agent Host's requests (`trust/get`, ...).
#[must_use]
pub fn start(
    config: HostConfig,
    inbound: SharedInbound,
) -> (HostSupervisor, mpsc::Receiver<HostEvent>) {
    HostSupervisor::start(
        config,
        HostDeps {
            spawner: Arc::new(TokioProcessSpawner),
            clock: Arc::new(SystemClock),
            inbound,
        },
    )
}
