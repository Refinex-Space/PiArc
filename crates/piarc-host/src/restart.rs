//! When to restart a failed Agent Host: exponential backoff, at most `max_restarts` restarts
//! within a sliding `window` (architecture section 7.5: 5 restarts per 10 minutes).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Restart limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartConfig {
    /// Restarts allowed within `window`; the next failure gives up.
    pub max_restarts: u32,
    /// The sliding window restarts are counted in.
    pub window: Duration,
    /// Delay before the first restart in the window; doubles with each further one.
    pub initial_backoff: Duration,
    /// Upper bound of the delay.
    pub max_backoff: Duration,
}

impl Default for RestartConfig {
    fn default() -> Self {
        Self {
            max_restarts: 5,
            window: Duration::from_secs(10 * 60),
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
        }
    }
}

/// What to do after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Start again after `delay`. `attempt` counts the restarts in the window, from 1.
    Restart {
        /// The restart's number within the window.
        attempt: u32,
        /// How long to wait first.
        delay: Duration,
    },
    /// Stop: `restarts` restarts already happened within the window.
    GiveUp {
        /// Restarts within the window.
        restarts: u32,
    },
}

/// Counts restarts in the window. Pure: the caller passes the time.
#[derive(Debug, Clone)]
pub struct RestartPolicy {
    config: RestartConfig,
    restarts: VecDeque<Instant>,
}

impl RestartPolicy {
    /// A policy with no restarts recorded.
    #[must_use]
    pub fn new(config: RestartConfig) -> Self {
        Self {
            config,
            restarts: VecDeque::new(),
        }
    }

    /// Records a failure at `now` and decides.
    pub fn on_failure(&mut self, now: Instant) -> RestartDecision {
        if let Some(start) = now.checked_sub(self.config.window) {
            while self.restarts.front().is_some_and(|&at| at <= start) {
                self.restarts.pop_front();
            }
        }
        let recent = u32::try_from(self.restarts.len()).unwrap_or(u32::MAX);
        if recent >= self.config.max_restarts {
            return RestartDecision::GiveUp { restarts: recent };
        }
        let factor = 1_u32.checked_shl(recent).unwrap_or(u32::MAX);
        let delay = self
            .config
            .initial_backoff
            .saturating_mul(factor)
            .min(self.config.max_backoff);
        self.restarts.push_back(now);
        RestartDecision::Restart {
            attempt: recent + 1,
            delay,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backs_off_exponentially_and_gives_up_on_the_sixth_failure_in_ten_minutes() {
        let mut policy = RestartPolicy::new(RestartConfig::default());
        let start = Instant::now();
        let decisions: Vec<RestartDecision> = (0..6)
            .map(|i| policy.on_failure(start + secs(i * 60)))
            .collect();
        assert_eq!(
            decisions,
            [
                RestartDecision::Restart {
                    attempt: 1,
                    delay: secs(1)
                },
                RestartDecision::Restart {
                    attempt: 2,
                    delay: secs(2)
                },
                RestartDecision::Restart {
                    attempt: 3,
                    delay: secs(4)
                },
                RestartDecision::Restart {
                    attempt: 4,
                    delay: secs(8)
                },
                RestartDecision::Restart {
                    attempt: 5,
                    delay: secs(16)
                },
                RestartDecision::GiveUp { restarts: 5 },
            ]
        );
    }

    #[test]
    fn forgets_restarts_older_than_the_window() {
        let mut policy = RestartPolicy::new(RestartConfig::default());
        let start = Instant::now();
        for i in 0..5 {
            assert!(matches!(
                policy.on_failure(start + secs(i)),
                RestartDecision::Restart { .. }
            ));
        }
        // Ten minutes after the first restart it no longer counts: one slot is free again.
        let later = start + secs(10 * 60);
        assert_eq!(
            policy.on_failure(later),
            RestartDecision::Restart {
                attempt: 5,
                delay: secs(16)
            }
        );
        assert_eq!(
            policy.on_failure(later),
            RestartDecision::GiveUp { restarts: 5 }
        );
    }

    #[test]
    fn caps_the_delay() {
        let config = RestartConfig {
            max_restarts: 20,
            ..RestartConfig::default()
        };
        let mut policy = RestartPolicy::new(config);
        let now = Instant::now();
        let last = (0..10).map(|_| policy.on_failure(now)).last();
        assert_eq!(
            last,
            Some(RestartDecision::Restart {
                attempt: 10,
                delay: secs(30)
            })
        );
    }
}
