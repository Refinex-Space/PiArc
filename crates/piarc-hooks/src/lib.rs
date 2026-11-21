//! piarc-hooks: hooks configuration parsing, matching, execution and decision merging.
//!
//! # Responsibilities
//!
//! - Parses the `hooks` of every settings layer into one [`HookConfig`] (event → matcher groups
//!   → `command`, `http` and `prompt` handlers), reports what PiArc does not run
//!   ([`Diagnostic`]) and selects the handlers of an event ([`HookConfig::select`]: [`Matcher`]
//!   rules, one run per handler defined in several files, `disableAllHooks`).
//! - Runs the selected handlers in parallel ([`Runner`]): commands with input JSON on stdin,
//!   exit code, stdout and stderr read concurrently and the whole process tree terminated
//!   through the injected port; `http` handlers through [`HttpPort`] under [`HttpRules`]
//!   (`allowedHttpHookUrls`, header variables); `prompt` handlers through [`JudgePort`]; one
//!   timeout ([`Timeouts`]) and cancellation for all.
//! - Reads each handler's result ([`Outcome`]) and merges one event's results into a
//!   [`Decision`] with Claude Code's semantics; bounds long output ([`spill`]).
//! - Defines the `Stop` continuation limit ([`STOP_CONTINUATION_LIMIT`]) and the audit record of
//!   one run ([`audit_detail`]).
//!
//! # Not responsible for
//!
//! - Process tree management: hook commands run through the `ProcessSpawner` injected by
//!   `piarc-core` (`piarc-exec`'s `ProcessTreeSpawner`), built by an injected [`Launcher`].
//! - The network and the model: `http` requests and `prompt` model calls go through the ports
//!   `piarc-core` implements (`piarc-web`, the Agent Host's auxiliary model channel).
//! - Permission rules, including a handler's `if` condition (`piarc-policy`, evaluated by
//!   `piarc-core`).
//! - Loading and merging settings files and project trust (`piarc-config`).
//! - Where the events happen and what is done with a decision (`piarc-core` and the Agent Host).
//!
//! # Allowed workspace dependencies
//!
//! Only the foundation crates `piarc-protocol` and `piarc-ports`. Collaboration with other feature
//! crates goes through `piarc-core`.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).

mod audit;
mod config;
mod decision;
mod error;
mod event;
mod http;
mod matcher;
mod output;
mod ports;
mod prompt;
mod run;
mod runner;
pub mod spill;

pub use audit::audit_detail;
pub use config::{
    Action, Command, Diagnostic, DiagnosticKind, Handler, HookConfig, Http, LayerHooks, Prompt,
    Shell, Source,
};
pub use decision::{Decision, Permission, RequestAnswer};
pub use error::Error;
pub use event::{ExitTwo, HandlerKind, HookEvent, LATER_EVENTS, PlainStdout, Timeouts};
pub use http::HttpRules;
pub use matcher::Matcher;
pub use output::{Kind, Outcome};
pub use ports::{HttpCall, HttpPort, HttpReply, JudgeCall, JudgePort, JudgeReply};
pub use prompt::fill as fill_prompt;
pub use run::{Ran, run};
pub use runner::{Detail, HandlerRun, Launcher, RunStatus, Runner, RunnerConfig};

/// How many times in a row `Stop` (and `SubagentStop`) hooks may continue a turn. The next
/// block is overridden, the turn ends and the user is told. The count restarts when the model
/// calls a tool (Claude Code's rule, architecture section 6.3.1).
pub const STOP_CONTINUATION_LIMIT: u32 = 8;
