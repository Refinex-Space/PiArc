//! The one segmentation coordinator (addendum 4.3): the same 16 kHz timeline goes to the
//! streaming recognizer and to the VAD. Only the recognizer's endpoint rules end a segment;
//! the VAD says whether a segment held speech at all (no speech, no text) and how long the
//! input has been silent.

use crate::audio::TARGET_RATE;
use crate::recognizer::{Activity, Streaming};

/// Most samples a segment keeps for refinement (20.5 s; the 20 s endpoint rule ends it first).
const MAX_SEGMENT_SAMPLES: usize = 20 * TARGET_RATE as usize + TARGET_RATE as usize / 2;

/// What the coordinator found in new audio.
#[derive(Debug, Clone, PartialEq)]
pub enum Found {
    /// The running hypothesis of `segment` changed.
    Partial {
        /// Segment.
        segment: u64,
        /// Hypothesis.
        text: String,
    },
    /// `segment` ended with text. `pcm` is its audio when refinement asked for it.
    Segment {
        /// Segment.
        segment: u64,
        /// Final text of the streaming recognizer.
        text: String,
        /// The segment's 16 kHz audio.
        pcm: Option<Vec<f32>>,
    },
    /// `segment` ended without speech: drop its partial.
    Discarded {
        /// Segment.
        segment: u64,
    },
}

/// Segments one session's audio.
pub struct Coordinator<S, V> {
    online: S,
    vad: V,
    keep_pcm: bool,
    segment: u64,
    partial: String,
    speech_in_segment: bool,
    pcm: Vec<f32>,
    samples: u64,
    last_speech: u64,
}

impl<S: Streaming, V: Activity> Coordinator<S, V> {
    /// A coordinator; `keep_pcm` collects each segment's audio for refinement.
    pub fn new(online: S, vad: V, keep_pcm: bool) -> Self {
        Self {
            online,
            vad,
            keep_pcm,
            segment: 0,
            partial: String::new(),
            speech_in_segment: false,
            pcm: Vec::new(),
            samples: 0,
            last_speech: 0,
        }
    }

    /// Feeds 16 kHz samples and reports what changed.
    pub fn push(&mut self, samples: &[f32], found: &mut Vec<Found>) {
        if samples.is_empty() {
            return;
        }
        self.samples += samples.len() as u64;
        self.vad.accept(samples);
        if self.vad.speaking() {
            self.speech_in_segment = true;
            self.last_speech = self.samples;
        }
        if self.keep_pcm && self.pcm.len() < MAX_SEGMENT_SAMPLES {
            let room = MAX_SEGMENT_SAMPLES - self.pcm.len();
            self.pcm
                .extend_from_slice(&samples[..samples.len().min(room)]);
        }
        self.online.accept(samples);
        self.online.decode();
        let text = self.online.text();
        if !text.is_empty() && text != self.partial {
            self.partial.clone_from(&text);
            found.push(Found::Partial {
                segment: self.segment,
                text,
            });
        }
        if self.online.is_endpoint() {
            self.end_segment(found);
            self.online.reset();
        }
    }

    /// Ends the input: pads, decodes the rest and reports the last segment.
    pub fn finish(&mut self, found: &mut Vec<Found>) {
        self.online.finish();
        let text = self.online.text();
        if !text.is_empty() && text != self.partial {
            self.partial = text;
        }
        self.end_segment(found);
    }

    fn end_segment(&mut self, found: &mut Vec<Found>) {
        let text = self.online.text();
        let had_output = !self.partial.is_empty() || !text.is_empty();
        if !text.trim().is_empty() && self.speech_in_segment {
            let pcm = self.keep_pcm.then(|| std::mem::take(&mut self.pcm));
            found.push(Found::Segment {
                segment: self.segment,
                text,
                pcm,
            });
        } else if !self.partial.is_empty() {
            found.push(Found::Discarded {
                segment: self.segment,
            });
        }
        if had_output {
            self.segment += 1;
        }
        self.partial.clear();
        self.pcm.clear();
        self.speech_in_segment = self.vad.speaking();
    }

    /// Audio fed so far, in ms.
    pub fn audio_ms(&self) -> u64 {
        self.samples * 1000 / u64::from(TARGET_RATE)
    }

