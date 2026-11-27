//! The recognizers behind narrow traits: the streaming transducer, the VAD and the offline
//! refiner. The sherpa-onnx implementations live here; the coordinator and the session only
//! see the traits, so their logic is tested without models.

use std::path::Path;

use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OnlineRecognizer, OnlineRecognizerConfig,
    OnlineStream, SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};

use crate::audio::TARGET_RATE;
use crate::error::SpeechError;
use crate::models::{BaseModelPaths, EnhancedModelPaths};

/// Seconds of silence fed after the last audio so the 480 ms chunk model emits its last
/// words (PoC, addendum appendix A: 0.8 s lost words, 1.2 s did not).
pub const TAIL_PADDING_SECONDS: f32 = 1.2;

/// A streaming recognizer for one utterance at a time.
pub trait Streaming {
    /// Feeds 16 kHz samples.
    fn accept(&mut self, samples: &[f32]);
    /// Decodes everything that is ready.
    fn decode(&mut self);
    /// The current utterance's text.
    fn text(&self) -> String;
    /// Whether the recognizer's endpoint rules fired.
    fn is_endpoint(&self) -> bool;
    /// Starts the next utterance.
    fn reset(&mut self);
    /// Pads silence, marks the input finished and decodes the rest.
    fn finish(&mut self);
}

/// A voice activity detector over 16 kHz samples.
pub trait Activity {
    /// Feeds samples (any length).
    fn accept(&mut self, samples: &[f32]);
    /// Whether speech is detected now.
    fn speaking(&self) -> bool;
}

/// An offline recognizer that rewrites one segment.
pub trait Refine: Send {
    /// Recognizes `pcm` (16 kHz mono).
    ///
    /// # Errors
    ///
    /// [`SpeechError::LoadFailed`] when the recognizer returns nothing.
    fn refine(&mut self, pcm: &[f32]) -> Result<String, SpeechError>;
}

fn path_text(path: &Path) -> Option<String> {
    Some(path.to_string_lossy().into_owned())
}

/// The X-ASR transducer. Not `Send`: created and used on the engine thread only.
pub struct OnlineModel {
    recognizer: OnlineRecognizer,
}

impl OnlineModel {
    /// Loads the model (about 1.6 s cold on an M1 Max, addendum appendix A).
    ///
    /// # Errors
    ///
    /// [`SpeechError::LoadFailed`] when sherpa-onnx refuses the files.
    pub fn load(paths: &BaseModelPaths, threads: i32) -> Result<Self, SpeechError> {
        let mut config = OnlineRecognizerConfig::default();
        config.model_config.transducer.encoder = path_text(&paths.encoder);
        config.model_config.transducer.decoder = path_text(&paths.decoder);
        config.model_config.transducer.joiner = path_text(&paths.joiner);
        config.model_config.tokens = path_text(&paths.tokens);
        config.model_config.modeling_unit = Some("bpe".to_owned());
        config.model_config.bpe_vocab = path_text(&paths.bpe_vocab);
        config.model_config.num_threads = threads;
        config.model_config.debug = false;
        config.decoding_method = Some("modified_beam_search".to_owned());
        config.max_active_paths = 4;
        config.hotwords_score = 1.5;
        config.enable_endpoint = true;
        // Endpoint rules: 2.4 s of silence before any word, 0.8 s after words, 20 s at most.
        config.rule1_min_trailing_silence = 2.4;
        config.rule2_min_trailing_silence = 0.8;
        config.rule3_min_utterance_length = 20.0;
        let recognizer = OnlineRecognizer::create(&config).ok_or(SpeechError::LoadFailed)?;
        Ok(Self { recognizer })
    }

    /// A stream for one session with its hotwords (`a/b/c`, may be empty).
    #[must_use]
    pub fn stream<'a>(&'a self, hotwords: &str) -> OnlineSession<'a> {
        let stream = if hotwords.is_empty() {
            self.recognizer.create_stream()
        } else {
            self.recognizer.create_stream_with_hotwords(hotwords)
        };
        OnlineSession {
            model: self,
            stream,
        }
    }
}

/// One session's stream on an [`OnlineModel`].
pub struct OnlineSession<'a> {
    model: &'a OnlineModel,
    stream: OnlineStream,
}

