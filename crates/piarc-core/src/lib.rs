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
//! `piarc-exec` process spawner and the system clock. Session orchestration on top of it
//! (routing its notifications into the event path, answering `trust/get` from the trust
//! store) arrives with T13 and T14.

pub mod agent_host;
pub mod demo;
mod error;
pub mod events;
pub mod route;
mod runtime;

pub use demo::{DemoReport, DemoSourceConfig};
pub use error::{Error, Result};
pub use events::{DeliveryDone, EventBatch, EventSink, EventStats, SinkClosed};
pub use route::RouteKey;
pub use runtime::{
    CoreConfig, CoreRuntime, MAX_COALESCE_INTERVAL, MAX_ECHO_BYTES, MIN_COALESCE_INTERVAL,
    RuntimeState,
};
