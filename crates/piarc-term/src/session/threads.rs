//! The session's three threads (see the parent module): IO, writer and waiter.

use std::io::{ErrorKind, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, MasterPty};

use super::{Event, EventHandler, Probe, Shared, lock, nanos, pty_size, spawn_error};
use crate::commands::CommandChange;
use crate::error::Result;
use crate::vt::{
    self, EffectsOutput, KeyEncoder, KeyInput, MODE_FOCUS_EVENTS, MouseEncoder, MouseInput,
    PasteOutcome, ScrollTo, SelectionGesture, focus_report,
};

/// Size of one PTY read.
const READ_CHUNK: usize = 64 * 1024;

pub(super) enum WriterMessage {
    /// Bytes for the program that are not input (query replies).
    Bytes(Vec<u8>),
    /// Input as typed (committed input-method text, an approved command).
    Input(Vec<u8>),
    Key(KeyInput),
    Mouse(MouseInput),
    Focus(bool),
    Scroll(ScrollTo),
    ClearSelection,
    Paste {
        text: String,
        allow_unsafe: bool,
        done: Sender<Result<PasteOutcome>>,
    },
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
    /// The program exited: drop the master (Windows, see the parent module).
    ProgramExited,
}

/// What the threads own.
pub(super) struct Workers {
    pub child: Box<dyn Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
    pub output: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub keys: KeyEncoder,
    pub mouse: MouseEncoder,
    pub gesture: SelectionGesture,
    pub messages: Receiver<WriterMessage>,
    pub writer: SyncSender<WriterMessage>,
    pub on_event: EventHandler,
}

/// Runs `work`; a panic marks the session failed and reports it instead of unwinding out of
/// the thread silently.
fn guarded(shared: &Shared, on_event: &EventHandler, name: &str, work: impl FnOnce()) {
    if let Err(payload) = catch_unwind(AssertUnwindSafe(work)) {
        shared.failed.store(true, Ordering::Release);
        let detail = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "a panic".to_owned());
        on_event(Event::Failed {
            reason: format!("the terminal's {name} thread failed: {detail}"),
        });
        // Wake anyone waiting for output that will not come.
        shared.changed.notify_all();
    }
}

pub(super) fn start(shared: &Arc<Shared>, workers: Workers) -> Result<()> {
    let Workers {
        mut child,
        reader,
        output,
        master,
        keys,
        mouse,
        gesture,
        messages,
        writer,
        on_event,
    } = workers;
    let writer_shared = Arc::clone(shared);
    let writer_events = Arc::clone(&on_event);
    thread::Builder::new()
        .name("piarc-term-writer".into())
        .spawn(move || {
            guarded(&writer_shared, &writer_events, "writer", || {
                writer_loop(
                    &writer_shared,
                    &messages,
                    output,
                    master.as_ref(),
                    Encoders {
                        keys,
                        mouse,
                        pointer: super::pointer::Pointer::new(gesture),
                    },
                );
            });
        })
        .map_err(|error| spawn_error("start the writer thread", &error))?;
    let (exit_tx, exit_rx) = mpsc::channel();
    let wait_writer = writer.clone();
    thread::Builder::new()
        .name("piarc-term-wait".into())
        .spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            // The IO thread is still reading; it takes the code at end of output.
            let _ = exit_tx.send(code);
            if cfg!(windows) {
                // Closed already when the session was closed first.
                let _ = wait_writer.send(WriterMessage::ProgramExited);
            }
        })
        .map_err(|error| spawn_error("start the waiter thread", &error))?;
    let io_shared = Arc::clone(shared);
    thread::Builder::new()
        .name("piarc-term-io".into())
        .spawn(move || {
            guarded(&io_shared, &on_event, "IO", || {
                io_loop(&io_shared, reader, &writer, on_event.as_ref());
            });
            drop(writer);
            // The waiter sends exactly once; a failed `wait` is an unknown exit code.
            let code = exit_rx.recv().ok().flatten();
            *lock(&io_shared.exit) = Some(code);
            io_shared.changed.notify_all();
            on_event(Event::Exited { code });
        })
        .map_err(|error| spawn_error("start the IO thread", &error))?;
    Ok(())
}

