//! Voice dictation measurements through the production pipeline (voice dictation addendum
//! 3.10 and 5.4): one warm engine plays each WAV of a list at real-time pace from the
//! development audio source (the same queue, resampling, segmentation, recognition and
//! normalization a microphone goes through), stops a moment after the speech and records, per
//! file, the final text, the first partial's delay after the first speech, the time from stop
//! to the last final, and the CPU time used. Then cold loads (models freed before each start)
//! and the process's physical footprint (`footprint`) before, during and after the idle
//! timeout. Prints one JSON document.
//!
//! The WAV list is a TSV of `id<TAB>path`. `scripts/speech/eval.mjs` and
//! `scripts/perf/probe-voice.mjs` run this and judge the numbers.
//!
//!   cargo run --release -p piarc-speech --features testing --example voice-bench -- \
//!     --assets target/speech-assets/darwin-arm64 --list <tsv> [--hotwords off] [--cold 20]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::dictation::{DictationEvent, DictationState, StopMode, TextStage};
use piarc_speech::vocabulary::{Vocabulary, VocabularySources};
use piarc_speech::wav_source::read_wav;
use piarc_speech::{DictationSink, Engine, EngineConfig, SessionOptions, StartRequest};
use serde_json::{Value, json};

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
    fn state_at(&self, wanted: DictationState) -> Option<Instant> {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .find_map(|(at, e)| match e {
                DictationEvent::State { state, .. } if *state == wanted => Some(*at),
                _ => None,
            })
    }

    fn wait(&self, state: DictationState, limit: Duration) -> Option<Instant> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(at) = self.state_at(state) {
                return Some(at);
            }
            if self.state_at(DictationState::Error).is_some() {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    fn first_partial(&self) -> Option<Instant> {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .find_map(|(at, e)| match e {
                DictationEvent::Text { text, .. } if !text.trim().is_empty() => Some(*at),
                _ => None,
            })
    }

    /// The finals in segment order (the last revision of each segment) and when the last came.
    fn finals(&self) -> (Vec<String>, Option<Instant>) {
        let events = self.events.lock().expect("lock");
        let mut segments: Vec<(u64, u64, String)> = Vec::new();
        let mut last = None;
        for (at, event) in events.iter() {
            if let DictationEvent::Text {
                stage: TextStage::Final,
                segment_id,
                revision,
                text,
                ..
            } = event
            {
                last = Some(*at);
                match segments.iter_mut().find(|(id, _, _)| id == segment_id) {
                    Some(entry) if entry.1 <= *revision => {
                        entry.1 = *revision;
                        entry.2.clone_from(text);
                    }
                    Some(_) => {}
                    None => segments.push((*segment_id, *revision, text.clone())),
                }
            }
        }
        segments.sort_by_key(|(id, _, _)| *id);
        (segments.into_iter().map(|(_, _, t)| t).collect(), last)
    }
}

struct Args {
    assets: PathBuf,
    list: Option<PathBuf>,
    hotwords: bool,
    cold: usize,
}

fn args() -> Args {
    let mut args = Args {
        assets: PathBuf::new(),
        list: None,
        hotwords: true,
        cold: 0,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let value = it.next().unwrap_or_default();
        match arg.as_str() {
            "--assets" => args.assets = PathBuf::from(value),
            "--list" => args.list = Some(PathBuf::from(value)),
            "--hotwords" => args.hotwords = value != "off",
            "--cold" => args.cold = value.parse().unwrap_or(0),
            other => panic!("unknown argument {other}"),
        }
    }
    assert!(
        args.assets.is_dir(),
        "--assets must be the speech assets directory"
    );
    args
}

