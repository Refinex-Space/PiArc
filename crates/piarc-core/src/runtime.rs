//! The Core runtime: a tokio multi-thread runtime started with [`CoreRuntime::start`], the
//! event path to the client and an ordered shutdown.
//!
//! # Shutdown order
//!
//! [`CoreRuntime::shutdown`] runs these steps on a dedicated thread, then calls back:
//!
//! 1. Stop accepting requests: the state becomes [`RuntimeState::ShuttingDown`] and every
//!    request fails with [`Error::ShuttingDown`].
//! 2. Stop the event sources: close every terminal, cancel the root [`CancellationToken`]
//!    (long tasks take child tokens of it) and wait for the demo sources to end.
//! 3. Flush the last batch: close the event queue, let the coalescer drain it, deliver the
//!    rest and wait for the client to finish with it (at most
//!    [`FINAL_DELIVERY_TIMEOUT`](crate::events::FINAL_DELIVERY_TIMEOUT)).
//! 4. Release the callback: the coalescer drops the [`EventSink`]. For the NAPI sink this
//!    releases the `ThreadsafeFunction`, which would otherwise keep Node's event loop alive.
//! 5. Shut the tokio runtime down and report [`RuntimeState::Stopped`].
//!
//! After step 4 the sink is never called again. Dropping a running `CoreRuntime` without
//! shutting it down cancels everything and stops the runtime in the background, without
//! the final flush.
//!
//! # Panics in tasks
//!
//! Tasks are spawned under a supervisor. A panic is not swallowed: it is printed to stderr
//! and reported as a structured error event on [`ERROR_ROUTE`](crate::route::ERROR_ROUTE).

mod mcp;
mod sessions;
mod state;
mod terminals;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::demo::{self, DemoReport, DemoSource, DemoSourceConfig};
use crate::dirs::DataDirs;
use crate::error::{Error, Result};
use crate::events::{
    self, DEFAULT_COALESCE_INTERVAL, DeliveryDone, Event, EventBatch, EventCounters, EventSender,
    EventSink, EventStats,
};
use crate::route::RouteKey;
use crate::secrets::{SecretsConfig, SecretsService};
use crate::sessions::{Hub, SessionsConfig};
use crate::storage::Storage;
use crate::terminal::Terminals;
use crate::tool_io::{ToolIo, ToolIoConfig};
use crate::trust::TrustService;

/// Shortest accepted coalescing interval.
pub const MIN_COALESCE_INTERVAL: Duration = Duration::from_millis(1);

/// Longest accepted coalescing interval.
pub const MAX_COALESCE_INTERVAL: Duration = Duration::from_secs(1);

/// Longest payload accepted by [`CoreRuntime::echo`], in bytes.
pub const MAX_ECHO_BYTES: usize = 64 * 1024;

/// How long the runtime waits for tasks that ignore cancellation before it detaches them.
const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

const RUNNING: u8 = 0;
const SHUTTING_DOWN: u8 = 1;
const STOPPED: u8 = 2;

/// Settings of the runtime.
#[derive(Clone)]
pub struct CoreConfig {
    /// How often the coalescer may deliver a batch.
    pub coalesce_interval: Duration,
    /// The data and cache directories (architecture section 9.1). Without them Core has no
    /// database, settings, trust, log files or sessions: only tests and benchmarks of the
    /// event path run that way.
    pub dirs: Option<DataDirs>,
    /// The session layer: how Agent Hosts start, the idle threshold and its clock (T14).
    pub sessions: SessionsConfig,
    /// The credential store of the vault's master key; the system credential store under the
    /// application's own name when absent. Tests use an in-memory store and a `piarc-test.` name.
    pub secret_store: Option<SecretStoreSetup>,
    /// Sees every delegated tool request first (tests only, T14-A06).
    pub tool_observer: Option<Arc<dyn crate::tool_io::ToolIoObserver>>,
    /// The user's home directory: Claude Code's user files are read from it
    /// (`~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude/rules/`,
    /// `~/.claude.json`). The process's home by default; tests inject a temporary one so they
    /// never read the machine's own files, `None` reads none of them.
    pub home: Option<PathBuf>,
    /// Where shell commands get their environment; the user's login shell of Core's own
    /// environment when absent (T17). Tests pass a fixed or prepared environment.
    pub command_env: Option<crate::tool_io::CommandEnv>,
    /// Hook timeouts and limits (architecture section 6.3.1); tests shorten them.
    pub hooks: piarc_hooks::RunnerConfig,
    /// Snapshot retention and its clock (architecture section 9.3, T28); tests move the clock.
    pub checkpoints: crate::checkpoints::CheckpointConfig,
    /// WebFetch's limits and the hosts it may reach although not public (T29); tests admit
    /// their local HTTP servers.
    pub web: crate::tool_io::WebConfig,
    /// Background tasks' thresholds and timer clock (T32); tests move the clock.
    pub tasks: crate::tasks::TasksConfig,
    /// Worktree retention and its clocks (T35); tests move them.
    pub worktrees: crate::worktrees::WorktreeConfig,
    /// The Bash sandbox's platform, proxy network, enterprise values and approval timeout
    /// (T39); tests point the proxy at local servers and stand in for the enterprise.
    pub sandbox: crate::tool_io::SandboxConfig,
}

