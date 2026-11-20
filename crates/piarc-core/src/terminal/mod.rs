//! Terminals in Core (ADR-0017, T10, T33): the registry of `piarc_term::Session`s, their events
//! on the event path, pulled frames, reads, input, and the end of their process trees.
//!
//! # Two kinds of terminals
//!
//! - **Of a session** (the terminal panel, ADR-0050's terminal tasks): opened through the tool
//!   I/O, which gives them the session's shell directory, the command environment of T17 (and
//!   the sandbox wrapper of a sandboxed session) and PiArc's shell integration. Each is a
//!   background task of kind `terminal` ([`bound`]): Core rewrites its screen file for the
//!   model, saves its snapshot, and ends it with the session or with PiArc.
//! - **Without a session** (the prototype page, tests): [`Terminals::create`], as T10 had them.
//!
//! # Events
//!
//! Each terminal reports on the route `term/<id>`, one
//! [`piarc_protocol::terminal::TerminalEvent`] per JSON object, sent from its IO thread with
//! `EventSender::blocking_send`.
//!
//! # Off the JavaScript thread
//!
//! Starting a terminal (opening the PTY, spawning the shell), pulling a frame, reading text,
//! searching and pasting run on the blocking pool and answer through a callback (the NAPI
//! layer settles a Promise with it). Input, keys, mouse, focus and resizing only queue a
//! message for the terminal's writer thread. A hidden terminal is not asked for frames and
//! produces none.
//!
//! # Closing
//!
//! Closing a terminal hangs up its PTY and ends everything attached to it
//! (`piarc_exec::terminal_tree`: SIGHUP then, after a grace, SIGKILL on macOS; the Job Object
//! on Windows). PiArc quitting closes every terminal the same way after saving the snapshots of
//! the session terminals ([`Terminals::shutdown`]).

mod bound;
mod events;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use piarc_exec::terminal_tree::{HANGUP_GRACE, TerminalTree};
use piarc_protocol::terminal::{
    TerminalCommand, TerminalInfo, TerminalMatch, TerminalPasteOutcome, TerminalTextRange,
};
use piarc_term::shell::Integration;
use piarc_term::vt::{KeyAction, MouseAction, MouseInput, PasteOutcome, TextOptions, TextRange};
use piarc_term::{Event as TermEvent, Program, Session, SessionConfig, SessionStats, keymap};
use tokio::runtime::Handle;

pub(crate) use bound::{BoundSpec, Opened};

use crate::error::{Error, Result};
use crate::events::{Event, EventSender};
use crate::route::RouteKey;
use crate::tasks::TaskManager;

/// Largest accepted grid side.
pub const MAX_TERMINAL_SIDE: u16 = 1000;

/// Scrollback kept per terminal, in lines.
pub const SCROLLBACK_LINES: usize = 10_000;

/// Where the user turns off clipboard writes by programs in terminals (`settings.json`).
const CLIPBOARD_SETTING: &str = "/terminal/clipboardWrite";

/// Settings of [`Terminals::create`] (a terminal without a session).
#[derive(Debug, Clone, Default)]
pub struct TerminalOptions {
    /// Columns (1 to [`MAX_TERMINAL_SIDE`]).
    pub cols: u16,
    /// Rows (1 to [`MAX_TERMINAL_SIDE`]).
    pub rows: u16,
    /// Cell size in pixels, for pixel size reports and mouse positions.
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
    /// Program and arguments; the user's login shell when unset.
    pub command: Option<(String, Vec<String>)>,
    /// Absolute working directory; the home directory when unset.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables.
    pub env: Vec<(String, String)>,
}

/// A key event as the renderer reports it (`KeyboardEvent` fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    /// Press, repeat or release.
    pub action: KeyAction,
    /// `KeyboardEvent.code`.
    pub code: String,
    /// The character the key produced, empty for named keys.
    pub text: String,
    /// `piarc_term::keymap::MOD_*` bits.
    pub mods: u16,
    /// Part of an input-method composition.
    pub composing: bool,
}

/// A mouse event as the renderer reports it, in pixels of the terminal's surface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseEvent {
    /// Press, release or motion.
    pub action: MouseAction,
    /// 1 left, 2 right, 3 middle, 4–7 wheel, 8–11 extra; `None` for motion alone.
    pub button: Option<u8>,
    /// `piarc_term::keymap::MOD_*` bits.
    pub mods: u16,
    /// Horizontal position.
    pub x: f32,
    /// Vertical position.
    pub y: f32,
}

