//! [`Session`]: a program in a PTY whose output feeds one libghostty-vt terminal (ADR-0017
//! rule 1).
//!
//! # Threads
//!
//! - The IO thread (`piarc-term-io`) reads the PTY and writes each chunk into the terminal
//!   under its lock, then collects the effects: query replies go to the writer, title and bell
//!   become [`Event`]s. At end of output it takes the program's exit code from the waiter thread
//!   and reports [`Event::Exited`].
//! - The waiter thread (`piarc-term-wait`) waits for the program. On Windows it then stops the
//!   writer: ConPTY ends its output only when the pseudoconsole closes, which happens when the
//!   writer drops the master, so without this a program that exits on its own would never
//!   reach end of output.
//! - The writer thread (`piarc-term-writer`) owns the PTY master. It writes input, encodes key
//!   events with the terminal's current modes, and resizes. Every request from callers is a
//!   message to it, so [`Session::write`], [`Session::key`] and [`Session::resize`] never
//!   block on the PTY.
//! - [`Session::frame`] runs on the caller's thread: it holds the terminal's lock only for the
//!   first half of the render-state update (libghostty-vt's two-phase update), and the
//!   frame encoder's lock for the rest.
//!
//! # Closing
//!
//! [`Session::close`] (and `Drop`) stops the writer and kills the program. The IO thread ends
//! when the PTY reports end of output. portable-pty 0.9.0's Windows `ChildKiller::kill`
//! reports success as an error (fixed only on wezterm's main branch), so its result is not
//! trusted on any platform: the exit is confirmed by the waiter thread's `wait`.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::error::{Error, Result};
use crate::frame::{EncodeStats, FrameEncoder};
use crate::vt::{self, KeyEncoder, KeyInput, Terminal};

/// How long a synchronized-output hold may freeze the screen before Core ends it
/// (libghostty-vt's rendering guide: "One second is a common limit").
pub const HOLD_TIMEOUT: Duration = Duration::from_secs(1);

/// Size of one PTY read.
const READ_CHUNK: usize = 64 * 1024;

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
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
    /// Cell width in pixels (for pixel size reports).
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
    /// The program.
    pub program: Program,
    /// Working directory; the home directory when unset.
    pub cwd: Option<PathBuf>,
    /// Variables set on top of the inherited environment.
    pub env: Vec<(String, String)>,
    /// Scrollback limit in lines.
    pub scrollback_lines: usize,
}

/// Something the terminal reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The program set the title (OSC 0/2).
    Title(String),
    /// The program rang the bell `count` times in one chunk of output.
    Bell {
        /// Bells in the chunk.
        count: u32,
    },
    /// The program exited and its output was fully read. `code` is `None` when the exit
    /// status could not be read.
    Exited {
        /// Exit code.
        code: Option<u32>,
    },
}

/// Receives [`Event`]s, on the IO thread. Must not block for long: output waits meanwhile.
pub type EventHandler = Arc<dyn Fn(Event) + Send + Sync>;

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
    done: Sender<Duration>,
}

struct Shared {
    terminal: Mutex<Terminal>,
    frames: Mutex<FrameEncoder>,
    counters: Counters,
    probe: Mutex<Option<Probe>>,
    exit: Mutex<Option<Option<u32>>>,
}

enum WriterMessage {
    Bytes(Vec<u8>),
    Key(KeyInput),
    Resize {
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    },
    Probe {
        byte: u8,
        done: Sender<Duration>,
    },
    /// The program exited: drop the master (Windows, see the module documentation).
    ProgramExited,
}

/// Locks `mutex`, recovering the data after a panic elsewhere: every critical section leaves
/// the terminal and the encoder consistent between calls.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A terminal session.
pub struct Session {
    shared: Arc<Shared>,
    writer: Mutex<Option<Sender<WriterMessage>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: AtomicBool,
}

