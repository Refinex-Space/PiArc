//! Event path of the Core runtime: coalescing rate, ordering without loss, backpressure,
//! ordered shutdown and task panics (T04-A01, T04-A02).

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_core::{
    CoreConfig, CoreRuntime, DeliveryDone, DemoReport, DemoSourceConfig, Error, EventBatch,
    EventSink, RouteKey, RuntimeState, SinkClosed,
};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(20);

enum Message {
    Delivery {
        at: Instant,
        batches: Vec<EventBatch>,
        done: DeliveryDone,
    },
    /// The sink was released, at this instant (taken in `Drop`, not when the test thread
    /// gets around to reading the message).
    Dropped(Instant),
}

/// Forwards every delivery, with its completion signal, to the test thread.
struct ChannelSink {
    tx: Mutex<Sender<Message>>,
}

impl EventSink for ChannelSink {
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        let tx = self.tx.lock().map_err(|_| SinkClosed)?;
        tx.send(Message::Delivery {
            at: Instant::now(),
            batches,
            done,
        })
        .map_err(|_| SinkClosed)
    }
}

impl Drop for ChannelSink {
    fn drop(&mut self) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(Message::Dropped(Instant::now()));
        }
    }
}

fn start(interval_ms: u64) -> (CoreRuntime, Receiver<Message>) {
    let (tx, rx) = channel();
    let sink = Arc::new(ChannelSink { tx: Mutex::new(tx) });
    let config = CoreConfig {
        coalesce_interval: Duration::from_millis(interval_ms),
        dirs: None,
        ..CoreConfig::default()
    };
    (
        CoreRuntime::start(config, sink).expect("runtime starts"),
        rx,
    )
}

fn demo(route: &str, events_per_second: u32, max_events: u64) -> DemoSourceConfig {
    DemoSourceConfig {
        route: RouteKey::parse(route).expect("valid route"),
        events_per_second: f64::from(events_per_second),
        pad_bytes: 16,
        max_events: Some(max_events),
    }
}

fn stop_source(core: &CoreRuntime, id: u32) -> Receiver<Result<DemoReport, Error>> {
    let (tx, rx) = channel();
    core.stop_demo_source(id, move |report| {
        let _ = tx.send(report);
    })
    .expect("source exists");
    rx
}

/// What the test thread saw.
#[derive(Default)]
struct Received {
    deliveries: Vec<Instant>,
    batch_seqs: HashMap<String, Vec<u64>>,
    events: HashMap<String, Vec<Value>>,
}

impl Received {
    fn record(&mut self, at: Instant, batches: Vec<EventBatch>) {
        self.deliveries.push(at);
        for batch in batches {
            let route = batch.route.as_str().to_owned();
            self.batch_seqs
                .entry(route.clone())
                .or_default()
                .push(batch.seq);
            let events: Vec<Value> =
                serde_json::from_slice(&batch.payload).expect("payload is a JSON array");
            assert!(!events.is_empty(), "a batch is never empty");
            self.events.entry(route).or_default().extend(events);
        }
    }

    fn event_count(&self, route: &str) -> usize {
        self.events.get(route).map_or(0, Vec::len)
    }

    /// Asserts that the demo events of `route` are numbered 1..=expected without gaps.
    fn assert_contiguous(&self, route: &str, expected: u64) {
        let seqs: Vec<u64> = self.events[route]
            .iter()
            .map(|event| event["seq"].as_u64().expect("seq is a number"))
            .collect();
        let wanted: Vec<u64> = (1..=expected).collect();
        assert_eq!(seqs, wanted, "events of {route}");
        let batches = &self.batch_seqs[route];
        let wanted_batches: Vec<u64> = (1..=batches.len() as u64).collect();
        assert_eq!(batches, &wanted_batches, "batch sequence of {route}");
    }
}

/// Receives deliveries, completing each at once, until `until` holds.
fn receive_until(
    rx: &Receiver<Message>,
    received: &mut Received,
    until: impl Fn(&Received) -> bool,
) {
    let deadline = Instant::now() + WAIT;
    while !until(received) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Message::Delivery { at, batches, done }) => {
                received.record(at, batches);
                drop(done);
            }
            Ok(Message::Dropped(_)) => panic!("the sink was dropped while events were expected"),
            Err(error) => panic!("no delivery within {WAIT:?}: {error}"),
        }
    }
}

