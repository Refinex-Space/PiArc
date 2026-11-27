//! Sample conversion, downmixing, resampling to 16 kHz and level metering (addendum 4.3).
//!
//! Everything here runs on the engine thread except [`Sample`], which the capture callback
//! uses to turn device samples into `f32` before queueing them.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler as _};

use crate::error::SpeechError;

/// The rate every recognizer and the VAD take.
pub const TARGET_RATE: u32 = 16_000;

/// Samples per level window at [`TARGET_RATE`] (40 ms).
pub const LEVEL_WINDOW: usize = 640;

/// Envelope buckets per level window.
pub const ENVELOPE_BUCKETS: usize = 8;

/// A device sample that converts to `f32` in [-1, 1].
pub trait Sample: Copy {
    /// The sample as `f32`, clamped to [-1, 1].
    fn to_f32(self) -> f32;
}

impl Sample for f32 {
    fn to_f32(self) -> f32 {
        if self.is_finite() {
            self.clamp(-1.0, 1.0)
        } else {
            0.0
        }
    }
}

impl Sample for f64 {
    #[expect(clippy::cast_possible_truncation, reason = "audio samples fit f32")]
    fn to_f32(self) -> f32 {
        (self as f32).to_f32()
    }
}

impl Sample for i16 {
    fn to_f32(self) -> f32 {
        f32::from(self) / 32_768.0
    }
}

impl Sample for u16 {
    fn to_f32(self) -> f32 {
        (f32::from(self) - 32_768.0) / 32_768.0
    }
}

impl Sample for i32 {
    #[expect(
        clippy::cast_precision_loss,
        reason = "24 bits of an i32 sample are enough"
    )]
    fn to_f32(self) -> f32 {
        (self as f32 / 2_147_483_648.0).to_f32()
    }
}

impl Sample for i8 {
    fn to_f32(self) -> f32 {
        f32::from(self) / 128.0
    }
}

impl Sample for u8 {
    fn to_f32(self) -> f32 {
        (f32::from(self) - 128.0) / 128.0
    }
}

/// Averages interleaved frames of `channels` channels into `out` (appended).
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    #[expect(clippy::cast_precision_loss, reason = "channel counts are tiny")]
    let scale = 1.0 / channels as f32;
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| (frame.iter().sum::<f32>() * scale).clamp(-1.0, 1.0)),
    );
}

/// Continuous mono resampling from the device rate to [`TARGET_RATE`]. One per session: the
/// filter state carries over between callbacks, and [`Resampler16k::flush`] emits the tail.
pub struct Resampler16k {
    inner: Option<Fft<f32>>,
    pending: Vec<f32>,
    output: Vec<f32>,
    /// Output samples still to drop at the start (the filter's delay).
    skip: usize,
    input_total: u64,
    output_total: u64,
    rate: u32,
}

impl Resampler16k {
    /// A resampler from `rate` Hz; 16 kHz input passes through unchanged.
    ///
    /// # Errors
    ///
    /// [`SpeechError::Audio`] for a rate rubato cannot convert (0 Hz).
    pub fn new(rate: u32) -> Result<Self, SpeechError> {
        if rate == 0 {
            return Err(SpeechError::Audio("sample rate 0"));
        }
        let inner = if rate == TARGET_RATE {
            None
        } else {
            // 10 ms of input per call; the FFT resampler keeps its state between calls.
            let chunk = (rate as usize / 100).max(16);
            Some(
                Fft::<f32>::new(
                    rate as usize,
                    TARGET_RATE as usize,
                    chunk,
                    1,
                    FixedSync::Input,
                )
                .map_err(|_| SpeechError::Audio("unsupported sample rate"))?,
            )
        };
        let (skip, output) = match &inner {
            Some(fft) => (fft.output_delay(), vec![0.0; fft.output_frames_max()]),
            None => (0, Vec::new()),
        };
        Ok(Self {
            inner,
            pending: Vec::new(),
            output,
            skip,
            input_total: 0,
            output_total: 0,
            rate,
        })
    }

    /// Converts `mono` and appends the 16 kHz samples ready so far to `out`.
    pub fn process(&mut self, mono: &[f32], out: &mut Vec<f32>) {
        self.input_total += mono.len() as u64;
        if self.inner.is_none() {
            out.extend_from_slice(mono);
            self.output_total += mono.len() as u64;
            return;
        }
        self.pending.extend_from_slice(mono);
        self.drain(out, false);
    }