/// A credential store for the vault's master key and the key's name in it.
#[derive(Clone)]
pub struct SecretStoreSetup {
    /// Where the master key lives.
    pub master_key: piarc_ports::SecretName,
    /// The store.
    pub store: Arc<dyn piarc_ports::SecretStore>,
}

impl std::fmt::Debug for CoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreConfig")
            .field("coalesce_interval", &self.coalesce_interval)
            .field("dirs", &self.dirs)
            .field("sessions", &self.sessions)
            .finish_non_exhaustive()
    }
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            coalesce_interval: DEFAULT_COALESCE_INTERVAL,
            dirs: None,
            sessions: SessionsConfig::default(),
            secret_store: None,
            tool_observer: None,
            command_env: None,
            home: std::env::home_dir(),
            hooks: piarc_hooks::RunnerConfig::default(),
            checkpoints: crate::checkpoints::CheckpointConfig::default(),
            web: crate::tool_io::WebConfig::default(),
            tasks: crate::tasks::TasksConfig::default(),
            worktrees: crate::worktrees::WorktreeConfig::default(),
            sandbox: crate::tool_io::SandboxConfig::default(),
        }
    }
}

impl CoreConfig {
    /// Checks the limits.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] when the interval is outside
    /// [`MIN_COALESCE_INTERVAL`]..=[`MAX_COALESCE_INTERVAL`].
    pub fn validate(&self) -> Result<()> {
        if (MIN_COALESCE_INTERVAL..=MAX_COALESCE_INTERVAL).contains(&self.coalesce_interval) {
            Ok(())
        } else {
            Err(Error::InvalidArgument {
                field: "coalesceIntervalMs",
                reason: format!(
                    "must be between {} and {} ms",
                    MIN_COALESCE_INTERVAL.as_millis(),
                    MAX_COALESCE_INTERVAL.as_millis()
                ),
            })
        }
    }
}

/// Lifecycle state of a [`CoreRuntime`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeState {
    /// Accepting requests.
    Running,
    /// [`CoreRuntime::shutdown`] was called; requests are refused.
    ShuttingDown,
    /// Shutdown finished: the sink is released and the runtime threads are gone.
    Stopped,
}

/// The Core runtime. See the module documentation for the lifecycle.
pub struct CoreRuntime {
    shared: Arc<Shared>,
}