fn options(id: &str, hotwords: bool) -> SessionOptions {
    SessionOptions {
        id: id.to_owned(),
        vocabulary: Vocabulary::build(
            &VocabularySources {
                builtin: hotwords,
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

/// CPU seconds this process has used (`ps`, user + system).
fn cpu_seconds() -> f64 {
    let out = Command::new("ps")
        .args(["-o", "time=", "-p", &std::process::id().to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    // [[hh:]mm:]ss.cc
    out.split(':').fold(0.0, |acc, part| {
        acc * 60.0 + part.parse::<f64>().unwrap_or(0.0)
    })
}

/// This process's physical footprint in MiB (`footprint`), if the tool answers.
fn footprint_mib() -> Option<f64> {
    let out = Command::new("footprint")
        .arg(std::process::id().to_string())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("Footprint:"))?;
    let after = line.split("Footprint:").nth(1)?.trim();
    let mut parts = after.split_whitespace();
    let value: f64 = parts.next()?.parse().ok()?;
    Some(match parts.next()? {
        "KB" => value / 1024.0,
        "MB" => value,
        "GB" => value * 1024.0,
        _ => return None,
    })
}

/// Duration and the offset of the first 20 ms window louder than -40 dBFS, in seconds.
fn speech_bounds(path: &Path) -> (f64, f64) {
    let wav = read_wav(&std::fs::read(path).expect("wav")).expect("a wav file");
    let frames = wav.samples.len() / wav.channels.max(1);
    let duration = frames as f64 / f64::from(wav.rate);
    let window = (wav.rate as usize / 50).max(1) * wav.channels.max(1);
    let first = wav
        .samples
        .chunks(window)
        .position(|w| {
            let rms = (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt();
            rms > 0.01
        })
        .map_or(0.0, |i| {
            (i * window / wav.channels.max(1)) as f64 / f64::from(wav.rate)
        });
    (duration, first)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn run_file(engine: &Engine, source: &Path, id: &str, path: &Path, hotwords: bool) -> Value {
    std::fs::copy(path, source).expect("copy the wav into place");
    let (duration, speech_at) = speech_bounds(path);
    let recorder = Arc::new(Recorder::default());
    let cpu_before = cpu_seconds();
    let session = format!("bench-{id}");
    engine
        .start(
            StartRequest {
                options: options(&session, hotwords),
                device: None,
                test: false,
            },
            recorder.clone(),
        )
        .expect("start");
    let Some(recording) = recorder.wait(DictationState::Recording, Duration::from_secs(30)) else {
        return json!({ "id": id, "error": "never recording" });
    };
    // Speech plus a short tail, as a speaker pressing stop right after the last word.
    std::thread::sleep(Duration::from_secs_f64(duration + 0.3));
    let stop = Instant::now();
    engine.stop(&session, StopMode::Keep).expect("stop");
    let done = recorder.wait(DictationState::Completed, Duration::from_secs(20));
    let cpu = cpu_seconds() - cpu_before;
    let (finals, last_final) = recorder.finals();
    let first_partial = recorder
        .first_partial()
        .map(|at| ms(at.saturating_duration_since(recording)) - speech_at * 1000.0);
    json!({
        "id": id,
        "text": finals.concat(),
        "segments": finals.len(),
        "durationS": duration,
        "firstPartialMs": first_partial,
        "stopToFinalMs": last_final.map(|at| ms(at.saturating_duration_since(stop))),
        "stopToCompletedMs": done.map(|at| ms(at.saturating_duration_since(stop))),
        "cpuRtf": cpu / duration.max(0.1),
    })
}

fn main() {
    let args = args();
    let scratch = std::env::temp_dir().join(format!("piarc-voice-bench-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let source = scratch.join("source.wav");
    let silence = scratch.join("silence.wav");
    std::fs::write(&silence, silence_wav(1.0)).expect("silence");
    std::fs::copy(&silence, &source).expect("source");
    let engine = Engine::new(EngineConfig {
        speech_dir: args.assets.clone(),
        cache_dir: scratch.join("cache"),
        idle_ttl: Duration::from_secs(3),
        threads: 2,
        refine_threads: 4,
        test_source: Some(source.clone()),
    });
    let baseline = footprint_mib();
    let mut items = Vec::new();
    let mut active = None;
    if let Some(list) = &args.list {
        let text = std::fs::read_to_string(list).expect("list");
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let (id, path) = line.split_once('\t').expect("id<TAB>path");
            let item = run_file(&engine, &source, id, Path::new(path), args.hotwords);
            eprintln!("{item}");
            items.push(item);
            active = active.max(footprint_mib().map(|v| (v * 10.0) as i64));
        }
    }
    let mut cold = Vec::new();
    for i in 0..args.cold {
        engine.unload();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::copy(&silence, &source).expect("source");
        let recorder = Arc::new(Recorder::default());
        let id = format!("cold-{i}");
        let started = Instant::now();
        engine
            .start(
                StartRequest {
                    options: options(&id, args.hotwords),
                    device: None,
                    test: false,
                },
                recorder.clone(),
            )
            .expect("start");
        if let Some(at) = recorder.wait(DictationState::Recording, Duration::from_secs(30)) {
            cold.push(ms(at.saturating_duration_since(started)));
        }
        let _ = engine.cancel(&id);
        let _ = recorder.wait(DictationState::Cancelled, Duration::from_secs(10));
    }
    // After the idle timeout the models are freed.
    std::thread::sleep(Duration::from_secs(5));
    let after_ttl = footprint_mib();
    let loaded_after_ttl = engine.status().engine_loaded;
    engine.shutdown();
    let _ = std::fs::remove_dir_all(&scratch);
    let report = json!({
        "hotwords": args.hotwords,
        "items": items,
        "coldLoadMs": cold,
        "footprintMiB": {
            "baseline": baseline,
            "activeMax": active.map(|v| v as f64 / 10.0),
            "afterIdleTimeout": after_ttl,
        },
        "modelsLoadedAfterIdleTimeout": loaded_after_ttl,
    });
    println!("{report}");
}

/// A 16 kHz mono PCM WAV of `seconds` of silence.
fn silence_wav(seconds: f64) -> Vec<u8> {
    let frames = (16_000.0 * seconds) as u32;
    let size = frames * 2;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + size).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&16_000_u32.to_le_bytes());
    out.extend_from_slice(&32_000_u32.to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&size.to_le_bytes());
    out.resize(out.len() + size as usize, 0);
    out
}
