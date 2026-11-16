//! The event path from Core to the client: a bounded queue, the coalescer that merges
//! events into batches about every 16 ms, and the [`EventSink`] that hands the batches over
//! (in production a NAPI-RS `ThreadsafeFunction`).
//!
//! # Batches
//!
//! Each flush produces one [`EventBatch`] per route key that has pending events. A batch
//! carries the route key, a per-route batch sequence number starting at 1, and an opaque
//! payload: a UTF-8 JSON array of the route's events in the order they were queued. The
//! main process forwards a batch by its route key and never parses the payload.
//!
//! # Rate
//!
//! A flush happens at the earliest when the first pending event arrived and at least one
//! interval after the previous flush. The sink is therefore called at most once per interval
//! (`1000 / interval_ms` times a second), an event that arrives after a quiet period is
//! delivered at once, and under sustained load each flush carries every event of the last
//! interval. With nothing pending no timer runs.
//!
//! # Backpressure (no event is ever dropped)
//!
//! - At most [`MAX_IN_FLIGHT_DELIVERIES`] delivery is outstanding: the coalescer hands the
//!   sink the next batches only after the client has finished with the previous ones (the
//!   sink drops its [`DeliveryDone`]). Until then events keep accumulating in the pending
//!   batches, so a slow client gets larger batches, not more callbacks.
//! - Pending batches are capped at [`MAX_PENDING_BYTES`]. Above the cap the coalescer stops
//!   reading the queue, the queue ([`EVENT_QUEUE_CAPACITY`] events) fills up, and producers
//!   wait: async producers await `send`, synchronous calls fail with the retryable
//!   [`Error::QueueFull`](crate::Error::QueueFull) before anything is queued.
//! - Events are lost only when the sink reports that the client is gone (the JavaScript
//!   environment was torn down); there is nobody left to deliver to.

use std::collections::HashMap;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until, timeout};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::route::RouteKey;

/// Default coalescing interval (architecture section 7.6).
pub const DEFAULT_COALESCE_INTERVAL: Duration = Duration::from_millis(16);

/// Capacity of the queue between producers and the coalescer, in events.
pub const EVENT_QUEUE_CAPACITY: usize = 65_536;

/// Pending payload size above which the coalescer stops reading the queue.
pub const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;

/// Deliveries the coalescer leaves outstanding before it waits for the client.
pub const MAX_IN_FLIGHT_DELIVERIES: usize = 1;

/// How long shutdown waits for the client to finish the last delivery.
pub const FINAL_DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);

/// One event: a route key and a payload that is a single JSON value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub(crate) route: RouteKey,
    pub(crate) json: Vec<u8>,
}

impl Event {
    /// An event whose payload is `value` serialized as JSON.
    ///
    /// # Errors
    ///
    /// [`Error::Internal`] when `value` cannot be serialized (a map with non-string keys,
    /// for example).
    pub fn from_json<T: serde::Serialize>(route: RouteKey, value: &T) -> Result<Self> {
        serde_json::to_vec(value)
            .map(|json| Self { route, json })
            .map_err(|error| Error::Internal {
                reason: format!("failed to serialize an event: {error}"),
            })
    }

    /// An event from a payload the caller has already serialized as one JSON value.
    pub(crate) fn from_raw_json(route: RouteKey, json: Vec<u8>) -> Self {
        Self { route, json }
    }
}

/// The events of one route key collected during one interval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventBatch {
    /// The route key every event of the batch was sent under.
    pub route: RouteKey,
    /// Per-route batch number: 1 for the first batch of a route, then consecutive.
    pub seq: u64,
    /// UTF-8 JSON array of the events, in queue order.
    pub payload: Vec<u8>,
}

/// The client is gone: the sink can no longer deliver anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

/// Receives coalesced batches. The production sink is the NAPI-RS `ThreadsafeFunction`
/// passed to `CoreRuntime.create`.
pub trait EventSink: Send + Sync + 'static {
    /// Hands `batches` (never empty) to the client. The sink drops `done` once the client
    /// has finished with them; the coalescer delivers nothing else until then.
    ///
    /// # Errors
    ///
    /// [`SinkClosed`] when the client can no longer be reached. `done` is dropped too.
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed>;
}

/// Completion signal of one delivery. Dropping it tells the coalescer that the client has
/// finished with the batches.
#[derive(Debug)]
pub struct DeliveryDone {
    tx: Option<mpsc::UnboundedSender<()>>,
}

impl DeliveryDone {
    fn new(tx: mpsc::UnboundedSender<()>) -> Self {
        Self { tx: Some(tx) }
    }

    /// A signal that nobody waits for (for deliveries outside the coalescer).
    #[must_use]
    pub fn detached() -> Self {
        Self { tx: None }
    }
}

impl Drop for DeliveryDone {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            // The coalescer may already have finished (shutdown timed out); then nobody
            // needs the signal.
            let _ = tx.send(());
        }
    }
}