    /// Emits everything still inside the filter, so the total output matches the input
    /// duration at 16 kHz (rounded).
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if self.inner.is_none() {
            return;
        }
        let expected = self.input_total * u64::from(TARGET_RATE) / u64::from(self.rate);
        // Silence pushes the filter's delayed samples out; the FFT resampler may need several
        // chunks before it emits, so keep going until the duration is reached (bounded).
        let mut rounds = 0;
        while self.output_total < expected && rounds < 256 {
            let need = self.inner.as_ref().map_or(0, Fft::input_frames_next);
            self.pending.resize(self.pending.len().max(need), 0.0);
            self.drain(out, true);
            rounds += 1;
        }
        if self.output_total > expected {
            let extra = usize::try_from(self.output_total - expected).unwrap_or(usize::MAX);
            out.truncate(out.len().saturating_sub(extra));
            self.output_total = expected;
        }
        self.pending.clear();
    }

    fn drain(&mut self, out: &mut Vec<f32>, flushing: bool) {
        let Some(fft) = self.inner.as_mut() else {
            return;
        };
        loop {
            let need = fft.input_frames_next();
            if self.pending.len() < need {
                if flushing && !self.pending.is_empty() {
                    self.pending.resize(need, 0.0);
                } else {
                    return;
                }
            }
            let Ok(input) = InterleavedSlice::new(&self.pending[..need], 1, need) else {
                return;
            };
            let frames = self.output.len();
            let Ok(mut output) = InterleavedSlice::new_mut(&mut self.output, 1, frames) else {
                return;
            };
            let indexing = Indexing::new();
            let Ok((used, produced)) =
                fft.process_into_buffer(&input, &mut output, Some(&indexing))
            else {
                return;
            };
            self.pending.drain(..used.min(self.pending.len()));
            let skipped = produced.min(self.skip);
            self.skip -= skipped;
            out.extend_from_slice(&self.output[skipped..produced]);
            self.output_total += (produced - skipped) as u64;
            if flushing {
                return;
            }
        }
    }
}

/// One 40 ms level reading.
#[derive(Debug, Clone, PartialEq)]
pub struct Level {
    /// Captured audio at the end of the window, in ms.
    pub audio_ms: u64,
    /// Root mean square.
    pub rms: f32,
    /// Peak absolute sample.
    pub peak: f32,
    /// Peak of each of [`ENVELOPE_BUCKETS`] equal parts.
    pub envelope: Vec<f32>,
}

/// Cuts the 16 kHz stream into 40 ms windows and measures each.
#[derive(Debug, Default)]
pub struct LevelMeter {
    window: Vec<f32>,
    samples: u64,
}

impl LevelMeter {
    /// Feeds 16 kHz samples; returns a reading for every completed window.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Level> {
        let mut levels = Vec::new();
        for &sample in samples {
            self.window.push(sample);
            self.samples += 1;
            if self.window.len() == LEVEL_WINDOW {
                levels.push(measure(
                    &self.window,
                    self.samples * 1000 / u64::from(TARGET_RATE),
                ));
                self.window.clear();
            }
        }
        levels
    }

    /// Audio measured so far, in ms.
    pub fn audio_ms(&self) -> u64 {
        self.samples * 1000 / u64::from(TARGET_RATE)
    }
}