impl Streaming for OnlineSession<'_> {
    fn accept(&mut self, samples: &[f32]) {
        #[expect(clippy::cast_possible_wrap, reason = "16000 fits i32")]
        self.stream.accept_waveform(TARGET_RATE as i32, samples);
    }

    fn decode(&mut self) {
        while self.model.recognizer.is_ready(&self.stream) {
            self.model.recognizer.decode(&self.stream);
        }
    }

    fn text(&self) -> String {
        self.model
            .recognizer
            .get_result(&self.stream)
            .map(|r| r.text.trim().to_owned())
            .unwrap_or_default()
    }

    fn is_endpoint(&self) -> bool {
        self.model.recognizer.is_endpoint(&self.stream)
    }

    fn reset(&mut self) {
        self.model.recognizer.reset(&self.stream);
    }

    fn finish(&mut self) {
        #[expect(clippy::cast_possible_truncation, reason = "a few thousand samples")]
        #[expect(clippy::cast_sign_loss, reason = "positive")]
        let padding = vec![0.0; (TAIL_PADDING_SECONDS * TARGET_RATE as f32) as usize];
        self.accept(&padding);
        self.stream.input_finished();
        self.decode();
    }
}

/// Silero VAD over 512-sample windows. Segments it queues are discarded: the coordinator
/// only asks whether speech is present.
pub struct Vad {
    detector: VoiceActivityDetector,
    pending: Vec<f32>,
    speaking: bool,
}

/// Silero's window at 16 kHz.
const VAD_WINDOW: usize = 512;

impl Vad {
    /// Loads the VAD.
    ///
    /// # Errors
    ///
    /// [`SpeechError::LoadFailed`] when sherpa-onnx refuses the file.
    pub fn load(model: &Path) -> Result<Self, SpeechError> {
        let config = VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: path_text(model),
                threshold: 0.5,
                min_silence_duration: 0.5,
                min_speech_duration: 0.25,
                #[expect(clippy::cast_possible_wrap, reason = "512 fits i32")]
                window_size: VAD_WINDOW as i32,
                max_speech_duration: 20.0,
            },
            #[expect(clippy::cast_possible_wrap, reason = "16000 fits i32")]
            sample_rate: TARGET_RATE as i32,
            num_threads: 1,
            provider: Some("cpu".to_owned()),
            debug: false,
            ..VadModelConfig::default()
        };
        let detector =
            VoiceActivityDetector::create(&config, 30.0).ok_or(SpeechError::LoadFailed)?;
        Ok(Self {
            detector,
            pending: Vec::with_capacity(VAD_WINDOW),
            speaking: false,
        })
    }
}

impl Activity for Vad {
    fn accept(&mut self, samples: &[f32]) {
        for &sample in samples {
            self.pending.push(sample);
            if self.pending.len() == VAD_WINDOW {
                self.detector.accept_waveform(&self.pending);
                self.pending.clear();
                self.speaking = self.detector.detected();
                while !self.detector.is_empty() {
                    self.detector.pop();
                }
            }
        }
    }

    fn speaking(&self) -> bool {
        self.speaking
    }
}

/// The Qwen3-ASR refiner.
pub struct Qwen {
    recognizer: OfflineRecognizer,
}

impl Qwen {
    /// Loads the model (about 1.8 s and 2 GB on an M1 Max, addendum appendix A).
    ///
    /// # Errors
    ///
    /// [`SpeechError::LoadFailed`] when sherpa-onnx refuses the files.
    /// `hotwords` are the canonical terms joined by `,` ([`crate::vocabulary::Vocabulary::context_words`]).
    pub fn load(
        paths: &EnhancedModelPaths,
        threads: i32,
        hotwords: &str,
    ) -> Result<Self, SpeechError> {
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.qwen3_asr.conv_frontend = path_text(&paths.conv_frontend);
        config.model_config.qwen3_asr.encoder = path_text(&paths.encoder);
        config.model_config.qwen3_asr.decoder = path_text(&paths.decoder);
        config.model_config.qwen3_asr.tokenizer = path_text(&paths.tokenizer);
        if !hotwords.is_empty() {
            // sherpa-onnx `qwen3-asr-hotwords`: comma-separated, fixed when the model loads.
            config.model_config.qwen3_asr.hotwords = Some(hotwords.to_owned());
        }
        config.model_config.num_threads = threads;
        config.model_config.debug = false;
        let recognizer = OfflineRecognizer::create(&config).ok_or(SpeechError::LoadFailed)?;
        Ok(Self { recognizer })
    }
}

impl Refine for Qwen {
    fn refine(&mut self, pcm: &[f32]) -> Result<String, SpeechError> {
        let stream = self.recognizer.create_stream();
        #[expect(clippy::cast_possible_wrap, reason = "16000 fits i32")]
        stream.accept_waveform(TARGET_RATE as i32, pcm);
        self.recognizer.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text.trim().to_owned())
            .ok_or(SpeechError::LoadFailed)
    }
}