struct Shared {
    state: AtomicU8,
    handle: Handle,
    runtime: Mutex<Option<Runtime>>,
    events: EventSender,
    counters: Arc<EventCounters>,
    cancel: CancellationToken,
    close_events: CancellationToken,
    coalescer: Mutex<Option<JoinHandle<()>>>,
    demo: Mutex<DemoRegistry>,
    terminals: Terminals,
    state_dirs: Option<StateServices>,
    waiters: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

/// The services that need the data directory.
#[derive(Clone)]
struct StateServices {
    storage: Storage,
    trust: TrustService,
    sessions: Hub,
}

#[derive(Default)]
struct DemoRegistry {
    next_id: u32,
    sources: HashMap<u32, DemoSource>,
}

/// Locks `mutex`, recovering the data if a panicking thread poisoned it. Every critical
/// section here leaves the data consistent, so a poisoned lock carries no broken state.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CoreRuntime {
    /// Starts the tokio runtime and the event coalescer that delivers batches to `sink`.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for an invalid `config`; [`Error::RuntimeStart`] when the
    /// tokio runtime cannot be created.
    pub fn start(config: CoreConfig, sink: Arc<dyn EventSink>) -> Result<Self> {
        config.validate()?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .thread_name("piarc-core")
            // I/O: the Agent Host's pipes, the sandbox proxy and child processes (T12).
            .enable_io()
            .enable_time()
            .build()
            .map_err(|error| Error::RuntimeStart {
                reason: error.to_string(),
            })?;
        let handle = runtime.handle().clone();
        let close_events = CancellationToken::new();
        let (events, coalescer, counters) = events::channel(
            config.coalesce_interval,
            Arc::clone(&sink),
            close_events.clone(),
        );
        let coalescer_task = handle.spawn(coalescer.run());
        let supervisor = handle.spawn(async move {
            if let Err(error) = coalescer_task.await
                && error.is_panic()
            {
                report_coalescer_panic(sink.as_ref(), &*error.into_panic());
            }
        });
        let terminals = Terminals::new(handle.clone(), events.clone());
        let cancel = CancellationToken::new();
        let state_dirs = match config.dirs.clone() {
            Some(dirs) => Some(open_state(
                dirs, &config, &handle, &events, &cancel, &terminals,
            )?),
            None => None,
        };
        let core = Self {
            shared: Arc::new(Shared {
                state: AtomicU8::new(RUNNING),
                handle,
                runtime: Mutex::new(Some(runtime)),
                events,
                counters,
                cancel,
                close_events,
                coalescer: Mutex::new(Some(supervisor)),
                demo: Mutex::new(DemoRegistry::default()),
                terminals,
                state_dirs,
                waiters: Mutex::new(Vec::new()),
            }),
        };
        if let Some(services) = core.shared.state_dirs.clone() {
            // Catch the index up with session files written while the app was closed.
            spawn_supervised(
                &core.shared.handle,
                &core.shared.events,
                "session index sync",
                async move {
                    if let Err(error) = services.storage.sync_sessions().await {
                        tracing::error!(target: "piarc_core::storage", "syncing the session index failed: {error}");
                    }
                    // The first session snapshot was read before the sync finished.
                    services.sessions.reload_snapshots();
                },
            );
        }
        Ok(core)
    }

    /// The current lifecycle state.
    #[must_use]
    pub fn state(&self) -> RuntimeState {
        match self.shared.state.load(Ordering::Acquire) {
            RUNNING => RuntimeState::Running,
            SHUTTING_DOWN => RuntimeState::ShuttingDown,
            _ => RuntimeState::Stopped,
        }
    }

    /// Counters of the event path.
    #[must_use]
    pub fn event_stats(&self) -> EventStats {
        self.shared.counters.snapshot()
    }

