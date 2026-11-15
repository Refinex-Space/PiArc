//! Demo event sources: configurable streams of numbered events for tests and benchmarks
//! (S2). Production paths never start one; the shipping NAPI build does not even export
//! the functions that do.
//!
//! Each event is `{"source":<id>,"seq":<n>,"pad":"xx…"}`. `seq` starts at 1 and is
//! consecutive within a source, so a receiver can check for loss and reordering.

use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;

/// Upper bound of [`DemoSourceConfig::events_per_second`].
pub const MAX_DEMO_RATE: u32 = 1_000_000;

/// Upper bound of [`DemoSourceConfig::pad_bytes`] (8 MiB, enough for batches far above the
/// size where large payloads matter).
pub const MAX_DEMO_PAD_BYTES: u32 = 8 * 1024 * 1024;

/// How often a source wakes up to emit the events that are due.
const TICK: Duration = Duration::from_millis(5);

/// What a demo source emits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoSourceConfig {
    /// Route key of every event.
    pub route: RouteKey,
    /// Target rate. Events due at each tick are emitted together; the long-run rate is
    /// exact.
    pub events_per_second: u32,
    /// Length of the `pad` string of each event, to control the payload size.
    pub pad_bytes: u32,
    /// Stop after this many events. `None` runs until stopped.
    pub max_events: Option<u64>,
}

impl DemoSourceConfig {
    /// Checks the limits.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] when the rate is 0 or above [`MAX_DEMO_RATE`], the pad
    /// is above [`MAX_DEMO_PAD_BYTES`] or `max_events` is 0.
    pub fn validate(&self) -> Result<()> {
        if self.events_per_second == 0 || self.events_per_second > MAX_DEMO_RATE {
            return Err(Error::InvalidArgument {
                field: "eventsPerSecond",
                reason: format!("must be between 1 and {MAX_DEMO_RATE}"),
            });
        }
        if self.pad_bytes > MAX_DEMO_PAD_BYTES {
            return Err(Error::InvalidArgument {
                field: "padBytes",
                reason: format!("must be at most {MAX_DEMO_PAD_BYTES}"),
            });
        }
        if self.max_events == Some(0) {
            return Err(Error::InvalidArgument {
                field: "maxEvents",
                reason: "must be at least 1 when set".to_owned(),
            });
        }
        Ok(())
    }
}

/// The result of a finished demo source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DemoReport {
    /// The source id.
    pub id: u32,
    /// Events queued. Every one of them is delivered unless the client is gone.
    pub emitted: u64,
}

/// A running source.
pub(crate) struct DemoSource {
    pub(crate) cancel: CancellationToken,
    pub(crate) task: JoinHandle<Option<DemoReport>>,
}

/// Runs a source until it is cancelled, reaches `max_events`, or the queue closes.
pub(crate) async fn run(
    id: u32,
    config: DemoSourceConfig,
    events: EventSender,
    cancel: CancellationToken,
) -> DemoReport {
    let pad = "x".repeat(config.pad_bytes as usize);
    let rate = f64::from(config.events_per_second);
    let limit = config.max_events.unwrap_or(u64::MAX);
    let start = Instant::now();
    let mut ticker = interval(TICK);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut emitted: u64 = 0;
    'ticks: while emitted < limit {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            _ = ticker.tick() => {}
        }
        let due = due_events(start.elapsed(), rate).min(limit);
        while emitted < due {
            let event =
                Event::from_raw_json(config.route.clone(), event_json(id, emitted + 1, &pad));
            tokio::select! {
                biased;
                () = cancel.cancelled() => break 'ticks,
                sent = events.send(event) => {
                    if sent.is_err() {
                        break 'ticks;
                    }
                }
            }
            emitted += 1;
        }
    }
    DemoReport { id, emitted }
}

/// Events due after `elapsed` at `rate` per second.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the product is non-negative and far below u64::MAX for any rate and run time"
)]
fn due_events(elapsed: Duration, rate: f64) -> u64 {
    (elapsed.as_secs_f64() * rate).floor() as u64
}

fn event_json(source: u32, seq: u64, pad: &str) -> Vec<u8> {
    let mut json = Vec::with_capacity(pad.len() + 48);
    json.extend_from_slice(b"{\"source\":");
    json.extend_from_slice(source.to_string().as_bytes());
    json.extend_from_slice(b",\"seq\":");
    json.extend_from_slice(seq.to_string().as_bytes());
    json.extend_from_slice(b",\"pad\":\"");
    json.extend_from_slice(pad.as_bytes());
    json.extend_from_slice(b"\"}");
    json
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> DemoSourceConfig {
        DemoSourceConfig {
            route: RouteKey::parse("demo").expect("valid route"),
            events_per_second: 100,
            pad_bytes: 0,
            max_events: None,
        }
    }

    #[test]
    fn events_are_json_objects_with_source_seq_and_pad() {
        let value: serde_json::Value =
            serde_json::from_slice(&event_json(7, 42, "xyz")).expect("valid JSON");
        assert_eq!(
            value,
            serde_json::json!({ "source": 7, "seq": 42, "pad": "xyz" })
        );
    }

    #[test]
    fn due_events_follow_the_rate() {
        assert_eq!(due_events(Duration::from_millis(0), 1000.0), 0);
        assert_eq!(due_events(Duration::from_millis(16), 1000.0), 16);
        assert_eq!(
            due_events(Duration::from_secs(60), 100_000.0 / 60.0),
            100_000
        );
    }

    #[test]
    fn validation_rejects_out_of_range_settings() {
        assert_eq!(config().validate(), Ok(()));
        for (bad, field) in [
            (
                DemoSourceConfig {
                    events_per_second: 0,
                    ..config()
                },
                "eventsPerSecond",
            ),
            (
                DemoSourceConfig {
                    events_per_second: MAX_DEMO_RATE + 1,
                    ..config()
                },
                "eventsPerSecond",
            ),
            (
                DemoSourceConfig {
                    pad_bytes: MAX_DEMO_PAD_BYTES + 1,
                    ..config()
                },
                "padBytes",
            ),
            (
                DemoSourceConfig {
                    max_events: Some(0),
                    ..config()
                },
                "maxEvents",
            ),
        ] {
            assert!(
                matches!(bad.validate(), Err(Error::InvalidArgument { field: f, .. }) if f == field),
                "{field}"
            );
        }
    }
}
