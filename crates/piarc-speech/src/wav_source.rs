//! Development-build audio source (feature `testing`, addendum V-9.5): plays a WAV file into
//! the same queue a microphone fills, at real-time pace on an absolute schedule, in the
//! file's own format and in callback-sized pieces of varying length, then keeps feeding
//! silence. Release builds do not have this module; `check-app-layout` looks for
//! [`MARKER`] in the release Core module and fails when it finds it.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::capture::Capture;
use crate::error::SpeechError;

/// String compiled into builds that contain the WAV source.
pub const MARKER: &str = "piarc-speech-test-wav-source";

/// Interleaved samples of a WAV file.
#[derive(Debug, Clone, PartialEq)]
pub struct Wav {
    /// Samples, interleaved, in [-1, 1].
    pub samples: Vec<f32>,
    /// Channels.
    pub channels: usize,
    /// Rate.
    pub rate: u32,
}

/// Reads a PCM 16-bit or IEEE float 32-bit WAV file.
///
/// # Errors
///
/// [`SpeechError::Audio`] for anything else.
pub fn read_wav(bytes: &[u8]) -> Result<Wav, SpeechError> {
    let bad = SpeechError::Audio("wav");
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad);
    }
    let mut at = 12;
    let mut format = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
            as usize;
        let body = bytes
            .get(at + 8..at + 8 + size)
            .ok_or(SpeechError::Audio("wav"))?;
        if id == b"fmt " && body.len() >= 16 {
            let tag = u16::from_le_bytes([body[0], body[1]]);
            let channels = usize::from(u16::from_le_bytes([body[2], body[3]]));
            let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            format = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or(SpeechError::Audio("wav"))?;
            let samples = match (tag, bits) {
                (1, 16) => body
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| f32::from(i16::from_le_bytes(*b)) / 32_768.0)
                    .collect(),
                (3, 32) => body
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| f32::from_le_bytes(*b).clamp(-1.0, 1.0))
                    .collect(),
                _ => return Err(SpeechError::Audio("wav format")),
            };
            if channels == 0 || rate == 0 {
                return Err(SpeechError::Audio("wav"));
            }
            return Ok(Wav {
                samples,
                channels,
                rate,
            });
        }
        at += 8 + size + (size & 1);
    }
    Err(bad)
}

/// The thread that feeds the queue; stopping it is dropping it.
pub struct Feeder {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Feeder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Opens a capture that plays `path`. `fail` set from outside makes it report a device
/// error (the same path a removed microphone takes).
///
/// # Errors
///
/// [`SpeechError::NoDevice`] when the file cannot be read, [`SpeechError::Audio`] when it is
/// not a supported WAV file.
pub fn open(path: &Path, fail: Arc<AtomicBool>) -> Result<Capture, SpeechError> {
    let bytes = std::fs::read(path).map_err(|_| SpeechError::NoDevice)?;
    let wav = read_wav(&bytes)?;
    let (mut producer, consumer) = rtrb::RingBuffer::new(wav.rate as usize * wav.channels * 2);
    let overflow = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let channels = wav.channels;
    let rate = wav.rate;
    let thread = {
        let stop = Arc::clone(&stop);
        let overflow = Arc::clone(&overflow);
        std::thread::Builder::new()
            .name(MARKER.to_owned())
            .spawn(move || {
                let started = Instant::now();
                let frames_per_ms = f64::from(wav.rate) / 1000.0;
                let mut sent_frames = 0_usize;
                // Callback sizes cycle through these (in frames), like real devices vary.
                let sizes = [480_usize, 512, 441, 1024, 128, 960];
                let mut i = 0;
                while !stop.load(Ordering::Relaxed) {
                    let size = sizes[i % sizes.len()];
                    i += 1;
                    for frame in sent_frames..sent_frames + size {
                        for channel in 0..channels {
                            let sample = wav
                                .samples
                                .get(frame * channels + channel)
                                .copied()
                                .unwrap_or(0.0);
                            if producer.push(sample).is_err() {
                                overflow.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    sent_frames += size;
                    #[expect(clippy::cast_precision_loss, reason = "frame counts of a test file")]
                    #[expect(
                        clippy::cast_possible_truncation,
                        reason = "milliseconds of a test run"
                    )]
                    #[expect(clippy::cast_sign_loss, reason = "positive")]
                    let due = started
                        + Duration::from_millis((sent_frames as f64 / frames_per_ms) as u64);
                    let now = Instant::now();
                    if due > now {
                        std::thread::sleep(due - now);
                    }
                }
            })
            .map_err(|_| SpeechError::NoDevice)?
    };
    let capture =
        Capture::from_parts(consumer, channels, rate, overflow, fail).with_feeder(Feeder {
            stop,
            thread: Some(thread),
        });
    Ok(capture)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(channels: u16, rate: u32, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + u32::try_from(data.len()).expect("size")).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16_u32.to_le_bytes());
        out.extend_from_slice(&1_u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16_u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&u32::try_from(data.len()).expect("size").to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn pcm16_wav_files_are_read() {
        let wav = read_wav(&wav_bytes(2, 48_000, &[16_384, -16_384, 0, 0])).expect("wav");
        assert_eq!(wav.channels, 2);
        assert_eq!(wav.rate, 48_000);
        assert_eq!(wav.samples, vec![0.5, -0.5, 0.0, 0.0]);
        assert!(read_wav(b"not a wav file").is_err());
    }

    #[test]
    fn the_source_plays_at_real_time_pace() {
        let dir = std::env::temp_dir().join(format!("piarc-wav-source-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("tone.wav");
        std::fs::write(&file, wav_bytes(1, 16_000, &vec![1000; 16_000])).expect("write");
        let mut capture = open(&file, Arc::new(AtomicBool::new(false))).expect("open");
        let started = Instant::now();
        let mut out = Vec::new();
        while out.len() < 4_000 {
            capture.read(&mut out);
            std::thread::sleep(Duration::from_millis(5));
        }
        // 4,000 samples at 16 kHz take 250 ms to arrive in real time.
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "{:?}",
            started.elapsed()
        );
        drop(capture);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
