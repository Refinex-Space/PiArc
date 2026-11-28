//! Errors of the speech engine. Messages never carry paths, recognized text or audio
//! (THR-18): the code is what the user sees, localized by the client.

use thiserror::Error;

/// A speech engine failure.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SpeechError {
    /// Another dictation or microphone test is running.
    #[error("a dictation is already running")]
    Busy,
    /// The session id is not the running session.
    #[error("no such dictation session")]
    UnknownSession,
    /// The runtime libraries are missing or could not be loaded.
    #[error("the speech runtime is not available ({0})")]
    Runtime(&'static str),
    /// A model's files are missing.
    #[error("speech model files are missing")]
    ModelMissing,
    /// A model's files do not match their manifest.
    #[error("speech model files are damaged")]
    ModelCorrupt,
    /// The recognizer or VAD could not be created from verified files.
    #[error("the speech model could not be loaded")]
    LoadFailed,
    /// No input device, or the chosen one is gone.
    #[error("no microphone is available")]
    NoDevice,
    /// The device refused to open or stopped delivering audio.
    #[error("the microphone stopped working")]
    DeviceLost,
    /// An audio format or rate the pipeline cannot handle.
    #[error("unsupported audio input ({0})")]
    Audio(&'static str),
    /// The engine thread is gone (shut down or panicked).
    #[error("the speech engine is not running")]
    EngineGone,
}

impl SpeechError {
    /// The stable code clients localize (`error.speech.<code>`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::UnknownSession => "unknownSession",
            Self::Runtime(_) => "runtimeMissing",
            Self::ModelMissing => "modelMissing",
            Self::ModelCorrupt => "modelCorrupt",
            Self::LoadFailed => "loadFailed",
            Self::NoDevice => "microphoneUnavailable",
            Self::DeviceLost => "deviceLost",
            Self::Audio(_) => "audioFormat",
            Self::EngineGone => "engineGone",
        }
    }

    /// Whether trying again may work without the user changing anything.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        matches!(self, Self::Busy | Self::DeviceLost | Self::EngineGone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_carry_no_paths() {
        for error in [
            SpeechError::Runtime("load"),
            SpeechError::ModelCorrupt,
            SpeechError::LoadFailed,
            SpeechError::Audio("rate"),
        ] {
            let text = error.to_string();
            assert!(!text.contains('/') && !text.contains('\\'), "{text}");
            assert!(!error.code().is_empty());
        }
    }
}
