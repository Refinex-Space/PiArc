//! The engine thread (addendum 4.3): created on the first request, it owns everything
//! sherpa-onnx and CPAL hand out (neither is `Send`), runs one session at a time and frees the
//! models after [`EngineConfig::idle_ttl`] without a session. Requests arrive over a channel;
//! nothing here blocks the caller.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use piarc_protocol::dictation::{
    DictationEvent, DictationState, InputDevice, SpeechModelState, StopMode,
};

use crate::audio::{Resampler16k, downmix};
use crate::capture::{self, Capture};
use crate::coordinator::Coordinator;
use crate::error::SpeechError;
use crate::models::{BundledAssets, EnhancedStore};
use crate::recognizer::{OnlineModel, Vad};
use crate::refine::RefineWorker;
use crate::session::{DictationSink, REFINE_DEADLINE, Session, SessionOptions};

/// How often the session loop wakes up to move audio.
const TICK: Duration = Duration::from_millis(10);
/// At most one overflow notice per this much time.
const OVERFLOW_NOTICE_EVERY: Duration = Duration::from_secs(5);

/// Engine settings.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// The bundled assets directory (`Resources/speech`).
    pub speech_dir: PathBuf,
    /// The enhanced model store (`<cache>/speech`).
    pub cache_dir: PathBuf,
    /// Free models after this long without a session (addendum V-5.4).
    pub idle_ttl: Duration,
    /// ONNX Runtime threads of the streaming recognizer.
    pub threads: i32,
    /// ONNX Runtime threads of the refiner.
    pub refine_threads: i32,
    /// Development builds: play this WAV file instead of opening a microphone.
    pub test_source: Option<PathBuf>,
}

/// What to start.
pub struct StartRequest {
    /// Session settings.
    pub options: SessionOptions,
    /// Opaque input device id, `None` for the system default.
    pub device: Option<String>,
    /// A microphone test: levels only, no models.
    pub test: bool,
}

enum Command {
    Start(Box<StartRequest>, Arc<dyn DictationSink>),
    Stop(String, StopMode),
    Cancel(String),
    Devices(Sender<Result<Vec<InputDevice>, SpeechError>>),
    Unload,
    FailDevice,
    Shutdown,
}

#[derive(Default)]
struct Flags {
    engine_loaded: AtomicBool,
    capture_open: AtomicBool,
    base_verified: AtomicBool,
    enhanced_verified: AtomicBool,
    fail_device: Arc<AtomicBool>,
}

struct Control {
    sender: Option<Sender<Command>>,
    thread: Option<JoinHandle<()>>,
}

/// The engine handle; cheap to share.
pub struct Engine {
    config: Arc<EngineConfig>,
    flags: Arc<Flags>,
    control: Mutex<Control>,
}

/// What the engine is doing (for `dictationStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EngineStatus {
    /// Models are in memory.
    pub engine_loaded: bool,
    /// A device is open.
    pub capture_open: bool,
}

impl Engine {
    /// An engine; no thread runs until the first request.
    #[must_use]
    pub fn new(config: EngineConfig) -> Self {
        Self {
            config: Arc::new(config),
            flags: Arc::new(Flags::default()),
            control: Mutex::new(Control {
                sender: None,
                thread: None,
            }),
        }
    }

    /// The bundled assets.
    #[must_use]
    pub fn bundled(&self) -> BundledAssets {
        BundledAssets::new(self.config.speech_dir.clone())
    }

    /// The enhanced model store.
    #[must_use]
    pub fn enhanced(&self) -> EnhancedStore {
        EnhancedStore::new(self.config.cache_dir.clone())
    }

    /// What the engine holds now.
    #[must_use]
    pub fn status(&self) -> EngineStatus {
        EngineStatus {
            engine_loaded: self.flags.engine_loaded.load(Ordering::Relaxed),
            capture_open: self.flags.capture_open.load(Ordering::Relaxed),
        }
    }