#[test]
fn callbacks_stay_within_the_interval_rate_and_batches_merge_events() {
    let interval_ms = 16;
    let (core, rx) = start(interval_ms);
    let total = 3_000;
    core.start_demo_source(demo("rate", 2_000, total))
        .expect("source starts");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| {
        r.event_count("rate") == total as usize
    });
    received.assert_contiguous("rate", total);

    let first = received.deliveries[0];
    let last = received.deliveries[received.deliveries.len() - 1];
    let seconds = last.duration_since(first).as_secs_f64();
    #[expect(clippy::cast_precision_loss, reason = "a few hundred deliveries")]
    let per_second = (received.deliveries.len() - 1) as f64 / seconds;
    #[expect(clippy::cast_precision_loss, reason = "16 ms")]
    let allowed = 1000.0 / interval_ms as f64 * 1.1;
    #[expect(clippy::cast_precision_loss, reason = "small counts")]
    let per_batch = total as f64 / received.batch_seqs["rate"].len() as f64;
    println!(
        "deliveries {}, {per_second:.1}/s (allowed {allowed:.1}/s), {per_batch:.1} events per batch",
        received.deliveries.len()
    );
    assert!(
        per_second <= allowed,
        "{per_second:.1} callbacks/s exceeds {allowed:.1}"
    );
    assert!(per_batch > 1.0, "batches average {per_batch:.2} events");
    // No one-second window holds more callbacks than the rate allows. Timestamps are taken
    // in the sink, so a preempted runtime thread can shift single gaps; whole windows are
    // what the limit is about.
    for (i, start) in received.deliveries.iter().enumerate() {
        let in_window = received.deliveries[i..]
            .iter()
            .take_while(|at| at.duration_since(*start) < Duration::from_secs(1))
            .count();
        #[expect(clippy::cast_precision_loss, reason = "small counts")]
        let in_window = in_window as f64;
        assert!(
            in_window <= allowed,
            "{in_window} callbacks within one second"
        );
    }
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn events_of_several_sources_arrive_complete_and_in_order_with_a_slow_client() {
    let (core, rx) = start(16);
    let total = 2_000;
    for route in ["a", "b", "c"] {
        core.start_demo_source(demo(route, 20_000, total))
            .expect("source starts");
    }
    let mut received = Received::default();
    let deadline = Instant::now() + WAIT;
    let mut outstanding = 0;
    while ["a", "b", "c"]
        .iter()
        .any(|r| received.event_count(r) < total as usize)
    {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Delivery { at, batches, done }) => {
                outstanding += 1;
                assert_eq!(
                    outstanding, 1,
                    "a second delivery arrived before the first completed"
                );
                received.record(at, batches);
                // A slow client: the coalescer must keep accumulating meanwhile.
                std::thread::sleep(Duration::from_millis(40));
                drop(done);
                outstanding -= 1;
            }
            Ok(Message::Dropped(_)) => panic!("sink dropped early"),
            Err(error) => panic!("missing deliveries: {error}"),
        }
    }
    for route in ["a", "b", "c"] {
        received.assert_contiguous(route, total);
    }
    let stats = core.event_stats();
    assert_eq!(stats.delivered, 3 * total);
    assert_eq!(stats.lost, 0);
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn ordered_shutdown_flushes_the_last_batch_then_never_delivers_again() {
    let (core, rx) = start(16);
    // Endless source: shutdown has to stop it.
    let id = core
        .start_demo_source(DemoSourceConfig {
            max_events: None,
            ..demo("endless", 5_000, 1)
        })
        .expect("source starts");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| r.event_count("endless") > 500);

    let (stopped_tx, stopped_rx) = channel();
    core.shutdown(move || {
        let _ = stopped_tx.send(Instant::now());
    })
    .expect("shutdown starts");
    assert_eq!(core.state(), RuntimeState::ShuttingDown);
    assert!(matches!(
        core.echo("endless", "late"),
        Err(Error::ShuttingDown)
    ));
    assert!(matches!(
        core.stop_demo_source(id, |_| {}),
        Err(Error::ShuttingDown)
    ));

    // Keep completing deliveries until the sink is released.
    let deadline = Instant::now() + WAIT;
    let released_at = loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Delivery { at, batches, done }) => {
                received.record(at, batches);
                drop(done);
            }
            Ok(Message::Dropped(at)) => break at,
            Err(error) => panic!("the sink was not released: {error}"),
        }
    };
    let stopped_at = stopped_rx.recv_timeout(WAIT).expect("shutdown completes");
    assert!(
        released_at <= stopped_at,
        "the callback was released before shutdown reported"
    );
    assert_eq!(core.state(), RuntimeState::Stopped);

    // Everything queued was delivered: the last batch was flushed.
    let stats = core.event_stats();
    assert_eq!(stats.queued, stats.delivered);
    assert_eq!(stats.lost, 0);
    let emitted = received.event_count("endless") as u64;
    assert_eq!(emitted, stats.delivered);
    received.assert_contiguous("endless", emitted);

    // Nothing after release, and further shutdowns report at once.
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(200)),
        Err(RecvTimeoutError::Disconnected)
    ));
    core.shutdown_blocking()
        .expect("second shutdown reports at once");
    assert!(matches!(
        core.echo("endless", "after"),
        Err(Error::ShuttingDown)
    ));
}

