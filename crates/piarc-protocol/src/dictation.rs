//! Voice dictation data types (ADR-0094, voice dictation addendum section 4.4). Numbers are
//! `u64` and `f64`: the schema formats of narrower types are not registered with ajv.
//!
//! Dictation events go to one window only, on the route `dictation/<webContentsId>`; model
//! and device state that carries no recognized text goes to every window on `core/speech`.
//! Text and levels never leave the process that owns the microphone except through these
//! events (THR-18).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Longest text one dictation text event carries, in bytes; longer segments are cut at a
/// character boundary (a segment is at most 20 s of speech, well below this).
pub const MAX_DICTATION_TEXT_BYTES: usize = 4096;

/// Most envelope buckets one level event carries.
pub const MAX_ENVELOPE_BUCKETS: usize = 8;

/// The state of a dictation session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DictationState {
    /// Checking assets and loading the runtime and models; no audio yet.
    Preparing,
    /// The microphone is open and text streams in.
    Recording,
    /// The microphone is closed; the last segment and any refinement are finishing.
    Finalizing,
    /// Done; every segment is final.
    Completed,
    /// Ended by the user without keeping dictated text.
    Cancelled,
    /// Ended by a failure; `code` says which.
    Error,
}

impl DictationState {
    /// Whether the session has ended.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Error)
    }
}

/// How settled a piece of recognized text is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TextStage {
    /// The current segment's running hypothesis; the next partial replaces it.
    Partial,
    /// The segment ended at a pause; refinement may still replace it.
    Provisional,
    /// The segment's text will not change again.
    Final,
}

/// An event on `dictation/<webContentsId>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DictationEvent {
    /// The session changed state.
    State {
        /// The session.
        session_id: String,
        /// Increases by one with every event of the session.
        sequence: u64,
        /// The new state.
        state: DictationState,
        /// Why, for `error` (and for a stop the engine decided itself, see [`DictationEvent::Notice`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// The audio level over the last 40 ms of captured audio (droppable).
    Level {
        /// The session.
        session_id: String,
        /// Increases by one with every event of the session.
        sequence: u64,
        /// Captured audio so far, in milliseconds, at the end of this window.
        audio_ms: u64,
        /// Root mean square, 0–1.
        rms: f64,
        /// Peak absolute sample, 0–1.
        peak: f64,
        /// Peak of each equal part of the window, 0–1, at most [`MAX_ENVELOPE_BUCKETS`].
        envelope: Vec<f64>,
    },
    /// Recognized text of one segment.
    Text {
        /// The session.
        session_id: String,
        /// Increases by one with every event of the session.
        sequence: u64,
        /// The segment, counted from 0 in speaking order.
        segment_id: u64,
        /// Increases with every new text for the same segment.
        revision: u64,
        /// How settled the text is.
        stage: TextStage,
        /// The text; empty for a partial means the segment had no speech after all.
        text: String,
    },
    /// Something the user should know that does not end the session, or why the engine
    /// stopped by itself (`maxDuration`, `noSpeech`, `deviceLost`, `overflow`, `refineSkipped`,
    /// `refineFailed`).
    Notice {
        /// The session.
        session_id: String,
        /// Increases by one with every event of the session.
        sequence: u64,
        /// What happened.
        code: String,
    },
}

impl DictationEvent {
    /// The session the event belongs to.
    #[must_use]
    pub fn session_id(&self) -> &str {
        match self {
            Self::State { session_id, .. }
            | Self::Level { session_id, .. }
            | Self::Text { session_id, .. }
            | Self::Notice { session_id, .. } => session_id,
        }
    }
}

/// What a dictation is started for (sent by the main process, which fills `window_id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DictationStart {
    /// The `webContents` id of the window that started it; events go to its route.
    pub window_id: u64,
    /// The composer in that window: `session:<id>` or `workspace:<path>` (its draft key).
    pub composer: String,
    /// The workspace whose trusted vocabulary may be used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// A level-only microphone test (settings): no model, no text.
    #[serde(default)]
    pub test: bool,
}

/// Answer to a start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DictationStarted {
    /// The new session.
    pub session_id: String,
    /// The route its events go to.
    pub route: String,
}

/// How a dictation stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StopMode {
    /// Stop button or Escape: finish the last segment and wait for refinement (bounded).
    Keep,
    /// Send while recording: finish the last segment, drop pending refinement.
    Send,
}

/// The dictation the process has, if any (`dictationStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// The running session, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Its window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u64>,
    /// Its composer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer: Option<String>,
    /// Its state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<DictationState>,
    /// Whether it is a microphone test.
    #[serde(default)]
    pub test: bool,
    /// Whether the recognition models are loaded.
    pub engine_loaded: bool,
    /// Whether an input device is open.
    pub capture_open: bool,
}

/// An audio input device. `id` is opaque (a stable hash of the system's device name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    /// Opaque id to store in settings.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Whether it is the system default input.
    pub default: bool,
}

/// Which model a status describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SpeechModelKind {
    /// The bundled streaming model (with VAD and runtime).
    Base,
    /// The optional refinement model.
    Enhanced,
}

/// The state of one speech model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SpeechModelState {
    /// Installed and verified (or not yet verified in this process but present).
    Ready,
    /// Not installed (enhanced) or files absent (base).
    Missing,
    /// Present but a file's size or SHA-256 does not match.
    Corrupt,
    /// Being downloaded.
    Downloading,
    /// Downloaded, being checked.
    Verifying,
    /// The last download failed; `error` says why.
    Failed,
}

/// The state of one speech model, broadcast on `core/speech`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModel {
    /// Stable id (`x-asr-zh-en-480ms-int8`, `qwen3-asr-0.6b-int8`).
    pub id: String,
    /// Base or enhanced.
    pub kind: SpeechModelKind,
    /// Model version (release date).
    pub version: String,
    /// State.
    pub state: SpeechModelState,
    /// Bytes on disk once installed.
    pub installed_bytes: u64,
    /// Bytes a download transfers (0 for the bundled model).
    pub download_bytes: u64,
    /// Bytes received so far while downloading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received_bytes: Option<u64>,
    /// Error code of the last failure (`network`, `checksum`, `diskFull`, `cancelled`…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether dictation uses it now.
    pub active: bool,
}

/// The payload of `core/speech` events and of `speechModels`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModels {
    /// Every model PiArc knows.
    pub models: Vec<SpeechModel>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn text_events_are_camel_case_on_the_wire() {
        let event = DictationEvent::Text {
            session_id: "d1".into(),
            sequence: 3,
            segment_id: 0,
            revision: 2,
            stage: TextStage::Provisional,
            text: "你好 PiArc".into(),
        };
        assert_eq!(
            serde_json::to_value(&event).expect("event"),
            json!({
                "type": "text",
                "sessionId": "d1",
                "sequence": 3,
                "segmentId": 0,
                "revision": 2,
                "stage": "provisional",
                "text": "你好 PiArc",
            })
        );
        assert_eq!(event.session_id(), "d1");
    }

    #[test]
    fn terminal_states_are_completed_cancelled_and_error() {
        assert!(DictationState::Completed.is_terminal());
        assert!(DictationState::Cancelled.is_terminal());
        assert!(DictationState::Error.is_terminal());
        assert!(!DictationState::Finalizing.is_terminal());
    }

    #[test]
    fn a_start_without_optional_members_parses() {
        let start: DictationStart =
            serde_json::from_value(json!({"windowId": 3, "composer": "session:s1"}))
                .expect("start");
        assert_eq!(start.workspace, None);
        assert!(!start.test);
    }
}
