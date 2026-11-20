//! The effects PiArc registers on every terminal: `WRITE_PTY` (query replies), `TITLE_CHANGED`,
//! `PWD_CHANGED`, `BELL`, `SEMANTIC_PROMPT` (OSC 133), `CLIPBOARD_WRITE`, `CLIPBOARD_READ`,
//! `RENDER_HOLD` and `RESET`.
//!
//! The callbacks only record what happened in [`Effects`], the terminal's userdata. The thread
//! that called `vt_write` collects the record with [`super::Terminal::take_effects`] after the
//! call and acts on it outside the terminal: replies go to the PTY writer, everything else
//! becomes events. That keeps the callbacks short and keeps them from writing to the terminal.
//!
//! Two callbacks answer the program right away, because libghostty-vt wants the answer before
//! the callback returns:
//!
//! - `CLIPBOARD_READ` is denied (an empty clipboard for OSC 52), except the follow-up read of a
//!   Kitty paste event (`granted`), which gets the text being pasted ([`Effects::paste`]).
//!   Nothing else in the terminal may read the user's clipboard.
//! - `CLIPBOARD_WRITE` is accepted when [`Effects::clipboard_write`] allows it and the text is
//!   recorded for the client to put on the system clipboard; otherwise it is denied.

use std::ffi::c_void;
use std::time::Instant;

use piarc_ghostty_sys as sys;

use super::render::RenderState;
use super::tracked::TrackedPoint;

/// One OSC 133 step the shell reported, with where the cursor was at that moment.
#[derive(Debug)]
pub struct SemanticMark {
    /// Which step.
    pub kind: SemanticKind,
    /// The exit code of a [`SemanticKind::CommandEnd`], when the shell sent one.
    pub exit_code: Option<i32>,
    /// The command line of a [`SemanticKind::OutputStart`], when the shell sent one.
    pub command: Option<String>,
    /// The cursor cell when the step was reported, following the content as it scrolls.
    /// `None` when it could not be tracked.
    pub at: Option<TrackedPoint>,
}

/// The OSC 133 steps of a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticKind {
    /// `A`: a primary prompt starts.
    PromptStart,
    /// `B`: the prompt is drawn; the user types the command from here.
    InputStart,
    /// `C`: the command was submitted; output follows.
    OutputStart,
    /// `D`: the command finished.
    CommandEnd,
}

/// What the callbacks recorded. Owned by the terminal (heap-allocated, its address is the
/// userdata pointer) and only touched by callbacks or by code holding `&mut Terminal`.
pub(crate) struct Effects {
    /// Bytes the terminal wants written back to the PTY, in order.
    pub(crate) replies: Vec<u8>,
    /// The new title, when it changed since the last collection.
    pub(crate) title: Option<String>,
    /// The new working directory (OSC 7), when it changed since the last collection.
    pub(crate) pwd: Option<String>,
    /// Bells since the last collection.
    pub(crate) bells: u32,
    /// OSC 133 steps since the last collection, in order.
    pub(crate) marks: Vec<SemanticMark>,
    /// Texts the program put on the clipboard (OSC 52), when that is allowed.
    pub(crate) clipboard: Vec<String>,
    /// Clipboard reads that were refused.
    pub(crate) clipboard_reads_denied: u32,
    /// The program reset the terminal (RIS): title, working directory and marks are gone.
    pub(crate) reset: bool,
    /// Accept clipboard writes (the user's setting).
    pub(crate) clipboard_write: bool,
    /// The text of the paste being written, for the follow-up read of a Kitty paste event.
    pub(crate) paste: Option<String>,
    /// When the current synchronized-output hold began, on the owner's clock; `None` outside
    /// a hold and until the owner stamps it ([`super::Terminal::stamp_hold`]).
    pub(crate) hold_since: Option<Instant>,
    /// A hold began and has no start time yet.
    pub(crate) hold_unstamped: bool,
    /// `capture` holds the frame of a hold that began and has not been taken yet.
    pub(crate) capture_ready: bool,
    /// Render state updated at the start of each hold (libghostty-vt's rendering guide:
    /// capture the frame the program wants left on screen when the hold begins).
    pub(crate) capture: RenderState,
}