/// Counters of the event path, for tests and benchmarks.
#[derive(Debug, Default)]
pub struct EventCounters {
    queued: AtomicU64,
    deliveries: AtomicU64,
    batches: AtomicU64,
    delivered: AtomicU64,
    lost: AtomicU64,
}

/// A snapshot of [`EventCounters`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventStats {
    /// Events accepted into the queue.
    pub queued: u64,
    /// Calls of [`EventSink::deliver`].
    pub deliveries: u64,
    /// Batches handed to the sink.
    pub batches: u64,
    /// Events handed to the sink.
    pub delivered: u64,
    /// Events dropped because the sink was closed.
    pub lost: u64,
}

impl EventCounters {
    /// Reads all counters.
    #[must_use]
    pub fn snapshot(&self) -> EventStats {
        EventStats {
            queued: self.queued.load(Ordering::Relaxed),
            deliveries: self.deliveries.load(Ordering::Relaxed),
            batches: self.batches.load(Ordering::Relaxed),
            delivered: self.delivered.load(Ordering::Relaxed),
            lost: self.lost.load(Ordering::Relaxed),
        }
    }
}

/// The producer side of the event queue.
#[derive(Debug, Clone)]
pub(crate) struct EventSender {
    tx: mpsc::Sender<Event>,
    counters: Arc<EventCounters>,
}