    fn send(&self, command: Command) -> Result<(), SpeechError> {
        let mut control = self.control.lock().unwrap_or_else(PoisonError::into_inner);
        if control.sender.is_none() {
            let (sender, receiver) = mpsc::channel();
            let config = Arc::clone(&self.config);
            let flags = Arc::clone(&self.flags);
            let thread = std::thread::Builder::new()
                .name("piarc-speech".to_owned())
                .spawn(move || run(&config, &flags, &receiver))
                .map_err(|_| SpeechError::EngineGone)?;
            control.sender = Some(sender);
            control.thread = Some(thread);
        }
        control
            .sender
            .as_ref()
            .ok_or(SpeechError::EngineGone)?
            .send(command)
            .map_err(|_| SpeechError::EngineGone)
    }

    /// Starts a session; its events go to `sink`. Returns at once.
    ///
    /// # Errors
    ///
    /// [`SpeechError::EngineGone`] when the engine thread cannot be started.
    pub fn start(
        &self,
        request: StartRequest,
        sink: Arc<dyn DictationSink>,
    ) -> Result<(), SpeechError> {
        self.send(Command::Start(Box::new(request), sink))
    }

    /// Stops session `id`.
    ///
    /// # Errors
    ///
    /// [`SpeechError::EngineGone`] when the engine is not running.
    pub fn stop(&self, id: &str, mode: StopMode) -> Result<(), SpeechError> {
        self.send(Command::Stop(id.to_owned(), mode))
    }

    /// Cancels session `id`.
    ///
    /// # Errors
    ///
    /// [`SpeechError::EngineGone`] when the engine is not running.
    pub fn cancel(&self, id: &str) -> Result<(), SpeechError> {
        self.send(Command::Cancel(id.to_owned()))
    }

    /// Frees the models now (feature turned off).
    pub fn unload(&self) {
        let _ = self.send(Command::Unload);
    }

