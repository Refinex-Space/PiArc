//! One dictation session: the state machine, event numbering, limits, refinement scheduling
//! and stop modes (addendum 3.2, 3.5, 3.7). Drives a [`Coordinator`] and turns what it finds
//! into [`DictationEvent`]s; the engine thread owns it.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use piarc_protocol::dictation::{DictationEvent, DictationState, StopMode, TextStage};

use crate::audio::{Level, LevelMeter};
use crate::coordinator::{Coordinator, Found};
use crate::recognizer::{Activity, Streaming};
use crate::transcript::{Normalize, accept_refined, normalize, separator};
use crate::vocabulary::Vocabulary;

/// Where a session's events go. `send` must deliver (text, state, notices); `send_level` may
/// drop when the client is behind.
pub trait DictationSink: Send + Sync {
    /// Delivers an event that must not be lost.
    fn send(&self, event: DictationEvent);
    /// Delivers a level event, or drops it.
    fn send_level(&self, event: DictationEvent);
}

/// Most segments waiting for refinement (addendum V-7.3).
pub const REFINE_QUEUE: usize = 2;
/// How long a segment waits for refinement before its base text becomes final.
pub const REFINE_DEADLINE: Duration = Duration::from_secs(3);

/// Session settings fixed at start.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    /// Session id.
    pub id: String,
    /// Terms for normalization.
    pub vocabulary: Vocabulary,
    /// Keep punctuation.
    pub punctuation: bool,
    /// Refine segments (the enhanced model is active).
    pub refine: bool,
    /// Longest session, audio time.
    pub max_audio: Duration,
    /// Longest stretch without speech before stopping, audio time.
    pub no_speech: Duration,
}

/// A segment's audio for the refiner.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    /// Segment.
    pub segment: u64,
    /// Its 16 kHz audio.
    pub pcm: Vec<f32>,
}

struct Pending {
    segment: u64,
    base: String,
    prefix: String,
    deadline: Instant,
    result: Option<Result<String, ()>>,
}

/// The session.
pub struct Session<S, V> {
    options: SessionOptions,
    sink: Arc<dyn DictationSink>,
    sequence: u64,
    state: DictationState,
    coordinator: Option<Coordinator<S, V>>,
    meter: LevelMeter,
    /// Revision and separator per open segment.
    revisions: std::collections::BTreeMap<u64, (u64, String)>,
    tail: Option<char>,
    pending: VecDeque<Pending>,
    jobs: Vec<Job>,
    stopping: bool,
}

impl<S: Streaming, V: Activity> Session<S, V> {
    /// A session in `preparing`; sends that state. `coordinator` is `None` for a microphone
    /// test (levels only).
    pub fn new(options: SessionOptions, sink: Arc<dyn DictationSink>) -> Self {
        let mut session = Self {
            options,
            sink,
            sequence: 0,
            state: DictationState::Preparing,
            coordinator: None,
            meter: LevelMeter::default(),
            revisions: std::collections::BTreeMap::new(),
            tail: None,
            pending: VecDeque::new(),
            jobs: Vec::new(),
            stopping: false,
        };
        session.set_state(DictationState::Preparing, None);
        session
    }

    /// The current state.
    #[cfg(test)]
    pub fn state(&self) -> DictationState {
        self.state
    }

    /// Turns refinement on or off once the engine knows whether the enhanced model loads.
    pub fn set_refine(&mut self, refine: bool) {
        self.options.refine = refine;
    }

