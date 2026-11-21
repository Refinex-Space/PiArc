//! One event's run: every selected handler, then the merged decision.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::config::Handler;
use crate::decision::Decision;
use crate::event::HookEvent;
use crate::output::Outcome;
use crate::runner::Runner;

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