#[test]
fn a_finished_source_reports_how_many_events_it_emitted() {
    let (core, rx) = start(16);
    let id = core
        .start_demo_source(demo("count", 50_000, 1_234))
        .expect("source starts");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| r.event_count("count") == 1_234);
    let report = stop_source(&core, id)
        .recv_timeout(WAIT)
        .expect("report arrives")
        .expect("source ended normally");
    assert_eq!(report, DemoReport { id, emitted: 1_234 });
    assert!(matches!(
        core.stop_demo_source(id, |_| {}),
        Err(Error::UnknownDemoSource { id: unknown }) if unknown == id
    ));
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn echo_validates_and_queues_without_waiting() {
    let (core, rx) = start(16);
    core.echo("echo", "hello").expect("valid echo");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| r.event_count("echo") == 1);
    assert_eq!(
        received.events["echo"][0],
        serde_json::json!({ "echo": "hello" })
    );

    let invalid_route = core.echo("bad route", "x").expect_err("space in route");
    assert_eq!(
        invalid_route.to_error_object().data.kind,
        piarc_protocol::ErrorKind::InvalidParams
    );
    let reserved = core.echo("core/errors", "x").expect_err("reserved route");
    assert!(matches!(
        reserved,
        Error::InvalidArgument { field: "route", .. }
    ));
    let too_big = core
        .echo("echo", &"x".repeat(piarc_core::MAX_ECHO_BYTES + 1))
        .expect_err("payload too large");
    assert!(matches!(
        too_big,
        Error::InvalidArgument {
            field: "payload",
            ..
        }
    ));
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn a_task_panic_becomes_an_error_event_and_the_runtime_keeps_working() {
    let (core, rx) = start(16);
    core.spawn_panicking_task().expect("task spawned");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| r.event_count("core/errors") == 1);
    let error = &received.events["core/errors"][0];
    assert_eq!(error["data"]["kind"], "internalError");
    assert_eq!(error["data"]["retryable"], false);
    assert_eq!(error["code"], -32603);
    assert!(
        error["message"]
            .as_str()
            .is_some_and(|m| m.contains("panic requested by a test")),
        "{error}"
    );

    core.echo("after-panic", "still running")
        .expect("runtime still accepts requests");
    receive_until(&rx, &mut received, |r| r.event_count("after-panic") == 1);
    core.shutdown_blocking().expect("shutdown");
}

#[test]
fn dropping_a_running_runtime_releases_the_sink_without_a_shutdown_call() {
    let (core, rx) = start(16);
    core.start_demo_source(DemoSourceConfig {
        max_events: None,
        ..demo("dropped", 1_000, 1)
    })
    .expect("source starts");
    let mut received = Received::default();
    receive_until(&rx, &mut received, |r| r.event_count("dropped") > 10);
    drop(core);
    let deadline = Instant::now() + WAIT;
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Delivery { done, .. }) => drop(done),
            Ok(Message::Dropped(_)) => break,
            Err(error) => panic!("the sink was not released after drop: {error}"),
        }
    }
}

#[test]
fn rejects_an_out_of_range_interval() {
    let (tx, _rx) = channel();
    let sink = Arc::new(ChannelSink { tx: Mutex::new(tx) });
    let config = CoreConfig {
        coalesce_interval: Duration::ZERO,
        dirs: None,
        ..CoreConfig::default()
    };
    let Err(error) = CoreRuntime::start(config, sink) else {
        panic!("a zero interval was accepted");
    };
    assert!(matches!(
        error,
        Error::InvalidArgument {
            field: "coalesceIntervalMs",
            ..
        }
    ));
}

/// A client whose environment is gone: every delivery fails and drops its completion signal.
struct ClosedSink {
    calls: Mutex<Vec<String>>,
}

impl EventSink for ClosedSink {
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.extend(batches.iter().map(|b| b.route.as_str().to_owned()));
        }
        drop(done);
        Err(SinkClosed)
    }
}

#[test]
fn a_closed_sink_drops_events_and_shutdown_does_not_wait_for_a_delivery() {
    let sink = Arc::new(ClosedSink {
        calls: Mutex::new(Vec::new()),
    });
    let config = CoreConfig {
        coalesce_interval: Duration::from_millis(16),
        dirs: None,
        ..CoreConfig::default()
    };
    let core = CoreRuntime::start(config, sink.clone()).expect("runtime starts");
    core.echo("echo", "lost").expect("valid echo");
    let deadline = Instant::now() + WAIT;
    while sink.calls.lock().expect("calls").is_empty() {
        assert!(Instant::now() < deadline, "the coalescer never delivered");
        std::thread::sleep(Duration::from_millis(5));
    }
    // The failed delivery is not in flight: shutting down has nothing to wait for.
    let started = Instant::now();
    core.shutdown_blocking().expect("shutdown");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown waited {:?} for a delivery that was never made",
        started.elapsed()
    );
    // Only the one attempt: the coalescer did not panic (which would deliver core/errors).
    assert_eq!(*sink.calls.lock().expect("calls"), ["echo"]);
}
