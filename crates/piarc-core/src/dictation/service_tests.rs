//! The dictation service without speech assets: the switch, the single owner, the window's
//! route, and the owner released by the engine's terminal state (addendum V-4.x, THR-18).

use std::sync::Mutex as StdMutex;
use std::time::Instant;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::events::{DeliveryDone, EventBatch, EventSink, SinkClosed};

#[derive(Default)]
struct Collect(StdMutex<Vec<(String, Value)>>);

impl EventSink for Collect {
    fn deliver(
        &self,
        batches: Vec<EventBatch>,
        done: DeliveryDone,
    ) -> std::result::Result<(), SinkClosed> {
        let mut seen = self.0.lock().expect("sink");
        for batch in batches {
            let events: Vec<Value> = serde_json::from_slice(&batch.payload).expect("JSON array");
            for event in events {
                seen.push((batch.route.as_str().to_owned(), event));
            }
        }
        drop(done);
        Ok(())
    }
}

impl Collect {
    fn seen(&self) -> Vec<(String, Value)> {
        self.0.lock().expect("sink").clone()
    }
}

struct Fixture {
    service: DictationService,
    sink: Arc<Collect>,
    close: CancellationToken,
    coalescing: tokio::task::JoinHandle<()>,
    dir: PathBuf,
}

impl Fixture {
    /// A service whose speech directory is empty: every start fails with `modelMissing`.
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "piarc dictation service {name} {}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("speech")).expect("dir");
        let sink = Arc::new(Collect::default());
        let close = CancellationToken::new();
        let (events, coalescer, _) =
            crate::events::channel(Duration::from_millis(1), sink.clone(), close.clone());
        let coalescing = tokio::spawn(coalescer.run());
        let service = DictationService::new(
            &SpeechConfig {
                dir: Some(dir.join("speech")),
                test_source: None,
                idle_ttl: Duration::from_secs(60),
            },
            dir.join("cache"),
            events,
        );
        Self {
            service,
            sink,
            close,
            coalescing,
            dir,
        }
    }

    async fn finish(self) -> Vec<(String, Value)> {
        let Self {
            service,
            sink,
            close,
            coalescing,
            dir,
        } = self;
        tokio::task::spawn_blocking(move || {
            service.shutdown();
            drop(service);
        })
        .await
        .expect("shutdown");
        close.cancel();
        coalescing.await.expect("coalescer");
        let _ = std::fs::remove_dir_all(dir);
        sink.seen()
    }

    async fn wait_for_terminal(&self, window: u64) -> Vec<Value> {
        let route = format!("dictation/{window}");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events: Vec<Value> = self
                .sink
                .seen()
                .into_iter()
                .filter(|(r, _)| *r == route)
                .map(|(_, e)| e)
                .collect();
            if events.iter().any(|e| {
                matches!(
                    e["state"].as_str(),
                    Some("error" | "completed" | "cancelled")
                )
            }) {
                return events;
            }
            assert!(Instant::now() < deadline, "no terminal state: {events:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn request(window: u64) -> DictationStart {
    DictationStart {
        window_id: window,
        composer: "composer-1".to_owned(),
        workspace: None,
        test: false,
    }
}

fn details(error: &Error) -> Value {
    error.to_error_object().data.details.unwrap_or(Value::Null)
}

#[tokio::test]
async fn a_turned_off_feature_refuses_to_start() {
    let f = Fixture::new("off");
    let preferences = VoicePreferences {
        enabled: false,
        ..VoicePreferences::default()
    };
    let error = f
        .service
        .start(&request(3), &preferences, None)
        .expect_err("refused");
    assert_eq!(
        error.to_error_object().data.kind,
        ErrorKind::PermissionDenied
    );
    assert_eq!(details(&error)["speech"], "disabled");
    assert!(!f.service.in_use());
    f.finish().await;
}

/// A session's events reach only its window's route, and its terminal state frees the
/// application-wide slot (THR-18: other windows never see the text).
#[tokio::test]
async fn missing_assets_end_the_session_on_its_window_and_free_the_slot() {
    let f = Fixture::new("missing");
    let started = f
        .service
        .start(&request(7), &VoicePreferences::default(), None)
        .expect("started");
    assert_eq!(started.route, "dictation/7");
    let events = f.wait_for_terminal(7).await;
    let last = events.last().expect("an event");
    assert_eq!(last["type"], "state");
    assert_eq!(last["state"], "error");
    assert_eq!(last["code"], "modelMissing");
    assert_eq!(last["sessionId"], started.session_id.as_str());
    assert!(!f.service.in_use(), "the terminal state releases the owner");
    // The slot is free again: the next start is accepted.
    let again = f
        .service
        .start(&request(8), &VoicePreferences::default(), None)
        .expect("started again");
    assert_ne!(again.session_id, started.session_id);
    f.wait_for_terminal(8).await;
    let seen = f.finish().await;
    assert!(
        seen.iter()
            .all(|(route, _)| route == "dictation/7" || route == "dictation/8"),
        "{seen:?}"
    );
}

#[tokio::test]
async fn one_dictation_at_a_time_and_only_its_window_controls_it() {
    let f = Fixture::new("owner");
    // Hold the slot as a running session would.
    *f.service.owner.lock().expect("owner") = Some(Owner {
        session: "dictation-41".to_owned(),
        window: 4,
        composer: "composer-1".to_owned(),
        test: false,
    });
    let error = f
        .service
        .start(&request(5), &VoicePreferences::default(), None)
        .expect_err("busy");
    assert_eq!(error.to_error_object().data.kind, ErrorKind::Busy);
    assert_eq!(details(&error)["speech"], "busy");
    assert_eq!(details(&error)["windowId"], 4);
    for result in [
        f.service.stop(5, "dictation-41", StopMode::Keep),
        f.service.cancel(5, "dictation-41"),
        f.service.stop(4, "dictation-other", StopMode::Send),
    ] {
        let error = result.expect_err("not this window's session");
        assert_eq!(details(&error)["speech"], "unknownSession");
    }
    let status = f.service.status();
    assert_eq!(status.window_id, Some(4));
    assert_eq!(status.session_id.as_deref(), Some("dictation-41"));
    // Another window going away leaves the session alone.
    f.service.release(5);
    assert!(f.service.in_use());
    f.finish().await;
}

#[tokio::test]
async fn models_report_the_bundled_model_missing_and_the_enhanced_one_absent() {
    let f = Fixture::new("models");
    let models = f.service.models(&VoicePreferences::default());
    assert_eq!(models.models.len(), 2);
    let bundled = &models.models[0];
    assert_eq!(bundled.kind, SpeechModelKind::Base);
    assert_eq!(bundled.state, SpeechModelState::Missing);
    let enhanced = &models.models[1];
    assert_eq!(enhanced.kind, SpeechModelKind::Enhanced);
    assert_eq!(enhanced.state, SpeechModelState::Missing);
    assert!(!enhanced.active);
    assert!(
        enhanced.download_bytes > 500_000_000,
        "{}",
        enhanced.download_bytes
    );
    f.finish().await;
}