    /// Lists input devices on the engine thread (blocks the caller up to 5 s; call it from a
    /// blocking pool).
    ///
    /// # Errors
    ///
    /// [`SpeechError::NoDevice`] when the audio system does not answer.
    pub fn devices(&self) -> Result<Vec<InputDevice>, SpeechError> {
        let (reply, answer) = mpsc::channel();
        self.send(Command::Devices(reply))?;
        answer
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| SpeechError::NoDevice)?
    }

    /// Development builds: makes the open input report an error (a removed microphone).
    pub fn fail_device(&self) {
        self.flags.fail_device.store(true, Ordering::Relaxed);
        let _ = self.send(Command::FailDevice);
    }

    /// Stops any session and the engine thread, and waits for it.
    pub fn shutdown(&self) {
        let (sender, thread) = {
            let mut control = self.control.lock().unwrap_or_else(PoisonError::into_inner);
            (control.sender.take(), control.thread.take())
        };
        if let Some(sender) = sender {
            let _ = sender.send(Command::Shutdown);
        }
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Models kept between sessions.
#[derive(Default)]
struct Loaded {
    online: Option<OnlineModel>,
    refiner: Option<RefineWorker>,
    generation: u64,
}

fn run(config: &EngineConfig, flags: &Flags, commands: &Receiver<Command>) {
    let mut loaded = Loaded::default();
    loop {
        let command = match commands.recv_timeout(config.idle_ttl) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => {
                unload(&mut loaded, flags);
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match command {
            Command::Start(request, sink) => {
                let ended = run_session(config, flags, commands, &mut loaded, *request, &sink);
                if ended == Ended::Shutdown {
                    break;
                }
            }
            Command::Devices(reply) => {
                let _ = reply.send(capture::devices());
            }
            Command::Unload => unload(&mut loaded, flags),
            Command::Stop(..) | Command::Cancel(_) | Command::FailDevice => {}
            Command::Shutdown => break,
        }
    }
    // Leaving the process: wait for a refinement in progress so no decode outlives Core.
    if let Some(refiner) = loaded.refiner.take() {
        refiner.shutdown();
    }
    unload(&mut loaded, flags);
}

fn unload(loaded: &mut Loaded, flags: &Flags) {
    loaded.online = None;
    loaded.refiner = None;
    flags.engine_loaded.store(false, Ordering::Relaxed);
}

#[derive(Debug, PartialEq, Eq)]
enum Ended {
    Done,
    Shutdown,
}

/// What the session loop must do after reading commands.
#[derive(Default)]
struct Requests {
    stop: Option<StopMode>,
    cancel: bool,
    shutdown: bool,
}

fn read_commands(commands: &Receiver<Command>, id: &str, requests: &mut Requests) {
    while let Ok(command) = commands.try_recv() {
        match command {
            Command::Stop(target, mode) if target == id => {
                // A send request wins over a plain stop.
                if requests.stop != Some(StopMode::Send) {
                    requests.stop = Some(mode);
                }
            }
            Command::Cancel(target) if target == id => requests.cancel = true,
            Command::Start(request, sink) => {
                // The service allows one owner; a second start here is answered, not run.
                sink.send(DictationEvent::State {
                    session_id: request.options.id.clone(),
                    sequence: 1,
                    state: DictationState::Error,
                    code: Some(SpeechError::Busy.code().to_owned()),
                });
            }
            Command::Devices(reply) => {
                let _ = reply.send(capture::devices());
            }
            Command::Shutdown => {
                requests.shutdown = true;
                requests.cancel = true;
            }
            Command::Stop(..) | Command::Cancel(_) | Command::Unload | Command::FailDevice => {}
        }
    }
}

/// Verifies and loads what a recognizing session needs.
fn prepare(config: &EngineConfig, flags: &Flags, loaded: &mut Loaded) -> Result<Vad, SpeechError> {
    let bundled = BundledAssets::new(config.speech_dir.clone());
    if !flags.base_verified.load(Ordering::Relaxed) {
        bundled.verify()?;
        flags.base_verified.store(true, Ordering::Relaxed);
    }
    sherpa_onnx_sys::load(&bundled.runtime_dir()).map_err(|_| SpeechError::Runtime("load"))?;
    let paths = bundled.paths();
    if loaded.online.is_none() {
        loaded.online = Some(OnlineModel::load(&paths, config.threads)?);
    }
    flags.engine_loaded.store(true, Ordering::Relaxed);
    Vad::load(&paths.vad)
}

/// Makes sure a refiner for `context` exists; `false` when the enhanced model is unusable.
fn prepare_refiner(
    config: &EngineConfig,
    flags: &Flags,
    loaded: &mut Loaded,
    context: &str,
) -> bool {
    let store = EnhancedStore::new(config.cache_dir.clone());
    if !flags.enhanced_verified.load(Ordering::Relaxed) {
        if store.quick_state() != SpeechModelState::Ready || store.verify().is_err() {
            return false;
        }
        flags.enhanced_verified.store(true, Ordering::Relaxed);
    }
    if loaded
        .refiner
        .as_ref()
        .is_none_or(|r| r.context() != context)
    {
        loaded.refiner = Some(RefineWorker::spawn_qwen(
            store.paths(),
            config.refine_threads,
            context.to_owned(),
        ));
    }
    true
}

fn open_capture(
    config: &EngineConfig,
    flags: &Flags,
    device: Option<&str>,
) -> Result<Capture, SpeechError> {
    flags.fail_device.store(false, Ordering::Relaxed);
    #[cfg(feature = "testing")]
    if let Some(path) = &config.test_source {
        return crate::wav_source::open(path, Arc::clone(&flags.fail_device));
    }
    #[cfg(not(feature = "testing"))]
    let _ = &config.test_source;
    capture::open(device)
}

#[expect(
    clippy::too_many_lines,
    reason = "the session loop reads best as one sequence"
)]
fn run_session(
    config: &EngineConfig,
    flags: &Flags,
    commands: &Receiver<Command>,
    loaded: &mut Loaded,
    request: StartRequest,
    sink: &Arc<dyn DictationSink>,
) -> Ended {
    let StartRequest {
        mut options,
        device,
        test,
    } = request;
    let id = options.id.clone();
    let hotwords = options.vocabulary.hotwords();
    let context = options.vocabulary.context_words();
    let wants_refine = options.refine && !test;
    options.refine = false;
    let mut session = Session::new(options.clone(), Arc::clone(sink));
    let mut requests = Requests::default();

    let vad = if test {
        None
    } else {
        match prepare(config, flags, loaded) {
            Ok(vad) => Some(vad),
            Err(error) => {
                session.fail(error.code());
                return Ended::Done;
            }
        }
    };
    let refine = wants_refine && prepare_refiner(config, flags, loaded, &context);
    if wants_refine && !refine {
        session.notice("enhancedUnavailable");
    }
    read_commands(commands, &id, &mut requests);
    if requests.cancel {
        session.cancel();
        return if requests.shutdown {
            Ended::Shutdown
        } else {
            Ended::Done
        };
    }
    if requests.stop.is_some() {
        session.stop(StopMode::Keep, Instant::now());
        return Ended::Done;
    }

    let mut capture = match open_capture(config, flags, device.as_deref()) {
        Ok(capture) => Some(capture),
        Err(error) => {
            session.fail(error.code());
            return Ended::Done;
        }
    };
    flags.capture_open.store(true, Ordering::Relaxed);
    if capture.as_ref().is_some_and(|c| c.fell_back) {
        session.notice("deviceFallback");
    }
    let (rate, channels) = capture
        .as_ref()
        .map_or((16_000, 1), |c| (c.rate, c.channels));
    let Ok(mut resampler) = Resampler16k::new(rate) else {
        session.fail(SpeechError::Audio("rate").code());
        flags.capture_open.store(false, Ordering::Relaxed);
        return Ended::Done;
    };

    loaded.generation += 1;
    let generation = loaded.generation;
    if let Some(refiner) = &loaded.refiner {
        refiner.set_generation(generation);
    }
    let online = loaded.online.as_ref();
    let coordinator = match (online, vad) {
        (Some(model), Some(vad)) => Some(Coordinator::new(model.stream(&hotwords), vad, refine)),
        _ => None,
    };
    if !test && coordinator.is_none() {
        session.fail(SpeechError::LoadFailed.code());
        flags.capture_open.store(false, Ordering::Relaxed);
        return Ended::Done;
    }
    session.set_refine(refine);
    session.record(coordinator);

    let mut interleaved = Vec::new();
    let mut mono = Vec::new();
    let mut resampled = Vec::new();
    let mut last_overflow_notice: Option<Instant> = None;
    loop {
        read_commands(commands, &id, &mut requests);
        let now = Instant::now();
        if requests.cancel {
            drop(capture.take());
            flags.capture_open.store(false, Ordering::Relaxed);
            session.cancel();
            break;
        }
        if let Some(open) = capture.as_mut() {
            interleaved.clear();
            open.read(&mut interleaved);
            let failed = open.failed();
            if open.take_overflow() > 0
                && last_overflow_notice
                    .is_none_or(|t| now.duration_since(t) >= OVERFLOW_NOTICE_EVERY)
            {
                session.notice("overflow");
                last_overflow_notice = Some(now);
            }
            mono.clear();
            downmix(&interleaved, channels, &mut mono);
            resampled.clear();
            resampler.process(&mono, &mut resampled);
            let stop = requests.stop.take();
            let close = stop.is_some() || failed;
            if close {
                // Close the device first, then push out what the filter still holds.
                drop(capture.take());
                flags.capture_open.store(false, Ordering::Relaxed);
                resampler.flush(&mut resampled);
            }
            let limited = session.feed(&resampled, now).is_some();
            if limited {
                drop(capture.take());
                flags.capture_open.store(false, Ordering::Relaxed);
            } else if failed {
                session.notice("deviceLost");
                session.stop(StopMode::Keep, now);
            } else if let Some(mode) = stop {
                session.stop(mode, now);
            }
        } else if let Some(mode) = requests.stop.take() {
            session.stop(mode, now);
        }
        if let Some(refiner) = &loaded.refiner {
            for job in session.take_jobs() {
                if !refiner.submit(generation, job.segment, job.pcm, now + REFINE_DEADLINE) {
                    session.refined(job.segment, Err(()), now);
                }
            }
            for refined in refiner.poll() {
                if refined.generation == generation {
                    session.refined(refined.segment, refined.result, now);
                }
            }
        }
        session.tick(now);
        if session.is_done() {
            break;
        }
        std::thread::sleep(TICK);
    }
    drop(capture);
    flags.capture_open.store(false, Ordering::Relaxed);
    if requests.shutdown {
        Ended::Shutdown
    } else {
        Ended::Done
    }
}