    fn next(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    fn set_state(&mut self, state: DictationState, code: Option<&str>) {
        if self.state.is_terminal() {
            return;
        }
        self.state = state;
        let sequence = self.next();
        self.sink.send(DictationEvent::State {
            session_id: self.options.id.clone(),
            sequence,
            state,
            code: code.map(str::to_owned),
        });
    }

    /// Sends a notice.
    pub fn notice(&mut self, code: &str) {
        if self.state.is_terminal() {
            return;
        }
        let sequence = self.next();
        self.sink.send(DictationEvent::Notice {
            session_id: self.options.id.clone(),
            sequence,
            code: code.to_owned(),
        });
    }

    /// The microphone is open: `recording`, with the coordinator for speech sessions.
    pub fn record(&mut self, coordinator: Option<Coordinator<S, V>>) {
        self.coordinator = coordinator;
        self.set_state(DictationState::Recording, None);
    }

    /// Feeds 16 kHz audio. Returns the notice code when a limit stopped the session.
    pub fn feed(&mut self, samples: &[f32], now: Instant) -> Option<&'static str> {
        if self.state != DictationState::Recording {
            return None;
        }
        for level in self.meter.push(samples) {
            self.send_level(&level);
        }
        let mut found = Vec::new();
        let (audio_ms, silent_ms) = match self.coordinator.as_mut() {
            Some(coordinator) => {
                coordinator.push(samples, &mut found);
                (coordinator.audio_ms(), coordinator.silent_ms())
            }
            None => (self.meter.audio_ms(), 0),
        };
        self.handle(found, now);
        let max = u64::try_from(self.options.max_audio.as_millis()).unwrap_or(u64::MAX);
        let quiet = u64::try_from(self.options.no_speech.as_millis()).unwrap_or(u64::MAX);
        let limit = if audio_ms >= max {
            Some("maxDuration")
        } else if self.coordinator.is_some() && silent_ms >= quiet {
            Some("noSpeech")
        } else {
            None
        };
        if let Some(code) = limit {
            self.notice(code);
            self.stop(StopMode::Keep, now);
        }
        limit
    }

    fn send_level(&mut self, level: &Level) {
        let sequence = self.next();
        self.sink.send_level(DictationEvent::Level {
            session_id: self.options.id.clone(),
            sequence,
            audio_ms: level.audio_ms,
            rms: f64::from(level.rms),
            peak: f64::from(level.peak),
            envelope: level.envelope.iter().map(|v| f64::from(*v)).collect(),
        });
    }

    fn normalized(&self, text: &str) -> String {
        normalize(
            text,
            &Normalize {
                vocabulary: &self.options.vocabulary,
                punctuation: self.options.punctuation,
            },
        )
    }

    fn send_text(&mut self, segment: u64, stage: TextStage, text: &str) {
        let tail = self.tail;
        let entry = self
            .revisions
            .entry(segment)
            .or_insert_with(|| (0, separator(tail, text).to_owned()));
        entry.0 += 1;
        let revision = entry.0;
        let full = if text.is_empty() {
            String::new()
        } else {
            format!("{}{text}", entry.1)
        };
        if stage == TextStage::Final {
            self.revisions.remove(&segment);
        }
        let sequence = self.next();
        self.sink.send(DictationEvent::Text {
            session_id: self.options.id.clone(),
            sequence,
            segment_id: segment,
            revision,
            stage,
            text: full,
        });
    }

    fn handle(&mut self, found: Vec<Found>, now: Instant) {
        for item in found {
            match item {
                Found::Partial { segment, text } => {
                    let text = self.normalized(&text);
                    self.send_text(segment, TextStage::Partial, &text);
                }
                Found::Discarded { segment } => {
                    self.send_text(segment, TextStage::Partial, "");
                    self.revisions.remove(&segment);
                }
                Found::Segment { segment, text, pcm } => self.segment(segment, &text, pcm, now),
            }
        }
    }

    fn segment(&mut self, segment: u64, text: &str, pcm: Option<Vec<f32>>, now: Instant) {
        let base = self.normalized(text);
        if base.is_empty() {
            self.send_text(segment, TextStage::Partial, "");
            self.revisions.remove(&segment);
            return;
        }
        let refine = self.options.refine && !self.stopping;
        match pcm {
            Some(pcm) if refine && self.pending.len() < REFINE_QUEUE => {
                self.send_text(segment, TextStage::Provisional, &base);
                let prefix = self
                    .revisions
                    .get(&segment)
                    .map(|(_, p)| p.clone())
                    .unwrap_or_default();
                self.pending.push_back(Pending {
                    segment,
                    base: base.clone(),
                    prefix,
                    deadline: now + REFINE_DEADLINE,
                    result: None,
                });
                self.jobs.push(Job { segment, pcm });
            }
            _ => {
                if refine {
                    self.notice("refineSkipped");
                }
                self.send_text(segment, TextStage::Final, &base);
            }
        }
        self.tail = base.chars().next_back();
    }

    /// Refinement jobs produced since the last call.
    pub fn take_jobs(&mut self) -> Vec<Job> {
        std::mem::take(&mut self.jobs)
    }

    /// A refinement result arrived (`Err` when the refiner failed).
    pub fn refined(&mut self, segment: u64, result: Result<String, ()>, now: Instant) {
        if let Some(pending) = self.pending.iter_mut().find(|p| p.segment == segment) {
            pending.result = Some(result);
        }
        self.tick(now);
    }