    /// Validates `route` and `payload` and queues the event `{"echo": payload}` without
    /// waiting: the lightweight synchronous call used to measure the NAPI call cost. No
    /// I/O, no lock that is held for long.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for an invalid route or a payload over
    /// [`MAX_ECHO_BYTES`]; [`Error::QueueFull`] when the queue is full;
    /// [`Error::ShuttingDown`] after shutdown started.
    pub fn echo(&self, route: &str, payload: &str) -> Result<()> {
        self.ensure_running()?;
        let route = RouteKey::parse(route)?;
        if payload.len() > MAX_ECHO_BYTES {
            return Err(Error::InvalidArgument {
                field: "payload",
                reason: format!("must be at most {MAX_ECHO_BYTES} bytes"),
            });
        }
        #[derive(serde::Serialize)]
        struct Echo<'a> {
            echo: &'a str,
        }
        let event = Event::from_json(route, &Echo { echo: payload })?;
        self.shared.events.try_send(event)
    }

    /// Starts a demo event source and returns its id.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for an invalid config; [`Error::ShuttingDown`] after
    /// shutdown started.
    pub fn start_demo_source(&self, config: DemoSourceConfig) -> Result<u32> {
        config.validate()?;
        self.ensure_running()?;
        let mut registry = lock(&self.shared.demo);
        registry.next_id += 1;
        let id = registry.next_id;
        let cancel = self.shared.cancel.child_token();
        let task = spawn_supervised(
            &self.shared.handle,
            &self.shared.events,
            "demo event source",
            demo::run(id, config, self.shared.events.clone(), cancel.clone()),
        );
        registry.sources.insert(id, DemoSource { cancel, task });
        Ok(id)
    }

    /// Stops demo source `id` (or collects it after it reached its event limit) and calls
    /// `on_stopped` with its report from a runtime thread once it has ended.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownDemoSource`] when no running or finished source has that id;
    /// [`Error::ShuttingDown`] after shutdown started (shutdown stops every source).
    pub fn stop_demo_source(
        &self,
        id: u32,
        on_stopped: impl FnOnce(Result<DemoReport>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let source = lock(&self.shared.demo)
            .sources
            .remove(&id)
            .ok_or(Error::UnknownDemoSource { id })?;
        source.cancel.cancel();
        self.shared.handle.spawn(async move {
            let report = match source.task.await {
                Ok(Some(report)) => Ok(report),
                Ok(None) => Err(Error::Internal {
                    reason: format!("demo event source {id} panicked"),
                }),
                Err(error) => Err(Error::Internal {
                    reason: format!("demo event source {id} did not finish: {error}"),
                }),
            };
            on_stopped(report);
        });
        Ok(())
    }

    /// Runs [`crate::host_probe::run`] on the runtime: one mock conversation with the Agent
    /// Host of a packaged app. Only the `testing` build of piarc-napi exports it (S6).
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`] after shutdown started; the probe's own errors reach `on_done`.
    pub fn run_agent_host_probe(
        &self,
        options: crate::host_probe::ProbeOptions,
        on_done: impl FnOnce(Result<crate::host_probe::ProbeReport>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.handle.spawn(async move {
            on_done(crate::host_probe::run(options).await);
        });
        Ok(())
    }

    /// Runs [`crate::keychain_probe::run`] on the blocking pool (it may wait for the user to
    /// answer a keychain dialog). Only the `testing` build of piarc-napi exports it (S6).
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`] after shutdown started.
    pub fn run_keychain_probe(
        &self,
        action: crate::keychain_probe::KeychainProbeAction,
        dir: std::path::PathBuf,
        on_done: impl FnOnce(crate::keychain_probe::KeychainProbeReport) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.handle.spawn_blocking(move || {
            on_done(crate::keychain_probe::run(action, &dir));
        });
        Ok(())
    }

    /// Spawns a supervised task that panics, to test that task panics become error events.
    /// Only the `testing` build of piarc-napi exports it.
    ///
    /// # Errors
    ///
    /// [`Error::ShuttingDown`] after shutdown started.
    pub fn spawn_panicking_task(&self) -> Result<()> {
        self.ensure_running()?;
        spawn_supervised(
            &self.shared.handle,
            &self.shared.events,
            "test task",
            async { panic!("panic requested by a test") },
        );
        Ok(())
    }

    fn services(&self) -> Result<StateServices> {
        self.shared.state_dirs.clone().ok_or(Error::NoDataDirectory)
    }

    /// Starts the ordered shutdown described in the module documentation on a dedicated
    /// thread and returns at once. `on_stopped` runs once the runtime has stopped; it runs
    /// immediately when that already happened, and every caller's callback runs when
    /// several calls overlap.
    ///
    /// # Errors
    ///
    /// [`Error::Internal`] when the shutdown thread cannot be spawned; the runtime is then
    /// left shutting down and `on_stopped` is dropped without running.
    pub fn shutdown(&self, on_stopped: impl FnOnce() + Send + 'static) -> Result<()> {
        let first = self
            .shared
            .state
            .compare_exchange(RUNNING, SHUTTING_DOWN, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        {
            let mut waiters = lock(&self.shared.waiters);
            if self.shared.state.load(Ordering::Acquire) != STOPPED {
                waiters.push(Box::new(on_stopped));
                if !first {
                    return Ok(());
                }
            } else {
                drop(waiters);
                on_stopped();
                return Ok(());
            }
        }
        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .name("piarc-core-shutdown".to_owned())
            .spawn(move || shared.run_shutdown())
            .map(|_| ())
            .map_err(|error| Error::Internal {
                reason: format!("failed to spawn the shutdown thread: {error}"),
            })
    }

    /// [`shutdown`](Self::shutdown) and wait for it. Must not be called from a runtime
    /// thread or from the thread the sink delivers on (the final delivery would wait for
    /// it).
    ///
    /// # Errors
    ///
    /// As [`shutdown`](Self::shutdown).
    pub fn shutdown_blocking(&self) -> Result<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.shutdown(move || {
            // The receiver below is alive until the message arrives.
            let _ = tx.send(());
        })?;
        rx.recv().map_err(|_| Error::Internal {
            reason: "the shutdown thread ended without reporting".to_owned(),
        })
    }

    fn ensure_running(&self) -> Result<()> {
        if self.shared.state.load(Ordering::Acquire) == RUNNING {
            Ok(())
        } else {
            Err(Error::ShuttingDown)
        }
    }
}

