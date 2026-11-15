//! piarc-host: Agent Host supervision: launch, handshake, framing, backpressure, restart and call reconciliation.
//!
//! # Responsibilities
//!
//! - Supervises the Agent Host process: launch, AHP handshake, stdio I/O (with the frame codec
//!   from `piarc-protocol`), backpressure, restart and reconciliation of in-flight calls.
//!
//! # Not responsible for
//!
//! - Frame encoding and decoding, message types and version negotiation (`piarc-protocol`).
//! - Process tree management: it launches the Agent Host through the `ProcessSpawner` injected by
//!   `piarc-core`.
//! - Sandbox profile generation (`piarc-sandbox`).
//! - Pi integration logic, which lives in the TypeScript Agent Host (`agent-host/`).
//! - Answering the Agent Host's requests (`trust/get`, ...): an injected [`InboundHandler`]
//!   does.
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Supervision (architecture section 7.5, ADR-0009)
//!
//! [`HostSupervisor::start`] launches the Agent Host and keeps it running:
//!
//! - **Handshake**: waits [`HostConfig::handshake_timeout`] (10 s) for `host/hello`, negotiates
//!   the protocol version and answers `core/welcome` with an incremented `connectionEpoch`. A
//!   different major version is refused with `protocolVersionMismatch` and not restarted.
//! - **Reading**: stdout is decoded continuously. Responses go straight to their callers; the
//!   Agent Host's requests go to the [`InboundHandler`]; session notifications go to the event
//!   queue ([`HostConfig::event_queue`]). When the consumer is slow the reader waits, stops
//!   reading stdout, and the Agent Host's outbound queue absorbs the backpressure by merging
//!   text deltas. Invalid frames (bad JSON, too large, not JSON-RPC) are reported as
//!   [`HostEvent::FrameError`] and dropped; the connection continues.
//! - **Writing**: requests go through a bounded queue ([`HostConfig::write_queue_frames`]).
//!   When it is full, a call fails at once with the retryable [`Error::Busy`] instead of
//!   waiting or growing memory.
//! - **Heartbeat**: `host/ping` every [`HostConfig::heartbeat_interval`] (30 s). A ping that
//!   times out counts as a failure only if no frame arrived meanwhile and the reader is not
//!   waiting on the consumer; [`HostConfig::heartbeat_failures`] (2) consecutive failures kill
//!   the process as hung.
//! - **Restart**: after any unrequested exit, [`RestartPolicy`] backs off exponentially (1 s,
//!   2 s, 4 s, ...) and allows 5 restarts per 10 minutes; the next failure gives up
//!   ([`HostEvent::GaveUp`]). Time comes from the injected `Clock`. After a restart every
//!   session opened through the supervisor is reopened with `session/resume`.
//! - **Reconciliation**: the [`Ledger`] tracks each call as sent → (acknowledged →) terminal;
//!   when a connection ends its open calls become uncertain, are reported in
//!   [`HostEvent::Uncertain`] and are never replayed.
//! - **Logging**: every stderr line becomes a `tracing` event (target
//!   `piarc_host::agent_host`) with `workspace`, `session` (from a `[session <id>] ` prefix)
//!   and `epoch` fields.

mod config;
mod connection;
mod error;
mod events;
mod inbound;
mod ledger;
mod restart;
mod supervisor;

pub use config::{DEFAULT_ENV_PASSTHROUGH, HostConfig};
pub use error::{Error, Result};
pub use events::{ExitReason, HostEvent};
pub use inbound::{InboundHandler, NoInbound, SharedInbound};
pub use ledger::{CallRecord, CallState, Ledger};
pub use restart::{RestartConfig, RestartDecision, RestartPolicy};
pub use supervisor::{HostDeps, HostSupervisor, SupervisorState};