fn io_loop(
    shared: &Shared,
    mut reader: Box<dyn Read + Send>,
    writer: &SyncSender<WriterMessage>,
    on_event: &(dyn Fn(Event) + Send + Sync),
) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        // End of output: Ok(0), or EIO once the program and every holder of the slave exited.
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let chunk = &buffer[..n];
        let read_at = Instant::now();
        note_probe(shared, chunk, read_at);
        let (mut effects, changes) = apply(shared, chunk);
        let c = &shared.counters;
        c.vt_write_nanos
            .fetch_add(nanos(read_at.elapsed()), Ordering::Relaxed);
        c.bytes_read
            .fetch_add(u64::try_from(n).unwrap_or(u64::MAX), Ordering::Relaxed);
        c.reads.fetch_add(1, Ordering::Relaxed);
        {
            let mut generation = lock(&shared.generation);
            *generation = generation.wrapping_add(1);
        }
        shared.changed.notify_all();
        if !effects.replies.is_empty() {
            // Waits while the program does not read its input (back-pressure on the output);
            // fails once the writer is gone, when replies no longer matter.
            let _ = writer.send(WriterMessage::Bytes(std::mem::take(&mut effects.replies)));
        }
        report(effects, changes, on_event);
        if shared.wake.swap(false, Ordering::AcqRel) {
            on_event(Event::Output);
        }
    }
}

fn note_probe(shared: &Shared, chunk: &[u8], read_at: Instant) {
    let mut probe = lock(&shared.probe);
    if probe.as_ref().is_some_and(|p| chunk.contains(&p.byte))
        && let Some(p) = probe.take()
    {
        // The measurement may have timed out; nobody is waiting then.
        let _ = p.done.send(read_at.saturating_duration_since(p.written));
    }
}

/// Writes `chunk` into the terminal and settles its effects while the terminal is locked:
/// the hold start gets the session clock, OSC 133 marks join the command log (their tracked
/// cells must not leave the lock).
fn apply(shared: &Shared, chunk: &[u8]) -> (EffectsOutput, Vec<CommandChange>) {
    let mut terminal = lock(&shared.terminal);
    terminal.write(chunk);
    terminal.stamp_hold((shared.now)());
    let mut effects = terminal.take_effects();
    let mut changes = Vec::new();
    if effects.reset || !effects.marks.is_empty() {
        let mut commands = lock(&shared.commands);
        if effects.reset {
            commands.reset();
        }
        for mark in std::mem::take(&mut effects.marks) {
            changes.extend(commands.apply(mark));
        }
    }
    drop(terminal);
    (effects, changes)
}

fn report(
    effects: EffectsOutput,
    changes: Vec<CommandChange>,
    on_event: &(dyn Fn(Event) + Send + Sync),
) {
    if effects.reset {
        on_event(Event::Title(String::new()));
        on_event(Event::Pwd(String::new()));
    }
    if let Some(title) = effects.title {
        on_event(Event::Title(title));
    }
    if let Some(pwd) = effects.pwd {
        on_event(Event::Pwd(pwd_path(&pwd)));
    }
    if effects.bells > 0 {
        on_event(Event::Bell {
            count: effects.bells,
        });
    }
    for change in changes {
        on_event(Event::Command(change));
    }
    for text in effects.clipboard {
        on_event(Event::Clipboard(text));
    }
    if effects.clipboard_reads_denied > 0 {
        on_event(Event::ClipboardReadDenied);
    }
}

/// The path of an OSC 7 `file://host/path` URL (percent-decoded; on Windows `/C:/x` becomes
/// `C:/x`); other values as sent.
pub(super) fn pwd_path(url: &str) -> String {
    let Some(rest) = url.strip_prefix("file://") else {
        return url.to_owned();
    };
    let Some(slash) = rest.find('/') else {
        return url.to_owned();
    };
    let path = percent_decode(&rest[slash..]);
    let bytes = path.as_bytes();
    if cfg!(windows) && bytes.len() >= 3 && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
        return path[1..].to_owned();
    }
    path
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The writer thread's encoders and pointer state.
struct Encoders {
    keys: KeyEncoder,
    mouse: MouseEncoder,
    pointer: super::pointer::Pointer,
}

