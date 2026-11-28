//! Audio capture (addendum 4.3): CPAL on the engine thread, or a WAV file at real-time pace in
//! development builds (feature `testing`, addendum V-9.5). The device callback only converts
//! samples to `f32` and pushes them into a bounded single-producer queue; when the queue is
//! full the samples are dropped and counted, never waited for.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use piarc_protocol::dictation::InputDevice;
use sha2::{Digest, Sha256};

use crate::audio::Sample;
use crate::error::SpeechError;

/// Queue capacity in seconds of device audio (addendum 4.1: about two seconds).
const QUEUE_SECONDS: usize = 2;

/// An open input: samples arrive interleaved at `rate` with `channels` channels.
pub struct Capture {
    _stream: Option<cpal::Stream>,
    #[cfg(feature = "testing")]
    _feeder: Option<crate::wav_source::Feeder>,
    consumer: rtrb::Consumer<f32>,
    /// Channels per frame.
    pub channels: usize,
    /// Device sample rate.
    pub rate: u32,
    overflow: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
    /// The requested device was not found and the default one was opened instead.
    pub fell_back: bool,
}

impl Capture {
    /// Moves every queued sample into `out` (interleaved).
    pub fn read(&mut self, out: &mut Vec<f32>) {
        let available = self.consumer.slots();
        if available == 0 {
            return;
        }
        if let Ok(chunk) = self.consumer.read_chunk(available) {
            let (first, second) = chunk.as_slices();
            out.extend_from_slice(first);
            out.extend_from_slice(second);
            chunk.commit_all();
        }
    }

    /// Samples dropped because the queue was full since the last call.
    pub fn take_overflow(&self) -> u64 {
        self.overflow.swap(0, Ordering::Relaxed)
    }

    /// Whether the device reported an error (removed, permission revoked, stopped).
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }

    /// A capture fed by the caller (tests and the WAV source).
    pub(crate) fn from_parts(
        consumer: rtrb::Consumer<f32>,
        channels: usize,
        rate: u32,
        overflow: Arc<AtomicU64>,
        failed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            _stream: None,
            #[cfg(feature = "testing")]
            _feeder: None,
            consumer,
            channels,
            rate,
            overflow,
            failed,
            fell_back: false,
        }
    }

    #[cfg(feature = "testing")]
    pub(crate) fn with_feeder(mut self, feeder: crate::wav_source::Feeder) -> Self {
        self._feeder = Some(feeder);
        self
    }
}

/// The opaque id of a device: the first 16 hex digits of the SHA-256 of CPAL's device id, so
/// settings never hold the system's device identifiers.
fn opaque_id(device: &cpal::Device) -> Option<String> {
    let id = device.id().ok()?.to_string();
    let digest = Sha256::digest(id.as_bytes());
    Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// The input devices, the system default first.
///
/// # Errors
///
/// [`SpeechError::NoDevice`] when the audio system cannot be queried.
pub fn devices() -> Result<Vec<InputDevice>, SpeechError> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| opaque_id(&d));
    let mut list: Vec<InputDevice> = host
        .input_devices()
        .map_err(|_| SpeechError::NoDevice)?
        .filter_map(|device| {
            let id = opaque_id(&device)?;
            let name = device
                .description()
                .map(|d| d.name().to_owned())
                .unwrap_or_else(|_| id.clone());
            Some(InputDevice {
                default: default.as_deref() == Some(id.as_str()),
                id,
                name,
            })
        })
        .collect();
    list.sort_by_key(|d| !d.default);
    Ok(list)
}

