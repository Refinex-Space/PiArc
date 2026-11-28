//! [`Session`]: a program in a PTY whose output feeds one libghostty-vt terminal (ADR-0017
//! rule 1).
//!
//! # Threads
//!
//! - The IO thread (`piarc-term-io`) reads the PTY and writes each chunk into the terminal
//!   under its lock, then collects the effects while still holding it (OSC 133 marks join the
//!   [`CommandLog`] there, because their tracked cells belong to the terminal). Outside the
//!   lock, query replies go to the writer and everything else becomes an [`Event`]. At end of
//!   output it takes the program's exit code from the waiter thread and reports
//!   [`Event::Exited`]. A read interrupted by a signal is retried.
//! - The waiter thread (`piarc-term-wait`) waits for the program. On Windows it then stops the
//!   writer: ConPTY ends its output only when the pseudoconsole closes, which happens when the
//!   writer drops the master, so without this a program that exits on its own would never
//!   reach end of output.
//! - The writer thread (`piarc-term-writer`) owns the PTY master. It writes input, encodes key
//!   and mouse events with the terminal's current modes, pastes, and resizes. Its queue is
//!   bounded ([`WRITER_QUEUE`]): callers' requests never block ([`Error::Busy`] when full),
//!   while the IO thread waits with its replies, which stops reading the program until the
//!   program reads its input again.
//! - Everything else ([`Session::frame`], the text and command reads, search, snapshots) runs
//!   on the caller's thread and takes the terminal's lock briefly; callers keep it off the
//!   JavaScript thread. Frames hold the lock only for the first half of the render-state update
//!   (libghostty-vt's two-phase update); a search only while it feeds.
//! - A panic in one of the three threads is caught: the session reports [`Event::Failed`] and
//!   behaves as closed instead of hanging its callers.
//!
//! # Closing
//!
//! [`Session::close`] (and `Drop`) stops the writer and hangs up the program. The IO thread
//! ends when the PTY reports end of output. portable-pty 0.9.0's Windows `ChildKiller::kill`
//! reports success as an error (fixed only on wezterm's main branch), so its result is not
//! trusted on any platform: the exit is confirmed by the waiter thread's `wait`. Ending the
//! program's whole process tree (jobs it started, on Windows everything in its Job Object) is
//! up to the owner, with [`Session::pid`] and [`Session::tty`] (Core does it with
//! `piarc-exec`).

mod pointer;
mod threads;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, PtySize, native_pty_system};

use crate::commands::{CommandInfo, CommandLog};
use crate::error::{Error, Result};
use crate::frame::{EncodeStats, FrameEncoder};
use crate::snapshot::{Restored, Saved};
use crate::vt::{
    self, ActiveScreen, KeyEncoder, KeyInput, Link, MouseEncoder, MouseGeometry, MouseInput,
    PasteOutcome, ScrollTo, SearchMatch, SelectionGesture, Terminal, TextOptions, TextRange,
};
use threads::{Workers, WriterMessage};

/// How long a synchronized-output hold may freeze the screen before Core ends it
/// (libghostty-vt's rendering guide: "One second is a common limit").
pub const HOLD_TIMEOUT: Duration = Duration::from_secs(1);

/// Requests waiting for the writer thread.
pub const WRITER_QUEUE: usize = 256;

/// The clock of a session (render-hold timeout).
pub type Now = Arc<dyn Fn() -> Instant + Send + Sync>;

/// What runs in the PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Program {
    /// The user's login shell (`$SHELL`, or the password database).
    DefaultShell,
    /// A program and its arguments, looked up on `PATH`.
    Command {
        /// Program name or path.
        program: String,
        /// Arguments.
        args: Vec<String>,
    },
}

/// Settings of a new session.
#[derive(Clone)]
pub struct SessionConfig {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
    /// Cell width in pixels (pixel size reports, mouse positions).
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
    /// The program.
    pub program: Program,
    /// Working directory; the home directory when unset.
    pub cwd: Option<PathBuf>,
    /// Environment variables: on top of the inherited environment, or the whole environment
    /// with `clear_env`. `TERM` and `COLORTERM` are always set.
    pub env: Vec<(String, String)>,
    /// Start from an empty environment instead of this process's.
    pub clear_env: bool,
    /// Scrollback limit in lines.
    pub scrollback_lines: usize,
    /// Accept clipboard writes from programs (OSC 52).
    pub clipboard_write: bool,
    /// A saved terminal to continue from: its screen and scrollback come first.
    pub restore: Option<Saved>,
    /// The clock (render-hold timeout); the system's when unset.
    pub now: Option<Now>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            cell_width: 8,
            cell_height: 16,
            program: Program::DefaultShell,
            cwd: None,
            env: Vec::new(),
            clear_env: false,
            scrollback_lines: 10_000,
            clipboard_write: true,
            restore: None,
            now: None,
        }
    }
}

