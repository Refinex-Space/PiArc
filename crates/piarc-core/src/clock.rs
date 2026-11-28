//! Clocks for Core's own timers (the idle reclaim of Agent Hosts): the system clock in
//! production, [`ManualClock`] in tests, so nothing waits for real time (architecture section
//! 7.2).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use piarc_ports::{BoxFuture, Clock};
use tokio::sync::oneshot;

pub use crate::agent_host::SystemClock;

/// A clock that moves only when told to: a sleep ends once [`ManualClock::advance`] moves the
/// time past its deadline.
#[derive(Debug)]
pub struct ManualClock {
    base: Instant,
    state: Mutex<ManualState>,
}

#[derive(Debug, Default)]
struct ManualState {
    elapsed: Duration,
    sleepers: Vec<(Duration, oneshot::Sender<()>)>,
}

impl ManualClock {
    /// A clock at its start.
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            state: Mutex::default(),
        })
    }

    /// Moves the time forward by `by` and ends the sleeps that are due.
    pub fn advance(&self, by: Duration) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.elapsed += by;
        let now = state.elapsed;
        let (due, waiting) = std::mem::take(&mut state.sleepers)
            .into_iter()
            .partition(|(deadline, _)| *deadline <= now);
        state.sleepers = waiting;
        drop(state);
        for (_, wake) in due {
            // A sleeper that gave up (its future was dropped) has nothing to wake.
            let _ = wake.send(());
        }
    }

    /// Sleeps that have not ended yet.
    #[must_use]
    pub fn sleepers(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sleepers
            .iter()
            .filter(|(_, wake)| !wake.is_closed())
            .count()
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        self.base
            + self
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .elapsed
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let deadline = state.elapsed + duration;
            state.sleepers.push((deadline, tx));
        }
        Box::pin(async move {
            // The clock dropping the sender also ends the sleep.
            let _ = rx.await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sleeps_end_only_when_the_time_passes_their_deadline() {
        let clock = ManualClock::new();
        let short = clock.sleep(Duration::from_secs(10));
        let long = clock.sleep(Duration::from_secs(60));
        assert_eq!(clock.sleepers(), 2);
        clock.advance(Duration::from_secs(30));
        short.await;
        assert_eq!(clock.sleepers(), 1);
        clock.advance(Duration::from_secs(30));
        long.await;
        assert_eq!(clock.now() - clock.base, Duration::from_secs(60));
    }
}