impl Effects {
    pub(crate) fn new(capture: RenderState) -> Self {
        Self {
            replies: Vec::new(),
            title: None,
            pwd: None,
            bells: 0,
            marks: Vec::new(),
            clipboard: Vec::new(),
            clipboard_reads_denied: 0,
            reset: false,
            clipboard_write: true,
            paste: None,
            hold_since: None,
            capture_ready: false,
            hold_unstamped: false,
            capture,
        }
    }
}

/// What [`super::Terminal::take_effects`] hands over after a write.
#[derive(Debug, Default)]
pub struct EffectsOutput {
    /// Bytes to write to the PTY (device attribute answers, mode reports, …).
    pub replies: Vec<u8>,
    /// The new title, if it changed.
    pub title: Option<String>,
    /// The new working directory (OSC 7), if it changed; empty when the program cleared it.
    pub pwd: Option<String>,
    /// Number of bells.
    pub bells: u32,
    /// OSC 133 steps, in order.
    pub marks: Vec<SemanticMark>,
    /// Texts for the system clipboard.
    pub clipboard: Vec<String>,
    /// Refused clipboard reads.
    pub clipboard_reads_denied: u32,
    /// The program reset the terminal.
    pub reset: bool,
}

impl EffectsOutput {
    /// Nothing happened.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.replies.is_empty()
            && self.title.is_none()
            && self.pwd.is_none()
            && self.bells == 0
            && self.marks.is_empty()
            && self.clipboard.is_empty()
            && self.clipboard_reads_denied == 0
            && !self.reset
    }
}

/// Recovers the [`Effects`] record from a callback's userdata.
///
/// # Safety
///
/// `userdata` must be the pointer `Terminal::new` registered, and the caller must be running
/// inside a callback, when no Rust reference to the record exists (the terminal is borrowed
/// mutably by the `vt_write`, `resize` or `paste` call that is executing).
unsafe fn effects<'a>(userdata: *mut c_void) -> Option<&'a mut Effects> {
    // SAFETY: per the contract above the pointer is either null or the live, unaliased record.
    unsafe { userdata.cast::<Effects>().as_mut() }
}