/// What a session terminal needs from Core's state: where files go, the task manager, the
/// shell integration.
struct Context {
    data_dir: PathBuf,
    tasks: TaskManager,
    integration: Option<Integration>,
}

struct Entry {
    id: u32,
    session: Arc<Session>,
    bound: Option<Arc<bound::Bound>>,
    tree: Option<TerminalTree>,
    /// The tree was ended (closing, or the shell exited).
    ended: AtomicBool,
}

struct Inner {
    handle: Handle,
    events: EventSender,
    next_id: AtomicU32,
    entries: Mutex<HashMap<u32, Arc<Entry>>>,
    /// Trees being ended (hangup, grace, kill): shutdown waits for them, or a process that
    /// ignores the hangup would outlive the runtime that was going to kill it.
    ending: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    context: OnceLock<Context>,
}

/// The registry of live terminals. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Terminals {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Terminals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminals").finish_non_exhaustive()
    }
}

/// Runs `work` (on the blocking pool), turning a panic into an internal error, so the caller's
/// callback always runs and a Promise waiting on it always settles (I55).
fn guarded<T>(location: &str, work: impl FnOnce() -> Result<T>) -> Result<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or_else(|payload| Err(Error::from_panic(location, &*payload)))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn check_size(cols: u16, rows: u16) -> Result<()> {
    let ok = |side: u16| (1..=MAX_TERMINAL_SIDE).contains(&side);
    if ok(cols) && ok(rows) {
        Ok(())
    } else {
        Err(Error::InvalidArgument {
            field: "size",
            reason: format!("columns and rows must be between 1 and {MAX_TERMINAL_SIDE}"),
        })
    }
}

