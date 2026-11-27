//! Voice dictation service (ADR-0094–0097, voice dictation addendum 4.5): who dictates, with
//! which settings and vocabulary, where events go, and the speech models' state.
//!
//! One session at a time in the whole application: `start` claims the owner (window,
//! composer) atomically and the engine's terminal state releases it. Events of a session go
//! to `dictation/<window>` only; model and device state, which carries no recognized text,
//! goes to every window on `core/speech`. Recognized text and the vocabulary are never
//! logged (THR-18).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use piarc_protocol::dictation::{
    DictationEvent, DictationStart, DictationStarted, DictationStatus, InputDevice, SpeechModel,
    SpeechModelKind, SpeechModelState, SpeechModels, StopMode,
};
use piarc_protocol::rpc_error::ErrorKind;
use piarc_speech::models::{ENHANCED_MODEL_ID, enhanced_manifest};
use piarc_speech::vocabulary::{
    Alphabet, Vocabulary, VocabularySources, cargo_toml_terms, package_json_terms,
};
use piarc_speech::{
    DictationSink, Engine, EngineConfig, SessionOptions, SpeechError, StartRequest,
};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;

pub mod download;

/// Route of model and device state (`core/speech`).
pub const SPEECH_ROUTE: &str = "core/speech";

/// Largest manifest file read for workspace vocabulary (addendum 3.6.1).
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// Where the speech assets are and how the engine behaves.
#[derive(Debug, Clone)]
pub struct SpeechConfig {
    /// The bundled assets (`Resources/speech`, or `target/speech-assets/<target>` in the
    /// source tree). `None`: dictation reports its assets missing.
    pub dir: Option<PathBuf>,
    /// Development builds: a WAV file played instead of a microphone (addendum V-9.5).
    pub test_source: Option<PathBuf>,
    /// Free models after this long without a session.
    pub idle_ttl: Duration,
}

impl Default for SpeechConfig {
    fn default() -> Self {
        Self {
            dir: None,
            test_source: None,
            idle_ttl: piarc_speech::IDLE_TTL,
        }
    }
}

/// The user's dictation preferences (`voiceDictation` in the user settings file), read
/// leniently: anything missing or malformed takes its default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoicePreferences {
    /// The feature is on (default true).
    pub enabled: bool,
    /// Opaque input device id, `None` for the system default.
    pub device: Option<String>,
    /// Refine with the enhanced model.
    pub enhanced: bool,
    /// Keep punctuation.
    pub punctuation: bool,
    /// Built-in technical terms.
    pub tech_terms: bool,
    /// Trusted workspace's package names.
    pub workspace_terms: bool,
    /// The user's dictionary.
    pub custom_terms: Vec<String>,
}

impl Default for VoicePreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            device: None,
            enhanced: false,
            punctuation: true,
            tech_terms: true,
            workspace_terms: true,
            custom_terms: Vec::new(),
        }
    }
}

