//! How long snapshots are kept (architecture section 9.3, ADR-0011 rule 4, ADR-0044 rule 9).
//! The index applies the policy (`piarc-store`); `piarc-core` runs it in the background with
//! its wall clock, which tests replace.

use std::time::Duration;

/// Checkpoints kept per session by default.
pub const DEFAULT_MAX_CHECKPOINTS: usize = 100;

/// A session not accessed for this long loses its snapshots by default.
pub const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The retention policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// The newest checkpoints of a session that are kept; older ones go with their records.
    pub max_checkpoints: usize,
    /// A session not opened or written for this long loses all its checkpoints.
    pub idle: Duration,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            max_checkpoints: DEFAULT_MAX_CHECKPOINTS,
            idle: DEFAULT_IDLE,
        }
    }
}

impl RetentionPolicy {
    /// Sessions last accessed before this instant (Unix milliseconds) are idle at `now_ms`.
    #[must_use]
    pub fn idle_before(&self, now_ms: i64) -> i64 {
        let idle = i64::try_from(self.idle.as_millis()).unwrap_or(i64::MAX);
        now_ms.saturating_sub(idle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_cutoff() {
        let policy = RetentionPolicy::default();
        assert_eq!(policy.max_checkpoints, 100);
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(policy.idle_before(31 * day), day);
        let forever = RetentionPolicy {
            idle: Duration::MAX,
            ..policy
        };
        assert_eq!(forever.idle_before(5), 5 - i64::MAX);
    }
}
