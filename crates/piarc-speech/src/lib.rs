//! piarc-speech: local voice dictation (ADR-0094, voice dictation addendum).
//!
//! # Responsibilities
//!
//! - Audio capture with CPAL into a bounded queue, downmixing, resampling to 16 kHz and level
//!   metering ([`capture`], [`audio`]).
//! - Streaming recognition with the bundled X-ASR model through sherpa-onnx, one segmentation
//!   coordinator over the recognizer's endpoints and Silero VAD, the session state machine,
//!   limits and stop modes ([`Engine`]).
//! - Optional segment refinement with Qwen3-ASR on its own thread, settled in order with a
//!   deadline and a conservative choice ([`transcript::accept_refined`]).
//! - Hotword vocabulary and text normalization ([`vocabulary`], [`transcript`]).
//! - The asset manifests, verification and the enhanced model's install and removal
//!   ([`models`]).
//!
//! # Not responsible for
//!
//! - Who may dictate, settings, workspace trust and file reading for vocabulary, event routing
//!   and downloads (`piarc-core`'s `dictation` service; downloads in `piarc-web`).
//! - Loading the runtime library mechanics (`sherpa-onnx-sys`, crate `piarc-sherpa-sys`).
//!
//! # Allowed workspace dependencies
//!
//! `piarc-protocol` (foundation) and `sherpa-onnx-sys` (the -sys layer, registered exception;
//! reached also through the upstream `sherpa-onnx` safe wrapper).
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
//!
//! # Privacy
//!
//! PCM stays in bounded in-memory buffers on the engine thread and is never written to disk;
//! recognized text and vocabulary are never logged (THR-18). Recognizers run with
//! `debug = false`.

pub mod audio;
pub mod capture;
mod coordinator;
mod engine;
mod error;
pub mod models;
mod recognizer;
mod refine;
mod session;
pub mod transcript;
pub mod vocabulary;
#[cfg(feature = "testing")]
pub mod wav_source;

pub use engine::{Engine, EngineConfig, EngineStatus, StartRequest};
pub use error::SpeechError;
pub use session::{DictationSink, REFINE_DEADLINE, REFINE_QUEUE, SessionOptions};

/// Default time without a session before models are freed (addendum V-5.4).
pub const IDLE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
/// Longest session (addendum V-5.3).
pub const MAX_SESSION: std::time::Duration = std::time::Duration::from_secs(600);
/// Longest stretch without speech before a session stops (addendum V-5.3).
pub const NO_SPEECH_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);