/// Something the terminal reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The program set the title (OSC 0/2); empty after a reset.
    Title(String),
    /// The shell reported its working directory (OSC 7): a path when the URL is a local file
    /// URL, else the URL as sent; empty after a reset.
    Pwd(String),
    /// The program rang the bell `count` times in one chunk of output.
    Bell {
        /// Bells in the chunk.
        count: u32,
    },
    /// A command started or finished (OSC 133).
    Command(crate::commands::CommandChange),
    /// The program put text on the clipboard (OSC 52) and clipboard writes are allowed.
    Clipboard(String),
    /// The program asked to read the clipboard; it got an empty answer.
    ClipboardReadDenied,
    /// The program exited and its output was fully read. `code` is `None` when the exit
    /// status could not be read.
    Exited {
        /// Exit code.
        code: Option<u32>,
    },
    /// A thread of the session failed; the session no longer works.
    Failed {
        /// What failed.
        reason: String,
    },
    /// Output arrived after a frame pulled with `park` ([`Session::frame_parking`]): the viewer
    /// that stopped pulling while nothing changed should pull again. Sent once per parking.
    Output,
}

/// Receives [`Event`]s, on the IO thread. Must not block for long: output waits meanwhile.
pub type EventHandler = Arc<dyn Fn(Event) + Send + Sync>;

/// The default colors a viewer gives the terminal ([`Session::set_colors`]); `None` keeps
/// libghostty-vt's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DefaultColors {
    /// Text without a color of its own.
    pub foreground: Option<piarc_protocol::term_frame::Rgb>,
    /// Cells without a background of their own.
    pub background: Option<piarc_protocol::term_frame::Rgb>,
    /// The cursor.
    pub cursor: Option<piarc_protocol::term_frame::Rgb>,
}

/// Counters of one session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionStats {
    /// Bytes read from the PTY.
    pub bytes_read: u64,
    /// Reads from the PTY.
    pub reads: u64,
    /// Time spent in `vt_write` (parsing and state updates), in nanoseconds.
    pub vt_write_nanos: u64,
    /// Frames produced, empty ones included.
    pub frames: u64,
    /// Empty frames (nothing changed).
    pub empty_frames: u64,
    /// Bytes of all frames.
    pub frame_bytes: u64,
    /// Time spent producing frames (update and encode), in nanoseconds.
    pub frame_nanos: u64,
    /// Rows sent with cells.
    pub rows_with_cells: u64,
    /// Rows sent as references.
    pub rows_reused: u64,
}

/// What a terminal shows, for titles and status lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalInfo {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
    /// The title the program set, empty when none.
    pub title: String,
    /// The working directory the shell reported (see [`Event::Pwd`]), empty when none.
    pub pwd: String,
    /// The alternate screen is active (a full-screen program runs).
    pub alternate_screen: bool,
    /// The number of the newest command (OSC 133), 0 before the first.
    pub last_command: u64,
}