impl Session {
    /// Starts `config.program` in a new PTY and the session's two threads.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size or a working directory that is not a
    /// directory; [`Error::Spawn`] when the PTY or the program cannot be started;
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn spawn(config: SessionConfig, on_event: EventHandler) -> Result<Self> {
        if let Some(cwd) = &config.cwd
            && !cwd.is_dir()
        {
            return Err(Error::InvalidArgument {
                field: "cwd",
                reason: format!("{} is not a directory", cwd.display()),
            });
        }
        let terminal = Terminal::new(config.cols, config.rows, config.scrollback_lines)?;
        let frames = FrameEncoder::new()?;
        let keys = KeyEncoder::new()?;
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
        let mut child = pair
            .slave
            .spawn_command(command(&config))
            .map_err(|error| spawn_error("start the program", &error))?;
        // The program holds its own copy of the slave; ours must close for EOF to arrive.
        drop(pair.slave);
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| spawn_error("read the PTY", &error))?;
        let output = pair
            .master
            .take_writer()
            .map_err(|error| spawn_error("write the PTY", &error))?;
        let shared = Arc::new(Shared {
            terminal: Mutex::new(terminal),
            frames: Mutex::new(frames),
            counters: Counters::default(),
            probe: Mutex::new(None),
            exit: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel();
        let writer_shared = Arc::clone(&shared);
        let master = pair.master;
        thread::Builder::new()
            .name("piarc-term-writer".into())
            .spawn(move || writer_loop(&writer_shared, &rx, output, master.as_ref(), keys))
            .map_err(|error| spawn_error("start the writer thread", &error))?;
        let (exit_tx, exit_rx) = mpsc::channel();
        let wait_tx = tx.clone();
        thread::Builder::new()
            .name("piarc-term-wait".into())
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                // The IO thread is still reading; it takes the code at end of output.
                let _ = exit_tx.send(code);
                if cfg!(windows) {
                    // Closed already when the session was closed first.
                    let _ = wait_tx.send(WriterMessage::ProgramExited);
                }
            })
            .map_err(|error| spawn_error("start the waiter thread", &error))?;
        let io_shared = Arc::clone(&shared);
        let io_tx = tx.clone();
        thread::Builder::new()
            .name("piarc-term-io".into())
            .spawn(move || {
                io_loop(&io_shared, reader, &io_tx, on_event.as_ref());
                // The waiter sends exactly once; a failed `wait` is an unknown exit code.
                let code = exit_rx.recv().ok().flatten();
                *lock(&io_shared.exit) = Some(code);
                on_event(Event::Exited { code });
            })
            .map_err(|error| spawn_error("start the IO thread", &error))?;
        Ok(Self {
            shared,
            writer: Mutex::new(Some(tx)),
            killer: Mutex::new(killer),
            closed: AtomicBool::new(false),
        })
    }

    fn send(&self, message: WriterMessage) -> Result<()> {
        lock(&self.writer)
            .as_ref()
            .ok_or(Error::Closed)?
            .send(message)
            .map_err(|_| Error::Closed)
    }

    /// Writes `bytes` to the program as they are (committed input-method text, pasted text).
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] after [`close`](Self::close).
    pub fn write(&self, bytes: Vec<u8>) -> Result<()> {
        self.send(WriterMessage::Bytes(bytes))
    }

    /// Encodes `input` with the terminal's current modes and writes the result.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] after [`close`](Self::close).
    pub fn key(&self, input: KeyInput) -> Result<()> {
        self.send(WriterMessage::Key(input))
    }

    /// Resizes the terminal, then the PTY (the program sees `SIGWINCH` after the grid has the
    /// new size).
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size; [`Error::Closed`] after
    /// [`close`](Self::close).
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

    /// Produces the next frame for `viewer`; `full` asks for a RESET frame. Blocks while the
    /// IO thread holds the terminal (at most one chunk of `vt_write`); call it off the
    /// JavaScript thread.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails; the next frame then resets the viewer.
    pub fn frame(&self, viewer: u32, full: bool) -> Result<Vec<u8>> {
        let started = Instant::now();
        let mut frames = lock(&self.shared.frames);
        frames.prepare(viewer, full);
        let (held, updated) = {
            let mut terminal = lock(&self.shared.terminal);
            update_locked(&mut terminal, &mut frames)?
        };
        if updated {
            frames.render_state().end_update()?;
        }
        let (bytes, stats) = frames.encode(held)?;
        drop(frames);
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

    /// The visible screen as plain text (libghostty-vt's formatter). What an agent reads, and
    /// the reference for comparing frames with the screen.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn viewport_text(&self) -> Result<String> {
        vt::viewport_text(&mut lock(&self.shared.terminal))
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

    /// Stops input and kills the program. Frames of the last screen stay available. Safe to
    /// call more than once.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        // Dropping the sender ends the writer thread, which closes the PTY master.
        lock(&self.writer).take();
        if self.exit().is_none() {
            // portable-pty 0.9.0 on Windows reports a successful kill as an error; the IO
            // thread's wait confirms the exit either way.
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
fn update_locked(terminal: &mut Terminal, frames: &mut FrameEncoder) -> Result<(bool, bool)> {
    if terminal.take_hold_capture(frames.render_state()) {
        frames.compare_all_rows();
        return Ok((true, false));
    }
    if let Some(since) = terminal.hold_since() {
        if since.elapsed() < HOLD_TIMEOUT {
            // Keep showing the frame captured when the hold began.
            return Ok((true, false));
        }
        terminal.end_hold()?;
    }
    frames.render_state().begin_update(terminal)?;
    Ok((false, true))
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
    // libghostty-vt implements xterm's sequences and 24-bit color; xterm-256color is the
    // terminfo entry every system has.
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    for (key, value) in &config.env {
        builder.env(key, value);
    }
    builder
}

fn io_loop(
    shared: &Shared,
    mut reader: Box<dyn Read + Send>,
    writer: &Sender<WriterMessage>,
    on_event: &(dyn Fn(Event) + Send + Sync),
) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        // End of output: Ok(0), or EIO once the program and every holder of the slave exited.
        let n = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk = &buffer[..n];
        let read_at = Instant::now();
        {
            let mut probe = lock(&shared.probe);
            if probe.as_ref().is_some_and(|p| chunk.contains(&p.byte))
                && let Some(p) = probe.take()
            {
                // The measurement may have timed out; nobody is waiting then.
                let _ = p.done.send(read_at.saturating_duration_since(p.written));
            }
        }
        let effects = {
            let mut terminal = lock(&shared.terminal);
            terminal.write(chunk);
            terminal.take_effects()
        };
        let c = &shared.counters;
        c.vt_write_nanos
            .fetch_add(nanos(read_at.elapsed()), Ordering::Relaxed);
        c.bytes_read
            .fetch_add(u64::try_from(n).unwrap_or(u64::MAX), Ordering::Relaxed);
        c.reads.fetch_add(1, Ordering::Relaxed);
        if !effects.replies.is_empty() {
            // The writer is gone once the session closed; replies no longer matter then.
            let _ = writer.send(WriterMessage::Bytes(effects.replies));
        }
        if let Some(title) = effects.title {
            on_event(Event::Title(title));
        }
        if effects.bells > 0 {
            on_event(Event::Bell {
                count: effects.bells,
            });
        }
    }
}