/// Copies a borrowed `GhosttyString` into a `String` (lossy UTF-8).
///
/// # Safety
///
/// `text` must point to `len` readable bytes (or be null), valid for this call.
unsafe fn string(text: sys::GhosttyString) -> String {
    if text.ptr.is_null() || text.len == 0 {
        return String::new();
    }
    // SAFETY: per the contract above.
    let bytes = unsafe { std::slice::from_raw_parts(text.ptr, text.len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// Reads a borrowed string the terminal holds (`DATA_TITLE`, `DATA_PWD`).
///
/// # Safety
///
/// `terminal` must be the live terminal of the running callback.
unsafe fn terminal_string(
    terminal: sys::GhosttyTerminal,
    data: sys::GhosttyTerminalData,
) -> String {
    let mut text = sys::GhosttyString {
        ptr: std::ptr::null(),
        len: 0,
    };
    // SAFETY: reading the terminal from a callback is allowed (the effects guide reads the
    // title in its example); TITLE and PWD write a borrowed GhosttyString.
    let result = unsafe { sys::ghostty_terminal_get(terminal, data, (&raw mut text).cast()) };
    if result == sys::GHOSTTY_SUCCESS {
        // SAFETY: the string is valid until the next mutating call on the terminal, and it is
        // copied before the callback returns.
        unsafe { string(text) }
    } else {
        String::new()
    }
}

pub(super) unsafe extern "C" fn on_write_pty(
    _terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    // SAFETY: libghostty-vt passes the userdata registered by Terminal::new, from inside the
    // call that holds the only borrow of the terminal.
    let Some(effects) = (unsafe { effects(userdata) }) else {
        return;
    };
    if data.is_null() || len == 0 {
        return;
    }
    // SAFETY: the library guarantees `data` points to `len` readable bytes for this call.
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    effects.replies.extend_from_slice(bytes);
}

pub(super) unsafe extern "C" fn on_title_changed(
    terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
) {
    // SAFETY: as in on_write_pty.
    let Some(effects) = (unsafe { effects(userdata) }) else {
        return;
    };
    // SAFETY: `terminal` is this callback's terminal.
    effects.title = Some(unsafe { terminal_string(terminal, sys::GHOSTTY_TERMINAL_DATA_TITLE) });
}

pub(super) unsafe extern "C" fn on_pwd_changed(
    terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
) {
    // SAFETY: as in on_write_pty.
    let Some(effects) = (unsafe { effects(userdata) }) else {
        return;
    };
    // SAFETY: `terminal` is this callback's terminal.
    effects.pwd = Some(unsafe { terminal_string(terminal, sys::GHOSTTY_TERMINAL_DATA_PWD) });
}

pub(super) unsafe extern "C" fn on_bell(_terminal: sys::GhosttyTerminal, userdata: *mut c_void) {
    // SAFETY: as in on_write_pty.
    if let Some(effects) = unsafe { effects(userdata) } {
        effects.bells = effects.bells.saturating_add(1);
    }
}

pub(super) unsafe extern "C" fn on_semantic_prompt(
    terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    event: *const sys::GhosttyTerminalSemanticPrompt,
) {
    // SAFETY: as in on_write_pty; `event` is valid for the call when not null.
    let (Some(effects), Some(event)) = (unsafe { effects(userdata) }, unsafe { event.as_ref() })
    else {
        return;
    };
    let kind = match event.kind {
        sys::GHOSTTY_SEMANTIC_PROMPT_PROMPT_START
            if event.prompt_kind == sys::GHOSTTY_SEMANTIC_PROMPT_PROMPT_PRIMARY =>
        {
            SemanticKind::PromptStart
        }
        sys::GHOSTTY_SEMANTIC_PROMPT_INPUT_START => SemanticKind::InputStart,
        sys::GHOSTTY_SEMANTIC_PROMPT_OUTPUT_START => SemanticKind::OutputStart,
        sys::GHOSTTY_SEMANTIC_PROMPT_COMMAND_END => SemanticKind::CommandEnd,
        // Right, continuation and secondary prompts do not delimit commands; later kinds are
        // ignored as the header asks.
        _ => return,
    };
    // SAFETY: the command string is valid for this call.
    let command = unsafe { string(event.command) };
    effects.marks.push(SemanticMark {
        kind,
        exit_code: event.has_exit_code.then_some(event.exit_code),
        command: (!command.is_empty()).then_some(command),
        // SAFETY: `terminal` is this callback's terminal, used by this thread only; tracking a
        // cell does not write VT input (the only reentrant call the library forbids).
        at: unsafe { TrackedPoint::at_cursor(terminal) },
    });
}

pub(super) unsafe extern "C" fn on_clipboard_write(
    _terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    write: *const sys::GhosttyClipboardWrite,
) {
    // SAFETY: as in on_write_pty; `write` is valid for the call when not null.
    let (Some(effects), Some(request)) = (unsafe { effects(userdata) }, unsafe { write.as_ref() })
    else {
        return;
    };
    let text = if effects.clipboard_write
        && request.location == sys::GHOSTTY_CLIPBOARD_LOCATION_STANDARD
    {
        // SAFETY: `contents` holds `contents_len` entries for this call.
        unsafe { plain_text(request.contents, request.contents_len) }
    } else {
        None
    };
    let result = match text {
        Some(text) => {
            effects.clipboard.push(text);
            sys::GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS
        }
        None => sys::GHOSTTY_CLIPBOARD_WRITE_RESULT_DENIED,
    };
    let reply = sys::GhosttyClipboardWriteReply {
        size: size_of::<sys::GhosttyClipboardWriteReply>(),
        result,
        remember: false,
    };
    if let Some(answer) = request.reply {
        // SAFETY: the reply function belongs to this request and is called before the
        // callback returns, as the header requires; the reply lives for the call.
        unsafe { answer(write, &raw const reply) };
    }
}

/// The first `text/…` representation as a string; `None` for none or for clearing.
///
/// # Safety
///
/// `contents` must point to `len` readable entries whose strings are valid for this call.
unsafe fn plain_text(contents: *const sys::GhosttyClipboardContent, len: usize) -> Option<String> {
    if contents.is_null() || len == 0 {
        return None;
    }
    // SAFETY: per the contract above.
    let entries = unsafe { std::slice::from_raw_parts(contents, len) };
    entries.iter().find_map(|entry| {
        // SAFETY: the entry's strings are valid for this call.
        let mime = unsafe { string(entry.mime) };
        // SAFETY: as above.
        mime.starts_with("text/")
            .then(|| unsafe { string(entry.data) })
    })
}

pub(super) unsafe extern "C" fn on_clipboard_read(
    _terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    read: *const sys::GhosttyClipboardRead,
) {
    // SAFETY: as in on_write_pty; `read` is valid for the call when not null.
    let (Some(effects), Some(request)) = (unsafe { effects(userdata) }, unsafe { read.as_ref() })
    else {
        return;
    };
    let Some(answer) = request.reply else {
        return;
    };
    // Only the read that follows a Kitty paste event gets anything: the text being pasted.
    let pasted = if request.granted {
        effects.paste.take()
    } else {
        None
    };
    let mime = "text/plain";
    let content = pasted.as_ref().map(|text| sys::GhosttyClipboardContent {
        mime: sys::GhosttyString {
            ptr: mime.as_ptr(),
            len: mime.len(),
        },
        data: sys::GhosttyString {
            ptr: text.as_ptr(),
            len: text.len(),
        },
    });
    let reply = sys::GhosttyClipboardReadReply {
        size: size_of::<sys::GhosttyClipboardReadReply>(),
        result: if content.is_some() {
            sys::GHOSTTY_CLIPBOARD_READ_RESULT_SUCCESS
        } else {
            sys::GHOSTTY_CLIPBOARD_READ_RESULT_DENIED
        },
        contents: content
            .as_ref()
            .map_or(std::ptr::null(), std::ptr::from_ref),
        contents_len: usize::from(content.is_some()),
        available: std::ptr::null(),
        available_len: 0,
        remember: false,
    };
    if content.is_none() {
        effects.clipboard_reads_denied = effects.clipboard_reads_denied.saturating_add(1);
    }
    // SAFETY: the reply function belongs to this request and is called before the callback
    // returns; the reply and the strings it points to live until after the call.
    unsafe { answer(read, &raw const reply) };
}

pub(super) unsafe extern "C" fn on_reset(_terminal: sys::GhosttyTerminal, userdata: *mut c_void) {
    // SAFETY: as in on_write_pty.
    if let Some(effects) = unsafe { effects(userdata) } {
        effects.reset = true;
        effects.title = None;
        effects.pwd = None;
        effects.marks.clear();
    }
}

pub(super) unsafe extern "C" fn on_render_hold(
    terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    held: bool,
) {
    // SAFETY: as in on_write_pty.
    let Some(effects) = (unsafe { effects(userdata) }) else {
        return;
    };
    if held {
        // The terminal holds exactly the frame the program wants left on screen: nothing
        // after the start of the hold has been processed yet.
        // SAFETY: `terminal` is the handle this callback was invoked for, and the vt_write
        // that triggered it holds the only borrow of it, on this thread.
        let captured = unsafe { effects.capture.update_raw(terminal) };
        effects.capture_ready = captured.is_ok();
        effects.hold_since = None;
        effects.hold_unstamped = true;
    } else {
        effects.hold_since = None;
        effects.hold_unstamped = false;
        effects.capture_ready = false;
    }
}