/// Opens `device` (an opaque id from [`devices`]), or the system default when it is `None`
/// or no longer present.
///
/// # Errors
///
/// [`SpeechError::NoDevice`] without any input device, [`SpeechError::DeviceLost`] when the
/// device refuses to open, [`SpeechError::Audio`] for a sample format CPAL does not convert.
pub fn open(device: Option<&str>) -> Result<Capture, SpeechError> {
    let host = cpal::default_host();
    let mut fell_back = false;
    let chosen = match device {
        Some(wanted) => {
            let found = host
                .input_devices()
                .ok()
                .and_then(|mut all| all.find(|d| opaque_id(d).as_deref() == Some(wanted)));
            if found.is_none() {
                fell_back = true;
            }
            found.or_else(|| host.default_input_device())
        }
        None => host.default_input_device(),
    }
    .ok_or(SpeechError::NoDevice)?;
    let config = chosen
        .default_input_config()
        .map_err(|_| SpeechError::DeviceLost)?;
    let channels = usize::from(config.channels().max(1));
    let rate = config.sample_rate();
    let (producer, consumer) = rtrb::RingBuffer::new(rate as usize * channels * QUEUE_SECONDS);
    let overflow = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let stream = build(&chosen, &config, producer, &overflow, &failed)?;
    stream.play().map_err(|_| SpeechError::DeviceLost)?;
    let mut capture = Capture::from_parts(consumer, channels, rate, overflow, failed);
    capture._stream = Some(stream);
    capture.fell_back = fell_back;
    Ok(capture)
}

fn build(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    producer: rtrb::Producer<f32>,
    overflow: &Arc<AtomicU64>,
    failed: &Arc<AtomicBool>,
) -> Result<cpal::Stream, SpeechError> {
    let stream_config: cpal::StreamConfig = (*config).into();
    let on_error = {
        let failed = Arc::clone(failed);
        move |_error: cpal::Error| failed.store(true, Ordering::Relaxed)
    };
    let overflow = Arc::clone(overflow);
    macro_rules! typed {
        ($t:ty) => {
            device.build_input_stream::<$t, _, _>(
                stream_config,
                queue_samples::<$t>(producer, overflow),
                on_error,
                None,
            )
        };
    }
    let built = match config.sample_format() {
        cpal::SampleFormat::F32 => typed!(f32),
        cpal::SampleFormat::F64 => typed!(f64),
        cpal::SampleFormat::I16 => typed!(i16),
        cpal::SampleFormat::U16 => typed!(u16),
        cpal::SampleFormat::I32 => typed!(i32),
        cpal::SampleFormat::I8 => typed!(i8),
        cpal::SampleFormat::U8 => typed!(u8),
        _ => return Err(SpeechError::Audio("sample format")),
    };
    built.map_err(|_| SpeechError::DeviceLost)
}

/// The device callback: convert and queue, count what does not fit. No locks, no
/// allocation, no I/O.
fn queue_samples<T: Sample + cpal::SizedSample>(
    mut producer: rtrb::Producer<f32>,
    overflow: Arc<AtomicU64>,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static {
    move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mut dropped = 0_u64;
        for &sample in data {
            if producer.push(sample.to_f32()).is_err() {
                dropped += 1;
            }
        }
        if dropped > 0 {
            overflow.fetch_add(dropped, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_queue_drops_and_counts_without_blocking() {
        let (producer, consumer) = rtrb::RingBuffer::new(4);
        let overflow = Arc::new(AtomicU64::new(0));
        let mut callback = queue_samples::<i16>(producer, Arc::clone(&overflow));
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: cpal::StreamInstant::new(0, 0),
            capture: cpal::StreamInstant::new(0, 0),
        });
        callback(&[16_384, -16_384, 0, 0, 1, 2], &info);
        let mut capture = Capture::from_parts(
            consumer,
            1,
            16_000,
            Arc::clone(&overflow),
            Arc::new(AtomicBool::new(false)),
        );
        let mut out = Vec::new();
        capture.read(&mut out);
        assert_eq!(out, vec![0.5, -0.5, 0.0, 0.0]);
        assert_eq!(capture.take_overflow(), 2);
        assert_eq!(capture.take_overflow(), 0);
    }
}
