//! The tool-batch gate: a [`ToolIoObserver`] that records every delegated request and checks
//! `expect.tool_batches` without timing.
//!
//! Requests of the calls in the next expected batch are held until every call of that batch
//! has made a request; then the whole batch is released together and the gate moves on.
//! Later requests of released calls (a tool's second request) pass at once. A request from a
//! call of a later batch while the current one is incomplete is a failure: those calls ran
//! together although they belong to different batches. The gate then releases everything so
//! the turn can finish and the report is written. Calls in no batch are not held.

use std::collections::BTreeSet;
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_core::tool_io::ToolIoObserver;
use piarc_ports::BoxFuture;
use tokio::sync::watch;

/// See the module documentation.
pub struct Gate {
    batches: Vec<BTreeSet<String>>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The batch being filled.
    current: usize,
    held: Vec<(String, watch::Sender<bool>)>,
    released: BTreeSet<String>,
    violation: Option<String>,
    /// Every request: `(tool call id, method)`.
    calls: Vec<(Option<String>, String)>,
}

impl Gate {
    /// A gate for `batches` (tool call ids); an empty list only records.
    #[must_use]
    pub fn new(batches: Vec<Vec<String>>) -> Self {
        Self {
            batches: batches
                .into_iter()
                .map(|batch| batch.into_iter().collect())
                .collect(),
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every request Core received: `(tool call id, method)`, in arrival order.
    #[must_use]
    pub fn calls(&self) -> Vec<(Option<String>, String)> {
        self.lock().calls.clone()
    }

    /// The tool batch assertions that failed.
    #[must_use]
    pub fn failures(&self) -> Vec<String> {
        let state = self.lock();
        if let Some(violation) = &state.violation {
            return vec![violation.clone()];
        }
        match self.batches.get(state.current) {
            Some(batch) => {
                let held: BTreeSet<&String> = state.held.iter().map(|(c, _)| c).collect();
                vec![format!(
                    "tool_batches[{}] never completed: expected {batch:?}, only {held:?} reached Core",
                    state.current
                )]
            }
            None => Vec::new(),
        }
    }

    fn batch_of(&self, call: &str) -> Option<usize> {
        self.batches.iter().position(|batch| batch.contains(call))
    }
}

fn release(state: &mut State) {
    for (call, open) in std::mem::take(&mut state.held) {
        open.send_replace(true);
        state.released.insert(call);
    }
}

impl ToolIoObserver for Gate {
    fn before(
        &self,
        _session_id: &str,
        method: &str,
        tool_call_id: Option<&str>,
    ) -> BoxFuture<'static, ()> {
        let pass: BoxFuture<'static, ()> = Box::pin(async {});
        let mut state = self.lock();
        state
            .calls
            .push((tool_call_id.map(str::to_owned), method.to_owned()));
        let Some(call) = tool_call_id else {
            return pass;
        };
        let Some(batch) = self.batch_of(call) else {
            return pass;
        };
        if state.violation.is_some() || state.released.contains(call) {
            return pass;
        }
        if batch != state.current {
            let held: BTreeSet<String> = state.held.iter().map(|(c, _)| c.clone()).collect();
            state.violation = Some(format!(
                "tool_batches: call `{call}` (batch {batch}) reached Core while batch {} {:?} was incomplete (held: {held:?})",
                state.current,
                self.batches[state.current.min(self.batches.len() - 1)]
            ));
            release(&mut state);
            return pass;
        }
        let (open, mut opened) = watch::channel(false);
        state.held.push((call.to_owned(), open));
        let held: BTreeSet<&str> = state.held.iter().map(|(c, _)| c.as_str()).collect();
        let complete = self.batches[batch]
            .iter()
            .all(|c| held.contains(c.as_str()));
        if complete {
            release(&mut state);
            state.current += 1;
        }
        Box::pin(async move {
            // The sender lives in `held` until it opens; a closed channel also lets the
            // request through.
            let _ = opened.wait_for(|open| *open).await;
        })
    }
}
