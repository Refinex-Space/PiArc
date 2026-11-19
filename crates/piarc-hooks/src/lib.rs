//! piarc-hooks: hooks configuration parsing, matching, execution and decision merging.
//!
//! # Responsibilities
//!
//! - Parses the `hooks` of every settings layer into one [`HookConfig`] (event → matcher groups
//!   → `command` handlers), reports what PiArc does not run ([`Diagnostic`]) and selects the
//!   handlers of an event ([`HookConfig::select`]: [`Matcher`] rules, one run per handler
//!   defined in several files, `disableAllHooks`).
//! - Runs the selected handlers in parallel ([`Runner`]): input JSON on stdin, exit code, stdout
//!   and stderr read concurrently, timeouts per event ([`Timeouts`]), cancellation, and
//!   termination of the whole process tree through the injected port.
//! - Reads each handler's result ([`Outcome`]) and merges one event's results into a
//!   [`Decision`] with Claude Code's semantics; bounds long output ([`spill`]).
//! - Defines the `Stop` continuation limit ([`STOP_CONTINUATION_LIMIT`]) and the audit record of
//!   one run ([`audit_detail`]).
//!
//! # Not responsible for
//!
//! - Process tree management: hook commands run through the `ProcessSpawner` injected by
//!   `piarc-core` (`piarc-exec`'s `ProcessTreeSpawner`), built by an injected [`Launcher`].
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

mod config;
mod decision;
mod event;
mod matcher;
mod output;
mod runner;
pub mod spill;

use std::path::Path;
use std::sync::Arc;

pub use config::{Diagnostic, DiagnosticKind, Handler, HookConfig, LayerHooks, Shell, Source};
pub use decision::{Decision, Permission, RequestAnswer};
pub use event::{ExitTwo, HookEvent, LATER_EVENTS, PlainStdout, Timeouts};
pub use matcher::Matcher;
pub use output::{Kind, Outcome};
pub use runner::{HandlerRun, Launcher, RunStatus, Runner, RunnerConfig};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// How many times in a row `Stop` hooks may continue a turn. The next block is overridden, the
/// turn ends and the user is told. The count restarts when the model calls a tool (Claude
/// Code's rule, architecture section 6.3.1).
pub const STOP_CONTINUATION_LIMIT: u32 = 8;

/// One event's run: each handler's outcome and the merged decision.
#[derive(Debug, Clone, Default)]
pub struct Ran {
    /// Each handler's outcome, in order.
    pub outcomes: Vec<Outcome>,
    /// The merged decision.
    pub decision: Decision,
}

/// Runs `handlers` of `event` with `input` in `cwd` and merges the results.
pub async fn run(
    runner: &Runner,
    event: HookEvent,
    handlers: &[Arc<Handler>],
    input: &Value,
    cwd: &Path,
    cancel: &CancellationToken,
) -> Ran {
    if handlers.is_empty() {
        return Ran::default();
    }
    let outcomes: Vec<Outcome> = runner
        .run(event, handlers, input, cwd, cancel)
        .await
        .into_iter()
        .map(|run| Outcome::read(event, run))
        .collect();
    let decision = Decision::merge(event, &outcomes);
    Ran { outcomes, decision }
}

/// The audit record of one handler's run. The command is recorded by its program name and a
/// SHA-256 digest: a command line can carry credentials.
#[must_use]
pub fn audit_detail(
    event: HookEvent,
    subject: Option<&str>,
    outcome: &Outcome,
    verdict: &str,
) -> Value {
    use sha2::{Digest, Sha256};
    let handler = &outcome.handler;
    let mut text = handler.command.clone();
    for arg in handler.args.iter().flatten() {
        text.push('\0');
        text.push_str(arg);
    }
    let digest: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let program: String = handler
        .command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .chars()
        .take(64)
        .collect();
    json!({
        "event": event.name(),
        "matcherValue": subject,
        "layer": handler.source.layer,
        "source": handler.source.file.as_ref().map(|f| f.display().to_string()),
        "pointer": handler.pointer,
        "program": program,
        "commandSha256": digest,
        "exitCode": outcome.exit_code,
        "durationMs": outcome.duration_ms,
        "timedOut": outcome.timed_out,
        "cancelled": outcome.cancelled,
        "decision": verdict,
    })
}
