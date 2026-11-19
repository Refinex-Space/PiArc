//! piarc-protocol: AHP and Core API data types, protocol versions and JSON Schema export.
//!
//! # Responsibilities
//!
//! - Defines the data types of the Agent Host Protocol (AHP) and of the Core API, and their
//!   version numbers ([`PROTOCOL_VERSION`], [`negotiate`]).
//! - Exports JSON Schema ([`export_schema`], via `schemars`); `packages/protocol` generates
//!   its TypeScript types from it, so this crate is the single source of those types
//!   (ADR-0009 rule 7, ADR-0014 rule 6).
//! - Registers every wire message for L1 contract tests ([`CONTRACTS`]).
//! - Provides the LF frame codec over byte buffers ([`FrameDecoder`], [`encode_frame`]), and
//!   the rule for cutting UTF-8 text sent in pieces ([`text`]).
//! - Defines the binary terminal frame format, a draft that T33 finalizes ([`term_frame`]):
//!   codec and the viewer model that the renderer mirrors in TypeScript.
//!
//! # Not responsible for
//!
//! - I/O, process supervision, heartbeats and backpressure (`piarc-host`): the codec only
//!   turns bytes into frames and back.
//! - Business logic: apart from the codec and [`negotiate`] it holds plain data types.
//!
//! # Allowed workspace dependencies
//!
//! None. This is a foundation crate: it must not depend on any other workspace crate.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Wire format
//!
//! - Transport: LF-delimited UTF-8 JSON ([`framing`]).
//! - Messages: JSON-RPC 2.0 requests, responses and notifications in both directions
//!   ([`jsonrpc`]). Batches are not supported: a JSON array is answered with an Invalid
//!   Request error (`-32600`, kind `invalidRequest`).
//! - Errors: the JSON-RPC error object with mandatory `data.kind` and `data.retryable`
//!   ([`rpc_error`]).
//! - Members are camelCase. Enum values are camelCase strings.
//! - Session notifications carry `sessionId`, `seq` and `ts` in `params`; ADR-0009's
//!   `type` is the JSON-RPC `method` and its `payload` is the rest of `params`
//!   ([`session`]).
//!
//! # Compatibility
//!
//! Versions are `major.minor` ([`ProtocolVersion`]). Peers with different majors refuse to
//! connect; peers with different minors connect and enable the intersection of their
//! capabilities.
//!
//! Within one major version:
//!
//! - New members must be optional. Receivers ignore members they do not know: no type uses
//!   `deny_unknown_fields`, and no exported schema sets `additionalProperties: false`.
//! - New methods, and new enum values on existing members, are only sent to a peer that
//!   enabled the capability introducing them; an older peer rejects unknown enum values.
//! - Removing or renaming a member, method or enum value, or making an optional member
//!   required, needs a new major version.

pub mod contract;
pub mod diff;
mod error;
pub mod exec;
pub mod framing;
pub mod fs;
pub mod handshake;
pub mod history;
pub mod hooks;
pub mod host;
pub mod input;
pub mod jsonrpc;
pub mod memory;
pub mod method;
pub mod models;
pub mod policy;
pub mod queue;
pub mod rpc_error;
mod schema;
pub mod secrets;
pub mod session;
pub mod term_frame;
pub mod text;
pub mod tool_call;
pub mod trust;
pub mod turn;
mod version;

pub use contract::{CONTRACTS, Contract, ContractKind, contract};
pub use error::{Error, Result};
pub use framing::{DEFAULT_MAX_FRAME_BYTES, FrameDecoder, MAX_NESTING, encode_frame};
pub use rpc_error::{ErrorData, ErrorKind, ErrorObject};
pub use schema::{CONTRACTS_FILE, SCHEMA_FILE, export_schema};
pub use version::{Capability, PROTOCOL_VERSION, ProtocolVersion, negotiate};