impl Shared {
    fn run_shutdown(&self) {
        let sources: Vec<DemoSource> = lock(&self.demo).sources.drain().map(|(_, s)| s).collect();
        let coalescer = lock(&self.coalescer).take();
        self.handle.block_on(async {
            // Terminals first: their tasks stop as interrupted and their snapshots are saved
            // while the database and the task manager still run.
            self.terminals.shutdown().await;
            // Agent Hosts first: they flush their sessions and may still send notifications.
            if let Some(services) = &self.state_dirs {
                services.sessions.shutdown().await;
            }
            self.cancel.cancel();
            for source in sources {
                // A source that panicked was already reported by its supervisor.
                let _ = source.task.await;
            }
            self.close_events.cancel();
            if let Some(coalescer) = coalescer {
                // The supervisor reports a coalescer panic itself and never panics.
                let _ = coalescer.await;
            }
        });
        if let Some(runtime) = lock(&self.runtime).take() {
            runtime.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);
        }
        if let Some(services) = &self.state_dirs {
            // Release every file in the data directory, which may go away with this Core: the
            // JavaScript object holding this Core lives until it is collected (I66).
            services.storage.close();
            piarc_telemetry::detach();
        }
        let waiters = {
            let mut waiters = lock(&self.waiters);
            self.state.store(STOPPED, Ordering::Release);
            std::mem::take(&mut *waiters)
        };
        for waiter in waiters {
            waiter();
        }
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // Only reached without a completed shutdown: the shutdown thread holds a reference
        // until it is done.
        let runtime = self
            .runtime
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(runtime) = runtime {
            self.cancel.cancel();
            self.close_events.cancel();
            runtime.shutdown_background();
        }
    }
}

/// Creates the data directory layout, routes the logs to `logs/`, opens the database and starts
/// the session layer.
fn open_state(
    dirs: DataDirs,
    config: &CoreConfig,
    handle: &Handle,
    events: &EventSender,
    cancel: &CancellationToken,
    terminals: &Terminals,
) -> Result<StateServices> {
    let io = |what: &str, error: std::io::Error| Error::Feature {
        kind: piarc_protocol::ErrorKind::IoError,
        retryable: false,
        message: format!("{what}: {error}"),
        details: None,
    };
    dirs.create_layout()
        .map_err(|e| io("cannot create the data directory", e))?;
    match piarc_telemetry::install(&dirs.logs()) {
        Ok(piarc_telemetry::Installed::Files) => {}
        Ok(piarc_telemetry::Installed::External) => {
            tracing::info!(target: "piarc_core", "another log subscriber is installed; log files are not written");
        }
        Err(error) => return Err(io("cannot open the log directory", error)),
    }
    let storage = Storage::open(dirs.with_home(config.home.clone()))?;
    let trust = TrustService::new(storage.clone());
    let data = storage.dirs().data().to_owned();
    let secrets = match &config.secret_store {
        Some(setup) => SecretsService::new(
            SecretsConfig::with_master_key(&data, setup.master_key.clone()),
            Arc::clone(&setup.store),
        ),
        None => SecretsService::new(SecretsConfig::new(&data), crate::secrets::system_store()),
    };
    let snapshots = crate::sessions::Snapshots::spawn(handle, events.clone(), storage.clone());
    let checkpoints =
        crate::checkpoints::Checkpoints::open(storage.clone(), config.checkpoints.clone())?;
    checkpoints.spawn_sweeper(handle, config.sessions.clock.clone(), cancel.child_token());
    let tasks = crate::tasks::TaskManager::new(config.tasks.clone());
    let tool_io = state_tool_io(config, data.clone(), events, &storage, &trust, &snapshots)
        .with_checkpoints(checkpoints)
        .with_tasks(tasks.clone())
        .with_terminals(terminals.clone())
        .with_secrets(secrets.clone());
    let worktrees = crate::worktrees::Worktrees::new(
        storage.clone(),
        tool_io.clone(),
        config.worktrees.clone(),
    );
    {
        let snapshots = snapshots.clone();
        worktrees.spawn_sweeper(handle, cancel.child_token(), move || {
            snapshots.send(crate::sessions::SnapshotMsg::Reload);
        });
    }
    let sessions = Hub::new(crate::sessions::Ctx {
        handle: handle.clone(),
        events: events.clone(),
        storage: storage.clone(),
        trust: trust.clone(),
        secrets,
        catalog_network: Arc::new(std::sync::atomic::AtomicBool::new(
            crate::providers::network_preference(&data, config.secret_store.is_none()),
        )),
        model_preferences: Arc::new(std::sync::Mutex::new(crate::providers::preferences(&data))),
        logins: Arc::default(),
        provider_writer: tokio::sync::Mutex::new(()),
        tool_io,
        config: config.sessions.clone(),
        snapshots,
        cancel: cancel.child_token(),
        files: crate::composer::file_search::FileSearch::default(),
        worktrees,
    });
    tasks.set_outlet(sessions.task_outlet());
    sessions.connect_hooks();
    terminals.attach(data, tasks.clone());
    {
        let _entered = handle.enter();
        tasks.start(storage.clone(), events.clone(), cancel.child_token());
    }
    tracing::info!(target: "piarc_core", data = %storage.dirs().data().display(), "Core state opened");
    Ok(StateServices {
        storage,
        trust,
        sessions,
    })
}

