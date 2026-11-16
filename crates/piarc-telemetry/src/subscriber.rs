//! The process-wide tracing subscriber: Core's events to `core-<day>.log`, the Agent Host's
//! stderr (target `piarc_host::agent_host`) to `agent-host-<day>.log`, both in the data
//! directory's `logs/`.
//!
//! A process has one global subscriber. [`install`] sets it on first use and points it at a
//! directory; later calls (another `CoreRuntime` in the same process) switch the directory.
//! When something else already set a global subscriber (a test harness), PiArc's files are
//! not written and [`install`] says so.

use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tracing::Level;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{FilterFn, LevelFilter};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;

use crate::rotation::{Calendar, DailyLog, RETENTION_DAYS, SystemCalendar};

/// Target prefix of the Agent Host's stderr lines (`piarc-host`).
pub const AGENT_HOST_TARGET: &str = "piarc_host::agent_host";

/// File prefix of Core's log.
pub const CORE_PREFIX: &str = "core";

/// File prefix of the Agent Host log.
pub const AGENT_HOST_PREFIX: &str = "agent-host";

/// Whether [`install`] routes the global subscriber to the files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installed {
    /// PiArc's subscriber writes to the directory.
    Files,
    /// Another global subscriber was set first; nothing is written to the files.
    External,
}

#[derive(Default)]
struct Sinks {
    core: Option<Arc<DailyLog>>,
    agent_host: Option<Arc<DailyLog>>,
}

fn sinks() -> &'static Mutex<Sinks> {
    static SINKS: OnceLock<Mutex<Sinks>> = OnceLock::new();
    SINKS.get_or_init(Mutex::default)
}

/// Routes the process's logs to `<logs_dir>` with the system clock (see the module docs).
///
/// # Errors
///
/// The I/O error when the directory cannot be created or listed.
pub fn install(logs_dir: &Path) -> io::Result<Installed> {
    install_with(logs_dir, Arc::new(SystemCalendar))
}

/// As [`install`] with an injected clock.
///
/// # Errors
///
/// As [`install`].
pub fn install_with(logs_dir: &Path, calendar: Arc<dyn Calendar>) -> io::Result<Installed> {
    let core = Arc::new(DailyLog::open(
        logs_dir,
        CORE_PREFIX,
        Arc::clone(&calendar),
        RETENTION_DAYS,
    )?);
    let agent_host = Arc::new(DailyLog::open(
        logs_dir,
        AGENT_HOST_PREFIX,
        calendar,
        RETENTION_DAYS,
    )?);
    {
        let mut sinks = sinks().lock().unwrap_or_else(PoisonError::into_inner);
        sinks.core = Some(core);
        sinks.agent_host = Some(agent_host);
    }
    static INSTALLED: OnceLock<Installed> = OnceLock::new();
    Ok(*INSTALLED.get_or_init(|| {
        let is_host = |meta: &tracing::Metadata<'_>| meta.target().starts_with(AGENT_HOST_TARGET);
        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(Route(Stream::Core))
                    .with_filter(LevelFilter::from_level(Level::INFO))
                    .with_filter(FilterFn::new(move |meta| !is_host(meta))),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(Route(Stream::AgentHost))
                    .with_filter(LevelFilter::from_level(Level::INFO))
                    .with_filter(FilterFn::new(is_host)),
            );
        if tracing::subscriber::set_global_default(subscriber).is_ok() {
            Installed::Files
        } else {
            Installed::External
        }
    }))
}

/// Stops writing to the files (Core shut down); events are dropped until the next
/// [`install`].
pub fn detach() {
    let mut sinks = sinks().lock().unwrap_or_else(PoisonError::into_inner);
    *sinks = Sinks::default();
}

#[derive(Debug, Clone, Copy)]
enum Stream {
    Core,
    AgentHost,
}

#[derive(Debug, Clone, Copy)]
struct Route(Stream);

impl<'a> MakeWriter<'a> for Route {
    type Writer = EventWriter;

    fn make_writer(&'a self) -> EventWriter {
        let sinks = sinks().lock().unwrap_or_else(PoisonError::into_inner);
        let log = match self.0 {
            Stream::Core => sinks.core.clone(),
            Stream::AgentHost => sinks.agent_host.clone(),
        };
        EventWriter {
            log,
            buffer: Vec::new(),
        }
    }
}

/// Collects one formatted event and appends it as a whole when dropped, so lines of
/// concurrent events never interleave.
pub struct EventWriter {
    log: Option<Arc<DailyLog>>,
    buffer: Vec<u8>,
}

impl Write for EventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.log.is_some() {
            self.buffer.extend_from_slice(bytes);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for EventWriter {
    fn drop(&mut self) {
        if let Some(log) = &self.log
            && !self.buffer.is_empty()
        {
            // A log that cannot be written has nowhere to report to; stderr is the fallback.
            if let Err(error) = log.append(&self.buffer) {
                eprintln!("piarc: cannot write the log file: {error}");
            }
        }
    }
}