#[derive(Default)]
struct Counters {
    bytes_read: AtomicU64,
    reads: AtomicU64,
    vt_write_nanos: AtomicU64,
    frames: AtomicU64,
    empty_frames: AtomicU64,
    frame_bytes: AtomicU64,
    frame_nanos: AtomicU64,
    rows_with_cells: AtomicU64,
    rows_reused: AtomicU64,
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

/// A pending direct-echo measurement: the writer wrote `byte` at `written`.
struct Probe {
    byte: u8,
    written: Instant,
    done: mpsc::Sender<Duration>,
}

/// State behind the terminal's lock: the terminal and the command log whose tracked cells
/// belong to it. Lock `commands` only while holding `terminal`.
struct Shared {
    terminal: Mutex<Terminal>,
    commands: Mutex<CommandLog>,
    /// Bumped after each chunk of output was applied; waiters sleep on `changed`.
    generation: Mutex<u64>,
    changed: Condvar,
    frames: Mutex<FrameEncoder>,
    counters: Counters,
    probe: Mutex<Option<Probe>>,
    exit: Mutex<Option<Option<u32>>>,
    failed: AtomicBool,
    now: Now,
    geometry: Mutex<MouseGeometry>,
    /// A viewer parked (stopped pulling) after a frame: the next output sends [`Event::Output`].
    wake: AtomicBool,
}

impl Shared {
    fn new(terminal: Terminal, frames: FrameEncoder, config: &SessionConfig) -> Self {
        Self {
            terminal: Mutex::new(terminal),
            commands: Mutex::new(CommandLog::default()),
            generation: Mutex::new(0),
            changed: Condvar::new(),
            frames: Mutex::new(frames),
            counters: Counters::default(),
            probe: Mutex::new(None),
            exit: Mutex::new(None),
            failed: AtomicBool::new(false),
            now: config.now.clone().unwrap_or_else(|| Arc::new(Instant::now)),
            geometry: Mutex::new(geometry(
                config.cols,
                config.rows,
                config.cell_width,
                config.cell_height,
            )),
            wake: AtomicBool::new(false),
        }
    }
}

/// Locks `mutex`, recovering the data after a panic elsewhere: every critical section leaves
/// the terminal and the encoder consistent between calls.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A terminal session.
pub struct Session {
    shared: Arc<Shared>,
    writer: Mutex<Option<SyncSender<WriterMessage>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: AtomicBool,
    pid: Option<u32>,
    tty: Option<PathBuf>,
}

impl Session {
    /// Starts `config.program` in a new PTY and the session's three threads. A restored
    /// terminal's screen and scrollback come before the program's output.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size or a working directory that is not a
    /// directory; [`Error::Spawn`] when the PTY or the program cannot be started;
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn spawn(config: SessionConfig, on_event: EventHandler) -> Result<Self> {
        Self::spawn_restored(config, on_event).map(|(session, _)| session)
    }

    /// [`spawn`](Self::spawn), also reporting how `config.restore` was applied.
    ///
    /// # Errors
    ///
    /// As [`spawn`](Self::spawn).
    pub fn spawn_restored(
        mut config: SessionConfig,
        on_event: EventHandler,
    ) -> Result<(Self, Option<Restored>)> {
        let (terminal, restored) = initial_terminal(&mut config)?;
        let frames = FrameEncoder::new()?;
        let (keys, mouse, gesture) = (
            KeyEncoder::new()?,
            MouseEncoder::new()?,
            SelectionGesture::new()?,
        );
        let pair = native_pty_system()
            .openpty(pty_size(
                config.cols,
                config.rows,
                config.cell_width,
                config.cell_height,
            ))
            .map_err(|error| spawn_error("open a PTY", &error))?;
        // Programs in the terminal inherit whether Ctrl+C is ignored (see `console`).
        #[cfg(windows)]
        crate::console::let_children_handle_ctrl_c();
        let child = pair
            .slave
            .spawn_command(command(&config))
            .map_err(|error| spawn_error("start the program", &error))?;
        // The program holds its own copy of the slave; ours must close for EOF to arrive.
        drop(pair.slave);
        let pid = child.process_id();
        #[cfg(unix)]
        let tty = pair.master.tty_name();
        #[cfg(not(unix))]
        let tty = None;
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| spawn_error("read the PTY", &error))?;
        let output = pair
            .master
            .take_writer()
            .map_err(|error| spawn_error("write the PTY", &error))?;
        let shared = Arc::new(Shared::new(terminal, frames, &config));
        let (tx, rx) = mpsc::sync_channel(WRITER_QUEUE);
        threads::start(
            &shared,
            Workers {
                child,
                reader,
                output,
                master: pair.master,
                keys,
                mouse,
                gesture,
                messages: rx,
                writer: tx.clone(),
                on_event,
            },
        )?;
        Ok((
            Self {
                shared,
                writer: Mutex::new(Some(tx)),
                killer: Mutex::new(killer),
                closed: AtomicBool::new(false),
                pid,
                tty,
            },
            restored,
        ))
    }

