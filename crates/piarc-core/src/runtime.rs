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
use crate::sessions::{Hub, Op, SessionsConfig};
use crate::storage::{Storage, report_json};
use crate::terminal::{KeyEvent, TerminalOptions, Terminals};
use crate::tool_io::{ToolIo, ToolIoConfig};
use crate::trust::{TrustService, TrustView};
use crate::workspace_settings::WorkspaceSettings;

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
    /// Where shell commands get their environment; the user's login shell of Core's own
    /// environment when absent (T17). Tests pass a fixed or prepared environment.
    pub command_env: Option<crate::tool_io::CommandEnv>,
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
            Some(dirs) => Some(open_state(dirs, &config, &handle, &events, &cancel)?),
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

    /// Starts a terminal (ADR-0017) and returns its id. Its title, bell and exit events
    /// arrive on the route `term/<id>`; frames are pulled with
    /// [`terminal_frame`](Self::terminal_frame).
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a bad size or a relative working directory;
    /// [`Error::Terminal`] when the program cannot start; [`Error::ShuttingDown`].
    pub fn create_terminal(&self, options: TerminalOptions) -> Result<u32> {
        self.ensure_running()?;
        self.shared.terminals.create(options)
    }

    /// Writes `bytes` to terminal `id` as they are (committed input-method text). Never
    /// blocks.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`], [`Error::Terminal`] once it is closed,
    /// [`Error::ShuttingDown`].
    pub fn terminal_write(&self, id: u32, bytes: Vec<u8>) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.write(id, bytes)
    }

    /// Encodes `key` with the terminal's current modes and writes it. Never blocks.
    ///
    /// # Errors
    ///
    /// As [`terminal_write`](Self::terminal_write).
    pub fn terminal_key(&self, id: u32, key: &KeyEvent) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.key(id, key)
    }

    /// Resizes terminal `id`. Never blocks.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a bad size, otherwise as
    /// [`terminal_write`](Self::terminal_write).
    pub fn terminal_resize(&self, id: u32, cols: u16, rows: u16, cell: (u32, u32)) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.resize(id, cols, rows, cell)
    }

    /// Encodes the next frame of terminal `id` for `viewer` (`full` asks for a RESET frame)
    /// on the blocking pool and calls `on_done` there with the bytes.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`], [`Error::ShuttingDown`]; encoding errors go to `on_done`.
    pub fn terminal_frame(
        &self,
        id: u32,
        viewer: u32,
        full: bool,
        on_done: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.frame(id, viewer, full, on_done)
    }

    /// Closes terminal `id`: kills its program and forgets it.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`], [`Error::ShuttingDown`].
    pub fn close_terminal(&self, id: u32) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.close(id)
    }

    /// The visible screen of terminal `id` as plain text (libghostty-vt's formatter), on the
    /// blocking pool. Only the `testing` build of piarc-napi exports it (T10 measurements).
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`], [`Error::ShuttingDown`].
    pub fn terminal_text(
        &self,
        id: u32,
        on_done: impl FnOnce(Result<String>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.text(id, on_done)
    }

    /// Counters of terminal `id`.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`].
    pub fn terminal_stats(&self, id: u32) -> Result<piarc_term::SessionStats> {
        self.shared.terminals.stats(id)
    }

    /// Measures the PTY's own echo time for `byte` (the baseline of the S7 echo budget), on
    /// the blocking pool. Only the `testing` build of piarc-napi exports it.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownTerminal`], [`Error::ShuttingDown`].
    pub fn terminal_probe_echo(
        &self,
        id: u32,
        byte: u8,
        on_done: impl FnOnce(Result<Duration>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        self.shared.terminals.probe_echo(id, byte, on_done)
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

    /// The database, when Core was started with a data directory.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`].
    pub fn storage(&self) -> Result<Storage> {
        self.services().map(|s| s.storage)
    }

    /// Project trust, when Core was started with a data directory. Its
    /// [`TrustService::trust_get`] answers the Agent Host's `trust/get`.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`].
    pub fn trust(&self) -> Result<TrustService> {
        self.services().map(|s| s.trust)
    }

    /// Loads the settings of `workspace` and keeps them current; changes arrive as events on
    /// the route `core/settings` ([`crate::workspace_settings`]).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`], or a watcher that cannot start.
    pub async fn open_settings(&self, workspace: PathBuf) -> Result<WorkspaceSettings> {
        self.ensure_running()?;
        let services = self.services()?;
        let dirs = services.storage.dirs().clone();
        let events = self.shared.events.clone();
        self.shared
            .handle
            .spawn(async move {
                WorkspaceSettings::open(&dirs, workspace, services.trust, events, true).await
            })
            .await
            .map_err(|e| Error::Internal {
                reason: format!("opening settings failed: {e}"),
            })?
    }

    /// The user's settings file as JSON (the client reads its preferences from it).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; reading errors go to `on_done`.
    pub fn user_settings(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.client_settings_job(on_done, crate::client_settings::read)
    }

    /// Writes one client preference (`pointer` under [`crate::client_settings::CLIENT_KEYS`];
    /// `None` removes it) and answers with the file's new content.
    ///
    /// # Errors
    ///
    /// As [`user_settings`](Self::user_settings).
    pub fn write_client_setting(
        &self,
        pointer: String,
        value: Option<serde_json::Value>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.client_settings_job(on_done, move |dir| {
            crate::client_settings::write(dir, &pointer, value)
        })
    }

    fn client_settings_job(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
        job: impl FnOnce(&std::path::Path) -> Result<serde_json::Value> + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let data = self.storage()?.dirs().data().to_owned();
        self.shared.handle.spawn(async move {
            let result = tokio::task::spawn_blocking(move || job(&data))
                .await
                .map_err(|e| Error::Internal {
                    reason: format!("a settings task failed: {e}"),
                });
            on_done(result.and_then(|r| r));
        });
        Ok(())
    }

    /// Rebuilds the session index from Pi's files (the "rebuild index" diagnostic action)
    /// and calls `on_done` with the report as JSON.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; the rebuild's errors go to
    /// `on_done`.
    pub fn rebuild_session_index(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.ensure_running()?;
        let storage = self.storage()?;
        self.shared.handle.spawn(async move {
            on_done(
                storage
                    .rebuild_session_index()
                    .await
                    .map(|r| report_json(&r)),
            );
        });
        Ok(())
    }

    /// The trust view of `path` (`decide`: `None` reads it, `Some(trusted)` records the user's
    /// decision first; [`revoke_trust`](Self::revoke_trust) forgets it), for the client.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`], [`Error::InvalidArgument`] for a
    /// relative path; lookup errors go to `on_done`.
    pub fn trust_view(
        &self,
        path: PathBuf,
        decide: Option<bool>,
        on_done: impl FnOnce(Result<TrustView>) + Send + 'static,
    ) -> Result<()> {
        let trust = self.trust_for(&path)?;
        let hub = self.services()?.sessions;
        self.shared.handle.spawn(async move {
            let result = match decide {
                None => trust.view(&path).await,
                Some(trusted) => trust.decide(&path, trusted).await,
            };
            if let (Some(_), Ok(view)) = (decide, &result) {
                hub.trust_changed(std::path::Path::new(&view.checkout))
                    .await;
            }
            on_done(result);
        });
        Ok(())
    }

    /// Revokes the trust decision of the project containing `path`; the open workspaces of the
    /// project restart their Agent Host without project resources before this answers.
    ///
    /// # Errors
    ///
    /// As [`trust_view`](Self::trust_view).
    pub fn revoke_trust(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<TrustView>) + Send + 'static,
    ) -> Result<()> {
        let trust = self.trust_for(&path)?;
        let hub = self.services()?.sessions;
        self.shared.handle.spawn(async move {
            let result = trust.revoke(&path).await;
            if let Ok(view) = &result {
                hub.trust_changed(std::path::Path::new(&view.checkout))
                    .await;
            }
            on_done(result);
        });
        Ok(())
    }

    /// Runs `job` on the session layer and calls `on_done` with its result from a runtime
    /// thread. Validation that needs no I/O happens in `job` too, but the call itself only
    /// queues the work: nothing here blocks the caller (architecture section 7.2).
    fn on_sessions<F, Fut>(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
        job: F,
    ) -> Result<()>
    where
        F: FnOnce(Hub) -> Fut + Send + 'static,
        Fut: Future<Output = Result<serde_json::Value>> + Send + 'static,
    {
        self.ensure_running()?;
        let hub = self.services()?.sessions;
        self.shared
            .handle
            .spawn(async move { on_done(job(hub).await) });
        Ok(())
    }

    /// Opens a workspace: starts its Agent Host at once and answers once it is ready (the
    /// workspace as in `core/workspaces`).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; the rest goes to `on_done`.
    pub fn open_workspace(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            let view = hub.open_workspace(path).await?;
            serde_json::to_value(view).map_err(encode_error)
        })
    }

    /// Closes a workspace: its sessions and its Agent Host.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn close_workspace(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.close_workspace(path).await?;
            Ok(serde_json::Value::Null)
        })
    }

    /// Creates a session in `workspace` (opened when needed), working in `cwd` (default: the
    /// workspace), optionally with a model.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn create_session(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<piarc_protocol::session::ModelRef>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.create_session_with_mode(workspace, cwd, model, None, on_done)
    }

    /// Creates a session with an explicit starting permission mode.
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn create_session_with_mode(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<piarc_protocol::session::ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.create_session(workspace, cwd, model, mode).await
        })
    }

    /// Answers the request identified by its session, revision and connection epoch.
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn answer_approval(
        &self,
        answer: piarc_protocol::policy::ApprovalAnswer,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.answer_approval(answer).await
        })
    }

    /// Reopens a session from the index and its file.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn resume_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.resume_session(id).await },
        )
    }

    /// Opens a copy of a session (up to `entry_id`) as a new session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn fork_session(
        &self,
        id: String,
        entry_id: Option<String>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.fork_session(id, entry_id).await
        })
    }

    /// Closes an open session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn close_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.close_session(id).await },
        )
    }

    /// Runs `op` (prompt, steer, follow-up, abort, a queue change, mark read) on an open
    /// session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn session_op(
        &self,
        id: String,
        op: Op,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            match op {
                Op::MarkRead => hub.mark_read(id).await?,
                // Open or not: the hub writes the index for sessions that are not open.
                Op::Prefs(change) => hub.set_prefs(id, change).await?,
                op => return hub.op(id, op).await,
            }
            Ok(serde_json::Value::Null)
        })
    }

    /// Deletes a session: closes it when open, then removes its Pi session file, its
    /// temporary directory and its index rows (architecture section 9.3). The client confirms
    /// first; Core does not ask.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn delete_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.delete_session(id).await?;
            Ok(serde_json::Value::Null)
        })
    }

    /// Items of a session's conversation: `start .. start + limit`, or the last `limit`.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn transcript_window(
        &self,
        id: String,
        start: Option<u64>,
        limit: u64,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.transcript_window(id, start, limit).await
        })
    }

    /// Stores an attachment for open session `id` and answers with its description (ADR-0030).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn store_attachment(
        &self,
        id: String,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.store_attachment(id, name, mime_type, bytes).await
        })
    }

    /// Searches the files below `root` for an `@` mention (ADR-0030).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn search_files(
        &self,
        search_id: String,
        root: PathBuf,
        query: String,
        limit: usize,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.search_files(search_id, root, query, limit).await
        })
    }

    /// Stops file search `search_id`; only queues.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn cancel_file_search(&self, search_id: &str) -> Result<()> {
        self.ensure_running()?;
        self.services()?.sessions.cancel_file_search(search_id);
        Ok(())
    }

    /// Sends the workspace and session list snapshots again (a client subscribed anew).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn resend_snapshots(&self) -> Result<()> {
        self.ensure_running()?;
        self.services()?.sessions.resend_snapshots();
        Ok(())
    }

    fn trust_for(&self, path: &std::path::Path) -> Result<TrustService> {
        self.ensure_running()?;
        if !path.is_absolute() {
            return Err(Error::InvalidArgument {
                field: "path",
                reason: "must be an absolute path".into(),
            });
        }
        self.trust()
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
        self.terminals.close_all();
        self.handle.block_on(async {
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
    let storage = Storage::open(dirs)?;
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
    let sessions = Hub::new(crate::sessions::Ctx {
        handle: handle.clone(),
        events: events.clone(),
        storage: storage.clone(),
        trust: trust.clone(),
        secrets,
        tool_io: ToolIo::with_notices(
            ToolIoConfig {
                observer: config.tool_observer.clone(),
                command_env: config
                    .command_env
                    .clone()
                    .unwrap_or_else(crate::tool_io::CommandEnv::login_shell),
                ..ToolIoConfig::new(data)
            },
            Some(events.clone()),
        )
        .policy_services(crate::tool_io::policy::Services {
            storage: storage.clone(),
            trust: trust.clone(),
            snapshots: snapshots.clone(),
        }),
        config: config.sessions.clone(),
        snapshots,
        cancel: cancel.child_token(),
        files: crate::composer::file_search::FileSearch::default(),
    });
    tracing::info!(target: "piarc_core", data = %storage.dirs().data().display(), "Core state opened");
    Ok(StateServices {
        storage,
        trust,
        sessions,
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