fn writer_loop(
    shared: &Shared,
    messages: &Receiver<WriterMessage>,
    mut output: Box<dyn Write + Send>,
    master: &(dyn MasterPty + Send),
    mut encoders: Encoders,
) {
    let mut encoded = Vec::new();
    for message in messages {
        encoded.clear();
        // Write errors mean the program is gone; the IO thread reports the exit.
        match message {
            WriterMessage::ProgramExited => break,
            message => handle(
                shared,
                message,
                &mut output,
                master,
                &mut encoders,
                &mut encoded,
            ),
        }
    }
    encoders.pointer.free(&mut lock(&shared.terminal));
}

fn handle(
    shared: &Shared,
    message: WriterMessage,
    output: &mut Box<dyn Write + Send>,
    master: &(dyn MasterPty + Send),
    encoders: &mut Encoders,
    encoded: &mut Vec<u8>,
) {
    match message {
        WriterMessage::Bytes(bytes) => write(output, &bytes),
        WriterMessage::Input(bytes) => {
            if !bytes.is_empty() {
                after_input(shared);
            }
            write(output, &bytes);
        }
        WriterMessage::Key(input) => {
            let keys = &mut encoders.keys;
            let synced = keys.sync(&mut lock(&shared.terminal));
            if synced.and_then(|()| keys.encode(&input, encoded)).is_ok() {
                if !encoded.is_empty() {
                    after_input(shared);
                }
                write(output, encoded);
            }
        }
        WriterMessage::Mouse(input) => {
            let Encoders {
                keys,
                mouse,
                pointer,
            } = encoders;
            pointer.handle(shared, &input, mouse, keys, encoded);
            write(output, encoded);
        }
        WriterMessage::Focus(gained) => {
            if lock(&shared.terminal).mode(MODE_FOCUS_EVENTS, false)
                && let Ok(report) = focus_report(gained)
            {
                write(output, &report);
            }
        }
        WriterMessage::Scroll(to) => {
            let _ = vt::scroll_viewport(&mut lock(&shared.terminal), to);
        }
        WriterMessage::ClearSelection => {
            let _ = vt::clear_selection(&mut lock(&shared.terminal));
        }
        WriterMessage::Paste {
            text,
            allow_unsafe,
            done,
        } => {
            let _ = done.send(paste(shared, &text, allow_unsafe, output));
        }
        WriterMessage::Resize {
            cols,
            rows,
            cell_width,
            cell_height,
        } => {
            let resized = lock(&shared.terminal).resize(cols, rows, cell_width, cell_height);
            if resized.is_ok() {
                *lock(&shared.geometry) = super::geometry(cols, rows, cell_width, cell_height);
                let _ = master.resize(pty_size(cols, rows, cell_width, cell_height));
            }
        }
        WriterMessage::Probe { byte, done } => {
            *lock(&shared.probe) = Some(Probe {
                byte,
                written: Instant::now(),
                done,
            });
            write(output, &[byte]);
        }
        WriterMessage::ProgramExited => {}
    }
}

fn paste(
    shared: &Shared,
    text: &str,
    allow_unsafe: bool,
    output: &mut Box<dyn Write + Send>,
) -> Result<PasteOutcome> {
    let (outcome, bytes) = {
        let mut terminal = lock(&shared.terminal);
        // The terminal writes the paste through WRITE_PTY: collect it right away, while no
        // output has been written in between.
        let outcome = terminal.paste(text, allow_unsafe)?;
        (outcome, terminal.take_effects().replies)
    };
    if outcome == PasteOutcome::Pasted {
        after_input(shared);
    }
    write(output, &bytes);
    Ok(outcome)
}

/// Typing brings the viewport back to where the program writes and drops the selection, as
/// terminals do.
fn after_input(shared: &Shared) {
    let mut terminal = lock(&shared.terminal);
    let _ = vt::scroll_viewport(&mut terminal, ScrollTo::Bottom);
    if vt::has_selection(&mut terminal).unwrap_or(false) {
        let _ = vt::clear_selection(&mut terminal);
    }
}

fn write(output: &mut Box<dyn Write + Send>, bytes: &[u8]) {
    if !bytes.is_empty() {
        let _ = output.write_all(bytes).and_then(|()| output.flush());
    }
}