    fn send(&self, message: WriterMessage) -> Result<()> {
        if self.shared.failed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let writer = lock(&self.writer);
        let writer = writer.as_ref().ok_or(Error::Closed)?;
        match writer.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(Error::Busy),
            Err(TrySendError::Disconnected(_)) => Err(Error::Closed),
        }
    }

    /// The program's process id (on Unix it leads the PTY's session), if known.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The PTY's terminal device (Unix), the controlling terminal of the program and of
    /// everything it starts that does not detach.
    #[must_use]
    pub fn tty(&self) -> Option<&std::path::Path> {
        self.tty.as_deref()
    }

    /// Writes `bytes` to the program as they are (committed input-method text). Like typing,
    /// it brings the viewport back to the bottom and clears the selection. Never blocks.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] after [`close`](Self::close); [`Error::Busy`] when the input queue is
    /// full.
    pub fn write(&self, bytes: Vec<u8>) -> Result<()> {
        self.send(WriterMessage::Input(bytes))
    }

    /// Encodes `input` with the terminal's current modes and writes the result. Never blocks.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write).
    pub fn key(&self, input: KeyInput) -> Result<()> {
        self.send(WriterMessage::Key(input))
    }

    /// A pointer event of the viewer (T34). While the program tracks the mouse it is encoded
    /// with the terminal's mouse mode and format and written; otherwise (and for the left
    /// button with Shift held) it selects: a press starts a selection gesture (`clicks` 2
    /// selects a word, 3 a line; Shift extends the selection), motion with the button held
    /// drags it, a release ends it. The wheel (buttons 4 and 5) scrolls the viewport, or on the
    /// alternate screen with alternate scroll mode (1007) sends the arrow keys. Events are
    /// handled in order with key input. Never blocks.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a button out of range; otherwise as
    /// [`write`](Self::write).
    pub fn mouse(&self, input: MouseInput) -> Result<()> {
        if input.button.is_some_and(|b| !(1..=11).contains(&b)) {
            return Err(Error::InvalidArgument {
                field: "button",
                reason: "must be between 1 and 11".into(),
            });
        }
        self.send(WriterMessage::Mouse(input))
    }

    /// Reports focus gained or lost when the program asked for it (mode 1004). Never blocks.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write).
    pub fn focus(&self, gained: bool) -> Result<()> {
        self.send(WriterMessage::Focus(gained))
    }

    /// Pastes `text` as the terminal's modes require: bracketed when the program asked for
    /// bracketed paste, a Kitty paste event when it asked for that, else as typed with line
    /// breaks as carriage returns. Text that could run commands without the user pressing
    /// Enter (a line break outside bracketed paste, the end-of-paste sequence) is refused with
    /// [`PasteOutcome::Unsafe`] unless `allow_unsafe`. Waits for the writer thread; call it off
    /// the JavaScript thread.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write); [`Error::Vt`] when libghostty-vt fails.
    pub fn paste(&self, text: String, allow_unsafe: bool) -> Result<PasteOutcome> {
        let (done, wait) = mpsc::channel();
        self.send(WriterMessage::Paste {
            text,
            allow_unsafe,
            done,
        })?;
        wait.recv().map_err(|_| Error::Closed)?
    }

    /// Resizes the terminal, then the PTY (the program sees `SIGWINCH` after the grid has the
    /// new size). Never blocks.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size; otherwise as [`write`](Self::write).
    pub fn resize(&self, cols: u16, rows: u16, cell_width: u32, cell_height: u32) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(Error::InvalidArgument {
                field: "size",
                reason: "columns and rows must be at least 1".into(),
            });
        }
        self.send(WriterMessage::Resize {
            cols,
            rows,
            cell_width,
            cell_height,
        })
    }

    /// Moves the viewport (the scrollback, the find bar's jumps). Never blocks.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write).
    pub fn scroll(&self, to: ScrollTo) -> Result<()> {
        self.send(WriterMessage::Scroll(to))
    }

    /// Sets the default foreground, background and cursor colors (the viewer's theme). Never
    /// blocks.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write).
    pub fn set_colors(&self, colors: DefaultColors) -> Result<()> {
        self.send(WriterMessage::Colors(colors))
    }

    /// Clears the selection, after the pointer events and keys already queued. Never blocks.
    ///
    /// # Errors
    ///
    /// As [`write`](Self::write).
    pub fn clear_selection(&self) -> Result<()> {
        self.send(WriterMessage::ClearSelection)
    }

    /// The selected text (wrapped rows joined, trailing spaces trimmed), empty when nothing is
    /// selected. Takes the terminal's lock; call it off the JavaScript thread.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn selection_text(&self) -> Result<String> {
        vt::selection_text(&mut lock(&self.shared.terminal))
    }

    /// The OSC 8 hyperlink at viewport cell (`col`, `row`), if any. Takes the terminal's lock;
    /// call it off the JavaScript thread.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn link_at(&self, col: u16, row: u16) -> Result<Option<Link>> {
        vt::link_at(&mut lock(&self.shared.terminal), col, row)
    }

    /// Whether programs may put text on the clipboard (OSC 52).
    pub fn set_clipboard_write(&self, allowed: bool) {
        lock(&self.shared.terminal).set_clipboard_write(allowed);
    }

    /// Produces the next frame for `viewer`; `full` asks for a RESET frame. Blocks while the
    /// IO thread holds the terminal (at most one chunk of `vt_write`); call it off the
    /// JavaScript thread. Only pulled frames are produced: a terminal nobody looks at costs
    /// nothing here.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails; the next frame then resets the viewer.
    pub fn frame(&self, viewer: u32, full: bool) -> Result<Vec<u8>> {
        self.frame_parking(viewer, full, false)
    }

    /// [`frame`](Self::frame) for a viewer that stops pulling when this frame is empty
    /// (`park`): output that arrives after the terminal was read for this frame sends
    /// [`Event::Output`] once, so the viewer knows to pull again. Arming happens under the
    /// terminal's lock, so no output can slip between the frame and the arming.
    ///
    /// # Errors
    ///
    /// As [`frame`](Self::frame).
    pub fn frame_parking(&self, viewer: u32, full: bool, park: bool) -> Result<Vec<u8>> {
        let started = Instant::now();
        let mut frames = lock(&self.shared.frames);
        frames.prepare(viewer, full);
        let (held, updated, scrollbar) = {
            let mut terminal = lock(&self.shared.terminal);
            if park {
                self.shared.wake.store(true, Ordering::Release);
            }
            let now = (self.shared.now)();
            let (held, updated) = update_locked(&mut terminal, &mut frames, now)?;
            (held, updated, terminal.scrollbar())
        };
        if updated {
            frames.render_state().end_update()?;
        }
        let (bytes, stats) = frames.encode(held, scrollbar)?;
        drop(frames);
        if park && !stats.empty {
            // The viewer keeps pulling: no wake needed.
            self.shared.wake.store(false, Ordering::Release);
        }
        self.count_frame(&bytes, stats, started.elapsed());
        Ok(bytes)
    }

    fn count_frame(&self, bytes: &[u8], stats: EncodeStats, elapsed: Duration) {
        let c = &self.shared.counters;
        c.frames.fetch_add(1, Ordering::Relaxed);
        if stats.empty {
            c.empty_frames.fetch_add(1, Ordering::Relaxed);
        }
        c.frame_bytes.fetch_add(
            u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        c.frame_nanos.fetch_add(nanos(elapsed), Ordering::Relaxed);
        c.rows_with_cells
            .fetch_add(u64::from(stats.rows_with_cells), Ordering::Relaxed);
        c.rows_reused
            .fetch_add(u64::from(stats.rows_reused), Ordering::Relaxed);
    }

    /// The visible screen as plain text (libghostty-vt's formatter); the reference for
    /// comparing frames with the screen.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn viewport_text(&self) -> Result<String> {
        vt::viewport_text(&mut lock(&self.shared.terminal))
    }

    /// `range` of the active screen as plain text (libghostty-vt's formatter): what an agent
    /// reads. On the alternate screen every range covers that screen.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn text(&self, range: TextRange, options: TextOptions) -> Result<String> {
        vt::plain_text(&mut lock(&self.shared.terminal), range, options)
    }

    /// Title, working directory, size and screen.
    #[must_use]
    pub fn info(&self) -> TerminalInfo {
        let mut terminal = lock(&self.shared.terminal);
        let last_command = lock(&self.shared.commands).last_seq();
        TerminalInfo {
            cols: terminal.cols(),
            rows: terminal.rows(),
            title: terminal.title(),
            pwd: threads::pwd_path(&terminal.pwd()),
            alternate_screen: terminal.active_screen() == ActiveScreen::Alternate,
            last_command,
        }
    }

    /// The newest command (OSC 133) with its output, if the shell reported one.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn last_command(&self) -> Result<Option<CommandInfo>> {
        let mut terminal = lock(&self.shared.terminal);
        let commands = lock(&self.shared.commands);
        commands.last(&mut terminal)
    }

    /// Command `seq`, if the log still has it.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn command(&self, seq: u64) -> Result<Option<CommandInfo>> {
        let mut terminal = lock(&self.shared.terminal);
        let commands = lock(&self.shared.commands);
        commands.get(seq, &mut terminal)
    }

    /// Waits until a command numbered above `after` has finished and returns it. Blocks up to
    /// `timeout`; call it off the JavaScript thread.
    ///
    /// # Errors
    ///
    /// [`Error::Timeout`] when no such command finished in time; [`Error::Closed`] when the
    /// program exited first.
    pub fn wait_command(&self, after: u64, timeout: Duration) -> Result<CommandInfo> {
        let deadline = Instant::now() + timeout;
        let mut generation = lock(&self.shared.generation);
        loop {
            {
                let mut terminal = lock(&self.shared.terminal);
                let commands = lock(&self.shared.commands);
                if let Some(seq) = commands.finished_after(after)
                    && let Some(info) = commands.get(seq, &mut terminal)?
                {
                    return Ok(info);
                }
            }
            if self.exit().is_some() || self.shared.failed.load(Ordering::Acquire) {
                return Err(Error::Closed);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Error::Timeout {
                    what: "the command to finish",
                });
            }
            generation = self
                .shared
                .changed
                .wait_timeout(generation, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Finds `query` in the active screen and its scrollback, newest first. The terminal is
    /// locked only while the search reads it, so output keeps flowing; call it off the
    /// JavaScript thread. `cancelled` is polled between steps.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for an empty query; [`Error::Cancelled`]; [`Error::Vt`].
    pub fn search(&self, query: &str, cancelled: &dyn Fn() -> bool) -> Result<Vec<SearchMatch>> {
        vt::search(&self.shared.terminal, query, cancelled).map(|(matches, _)| matches)
    }

    /// The terminal as it is now, for saving: a libghostty-vt snapshot, the VT replay and the
    /// plain text (`crate::snapshot`).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails to format the screen.
    pub fn save(&self) -> Result<Saved> {
        Saved::capture(&mut lock(&self.shared.terminal))
    }

    /// The counters.
    #[must_use]
    pub fn stats(&self) -> SessionStats {
        let c = &self.shared.counters;
        SessionStats {
            bytes_read: c.bytes_read.load(Ordering::Relaxed),
            reads: c.reads.load(Ordering::Relaxed),
            vt_write_nanos: c.vt_write_nanos.load(Ordering::Relaxed),
            frames: c.frames.load(Ordering::Relaxed),
            empty_frames: c.empty_frames.load(Ordering::Relaxed),
            frame_bytes: c.frame_bytes.load(Ordering::Relaxed),
            frame_nanos: c.frame_nanos.load(Ordering::Relaxed),
            rows_with_cells: c.rows_with_cells.load(Ordering::Relaxed),
            rows_reused: c.rows_reused.load(Ordering::Relaxed),
        }
    }

    /// `Some(code)` once the program exited and its output was read.
    #[must_use]
    pub fn exit(&self) -> Option<Option<u32>> {
        *lock(&self.shared.exit)
    }

    /// Measures the PTY's own echo time, the baseline of the S7 echo budget: the writer
    /// thread writes `byte` straight to the PTY and the IO thread notes when it reads it back,
    /// before parsing. Blocks up to `timeout`; the program must echo (a shell or `cat`) and
    /// `byte` should not otherwise appear in the output meanwhile.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] after close; [`Error::Pty`] when no echo arrived in time.
    pub fn probe_direct_echo(&self, byte: u8, timeout: Duration) -> Result<Duration> {
        let (done, wait) = mpsc::channel();
        self.send(WriterMessage::Probe { byte, done })?;
        wait.recv_timeout(timeout).map_err(|_| Error::Pty {
            operation: "echo probe",
            reason: format!("no echo within {} ms", timeout.as_millis()),
        })
    }

    /// Stops input and hangs up the program. Frames and text of the last screen stay
    /// available. Safe to call more than once.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // Dropping the sender ends the writer thread, which closes the PTY master.
        lock(&self.writer).take();
        if self.exit().is_none() {
            // portable-pty sends SIGHUP on Unix; on Windows 0.9.0 reports a successful kill as
            // an error. The IO thread's wait confirms the exit either way.
            let _ = lock(&self.killer).kill();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

/// The part of a frame that needs the terminal; the caller holds its lock. Returns
/// `(held, began an update)`.
fn update_locked(
    terminal: &mut Terminal,
    frames: &mut FrameEncoder,
    now: Instant,
) -> Result<(bool, bool)> {
    if terminal.take_hold_capture(frames.render_state()) {
        frames.compare_all_rows();
        return Ok((true, false));
    }
    if let Some(since) = terminal.hold_since() {
        if now.saturating_duration_since(since) < HOLD_TIMEOUT {
            // Keep showing the frame captured when the hold began.
            return Ok((true, false));
        }
        terminal.end_hold()?;
    }
    frames.render_state().begin_update(terminal)?;
    Ok((false, true))
}

/// Checks `config` and builds the terminal the program's output goes into: new, or restored
/// from `config.restore` and brought to the configured size.
fn initial_terminal(config: &mut SessionConfig) -> Result<(Terminal, Option<Restored>)> {
    if let Some(cwd) = &config.cwd
        && !cwd.is_dir()
    {
        return Err(Error::InvalidArgument {
            field: "cwd",
            reason: format!("{} is not a directory", cwd.display()),
        });
    }
    if config.cols == 0 || config.rows == 0 {
        return Err(Error::InvalidArgument {
            field: "size",
            reason: "columns and rows must be at least 1".into(),
        });
    }
    let (mut terminal, restored) = match config.restore.take() {
        Some(saved) => {
            let (terminal, how) = saved.restore(config.scrollback_lines)?;
            (terminal, Some(how))
        }
        None => (
            Terminal::new(config.cols, config.rows, config.scrollback_lines)?,
            None,
        ),
    };
    if (terminal.cols(), terminal.rows()) != (config.cols, config.rows) {
        terminal.resize(
            config.cols,
            config.rows,
            config.cell_width,
            config.cell_height,
        )?;
    }
    terminal.set_clipboard_write(config.clipboard_write);
    Ok((terminal, restored))
}

/// The user's shell for [`Program::DefaultShell`]: `$SHELL` when it is set and executable,
/// else the password database (Unix); `%COMSPEC%` or `cmd.exe` (Windows).
#[must_use]
pub fn default_shell() -> String {
    CommandBuilder::new_default_prog().get_shell()
}

fn spawn_error(what: &str, error: &dyn std::fmt::Display) -> Error {
    Error::Spawn {
        reason: format!("cannot {what}: {error}"),
    }
}

fn pty_size(cols: u16, rows: u16, cell_width: u32, cell_height: u32) -> PtySize {
    let px = |cells: u16, cell: u32| {
        u16::try_from(u32::from(cells).saturating_mul(cell)).unwrap_or(u16::MAX)
    };
    PtySize {
        rows,
        cols,
        pixel_width: px(cols, cell_width),
        pixel_height: px(rows, cell_height),
    }
}

fn geometry(cols: u16, rows: u16, cell_width: u32, cell_height: u32) -> MouseGeometry {
    MouseGeometry {
        width: u32::from(cols).saturating_mul(cell_width),
        height: u32::from(rows).saturating_mul(cell_height),
        cell_width,
        cell_height,
    }
}

fn command(config: &SessionConfig) -> CommandBuilder {
    let mut builder = match &config.program {
        Program::DefaultShell => CommandBuilder::new_default_prog(),
        Program::Command { program, args } => {
            let mut builder = CommandBuilder::new(program);
            builder.args(args);
            builder
        }
    };
    if let Some(cwd) = &config.cwd {
        builder.cwd(cwd);
    }
    if config.clear_env {
        builder.env_clear();
    }
    for (key, value) in &config.env {
        builder.env(key, value);
    }
    // libghostty-vt implements xterm's sequences and 24-bit color; xterm-256color is the
    // terminfo entry every system has.
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder
}

#[cfg(test)]
mod tests;
