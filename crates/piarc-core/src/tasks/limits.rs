//! The thresholds of background tasks and Monitor, in one place (ADR-0049 rule 8). Foreground
//! command timeouts stay in `piarc_exec::ExecLimits`.

use std::sync::Arc;
use std::time::Duration;

use piarc_ports::Clock;

/// Monitor's timeouts and pace, notice and snapshot sizes, the read chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskLimits {
    /// Timeout of a Monitor that asks for none (Claude Code's: 5 minutes).
    pub monitor_default_timeout: Duration,
    /// The longest a Monitor runs (Claude Code's: 30 minutes); longer requests are cut.
    pub monitor_max_timeout: Duration,
    /// Lines one Monitor reminder carries at most; earlier ones are summarized as omitted.
    pub monitor_batch_lines: usize,
    /// Characters one Monitor reminder carries at most.
    pub monitor_batch_chars: usize,
    /// Characters one Monitor delivers in all; then it stops feeding the model.
    pub monitor_total_chars: usize,
    /// Undelivered lines a Monitor keeps (also while the Agent Host restarts); older ones are
    /// counted as omitted.
    pub monitor_buffer_lines: usize,
    /// Least time between two wakes of an idle session by Monitor output.
    pub monitor_wake_interval: Duration,
    /// Least time between two `core/tasks` snapshots.
    pub snapshot_interval: Duration,
    /// Tasks in a snapshot, newest first.
    pub snapshot_tasks: usize,
    /// Last lines of each task in a snapshot, and their length.
    pub snapshot_tail_lines: usize,
    /// Characters of each line in a snapshot.
    pub snapshot_line_chars: usize,
    /// Last lines in a completion notice and in `KillShell`'s result.
    pub notice_tail_lines: usize,
    /// Characters of that preview.
    pub notice_tail_chars: usize,
    /// Bytes one `exec/background/read` returns at most.
    pub read_chunk: usize,
}

impl Default for TaskLimits {
    fn default() -> Self {
        Self {
            monitor_default_timeout: Duration::from_secs(5 * 60),
            monitor_max_timeout: Duration::from_secs(30 * 60),
            monitor_batch_lines: 50,
            monitor_batch_chars: 5_000,
            monitor_total_chars: 50_000,
            monitor_buffer_lines: 2_000,
            monitor_wake_interval: Duration::from_secs(30),
            snapshot_interval: Duration::from_millis(250),
            snapshot_tasks: 200,
            snapshot_tail_lines: 5,
            snapshot_line_chars: 300,
            notice_tail_lines: 10,
            notice_tail_chars: 2_000,
            read_chunk: 64 * 1024,
        }
    }
}

impl TaskLimits {
    /// The timeout of a Monitor that asked for `requested`, and whether it was cut.
    #[must_use]
    pub fn monitor_timeout(&self, requested: Option<Duration>) -> (Duration, bool) {
        match requested {
            None => (self.monitor_default_timeout, false),
            Some(asked) if asked > self.monitor_max_timeout => (self.monitor_max_timeout, true),
            Some(asked) => (asked, false),
        }
    }
}

/// The task manager's settings: thresholds and the clock of its timers (foreground timeouts,
/// Monitor timeouts and wakes). Tests and L2 pass a manual clock.
#[derive(Clone)]
pub struct TasksConfig {
    /// Thresholds.
    pub limits: TaskLimits,
    /// The clock of the timers.
    pub clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for TasksConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TasksConfig")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Default for TasksConfig {
    fn default() -> Self {
        Self {
            limits: TaskLimits::default(),
            clock: Arc::new(crate::clock::SystemClock),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_timeouts_default_to_five_minutes_and_cap_at_thirty() {
        let limits = TaskLimits::default();
        assert_eq!(
            limits.monitor_timeout(None),
            (Duration::from_secs(300), false)
        );
        assert_eq!(
            limits.monitor_timeout(Some(Duration::from_secs(60))),
            (Duration::from_secs(60), false)
        );
        assert_eq!(
            limits.monitor_timeout(Some(Duration::from_secs(7200))),
            (Duration::from_secs(1800), true)
        );
    }
}