impl EventSender {
    /// Queues `event`, waiting while the queue is full.
    pub(crate) async fn send(&self, event: Event) -> Result<()> {
        self.tx.send(event).await.map_err(|_| Error::ShuttingDown)?;
        self.counters.queued.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Queues `event` from a thread outside the runtime (a terminal's IO thread), waiting
    /// while the queue is full. Must not be called from a runtime thread.
    pub(crate) fn blocking_send(&self, event: Event) -> Result<()> {
        self.tx
            .blocking_send(event)
            .map_err(|_| Error::ShuttingDown)?;
        self.counters.queued.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Queues `event` without waiting.
    pub(crate) fn try_send(&self, event: Event) -> Result<()> {
        self.tx.try_send(event).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => Error::QueueFull,
            mpsc::error::TrySendError::Closed(_) => Error::ShuttingDown,
        })?;
        self.counters.queued.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// Creates the queue and the coalescer that drains it into `sink`. The coalescer runs until
/// `close` is cancelled and the queue is drained, then delivers what is left and drops the
/// sink.
pub(crate) fn channel(
    interval: Duration,
    sink: Arc<dyn EventSink>,
    close: CancellationToken,
) -> (EventSender, Coalescer, Arc<EventCounters>) {
    let (tx, rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
    let (done_tx, done_rx) = mpsc::unbounded_channel();
    let counters = Arc::new(EventCounters::default());
    let sender = EventSender {
        tx,
        counters: Arc::clone(&counters),
    };
    let coalescer = Coalescer {
        interval,
        rx,
        sink: Some(sink),
        close,
        done_tx,
        done_rx,
        in_flight: 0,
        pending: Pending::default(),
        seqs: HashMap::new(),
        last_flush: None,
        counters: Arc::clone(&counters),
    };
    (sender, coalescer, counters)
}

/// Events collected since the last flush, grouped by route in order of first appearance.
#[derive(Debug, Default)]
struct Pending {
    routes: Vec<PendingRoute>,
    index: HashMap<RouteKey, usize>,
    bytes: usize,
    since: Option<Instant>,
}

#[derive(Debug)]
struct PendingRoute {
    route: RouteKey,
    /// `[` followed by the comma-separated events; `]` is appended on flush.
    json: Vec<u8>,
    events: u64,
}

impl Pending {
    fn push(&mut self, event: Event, now: Instant) {
        self.since.get_or_insert(now);
        self.bytes += event.json.len() + 1;
        let slot = match self.index.get(&event.route) {
            Some(&slot) => slot,
            None => {
                self.index.insert(event.route.clone(), self.routes.len());
                self.routes.push(PendingRoute {
                    route: event.route,
                    json: Vec::with_capacity(event.json.len() + 2),
                    events: 0,
                });
                self.routes.len() - 1
            }
        };
        let entry = &mut self.routes[slot];
        entry.json.push(if entry.events == 0 { b'[' } else { b',' });
        entry.json.extend_from_slice(&event.json);
        entry.events += 1;
    }

    fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }

    fn take(&mut self) -> Vec<PendingRoute> {
        self.index.clear();
        self.bytes = 0;
        self.since = None;
        std::mem::take(&mut self.routes)
    }
}

/// Merges queued events into batches and hands them to the sink (see the module docs).
pub(crate) struct Coalescer {
    interval: Duration,
    rx: mpsc::Receiver<Event>,
    sink: Option<Arc<dyn EventSink>>,
    close: CancellationToken,
    done_tx: mpsc::UnboundedSender<()>,
    done_rx: mpsc::UnboundedReceiver<()>,
    in_flight: usize,
    pending: Pending,
    seqs: HashMap<RouteKey, u64>,
    last_flush: Option<Instant>,
    counters: Arc<EventCounters>,
}

/// What woke the coalescer.
enum Wake {
    Close,
    Done,
    Flush,
    Event(Option<Event>),
}

impl Coalescer {
    /// Runs until the queue is closed and drained, then delivers the remaining events and
    /// releases the sink.
    pub(crate) async fn run(mut self) {
        let mut closing = false;
        let mut timer = pin!(sleep_until(Instant::now()));
        let mut armed_for: Option<Instant> = None;
        loop {
            let deadline = self.flush_deadline();
            if let Some(at) = deadline
                && armed_for != Some(at)
            {
                timer.as_mut().reset(at);
                armed_for = Some(at);
            }
            let can_flush = deadline.is_some() && self.in_flight < MAX_IN_FLIGHT_DELIVERIES;
            let can_read = self.pending.bytes < MAX_PENDING_BYTES;
            let wake = tokio::select! {
                biased;
                () = self.close.cancelled(), if !closing => Wake::Close,
                Some(()) = self.done_rx.recv() => Wake::Done,
                () = &mut timer, if can_flush => Wake::Flush,
                event = self.rx.recv(), if can_read => Wake::Event(event),
            };
            match wake {
                Wake::Close => {
                    // Refuse new events but keep draining the ones already queued.
                    closing = true;
                    self.rx.close();
                }
                Wake::Done => self.in_flight -= 1,
                Wake::Flush => {
                    armed_for = None;
                    self.flush();
                }
                Wake::Event(Some(event)) => self.push(event),
                Wake::Event(None) => break,
            }
        }
        self.finish().await;
    }

    fn push(&mut self, first: Event) {
        let now = Instant::now();
        self.pending.push(first, now);
        // Take what is already queued in the same wake-up, so a burst lands in one batch.
        while self.pending.bytes < MAX_PENDING_BYTES {
            match self.rx.try_recv() {
                Ok(event) => self.pending.push(event, now),
                Err(_) => break,
            }
        }
    }

    /// When the pending events are due: not before they arrived and not within one
    /// interval of the previous flush. `None` when nothing is pending.
    fn flush_deadline(&self) -> Option<Instant> {
        let since = self.pending.since?;
        Some(match self.last_flush {
            Some(last) => since.max(last + self.interval),
            None => since,
        })
    }

    fn flush(&mut self) {
        let routes = self.pending.take();
        if routes.is_empty() {
            return;
        }
        self.last_flush = Some(Instant::now());
        let events: u64 = routes.iter().map(|r| r.events).sum();
        let Some(sink) = &self.sink else {
            self.counters.lost.fetch_add(events, Ordering::Relaxed);
            return;
        };
        let batches: Vec<EventBatch> = routes
            .into_iter()
            .map(|mut entry| {
                entry.json.push(b']');
                let seq = self.seqs.entry(entry.route.clone()).or_insert(0);
                *seq += 1;
                EventBatch {
                    route: entry.route,
                    seq: *seq,
                    payload: entry.json,
                }
            })
            .collect();
        let count = batches.len() as u64;
        match sink.deliver(batches, DeliveryDone::new(self.done_tx.clone())) {
            Ok(()) => {
                self.in_flight += 1;
                self.counters.deliveries.fetch_add(1, Ordering::Relaxed);
                self.counters.batches.fetch_add(count, Ordering::Relaxed);
                self.counters.delivered.fetch_add(events, Ordering::Relaxed);
            }
            Err(SinkClosed) => {
                // The sink dropped `done`, which has already signalled completion: count the
                // attempt as in flight so that signal balances it.
                self.in_flight += 1;
                eprintln!(
                    "[piarc-core] event sink closed; dropping {events} events and all later ones"
                );
                self.counters.lost.fetch_add(events, Ordering::Relaxed);
                self.sink = None;
            }
        }
    }

    /// Delivers what is still pending once the previous delivery completed and the interval
    /// has passed, waits for the client to finish with it, then drops the sink.
    async fn finish(mut self) {
        let deadline = Instant::now() + FINAL_DELIVERY_TIMEOUT;
        if !self.pending.is_empty() {
            if self.wait_for_deliveries(deadline).await
                && let Some(at) = self.flush_deadline()
            {
                sleep_until(at).await;
            }
            self.flush();
        }
        self.wait_for_deliveries(deadline).await;
        self.sink = None;
    }

    /// Waits until no delivery is outstanding. False when `deadline` passed first.
    async fn wait_for_deliveries(&mut self, deadline: Instant) -> bool {
        while self.in_flight > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match timeout(remaining, self.done_rx.recv()).await {
                Ok(Some(())) => self.in_flight -= 1,
                Ok(None) | Err(_) => {
                    eprintln!(
                        "[piarc-core] the client did not finish {} delivery within {:?}; \
                         releasing the event sink",
                        self.in_flight, FINAL_DELIVERY_TIMEOUT
                    );
                    return false;
                }
            }
        }
        true
    }
}
