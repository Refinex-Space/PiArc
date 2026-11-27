//! Real-model tests through the production pipeline (addendum 5.1): the development WAV
//! source plays real speech at real-time pace into the same queue a microphone fills; the
//! engine downmixes, resamples, segments, recognizes and emits events exactly as in the app.
//!
//! The models are large and not in Git: `node scripts/dev/fetch-speech-assets.mjs` lays them
//! out in `target/speech-assets/`. Without `PIARC_REQUIRE_SPEECH_MODELS=1` these tests print
//! NOT RUN and do nothing (they then prove nothing); with it, missing assets fail.
//!
//! Run: `PIARC_REQUIRE_SPEECH_MODELS=1 cargo test -p piarc-speech --features testing --test real_model -- --nocapture`
#![cfg(feature = "testing")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::dictation::{DictationEvent, DictationState, StopMode, TextStage};
use piarc_speech::models::target_key;
use piarc_speech::vocabulary::{Vocabulary, VocabularySources};
use piarc_speech::{DictationSink, Engine, EngineConfig, SessionOptions, StartRequest};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn assets() -> Option<PathBuf> {
    if std::env::var("PIARC_REQUIRE_SPEECH_MODELS").as_deref() != Ok("1") {
        println!(
            "NOT RUN: set PIARC_REQUIRE_SPEECH_MODELS=1 after node scripts/dev/fetch-speech-assets.mjs"
        );
        return None;
    }
    let dir = std::env::var_os("PIARC_SPEECH_ASSETS").map_or_else(
        || {
            repo()
                .join("target")
                .join("speech-assets")
                .join(target_key())
        },
        PathBuf::from,
    );
    assert!(dir.is_dir(), "speech assets missing at {}", dir.display());
    Some(dir)
}

fn test_wav(name: &str) -> PathBuf {
    repo()
        .join("target")
        .join("speech-assets")
        .join("test-wavs")
        .join(name)
}

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<(Instant, DictationEvent)>>,
}

impl DictationSink for Recorder {
    fn send(&self, event: DictationEvent) {
        self.events
            .lock()
            .expect("lock")
            .push((Instant::now(), event));
    }
    fn send_level(&self, event: DictationEvent) {
        self.send(event);
    }
}

impl Recorder {
    fn snapshot(&self) -> Vec<(Instant, DictationEvent)> {
        self.events.lock().expect("lock").clone()
    }

    fn state_at(&self, wanted: DictationState) -> Option<Instant> {
        self.snapshot().into_iter().find_map(|(at, e)| match e {
            DictationEvent::State { state, .. } if state == wanted => Some(at),
            _ => None,
        })
    }

    fn finals(&self) -> Vec<String> {
        self.snapshot()
            .into_iter()
            .filter_map(|(_, e)| match e {
                DictationEvent::Text {
                    stage: TextStage::Final,
                    text,
                    ..
                } => Some(text),
                _ => None,
            })
            .collect()
    }

    fn first_partial(&self) -> Option<Instant> {
        self.snapshot().into_iter().find_map(|(at, e)| match e {
            DictationEvent::Text {
                stage: TextStage::Partial,
                text,
                ..
            } if !text.is_empty() => Some(at),
            _ => None,
        })
    }