fn writer_loop(
    shared: &Shared,
    messages: &Receiver<WriterMessage>,
    mut output: Box<dyn Write + Send>,
    master: &(dyn MasterPty + Send),
    mut keys: KeyEncoder,
) {
    let mut encoded = Vec::new();
    for message in messages {
        // Write errors mean the program is gone; the IO thread reports the exit.
        match message {
            WriterMessage::Bytes(bytes) => {
                let _ = output.write_all(&bytes).and_then(|()| output.flush());
            }
            WriterMessage::Key(input) => {
                encoded.clear();
                let synced = keys.sync(&mut lock(&shared.terminal));
                if synced
                    .and_then(|()| keys.encode(&input, &mut encoded))
                    .is_ok()
                    && !encoded.is_empty()
                {
                    let _ = output.write_all(&encoded).and_then(|()| output.flush());
                }
            }
            WriterMessage::Resize {
                cols,
                rows,
                cell_width,
                cell_height,
            } => {
                let resized = lock(&shared.terminal).resize(cols, rows, cell_width, cell_height);
                if resized.is_ok() {
                    let _ = master.resize(pty_size(cols, rows, cell_width, cell_height));
                }
            }
            WriterMessage::Probe { byte, done } => {
                *lock(&shared.probe) = Some(Probe {
                    byte,
                    written: Instant::now(),
                    done,
                });
                let _ = output.write_all(&[byte]).and_then(|()| output.flush());
            }
            WriterMessage::ProgramExited => break,
        }
    }
}