    /// Settles pending segments in order: the front one when its result arrived or its
    /// deadline passed. A late segment never overtakes an earlier one.
    pub fn tick(&mut self, now: Instant) {
        while let Some(front) = self.pending.front() {
            if front.result.is_none() && now < front.deadline {
                break;
            }
            let Some(pending) = self.pending.pop_front() else {
                break;
            };
            self.settle(pending);
        }
        self.finish_if_done();
    }

    fn settle(&mut self, pending: Pending) {
        let chosen = match pending.result {
            Some(Ok(refined)) => {
                let refined = self.normalized(&refined);
                if accept_refined(&pending.base, &refined, &self.options.vocabulary) {
                    refined
                } else {
                    pending.base
                }
            }
            Some(Err(())) => {
                self.notice("refineFailed");
                pending.base
            }
            None => {
                self.notice("refineTimeout");
                pending.base
            }
        };
        self.revisions
            .entry(pending.segment)
            .or_insert_with(|| (1, pending.prefix.clone()));
        self.send_text(pending.segment, TextStage::Final, &chosen);
    }

    /// Stops: closes the input, finishes the last segment, enters `finalizing`. `Send`
    /// settles pending refinement with the base text at once.
    pub fn stop(&mut self, mode: StopMode, now: Instant) {
        if self.state != DictationState::Recording && self.state != DictationState::Preparing {
            if mode == StopMode::Send {
                self.settle_all();
                self.finish_if_done();
            }
            return;
        }
        let was_recording = self.state == DictationState::Recording;
        self.stopping = true;
        self.set_state(DictationState::Finalizing, None);
        if was_recording {
            let mut found = Vec::new();
            if let Some(coordinator) = self.coordinator.as_mut() {
                coordinator.finish(&mut found);
            }
            self.handle(found, now);
        }
        if mode == StopMode::Send {
            self.settle_all();
        }
        self.tick(now);
    }

    fn settle_all(&mut self) {
        self.jobs.clear();
        // Sending does not wait for refinement and never replaces text the user saw.
        while let Some(pending) = self.pending.pop_front() {
            self.revisions
                .entry(pending.segment)
                .or_insert_with(|| (1, pending.prefix.clone()));
            self.send_text(pending.segment, TextStage::Final, &pending.base);
        }
    }

    fn finish_if_done(&mut self) {
        if self.stopping && self.pending.is_empty() && self.state == DictationState::Finalizing {
            self.set_state(DictationState::Completed, None);
        }
    }

    /// Cancels: no more text; the client removes what dictation still owns.
    pub fn cancel(&mut self) {
        self.pending.clear();
        self.jobs.clear();
        self.set_state(DictationState::Cancelled, None);
    }

    /// Ends with an error code.
    pub fn fail(&mut self, code: &str) {
        self.pending.clear();
        self.jobs.clear();
        self.set_state(DictationState::Error, Some(code));
    }

    /// Whether the session has ended.
    pub fn is_done(&self) -> bool {
        self.state.is_terminal()
    }

    /// Whether refinement is still pending.
    #[cfg(test)]
    pub fn refining(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;
    use crate::coordinator::tests::{Script, Voice};
    use crate::vocabulary::VocabularySources;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<DictationEvent>>);

    impl DictationSink for Recorder {
        fn send(&self, event: DictationEvent) {
            self.0.lock().expect("lock").push(event);
        }
        fn send_level(&self, event: DictationEvent) {
            self.0.lock().expect("lock").push(event);
        }
    }