    fn wait_for(&self, state: DictationState, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if self.state_at(state).is_some() || self.state_at(DictationState::Error).is_some() {
                return self.state_at(state).is_some();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

fn engine(speech: &Path, wav: &Path) -> Engine {
    Engine::new(EngineConfig {
        speech_dir: speech.to_path_buf(),
        cache_dir: std::env::temp_dir().join("piarc-speech-real-model-cache"),
        idle_ttl: Duration::from_secs(60),
        threads: 2,
        refine_threads: 4,
        test_source: Some(wav.to_path_buf()),
    })
}

fn options(id: &str) -> SessionOptions {
    SessionOptions {
        id: id.to_owned(),
        vocabulary: Vocabulary::build(
            &VocabularySources {
                builtin: true,
                custom: &[],
                workspace: &[],
            },
            None,
        ),
        punctuation: true,
        refine: false,
        max_audio: Duration::from_secs(600),
        no_speech: Duration::from_secs(30),
    }
}

/// Plays `wav` for `seconds`, stops and returns the recorder.
fn dictate(speech: &Path, wav: &Path, seconds: f32, id: &str) -> Arc<Recorder> {
    let engine = engine(speech, wav);
    let recorder = Arc::new(Recorder::default());
    engine
        .start(
            StartRequest {
                options: options(id),
                device: None,
                test: false,
            },
            recorder.clone(),
        )
        .expect("start");
    assert!(
        recorder.wait_for(DictationState::Recording, Duration::from_secs(20)),
        "never recording: {:?}",
        recorder.snapshot().last()
    );
    std::thread::sleep(Duration::from_secs_f32(seconds));
    engine.stop(id, StopMode::Keep).expect("stop");
    assert!(recorder.wait_for(DictationState::Completed, Duration::from_secs(10)));
    engine.shutdown();
    recorder
}

#[test]
fn partials_arrive_before_the_end_and_the_last_words_are_kept() {
    let Some(speech) = assets() else { return };
    let recorder = dictate(&speech, &test_wav("0.wav"), 10.6, "real-0");
    let recording = recorder
        .state_at(DictationState::Recording)
        .expect("recording");
    let partial = recorder.first_partial().expect("a partial");
    // 0.wav is 10.05 s long; the first words must show long before it ends.
    assert!(
        partial.duration_since(recording) < Duration::from_secs(4),
        "{:?}",
        partial.duration_since(recording)
    );
    let text = recorder.finals().concat().to_lowercase();
    println!("0.wav: {text}");
    for expected in ["昨天是", "monday", "星期三"] {
        assert!(text.contains(expected), "{expected} missing from {text}");
    }
}

#[test]
fn mixed_chinese_and_english_is_recognized_from_48_khz_stereo() {
    let Some(speech) = assets() else { return };
    // The same speech as a 48 kHz stereo file, the format of a typical microphone.
    let source = std::fs::read(test_wav("2.wav")).expect("2.wav");
    let wav = piarc_speech::wav_source::read_wav(&source).expect("wav");
    let stereo = std::env::temp_dir().join(format!("piarc-speech-48k-{}.wav", std::process::id()));
    std::fs::write(&stereo, upsample_stereo(&wav.samples, wav.rate)).expect("write");
    let recorder = dictate(&speech, &stereo, 5.2, "real-2");
    let text = recorder.finals().concat().to_lowercase();
    println!("2.wav at 48 kHz stereo: {text}");
    assert!(text.contains("frequently"), "{text}");
    assert!(text.contains("频繁"), "{text}");
    let _ = std::fs::remove_file(stereo);
}

#[test]
fn silence_gives_no_text() {
    let Some(speech) = assets() else { return };
    let silence =
        std::env::temp_dir().join(format!("piarc-speech-silence-{}.wav", std::process::id()));
    std::fs::write(&silence, pcm16_wav(1, 16_000, &vec![0; 16_000 * 3])).expect("write");
    let recorder = dictate(&speech, &silence, 3.0, "real-silence");
    assert!(recorder.finals().is_empty(), "{:?}", recorder.finals());
    let _ = std::fs::remove_file(silence);
}

#[test]
fn decoding_is_deterministic() {
    let Some(speech) = assets() else { return };
    let first = dictate(&speech, &test_wav("1.wav"), 5.4, "real-1a").finals();
    let second = dictate(&speech, &test_wav("1.wav"), 5.4, "real-1b").finals();
    println!("1.wav: {first:?}");
    assert_eq!(first, second);
    assert!(first.concat().to_lowercase().contains("always"));
}

fn pcm16_wav(channels: u16, rate: u32, samples: &[i16]) -> Vec<u8> {
    let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    let size = u32::try_from(data.len()).expect("size");
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + size).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&data);
    out
}

/// Linear interpolation to 48 kHz, duplicated to two channels.
fn upsample_stereo(samples: &[f32], rate: u32) -> Vec<u8> {
    let ratio = f64::from(48_000_u32) / f64::from(rate);
    #[expect(clippy::cast_possible_truncation, reason = "test lengths")]
    #[expect(clippy::cast_sign_loss, reason = "positive")]
    #[expect(clippy::cast_precision_loss, reason = "test lengths")]
    let frames = (samples.len() as f64 * ratio) as usize;
    let mut out = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        #[expect(clippy::cast_precision_loss, reason = "test lengths")]
        let at = i as f64 / ratio;
        #[expect(clippy::cast_possible_truncation, reason = "index")]
        #[expect(clippy::cast_sign_loss, reason = "positive")]
        let j = at as usize;
        let a = f64::from(samples.get(j).copied().unwrap_or(0.0));
        let b = f64::from(samples.get(j + 1).copied().unwrap_or(0.0));
        #[expect(clippy::cast_precision_loss, reason = "test lengths")]
        let value = a + (b - a) * (at - j as f64);
        #[expect(clippy::cast_possible_truncation, reason = "clamped to i16")]
        let sample = (value * 32_767.0).clamp(-32_768.0, 32_767.0) as i16;
        out.push(sample);
        out.push(sample);
    }
    pcm16_wav(2, 48_000, &out)
}
