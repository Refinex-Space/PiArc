//! Monotonic time and sleeping.

use std::time::{Duration, Instant};

use crate::process::BoxFuture;

/// A monotonic clock. Production code uses the system clock; tests use a clock they advance
/// themselves, so behaviour that depends on minutes of wall time (restart windows, backoff)
/// runs instantly and deterministically.
pub trait Clock: Send + Sync {
    /// The current instant.
    fn now(&self) -> Instant;

    /// Completes once `duration` has passed on this clock.
    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()>;
}