    impl Recorder {
        fn events(&self) -> Vec<DictationEvent> {
            self.0.lock().expect("lock").clone()
        }
        fn texts(&self) -> Vec<(u64, TextStage, String)> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    DictationEvent::Text {
                        segment_id,
                        stage,
                        text,
                        ..
                    } => Some((segment_id, stage, text)),
                    _ => None,
                })
                .collect()
        }
        fn states(&self) -> Vec<DictationState> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    DictationEvent::State { state, .. } => Some(state),
                    _ => None,
                })
                .collect()
        }
        fn notices(&self) -> Vec<String> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    DictationEvent::Notice { code, .. } => Some(code),
                    _ => None,
                })
                .collect()
        }
    }

    fn options(refine: bool) -> SessionOptions {
        SessionOptions {
            id: "d1".into(),
            vocabulary: Vocabulary::build(
                &VocabularySources {
                    builtin: true,
                    custom: &[],
                    workspace: &[],
                },
                None,
            ),
            punctuation: true,
            refine,
            max_audio: Duration::from_secs(600),
            no_speech: Duration::from_secs(30),
        }
    }

    fn speaking(texts: &[&'static str], endpoints: &[bool]) -> Coordinator<Script, Voice> {
        Coordinator::new(
            Script {
                texts: texts.iter().copied().collect(),
                endpoints: endpoints.iter().copied().collect(),
                ..Script::default()
            },
            Voice {
                answers: VecDeque::from([true]),
                ..Voice::default()
            },
            true,
        )
    }

    const CHUNK: [f32; 320] = [0.0; 320];

    #[test]
    fn a_basic_session_goes_preparing_recording_finalizing_completed() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(false), sink.clone());
        session.record(Some(speaking(
            &["使用 redis", "使用 redis 缓存"],
            &[false, true],
        )));
        let now = Instant::now();
        session.feed(&CHUNK, now);
        session.feed(&CHUNK, now);
        session.stop(StopMode::Keep, now);
        assert_eq!(
            sink.states(),
            vec![
                DictationState::Preparing,
                DictationState::Recording,
                DictationState::Finalizing,
                DictationState::Completed
            ]
        );
        assert_eq!(
            sink.texts(),
            vec![
                (0, TextStage::Partial, "使用 Redis".into()),
                (0, TextStage::Partial, "使用 Redis 缓存".into()),
                (0, TextStage::Final, "使用 Redis 缓存".into()),
            ]
        );
        let sequences: Vec<u64> = sink
            .events()
            .iter()
            .map(|e| match e {
                DictationEvent::State { sequence, .. }
                | DictationEvent::Level { sequence, .. }
                | DictationEvent::Text { sequence, .. }
                | DictationEvent::Notice { sequence, .. } => *sequence,
            })
            .collect();
        assert!(
            sequences.windows(2).all(|w| w[1] == w[0] + 1),
            "{sequences:?}"
        );
    }

    #[test]
    fn later_segments_get_a_separator() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(false), sink.clone());
        session.record(Some(speaking(
            &["First part.", "", "Second"],
            &[true, false, true],
        )));
        let now = Instant::now();
        for _ in 0..3 {
            session.feed(&CHUNK, now);
        }
        let finals: Vec<String> = sink
            .texts()
            .into_iter()
            .filter(|t| t.1 == TextStage::Final)
            .map(|t| t.2)
            .collect();
        assert_eq!(finals, vec!["First part.".to_owned(), " Second".to_owned()]);
    }

    #[test]
    fn refinement_replaces_only_when_conservative_and_in_order() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(true), sink.clone());
        session.record(Some(speaking(
            &["保留 v1.2.3 的逻辑", "", "第二段"],
            &[true, false, true],
        )));
        let now = Instant::now();
        for _ in 0..3 {
            session.feed(&CHUNK, now);
        }
        let jobs = session.take_jobs();
        assert_eq!(
            jobs.iter().map(|j| j.segment).collect::<Vec<_>>(),
            vec![0, 1]
        );
        // Segment 1's result arrives first: it waits for segment 0.
        session.refined(1, Ok("第二段。".into()), now);
        assert!(
            !sink
                .texts()
                .iter()
                .any(|t| t.0 == 1 && t.1 == TextStage::Final)
        );
        // Segment 0's refinement drops the version: the base text stays.
        session.refined(0, Ok("保留 v1.3 的逻辑".into()), now);
        let finals: Vec<(u64, String)> = sink
            .texts()
            .into_iter()
            .filter(|t| t.1 == TextStage::Final)
            .map(|t| (t.0, t.2))
            .collect();
        assert_eq!(
            finals,
            vec![(0, "保留 v1.2.3 的逻辑".into()), (1, "第二段。".into())]
        );
    }

    #[test]
    fn refinement_past_its_deadline_keeps_the_base_text() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(true), sink.clone());
        session.record(Some(speaking(&["你好"], &[true])));
        let start = Instant::now();
        session.feed(&CHUNK, start);
        session.tick(start + Duration::from_secs(1));
        assert!(session.refining());
        session.tick(start + REFINE_DEADLINE);
        assert!(!session.refining());
        assert_eq!(sink.texts().last().map(|t| t.1), Some(TextStage::Final));
        assert!(sink.notices().contains(&"refineTimeout".to_owned()));
        // A result after settling is ignored.
        session.refined(0, Ok("完全不同".into()), start + REFINE_DEADLINE * 2);
        assert_eq!(
            sink.texts()
                .iter()
                .filter(|t| t.1 == TextStage::Final)
                .count(),
            1
        );
    }

    #[test]
    fn a_full_refinement_queue_finalizes_new_segments_at_once() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(true), sink.clone());
        session.record(Some(speaking(
            &["一", "", "二", "", "三"],
            &[true, false, true, false, true],
        )));
        let now = Instant::now();
        for _ in 0..5 {
            session.feed(&CHUNK, now);
        }
        assert_eq!(session.take_jobs().len(), REFINE_QUEUE);
        assert!(
            sink.texts()
                .iter()
                .any(|t| t.0 == 2 && t.1 == TextStage::Final)
        );
        assert!(sink.notices().contains(&"refineSkipped".to_owned()));
    }

    #[test]
    fn sending_settles_pending_refinement_with_the_shown_text() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(true), sink.clone());
        session.record(Some(speaking(&["发送前的话"], &[true])));
        let now = Instant::now();
        session.feed(&CHUNK, now);
        session.stop(StopMode::Send, now);
        assert_eq!(session.state(), DictationState::Completed);
        assert_eq!(
            sink.texts().last(),
            Some(&(0, TextStage::Final, "发送前的话".into()))
        );
        session.refined(0, Ok("别的".into()), now);
        assert_eq!(
            sink.texts()
                .iter()
                .filter(|t| t.1 == TextStage::Final)
                .count(),
            1
        );
    }

    #[test]
    fn stop_and_cancel_are_idempotent() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(false), sink.clone());
        session.record(Some(speaking(&["x"], &[false])));
        let now = Instant::now();
        session.feed(&CHUNK, now);
        session.stop(StopMode::Keep, now);
        session.stop(StopMode::Keep, now);
        session.cancel();
        session.stop(StopMode::Send, now);
        let states = sink.states();
        assert_eq!(
            states.iter().filter(|s| s.is_terminal()).count(),
            1,
            "{states:?}"
        );
        assert_eq!(states.last(), Some(&DictationState::Completed));
    }

    #[test]
    fn cancel_ends_without_more_text() {
        let sink = Arc::new(Recorder::default());
        let mut session = Session::new(options(true), sink.clone());
        session.record(Some(speaking(&["一", "一二"], &[true, false])));
        let now = Instant::now();
        session.feed(&CHUNK, now);
        let before = sink.texts().len();
        session.cancel();
        session.feed(&CHUNK, now);
        session.refined(0, Ok("一".into()), now);
        assert_eq!(sink.texts().len(), before);
        assert_eq!(sink.states().last(), Some(&DictationState::Cancelled));
    }

    #[test]
    fn long_silence_and_long_sessions_stop_by_themselves() {
        let sink = Arc::new(Recorder::default());
        let mut opts = options(false);
        opts.no_speech = Duration::from_millis(500);
        let mut session = Session::new(opts, sink.clone());
        session.record(Some(Coordinator::new(
            Script::default(),
            Voice::default(),
            false,
        )));
        let now = Instant::now();
        assert_eq!(session.feed(&[0.0; 4000], now), None);
        assert_eq!(session.feed(&[0.0; 4800], now), Some("noSpeech"));
        assert_eq!(session.state(), DictationState::Completed);

        let sink = Arc::new(Recorder::default());
        let mut opts = options(false);
        opts.max_audio = Duration::from_millis(400);
        let mut session = Session::new(opts, sink.clone());
        session.record(Some(speaking(&[], &[])));
        assert_eq!(session.feed(&[0.0; 6400], now), Some("maxDuration"));
        assert!(sink.notices().contains(&"maxDuration".to_owned()));
    }

    #[test]
    fn levels_are_sent_for_every_40_ms() {
        let sink = Arc::new(Recorder::default());
        let mut session: Session<Script, Voice> = Session::new(options(false), sink.clone());
        session.record(None);
        session.feed(&[0.0; 1600], Instant::now());
        let levels = sink
            .events()
            .iter()
            .filter(|e| matches!(e, DictationEvent::Level { .. }))
            .count();
        assert_eq!(levels, 2);
    }
}
