//! The thresholds of shell commands, in one place (architecture sections 6.11 and 6.15).
//!
//! [`ExecLimits::default`] holds the calibrated values; Core passes its own [`ExecLimits`] when
//! it wants others (tests, later settings). Nothing else in PiArc hard-codes these numbers.

use std::time::Duration;

/// Timeouts, output budgets and the termination grace period of shell commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecLimits {
    /// Timeout of a command that asks for none.
    pub default_timeout: Duration,
    /// The longest timeout a command gets; longer requests are cut to it.
    pub max_timeout: Duration,
    /// Output of a successful command up to this many characters reaches the model whole.
    pub inline_chars: usize,
    /// Longer successful output: this many characters around the omission (half from the
    /// start, half from the end), with the full text saved to a file.
    pub preview_chars: usize,
    /// Longer output of a failed command: this many characters from its start ...
    pub failure_head_chars: usize,
    /// ... and this many from its end, where errors usually are.
    pub failure_tail_chars: usize,
    /// After `SIGTERM` to the process group, how long the processes get before `SIGKILL`.
    pub kill_grace: Duration,
}

impl Default for ExecLimits {
    fn default() -> Self {
        Self {
            default_timeout: Duration::from_secs(120),
            max_timeout: Duration::from_secs(600),
            inline_chars: 30_000,
            preview_chars: 2_000,
            failure_head_chars: 10_000,
            failure_tail_chars: 20_000,
            kill_grace: Duration::from_secs(2),
        }
    }
}

/// The timeout a command runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeout {
    /// What applies.
    pub duration: Duration,
    /// What the caller asked for, when it asked.
    pub requested: Option<Duration>,
    /// Whether the request was longer than [`ExecLimits::max_timeout`] and was cut to it.
    pub capped: bool,
}

impl ExecLimits {
    /// The timeout for a request of `requested` (none: the default).
    #[must_use]
    pub fn timeout(&self, requested: Option<Duration>) -> Timeout {
        match requested {
            None => Timeout {
                duration: self.default_timeout,
                requested: None,
                capped: false,
            },
            Some(asked) if asked > self.max_timeout => Timeout {
                duration: self.max_timeout,
                requested: Some(asked),
                capped: true,
            },
            Some(asked) => Timeout {
                duration: asked,
                requested: Some(asked),
                capped: false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_two_minutes_and_caps_at_ten() {
        let limits = ExecLimits::default();
        assert_eq!(limits.timeout(None).duration, Duration::from_secs(120));
        assert!(!limits.timeout(None).capped);
        let asked = limits.timeout(Some(Duration::from_secs(30)));
        assert_eq!(asked.duration, Duration::from_secs(30));
        assert!(!asked.capped);
        let exact = limits.timeout(Some(Duration::from_secs(600)));
        assert_eq!(exact.duration, Duration::from_secs(600));
        assert!(!exact.capped);
        let long = limits.timeout(Some(Duration::from_secs(3600)));
        assert_eq!(long.duration, Duration::from_secs(600));
        assert_eq!(long.requested, Some(Duration::from_secs(3600)));
        assert!(long.capped);
    }
}