    /// Time since speech was last detected (or since the start), in ms.
    pub fn silent_ms(&self) -> u64 {
        (self.samples - self.last_speech) * 1000 / u64::from(TARGET_RATE)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::VecDeque;

    use super::*;

    /// A scripted recognizer: each `accept` call takes the next text; `endpoint_after` makes
    /// the call with that index report an endpoint.
    #[derive(Default)]
    pub(crate) struct Script {
        pub texts: VecDeque<&'static str>,
        pub endpoints: VecDeque<bool>,
        pub current: String,
        pub endpoint: bool,
        pub finished: bool,
        pub tail: Option<&'static str>,
    }

    impl Streaming for Script {
        fn accept(&mut self, _samples: &[f32]) {
            if let Some(text) = self.texts.pop_front() {
                self.current = text.to_owned();
            }
            self.endpoint = self.endpoints.pop_front().unwrap_or(false);
        }
        fn decode(&mut self) {}
        fn text(&self) -> String {
            self.current.clone()
        }
        fn is_endpoint(&self) -> bool {
            self.endpoint
        }
        fn reset(&mut self) {
            self.current.clear();
            self.endpoint = false;
        }
        fn finish(&mut self) {
            self.finished = true;
            if let Some(tail) = self.tail {
                self.current = tail.to_owned();
            }
        }
    }

    /// A VAD that reports a fixed answer per call.
    #[derive(Default)]
    pub(crate) struct Voice {
        pub answers: VecDeque<bool>,
        pub now: bool,
    }

    impl Activity for Voice {
        fn accept(&mut self, _samples: &[f32]) {
            self.now = self.answers.pop_front().unwrap_or(self.now);
        }
        fn speaking(&self) -> bool {
            self.now
        }
    }

    const CHUNK: [f32; 320] = [0.0; 320];

    #[test]
    fn partials_replace_each_other_and_an_endpoint_ends_the_segment() {
        let online = Script {
            texts: VecDeque::from(["你", "你好", "你好", "", "世"]),
            endpoints: VecDeque::from([false, false, true, false, false]),
            ..Script::default()
        };
        let vad = Voice {
            answers: VecDeque::from([true, true, false, false, true]),
            ..Voice::default()
        };
        let mut coordinator = Coordinator::new(online, vad, true);
        let mut found = Vec::new();
        for _ in 0..5 {
            coordinator.push(&CHUNK, &mut found);
        }
        assert_eq!(
            found[..3],
            [
                Found::Partial {
                    segment: 0,
                    text: "你".into()
                },
                Found::Partial {
                    segment: 0,
                    text: "你好".into()
                },
                Found::Segment {
                    segment: 0,
                    text: "你好".into(),
                    pcm: Some(vec![0.0; 960])
                },
            ]
        );
        assert_eq!(
            found[3],
            Found::Partial {
                segment: 1,
                text: "世".into()
            }
        );
    }

    #[test]
    fn a_segment_without_speech_gives_no_text() {
        let online = Script {
            texts: VecDeque::from(["嗯"]),
            endpoints: VecDeque::from([true]),
            ..Script::default()
        };
        let mut coordinator = Coordinator::new(online, Voice::default(), false);
        let mut found = Vec::new();
        coordinator.push(&CHUNK, &mut found);
        assert_eq!(
            found,
            vec![
                Found::Partial {
                    segment: 0,
                    text: "嗯".into()
                },
                Found::Discarded { segment: 0 },
            ]
        );
    }

    #[test]
    fn finishing_keeps_the_last_words() {
        let online = Script {
            texts: VecDeque::from(["the last"]),
            tail: Some("the last word"),
            ..Script::default()
        };
        let vad = Voice {
            answers: VecDeque::from([true]),
            ..Voice::default()
        };
        let mut coordinator = Coordinator::new(online, vad, false);
        let mut found = Vec::new();
        coordinator.push(&CHUNK, &mut found);
        coordinator.finish(&mut found);
        assert_eq!(
            found.last(),
            Some(&Found::Segment {
                segment: 0,
                text: "the last word".into(),
                pcm: None
            })
        );
    }

    #[test]
    fn silence_is_measured_in_audio_time() {
        let vad = Voice {
            answers: VecDeque::from([true, false, false]),
            ..Voice::default()
        };
        let mut coordinator = Coordinator::new(Script::default(), vad, false);
        let mut found = Vec::new();
        for _ in 0..3 {
            coordinator.push(&[0.0; 1600], &mut found);
        }
        assert_eq!(coordinator.audio_ms(), 300);
        assert_eq!(coordinator.silent_ms(), 200);
        assert!(found.is_empty());
    }

    #[test]
    fn segment_audio_is_bounded() {
        let vad = Voice {
            answers: VecDeque::from([true]),
            ..Voice::default()
        };
        let online = Script {
            texts: VecDeque::from(["x"]),
            tail: Some("x"),
            ..Script::default()
        };
        let mut coordinator = Coordinator::new(online, vad, true);
        let mut found = Vec::new();
        for _ in 0..30 {
            coordinator.push(&vec![0.1; 16_000], &mut found);
        }
        coordinator.finish(&mut found);
        let Some(Found::Segment { pcm: Some(pcm), .. }) = found.last() else {
            unreachable!("a segment with audio: {found:?}");
        };
        assert_eq!(pcm.len(), MAX_SEGMENT_SAMPLES);
    }
}