impl VoicePreferences {
    /// Reads `voiceDictation` from the user settings document.
    #[must_use]
    pub fn from_settings(settings: &Value) -> Self {
        let defaults = Self::default();
        let Some(voice) = settings.get("voiceDictation").and_then(Value::as_object) else {
            return defaults;
        };
        let flag =
            |key: &str, default: bool| voice.get(key).and_then(Value::as_bool).unwrap_or(default);
        Self {
            enabled: flag("enabled", defaults.enabled),
            device: voice
                .get("device")
                .and_then(Value::as_str)
                .filter(|d| d.len() == 16 && d.chars().all(|c| c.is_ascii_hexdigit()))
                .map(str::to_owned),
            enhanced: voice.get("mode").and_then(Value::as_str) == Some("enhanced"),
            punctuation: flag("punctuation", defaults.punctuation),
            tech_terms: flag("techTerms", defaults.tech_terms),
            workspace_terms: flag("workspaceTerms", defaults.workspace_terms),
            custom_terms: voice
                .get("customTerms")
                .and_then(Value::as_array)
                .map(|terms| {
                    terms
                        .iter()
                        .filter_map(Value::as_str)
                        .take(piarc_speech::vocabulary::MAX_CUSTOM_TERMS)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Owner {
    session: String,
    window: u64,
    composer: String,
    test: bool,
}

/// Sends a session's events to its window's route and releases the owner when it ends.
struct WindowSink {
    route: RouteKey,
    events: EventSender,
    owner: Arc<Mutex<Option<Owner>>>,
    session: String,
}

impl WindowSink {
    fn release_if_ended(&self, event: &DictationEvent) {
        if let DictationEvent::State { state, .. } = event
            && state.is_terminal()
        {
            let mut owner = self.owner.lock().unwrap_or_else(PoisonError::into_inner);
            if owner.as_ref().is_some_and(|o| o.session == self.session) {
                *owner = None;
            }
        }
    }
}

impl DictationSink for WindowSink {
    fn send(&self, event: DictationEvent) {
        // Release before delivery: a client reacting to the terminal state can start again.
        self.release_if_ended(&event);
        if let Ok(event) = Event::from_json(self.route.clone(), &event) {
            // The engine thread is not a runtime thread; text and states must arrive.
            let _ = self.events.blocking_send(event);
        }
    }

    fn send_level(&self, event: DictationEvent) {
        if let Ok(event) = Event::from_json(self.route.clone(), &event) {
            // Levels are advisory: a full queue drops them.
            let _ = self.events.try_send(event);
        }
    }
}

/// The dictation service: one per Core.
pub struct DictationService {
    engine: Engine,
    pub(crate) downloads: Arc<download::Downloads>,
    owner: Arc<Mutex<Option<Owner>>>,
    events: EventSender,
    next: AtomicU64,
    alphabet: Mutex<Option<Arc<Alphabet>>>,
}

/// A speech failure as a Core error: the code goes to `details.speech` for the client.
pub(crate) fn speech_error(error: &SpeechError) -> Error {
    let kind = match error {
        SpeechError::Busy => ErrorKind::Busy,
        SpeechError::UnknownSession => ErrorKind::NotFound,
        SpeechError::ModelMissing | SpeechError::Runtime(_) | SpeechError::NoDevice => {
            ErrorKind::NotFound
        }
        SpeechError::ModelCorrupt | SpeechError::LoadFailed | SpeechError::DeviceLost => {
            ErrorKind::IoError
        }
        SpeechError::Audio(_) | SpeechError::EngineGone => ErrorKind::InternalError,
    };
    Error::Feature {
        kind,
        retryable: error.retryable(),
        message: error.to_string(),
        details: Some(serde_json::json!({ "speech": error.code() }).to_string()),
    }
}

fn disabled() -> Error {
    Error::Feature {
        kind: ErrorKind::PermissionDenied,
        retryable: false,
        message: "voice dictation is turned off".to_owned(),
        details: Some(serde_json::json!({ "speech": "disabled" }).to_string()),
    }
}

fn busy(owner: &Owner) -> Error {
    Error::Feature {
        kind: ErrorKind::Busy,
        retryable: true,
        message: "another window is dictating".to_owned(),
        details: Some(
            serde_json::json!({ "speech": "busy", "windowId": owner.window, "test": owner.test })
                .to_string(),
        ),
    }
}

/// The dictation route of a window.
///
/// # Errors
///
/// Never for a number; kept fallible like the other route constructors.
pub fn window_route(window: u64) -> Result<RouteKey> {
    RouteKey::parse(&format!("dictation/{window}"))
}

/// Package names of the workspace at `root` (addendum 3.6.1): `package.json` and
/// `Cargo.toml` at its root only, each a regular file of at most 256 KiB that stays inside
/// the workspace once links are resolved.
#[must_use]
pub fn workspace_terms(root: &Path) -> Vec<String> {
    let Ok(real_root) = root.canonicalize() else {
        return Vec::new();
    };
    let mut terms = Vec::new();
    for (name, parse) in [
        (
            "package.json",
            package_json_terms as fn(&str) -> Vec<String>,
        ),
        ("Cargo.toml", cargo_toml_terms),
    ] {
        let path = root.join(name);
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        if !real.starts_with(&real_root) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&real) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&real) {
            terms.extend(parse(&text));
        }
    }
    terms.truncate(piarc_speech::vocabulary::MAX_WORKSPACE_TERMS);
    terms
}

impl DictationService {
    /// The service; nothing runs until the first request.
    pub(crate) fn new(config: &SpeechConfig, cache_dir: PathBuf, events: EventSender) -> Self {
        let engine = Engine::new(EngineConfig {
            speech_dir: config.dir.clone().unwrap_or_default(),
            cache_dir: cache_dir.join("speech"),
            idle_ttl: config.idle_ttl,
            threads: 2,
            refine_threads: 4,
            test_source: config.test_source.clone(),
        });
        Self {
            engine,
            downloads: Arc::new(download::Downloads::default()),
            owner: Arc::new(Mutex::new(None)),
            events,
            next: AtomicU64::new(0),
            alphabet: Mutex::new(None),
        }
    }

    /// The model's BPE alphabet, read once (for term validation); `None` when absent.
    fn alphabet(&self) -> Option<Arc<Alphabet>> {
        let mut cached = self.alphabet.lock().unwrap_or_else(PoisonError::into_inner);
        if cached.is_none() {
            let path = self.engine.bundled().paths().bpe_vocab;
            if let Ok(text) = std::fs::read_to_string(path) {
                *cached = Some(Arc::new(Alphabet::from_bpe_vocab(&text)));
            }
        }
        cached.clone()
    }

    /// Starts a session for `request` with `preferences`; `trusted_workspace` is the
    /// workspace to take vocabulary from when the caller checked its trust.
    ///
    /// # Errors
    ///
    /// `permissionDenied` (`speech: disabled`) when the feature is off, `busy` when another
    /// session runs (with its window), or the engine's error.
    pub(crate) fn start(
        &self,
        request: &DictationStart,
        preferences: &VoicePreferences,
        trusted_workspace: Option<&Path>,
    ) -> Result<DictationStarted> {
        if !preferences.enabled {
            return Err(disabled());
        }
        let route = window_route(request.window_id)?;
        let session = format!(
            "dictation-{}",
            self.next.fetch_add(1, Ordering::Relaxed) + 1
        );
        {
            let mut owner = self.owner.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(current) = owner.as_ref() {
                return Err(busy(current));
            }
            *owner = Some(Owner {
                session: session.clone(),
                window: request.window_id,
                composer: request.composer.clone(),
                test: request.test,
            });
        }
        let workspace = match trusted_workspace {
            Some(root) if preferences.workspace_terms && !request.test => workspace_terms(root),
            _ => Vec::new(),
        };
        let alphabet = self.alphabet();
        let vocabulary = Vocabulary::build(
            &VocabularySources {
                builtin: preferences.tech_terms,
                custom: &preferences.custom_terms,
                workspace: &workspace,
            },
            alphabet.as_deref(),
        );
        let enhanced =
            preferences.enhanced && self.engine.enhanced().quick_state() == SpeechModelState::Ready;
        let sink = Arc::new(WindowSink {
            route: route.clone(),
            events: self.events.clone(),
            owner: Arc::clone(&self.owner),
            session: session.clone(),
        });
        let started = self.engine.start(
            StartRequest {
                options: SessionOptions {
                    id: session.clone(),
                    vocabulary,
                    punctuation: preferences.punctuation,
                    refine: enhanced,
                    max_audio: piarc_speech::MAX_SESSION,
                    no_speech: piarc_speech::NO_SPEECH_LIMIT,
                },
                device: preferences.device.clone(),
                test: request.test,
            },
            sink,
        );
        if let Err(error) = started {
            self.clear(&session);
            return Err(speech_error(&error));
        }
        Ok(DictationStarted {
            session_id: session,
            route: route.to_string(),
        })
    }

    fn clear(&self, session: &str) {
        let mut owner = self.owner.lock().unwrap_or_else(PoisonError::into_inner);
        if owner.as_ref().is_some_and(|o| o.session == session) {
            *owner = None;
        }
    }

    fn check(&self, window: u64, session: &str) -> Result<()> {
        let owner = self.owner.lock().unwrap_or_else(PoisonError::into_inner);
        match owner.as_ref() {
            Some(o) if o.session == session && o.window == window => Ok(()),
            _ => Err(speech_error(&SpeechError::UnknownSession)),
        }
    }

    /// Stops `session` of `window`.
    ///
    /// # Errors
    ///
    /// `notFound` when it is not that window's running session.
    pub(crate) fn stop(&self, window: u64, session: &str, mode: StopMode) -> Result<()> {
        self.check(window, session)?;
        self.engine
            .stop(session, mode)
            .map_err(|e| speech_error(&e))
    }

    /// Cancels `session` of `window`.
    ///
    /// # Errors
    ///
    /// As [`stop`](Self::stop).
    pub(crate) fn cancel(&self, window: u64, session: &str) -> Result<()> {
        self.check(window, session)?;
        self.engine.cancel(session).map_err(|e| speech_error(&e))
    }

    /// The window is gone (closed, reloaded, crashed): its session ends without text.
    pub(crate) fn release(&self, window: u64) {
        let session = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|o| o.window == window)
            .map(|o| o.session.clone());
        if let Some(session) = session {
            let _ = self.engine.cancel(&session);
        }
    }

    /// The feature was turned off: any session stops keeping its text, models are freed.
    pub(crate) fn disable(&self) {
        let session = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|o| o.session.clone());
        if let Some(session) = session {
            let _ = self.engine.stop(&session, StopMode::Keep);
        }
        self.engine.unload();
    }

    /// The running session, if any.
    pub(crate) fn status(&self) -> DictationStatus {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let engine = self.engine.status();
        DictationStatus {
            session_id: owner.as_ref().map(|o| o.session.clone()),
            window_id: owner.as_ref().map(|o| o.window),
            composer: owner.as_ref().map(|o| o.composer.clone()),
            state: None,
            test: owner.as_ref().is_some_and(|o| o.test),
            engine_loaded: engine.engine_loaded,
            capture_open: engine.capture_open,
        }
    }

    /// Input devices (blocks up to 5 s: call from a blocking pool).
    ///
    /// # Errors
    ///
    /// `notFound` (`speech: microphoneUnavailable`) when the audio system does not answer.
    pub(crate) fn devices(&self) -> Result<Vec<InputDevice>> {
        self.engine.devices().map_err(|e| speech_error(&e))
    }

    /// The models' state.
    pub(crate) fn models(&self, preferences: &VoicePreferences) -> SpeechModels {
        let enhanced = self.engine.enhanced();
        let enhanced_state = enhanced.quick_state();
        let enhanced_active = preferences.enhanced && enhanced_state == SpeechModelState::Ready;
        let manifest = enhanced_manifest();
        let mut models = SpeechModels {
            models: vec![
                self.engine.bundled().status(!enhanced_active),
                SpeechModel {
                    id: ENHANCED_MODEL_ID.to_owned(),
                    kind: SpeechModelKind::Enhanced,
                    version: manifest.version.clone(),
                    state: enhanced_state,
                    installed_bytes: manifest.total_bytes(),
                    download_bytes: manifest.total_bytes(),
                    received_bytes: None,
                    error: None,
                    active: enhanced_active,
                },
            ],
        };
        self.downloads.apply(&mut models);
        models
    }

    /// Deletes the enhanced model (addendum V-7.5): refused while any dictation runs; the
    /// refiner is unloaded first. The main process asked natively before.
    ///
    /// # Errors
    ///
    /// `busy` while a dictation or a download runs, `ioError` when the files cannot be removed.
    pub(crate) fn delete_enhanced(&self) -> Result<()> {
        if self.in_use() || self.downloads.state().received.is_some() {
            return Err(speech_error(&SpeechError::Busy));
        }
        self.engine.unload();
        self.engine
            .enhanced()
            .remove()
            .map_err(|e| speech_error(&e))
    }

    /// Re-checks the files of a model now (sizes and SHA-256).
    ///
    /// # Errors
    ///
    /// The model's `modelMissing` or `modelCorrupt`.
    pub(crate) fn verify(&self, enhanced: bool) -> Result<()> {
        let result = if enhanced {
            self.engine.enhanced().verify()
        } else {
            self.engine.bundled().verify()
        };
        result.map_err(|e| speech_error(&e))
    }

    /// Broadcasts the models' state on `core/speech`.
    pub(crate) fn broadcast(&self, models: &SpeechModels) {
        if let Ok(event) = Event::from_json(RouteKey::speech(), models) {
            let _ = self.events.try_send(event);
        }
    }

    /// Development builds: makes the open input fail like a removed microphone.
    pub(crate) fn fail_device(&self) {
        self.engine.fail_device();
    }

    /// Stops any session and the engine; waits for its threads.
    pub(crate) fn shutdown(&self) {
        self.engine.shutdown();
    }

    /// The enhanced model store (downloads).
    pub(crate) fn enhanced_store(&self) -> piarc_speech::models::EnhancedStore {
        self.engine.enhanced()
    }

    /// Whether a dictation or microphone test runs.
    pub(crate) fn in_use(&self) -> bool {
        self.owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

#[cfg(test)]
mod service_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_default_on_and_read_leniently() {
        assert_eq!(
            VoicePreferences::from_settings(&Value::Null),
            VoicePreferences::default()
        );
        let settings = serde_json::json!({
            "voiceDictation": {
                "enabled": false,
                "device": "0123456789abcdef",
                "mode": "enhanced",
                "punctuation": "yes",
                "customTerms": ["PiArc", 3, "MyProject"],
            }
        });
        let prefs = VoicePreferences::from_settings(&settings);
        assert!(!prefs.enabled);
        assert_eq!(prefs.device.as_deref(), Some("0123456789abcdef"));
        assert!(prefs.enhanced);
        assert!(prefs.punctuation, "a malformed value keeps the default");
        assert_eq!(prefs.custom_terms, vec!["PiArc", "MyProject"]);
        let bad_device = serde_json::json!({ "voiceDictation": { "device": "../../etc" } });
        assert_eq!(VoicePreferences::from_settings(&bad_device).device, None);
    }

    #[test]
    fn workspace_terms_read_only_root_manifests_inside_the_workspace() {
        let root =
            std::env::temp_dir().join(format!("piarc-dictation-terms-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("piarc-dictation-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"demo-app","dependencies":{"react":"1"}}"#,
        )
        .expect("package");
        std::fs::write(
            outside.join("Cargo.toml"),
            "[package]\nname = \"secret-crate\"\n",
        )
        .expect("cargo");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("Cargo.toml"), root.join("Cargo.toml"))
            .expect("link");
        std::fs::write(root.join(".env"), "TOKEN=1").expect("env");
        let terms = workspace_terms(&root);
        assert_eq!(terms, vec!["demo-app", "react"]);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn oversized_manifests_are_skipped() {
        let root = std::env::temp_dir().join(format!("piarc-dictation-big-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        let big = format!("{{\"name\":\"big\",\"x\":\"{}\"}}", "a".repeat(300 * 1024));
        std::fs::write(root.join("package.json"), big).expect("write");
        assert!(workspace_terms(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn speech_errors_carry_their_code() {
        let object = speech_error(&SpeechError::ModelCorrupt).to_error_object();
        assert_eq!(object.data.kind, ErrorKind::IoError);
        assert_eq!(
            object.data.details,
            Some(serde_json::json!({ "speech": "modelCorrupt" }))
        );
    }
}