fn measure(window: &[f32], audio_ms: u64) -> Level {
    #[expect(clippy::cast_precision_loss, reason = "window lengths are small")]
    let len = window.len().max(1) as f32;
    let rms = (window.iter().map(|s| s * s).sum::<f32>() / len).sqrt();
    let peak = window.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
    let bucket = window.len().div_ceil(ENVELOPE_BUCKETS).max(1);
    let envelope = window
        .chunks(bucket)
        .map(|part| part.iter().fold(0.0_f32, |m, s| m.max(s.abs())))
        .collect();
    Level {
        audio_ms,
        rms: rms.min(1.0),
        peak: peak.min(1.0),
        envelope,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, seconds: f32, hz: f32) -> Vec<f32> {
        #[expect(clippy::cast_possible_truncation, reason = "test lengths")]
        #[expect(clippy::cast_sign_loss, reason = "positive")]
        let n = (rate as f32 * seconds) as usize;
        #[expect(clippy::cast_precision_loss, reason = "test signal")]
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn resample_in(chunks: &[usize], input: &[f32], rate: u32) -> Vec<f32> {
        let mut resampler = Resampler16k::new(rate).expect("resampler");
        let mut out = Vec::new();
        let mut at = 0;
        let mut i = 0;
        while at < input.len() {
            let size = chunks[i % chunks.len()].min(input.len() - at);
            resampler.process(&input[at..at + size], &mut out);
            at += size;
            i += 1;
        }
        resampler.flush(&mut out);
        out
    }

    #[test]
    fn resampling_is_continuous_across_callback_sizes() {
        let input = sine(48_000, 1.0, 440.0);
        let whole = resample_in(&[input.len()], &input, 48_000);
        for chunks in [&[1_usize, 127, 480][..], &[4096], &[13, 1000, 7]] {
            let pieces = resample_in(chunks, &input, 48_000);
            assert_eq!(pieces.len(), whole.len(), "{chunks:?}");
            let worst = pieces
                .iter()
                .zip(&whole)
                .fold(0.0_f32, |m, (a, b)| m.max((a - b).abs()));
            assert!(worst <= 1e-4, "{chunks:?}: {worst}");
        }
    }

    #[test]
    fn flush_keeps_the_duration() {
        for rate in [44_100, 48_000, 22_050, 96_000, 8_000] {
            let input = sine(rate, 0.73, 300.0);
            let out = resample_in(&[333], &input, rate);
            let expected = input.len() as u64 * 16_000 / u64::from(rate);
            assert_eq!(out.len() as u64, expected, "{rate}");
        }
    }

    #[test]
    fn resampled_sine_keeps_its_amplitude() {
        let out = resample_in(&[480], &sine(48_000, 1.0, 440.0), 48_000);
        let middle = &out[2000..14_000];
        let peak = middle.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        assert!((peak - 0.5).abs() < 0.02, "{peak}");
    }

    #[test]
    fn sixteen_kilohertz_passes_through() {
        let input = sine(16_000, 0.1, 200.0);
        assert_eq!(resample_in(&[100], &input, 16_000), input);
    }

    #[test]
    fn downmix_averages_and_clamps() {
        let mut out = Vec::new();
        downmix(&[0.5, -0.5, 1.0, 1.0, 0.2, 0.4], 2, &mut out);
        assert_eq!(out.len(), 3);
        assert!(out[0].abs() < 1e-6 && (out[1] - 1.0).abs() < 1e-6 && (out[2] - 0.3).abs() < 1e-6);
        let mut mono = Vec::new();
        downmix(&[0.1, 0.2], 1, &mut mono);
        assert_eq!(mono, vec![0.1, 0.2]);
    }

    #[test]
    fn device_formats_convert_to_the_same_level() {
        assert!((i16::MAX.to_f32() - 1.0).abs() < 1e-3);
        assert!((u16::MAX.to_f32() - 1.0).abs() < 1e-3);
        assert!((u16::MIN.to_f32() + 1.0).abs() < 1e-6);
        assert!((i32::MIN.to_f32() + 1.0).abs() < 1e-6);
        assert!((u8::MAX.to_f32() - 1.0).abs() < 1e-2);
        assert_eq!(f32::NAN.to_f32(), 0.0);
        assert_eq!(2.0_f32.to_f32(), 1.0);
    }

    #[test]
    fn levels_come_every_40_ms_and_silence_is_flat() {
        let mut meter = LevelMeter::default();
        let silence = meter.push(&vec![0.0; 1280]);
        assert_eq!(silence.len(), 2);
        assert_eq!(silence[1].audio_ms, 80);
        assert!(silence.iter().all(|l| l.rms == 0.0 && l.peak == 0.0));
        assert_eq!(silence[0].envelope.len(), ENVELOPE_BUCKETS);
        let loud = meter.push(&sine(16_000, 0.04, 400.0));
        assert_eq!(loud.len(), 1);
        assert!(loud[0].peak > 0.4 && loud[0].rms > 0.3, "{loud:?}");
    }

    #[test]
    fn a_zero_rate_is_refused() {
        assert!(Resampler16k::new(0).is_err());
    }
}