/// Whether the user allows programs in terminals to write the clipboard (default yes).
fn clipboard_write_allowed(data_dir: Option<&Path>) -> bool {
    let Some(text) = data_dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
    else {
        return true;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.pointer(CLIPBOARD_SETTING)
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(true)
}

impl Terminals {
    pub(crate) fn new(handle: Handle, events: EventSender) -> Self {
        Self {
            inner: Arc::new(Inner {
                handle,
                events,
                next_id: AtomicU32::new(1),
                entries: Mutex::new(HashMap::new()),
                ending: Mutex::new(Vec::new()),
                context: OnceLock::new(),
            }),
        }
    }

    /// Connects Core's state: session terminals become possible. Installs the shell
    /// integration under `<data dir>/shell-integration/`; without it terminals still work,
    /// without command boundaries.
    pub(crate) fn attach(&self, data_dir: PathBuf, tasks: TaskManager) {
        let integration = match piarc_term::shell::install(&data_dir.join("shell-integration")) {
            Ok(integration) => Some(integration),
            Err(error) => {
                tracing::warn!(target: "piarc_core::terminal", %error, "no shell integration");
                None
            }
        };
        tasks.set_terminal_views(Arc::new(bound::Views(Arc::downgrade(&self.inner))));
        let _ = self.inner.context.set(Context {
            data_dir,
            tasks,
            integration,
        });
    }

    fn entry(&self, id: u32) -> Result<Arc<Entry>> {
        lock(&self.inner.entries)
            .get(&id)
            .cloned()
            .ok_or(Error::UnknownTerminal { id })
    }

    fn session(&self, id: u32) -> Result<Arc<Session>> {
        Ok(Arc::clone(&self.entry(id)?.session))
    }

    /// Runs `work` with the terminal on the blocking pool and hands its result to `on_done`.
    fn on_pool<T: Send + 'static>(
        &self,
        id: u32,
        location: &'static str,
        work: impl FnOnce(&Session) -> Result<T> + Send + 'static,
        on_done: impl FnOnce(Result<T>) + Send + 'static,
    ) -> Result<()> {
        let session = self.session(id)?;
        self.inner.handle.spawn_blocking(move || {
            on_done(guarded(location, || work(&session)));
        });
        Ok(())
    }

    /// Starts a terminal without a session on the blocking pool; `on_done` gets its id. Its
    /// events arrive on `term/<id>`.
    pub(crate) fn create(
        &self,
        options: TerminalOptions,
        on_done: impl FnOnce(Result<u32>) + Send + 'static,
    ) -> Result<()> {
        check_size(options.cols, options.rows)?;
        if let Some(cwd) = &options.cwd
            && !cwd.is_absolute()
        {
            return Err(Error::InvalidArgument {
                field: "cwd",
                reason: "must be an absolute path".into(),
            });
        }
        let me = self.clone();
        self.inner.handle.spawn_blocking(move || {
            on_done(guarded("terminal create", || me.spawn_plain(options)));
        });
        Ok(())
    }

    fn spawn_plain(&self, options: TerminalOptions) -> Result<u32> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let data_dir = self.inner.context.get().map(|c| c.data_dir.as_path());
        let config = SessionConfig {
            cols: options.cols,
            rows: options.rows,
            cell_width: options.cell_width,
            cell_height: options.cell_height,
            program: match options.command {
                Some((program, args)) => Program::Command { program, args },
                None => Program::DefaultShell,
            },
            cwd: options.cwd,
            env: options.env,
            scrollback_lines: SCROLLBACK_LINES,
            clipboard_write: clipboard_write_allowed(data_dir),
            ..SessionConfig::default()
        };
        let session = Session::spawn(config, self.event_handler(id, None)?)?;
        self.insert(id, session, None);
        Ok(id)
    }

    /// The event handler of terminal `id`: forwards to `term/<id>` and lets a session
    /// terminal react (`hooks`).
    fn event_handler(
        &self,
        id: u32,
        hooks: Option<Arc<bound::Hooks>>,
    ) -> Result<piarc_term::EventHandler> {
        let route = RouteKey::parse(&format!("term/{id}"))?;
        let events = self.inner.events.clone();
        let weak = Arc::downgrade(&self.inner);
        Ok(Arc::new(move |event: TermEvent| {
            if let Ok(json) = serde_json::to_value(events::to_protocol(&event))
                && let Ok(event) = Event::from_json(route.clone(), &json)
            {
                // Runs on the terminal's IO thread, outside the runtime. The queue only fails
                // when Core is shutting down; nobody listens then.
                let _ = events.blocking_send(event);
            }
            if let Some(hooks) = &hooks {
                hooks.on_event(&event);
            }
            if matches!(event, TermEvent::Exited { .. })
                && let Some(inner) = weak.upgrade()
            {
                Terminals { inner }.program_exited(id);
            }
        }))
    }

    fn insert(&self, id: u32, session: Session, bound: Option<Arc<bound::Bound>>) -> Arc<Entry> {
        let tree = session.pid().and_then(|pid| {
            TerminalTree::attach(pid, session.tty())
                .inspect_err(|error| {
                    tracing::warn!(target: "piarc_core::terminal", %error, "cannot follow the terminal's processes");
                })
                .ok()
        });
        let entry = Arc::new(Entry {
            id,
            session: Arc::new(session),
            bound,
            tree,
            ended: AtomicBool::new(false),
        });
        lock(&self.inner.entries).insert(id, Arc::clone(&entry));
        entry
    }

    /// The shell exited on its own: what it left attached to the terminal ends too (the PTY
    /// hung up, as a terminal window closing does). A session terminal's task is ended by its
    /// hooks.
    fn program_exited(&self, id: u32) {
        if let Ok(entry) = self.entry(id) {
            self.end_tree(&entry);
        }
    }

    /// Hangs up terminal `entry` and ends its process tree, on the runtime.
    fn end_tree(&self, entry: &Arc<Entry>) {
        if entry.ended.swap(true, Ordering::AcqRel) {
            return;
        }
        let entry = Arc::clone(entry);
        let ending = self.inner.handle.spawn(async move {
            let session = Arc::clone(&entry.session);
            match &entry.tree {
                Some(tree) => tree.end(move || session.close(), HANGUP_GRACE).await,
                None => session.close(),
            }
        });
        let mut endings = lock(&self.inner.ending);
        endings.retain(|e| !e.is_finished());
        endings.push(ending);
    }

    pub(crate) fn write(&self, id: u32, bytes: Vec<u8>) -> Result<()> {
        Ok(self.session(id)?.write(bytes)?)
    }

    pub(crate) fn key(&self, id: u32, key: &KeyEvent) -> Result<()> {
        let input = keymap::key_input(key.action, &key.code, &key.text, key.mods, key.composing);
        Ok(self.session(id)?.key(input)?)
    }

    pub(crate) fn mouse(&self, id: u32, event: MouseEvent) -> Result<()> {
        Ok(self.session(id)?.mouse(MouseInput {
            action: event.action,
            button: event.button,
            mods: event.mods & keymap::MODS_MASK,
            x: event.x,
            y: event.y,
        })?)
    }

    pub(crate) fn focus(&self, id: u32, gained: bool) -> Result<()> {
        Ok(self.session(id)?.focus(gained)?)
    }

    pub(crate) fn paste(
        &self,
        id: u32,
        text: String,
        allow_unsafe: bool,
        on_done: impl FnOnce(Result<TerminalPasteOutcome>) + Send + 'static,
    ) -> Result<()> {
        self.on_pool(
            id,
            "terminal paste",
            move |session| {
                Ok(match session.paste(text, allow_unsafe)? {
                    PasteOutcome::Pasted => TerminalPasteOutcome::Pasted,
                    PasteOutcome::Unsafe => TerminalPasteOutcome::Unsafe,
                    PasteOutcome::Empty => TerminalPasteOutcome::Empty,
                })
            },
            on_done,
        )
    }

    pub(crate) fn resize(&self, id: u32, cols: u16, rows: u16, cell: (u32, u32)) -> Result<()> {
        check_size(cols, rows)?;
        Ok(self.session(id)?.resize(cols, rows, cell.0, cell.1)?)
    }

    /// Encodes the next frame for `viewer` on the blocking pool and calls `on_done` there.
    pub(crate) fn frame(
        &self,
        id: u32,
        viewer: u32,
        full: bool,
        on_done: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
    ) -> Result<()> {
        self.on_pool(
            id,
            "terminal frame",
            move |session| session.frame(viewer, full).map_err(Error::from),
            on_done,
        )
    }

    /// `range` of terminal `id` as plain text (the formatter's), on the blocking pool.
    pub(crate) fn text(
        &self,
        id: u32,
        range: TerminalTextRange,
        unwrap: bool,
        on_done: impl FnOnce(Result<String>) + Send + 'static,
    ) -> Result<()> {
        let range = match range {
            TerminalTextRange::Screen => TextRange::Screen,
            TerminalTextRange::Viewport => TextRange::Viewport,
            TerminalTextRange::All => TextRange::All,
            TerminalTextRange::LastLines { count } => TextRange::LastRows(count),
        };
        let options = TextOptions { unwrap, trim: true };
        self.on_pool(
            id,
            "terminal text",
            move |session| session.text(range, options).map_err(Error::from),
            on_done,
        )
    }

    /// The newest command of terminal `id` (OSC 133), on the blocking pool.
    pub(crate) fn last_command(
        &self,
        id: u32,
        on_done: impl FnOnce(Result<Option<TerminalCommand>>) + Send + 'static,
    ) -> Result<()> {
        self.on_pool(
            id,
            "terminal command",
            |session| Ok(session.last_command()?.map(events::command)),
            on_done,
        )
    }

    /// Finds `query` in terminal `id`, on the blocking pool (output keeps flowing).
    pub(crate) fn search(
        &self,
        id: u32,
        query: String,
        on_done: impl FnOnce(Result<Vec<TerminalMatch>>) + Send + 'static,
    ) -> Result<()> {
        self.on_pool(
            id,
            "terminal search",
            move |session| {
                let found = session.search(&query, &|| false)?;
                Ok(found.into_iter().map(events::search_match).collect())
            },
            on_done,
        )
    }

    /// What terminal `id` shows.
    pub(crate) fn info(&self, id: u32) -> Result<TerminalInfo> {
        let entry = self.entry(id)?;
        let info = entry.session.info();
        Ok(TerminalInfo {
            terminal_id: id,
            cols: u32::from(info.cols),
            rows: u32::from(info.rows),
            title: info.title,
            pwd: info.pwd,
            alternate_screen: info.alternate_screen,
            last_command: info.last_command,
            session_id: entry.bound.as_ref().map(|b| b.session_id.clone()),
            task_id: entry.bound.as_ref().map(|b| b.task_id.clone()),
            shared: entry.bound.as_ref().is_some_and(|b| b.is_shared()),
        })
    }

    /// Closes terminal `id` because the user closed it: a session terminal stops as its task
    /// (the snapshot is dropped), any other at once.
    pub(crate) fn close(&self, id: u32) -> Result<()> {
        let entry = self.entry(id)?;
        match (&entry.bound, self.inner.context.get()) {
            (Some(bound), Some(context)) => {
                let (tasks, task_id) = (context.tasks.clone(), bound.task_id.clone());
                self.inner.handle.spawn(async move {
                    let _ = tasks.stop(&task_id, crate::tasks::StopBy::User).await;
                });
            }
            _ => self.close_now(id, false),
        }
        Ok(())
    }

    /// Takes terminal `id` out of the registry and ends it; `keep` saves a session terminal's
    /// snapshot for the next start (PiArc quits), else drops it.
    fn close_now(&self, id: u32, keep: bool) {
        let Some(entry) = lock(&self.inner.entries).remove(&id) else {
            return;
        };
        if let Some(bound) = &entry.bound {
            bound.closing(&entry.session, keep);
        }
        self.end_tree(&entry);
    }

    /// PiArc quits: session terminals stop as their tasks (snapshots kept, `interrupted`),
    /// the rest close; returns once every tree has been ended (hangup, grace, kill).
    pub(crate) async fn shutdown(&self) {
        let entries: Vec<Arc<Entry>> = lock(&self.inner.entries).values().cloned().collect();
        let context = self.inner.context.get();
        let mut stops = Vec::new();
        for entry in &entries {
            match (&entry.bound, context) {
                (Some(bound), Some(context)) => {
                    let (tasks, task_id) = (context.tasks.clone(), bound.task_id.clone());
                    stops.push(self.inner.handle.spawn(async move {
                        let _ = tasks.stop(&task_id, crate::tasks::StopBy::Shutdown).await;
                    }));
                }
                _ => self.close_now(entry.id, false),
            }
        }
        for stop in stops {
            let _ = stop.await;
        }
        // A terminal whose task did not stop in time closes here, its snapshot kept.
        let me = self.clone();
        let ids: Vec<u32> = entries.iter().map(|e| e.id).collect();
        let _ = tokio::task::spawn_blocking(move || {
            for id in ids {
                me.close_now(id, true);
            }
        })
        .await;
        // Every tree's hangup, grace and kill runs to its end before the runtime stops:
        // a process that ignores the hangup must not outlive the task that kills it.
        let endings = std::mem::take(&mut *lock(&self.inner.ending));
        for ending in endings {
            let _ = ending.await;
        }
        // The shells' exits arrive before the event channel closes.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        while entries.iter().any(|e| e.session.exit().is_none())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub(crate) fn stats(&self, id: u32) -> Result<SessionStats> {
        Ok(self.session(id)?.stats())
    }

    pub(crate) fn probe_echo(
        &self,
        id: u32,
        byte: u8,
        on_done: impl FnOnce(Result<Duration>) + Send + 'static,
    ) -> Result<()> {
        self.on_pool(
            id,
            "terminal echo probe",
            move |session| {
                session
                    .probe_direct_echo(byte, Duration::from_secs(5))
                    .map_err(Error::from)
            },
            on_done,
        )
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    /// I55: a panic in work run on the blocking pool settles the caller with an internal error
    /// instead of leaving its Promise unsettled.
    #[test]
    fn a_panic_on_the_blocking_pool_becomes_an_internal_error() {
        let result: Result<u8> = guarded("terminal frame", || panic!("broken frame"));
        let error = result.expect_err("the panic is reported");
        assert_eq!(error.kind(), piarc_protocol::ErrorKind::InternalError);
        assert!(error.to_string().contains("broken frame"), "{error}");
        assert_eq!(
            guarded("terminal frame", || Ok(7)).expect("passes through"),
            7
        );
    }

    #[test]
    fn the_clipboard_setting_defaults_to_allowed() {
        let dir = std::env::temp_dir().join(format!("piarc-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        assert!(clipboard_write_allowed(Some(&dir)), "no settings file");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"terminal":{"clipboardWrite":false}}"#,
        )
        .expect("settings");
        assert!(!clipboard_write_allowed(Some(&dir)));
        assert!(clipboard_write_allowed(None));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests;
