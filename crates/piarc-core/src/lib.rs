//! piarc-core: runtime facade: workspace and session orchestration, event bus, incremental merging, background task registry.
//!
//! # Responsibilities
//!
//! - Runtime facade of PiArc Core: workspace and session orchestration, the event bus, incremental
//!   event merging and the background task registry.
//! - Owns the tokio runtime and the workspace and session actors.
//! - Composes the feature crates: it is the only place where they collaborate, and it injects the
//!   `ProcessSpawner` from `piarc-exec` into `piarc-host`, `piarc-hooks` and sandboxed command
//!   execution.
//!
//! # Not responsible for
//!
//! - The JavaScript binding surface (`piarc-napi`).
//! - Feature logic that belongs to a feature crate, such as permission decisions, hook execution or
//!   snapshot storage.
//!
//! # Allowed workspace dependencies
//!
//! The feature crates `piarc-host`, `piarc-policy`, `piarc-hooks`, `piarc-config`, `piarc-fs`,
//! `piarc-checkpoint`, `piarc-exec`, `piarc-term`, `piarc-sandbox`, `piarc-store`, `piarc-diff`,
//! `piarc-git`, `piarc-secrets`, `piarc-telemetry`, and the foundation crates `piarc-protocol` and
//! `piarc-ports`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Event path (T04)
//!
//! [`CoreRuntime::start`] starts the tokio runtime and the coalescer: events go through a
//! bounded queue, are merged per [`RouteKey`] about every 16 ms and reach the client through
//! an [`EventSink`] (the NAPI-RS `ThreadsafeFunction` in production). The rate limit,
//! backpressure policy and batch format are documented in [`events`]; the ordered shutdown
//! in the `runtime` module docs of [`CoreRuntime`]. Demo event sources ([`demo`]) exist for
//! tests and benchmarks only.
//!
//! # Agent Host (T06)
//!
//! [`agent_host::start`] supervises one workspace's Agent Host with the production I/O: the
//! `piarc-exec` process-tree spawner and the system clock. A packaged app starts it from its
//! own resources with [`agent_host::start_bundled`] (T12: bundled Node, `PI_PACKAGE_DIR`, minimal
//! environment, `sandbox-exec` with the permissive profile on macOS);
//! [`host_probe`] is that path's test entry. Session orchestration on top of it
//! (routing its notifications into the event path, answering `trust/get` from the trust
//! store) arrives with T13 and T14.
//!
//! # Delegated tool I/O (T07)
//!
//! [`tool_io::ToolIo`] answers the Agent Host's `fs/*` requests with `piarc-fs` and its
//! `exec/*` requests with `piarc-exec`, per registered session scope (ADR-0004).
//!
//! # Credentials (T08)
//!
//! [`secrets::SecretsService`] serves the `piarc-secrets` vault to every Agent Host
//! (`secrets/*`): lazy open with structured errors, change push (`secrets/changed`) and key
//! locks that serialize concurrent OAuth refreshes across Agent Hosts. The master key's
//! service name comes from the application identifier in [`identity`].
//!
//! # Release manifests (T12)
//!
//! [`release::verify_manifest`] and [`release::verify_file`] check a release's signed
//! manifest and each downloaded artefact before an update (ADR-0018 rule 4, ADR-0024); every
//! failure is a structured `releaseIntegrity` error and the caller refuses the update.
//!
//! # Terminals (T10, T33)
//!
//! [`CoreRuntime::create_terminal`], [`CoreRuntime::open_session_terminal`] and their siblings
//! run `piarc-term` sessions (ADR-0017): events on the route `term/<id>`, frames pulled with
//! [`CoreRuntime::terminal_frame`], reads, input and process trees ([`terminal`]); terminals
//! of a session are background tasks the model can read (ADR-0050).

pub mod agent_host;
pub mod checkpoints;
pub mod client_settings;
pub mod clock;
pub mod composer;
pub mod config_diagnostics;
pub mod demo;
pub mod dirs;
mod error;
pub mod events;
pub(crate) mod hooks;
pub mod host_probe;
pub mod identity;
pub mod keychain_probe;
pub mod providers;
pub mod release;
pub mod route;
mod runtime;
pub mod secrets;
pub mod sessions;
pub mod storage;
pub mod tasks;
pub mod terminal;
pub mod tool_io;
pub mod trust;
pub mod workspace_settings;

pub use demo::{DemoReport, DemoSourceConfig};
pub use dirs::DataDirs;
pub use error::{Error, Result};
pub use events::{DeliveryDone, EventBatch, EventSink, EventStats, SinkClosed};
pub use piarc_term::DefaultColors as TerminalColors;
pub use piarc_term::SessionStats as TerminalStats;
pub use piarc_term::vt::KeyAction;
pub use piarc_term::vt::MouseAction;
pub use route::RouteKey;
pub use runtime::{
    CoreConfig, CoreRuntime, MAX_COALESCE_INTERVAL, MAX_ECHO_BYTES, MIN_COALESCE_INTERVAL,
    RuntimeState, SecretStoreSetup,
};
pub use terminal::{KeyEvent, MouseEvent, TerminalOptions};