/// The tool I/O of Core's state: commands with the login shell's environment, policy, hooks.
fn state_tool_io(
    config: &CoreConfig,
    data: PathBuf,
    events: &EventSender,
    storage: &Storage,
    trust: &TrustService,
    snapshots: &crate::sessions::Snapshots,
) -> ToolIo {
    ToolIo::with_notices(
        ToolIoConfig {
            observer: config.tool_observer.clone(),
            home: config.home.clone(),
            command_env: config
                .command_env
                .clone()
                .unwrap_or_else(crate::tool_io::CommandEnv::login_shell),
            clock: config.sessions.clock.clone(),
            web: config.web.clone(),
            sandbox: config.sandbox.clone(),
            ..ToolIoConfig::new(data)
        },
        Some(events.clone()),
    )
    .policy_services(crate::tool_io::policy::Services {
        storage: storage.clone(),
        trust: trust.clone(),
        snapshots: snapshots.clone(),
        hooks: Some(crate::hooks::HooksService::new(
            storage.clone(),
            trust.clone(),
            Some(events.clone()),
            Arc::new(piarc_exec::ProcessTreeSpawner),
            config.hooks,
            crate::tool_io::hook_condition,
        )),
    })
}

fn encode_error(error: serde_json::Error) -> Error {
    Error::Internal {
        reason: format!("cannot encode the result: {error}"),
    }
}

/// Spawns `future` and a supervisor that reports a panic as an error event. The returned
/// handle yields `None` when the task panicked or was cancelled.
fn spawn_supervised<F>(
    handle: &Handle,
    events: &EventSender,
    name: &'static str,
    future: F,
) -> JoinHandle<Option<F::Output>>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let task = handle.spawn(future);
    let events = events.clone();
    handle.spawn(async move {
        match task.await {
            Ok(value) => Some(value),
            Err(error) => {
                if error.is_panic() {
                    let error = Error::from_panic(name, &*error.into_panic());
                    report_task_panic(&events, error).await;
                }
                None
            }
        }
    })
}

async fn report_task_panic(events: &EventSender, error: Error) {
    eprintln!("[piarc-core] {error}");
    let sent = match Event::from_json(RouteKey::errors(), &error.to_error_object()) {
        Ok(event) => events.send(event).await,
        Err(serialize) => Err(serialize),
    };
    if let Err(not_sent) = sent {
        eprintln!("[piarc-core] could not queue the error event: {not_sent}");
    }
}

/// The coalescer cannot report its own panic through itself: deliver one out-of-band batch
/// (sequence 0) straight to the sink.
fn report_coalescer_panic(sink: &dyn EventSink, payload: &(dyn std::any::Any + Send)) {
    let error = Error::from_panic("event coalescer", payload);
    eprintln!("[piarc-core] {error}; no further events will be delivered");
    let Ok(json) = serde_json::to_vec(&error.to_error_object()) else {
        return;
    };
    let mut payload = Vec::with_capacity(json.len() + 2);
    payload.push(b'[');
    payload.extend_from_slice(&json);
    payload.push(b']');
    let batch = EventBatch {
        route: RouteKey::errors(),
        seq: 0,
        payload,
    };
    if sink.deliver(vec![batch], DeliveryDone::detached()).is_err() {
        eprintln!("[piarc-core] the event sink is closed; the coalescer panic was not delivered");
    }
}
