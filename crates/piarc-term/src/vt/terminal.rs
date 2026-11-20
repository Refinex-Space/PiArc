//! [`Terminal`]: one libghostty-vt terminal with PiArc's effects registered.

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::time::Instant;

use piarc_ghostty_sys as sys;

use super::effects::{self, Effects, EffectsOutput};
use super::render::RenderState;
use super::{MODE_SYNCHRONIZED_OUTPUT, check};
use crate::error::{Error, Result};

/// Unfinished VT input the terminal keeps so a snapshot can be taken in the middle of a
/// sequence (`CONTINUATION_MAX_BYTES`). A longer unfinished sequence makes snapshots fail until
/// it completes; the VT replay still works then.
pub const CONTINUATION_MAX_BYTES: usize = 1024 * 1024;

/// Largest text a program may put on the clipboard (`CLIPBOARD_WRITE_MAX_BYTES`).
pub const CLIPBOARD_WRITE_MAX_BYTES: usize = 1024 * 1024;

/// DEC private mode 2004: bracketed paste.
pub const MODE_BRACKETED_PASTE: u16 = 2004;
/// DEC private mode 1004: focus reports.
pub const MODE_FOCUS_EVENTS: u16 = 1004;

/// Which screen buffer is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveScreen {
    /// The normal screen with its scrollback.
    Primary,
    /// The alternate screen of full-screen programs (no scrollback).
    Alternate,
}

/// Scroll state of the viewport, in rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Scrollbar {
    /// Rows of scrollback plus the active area.
    pub total: u64,
    /// First row of the viewport, from the top of the scrollback.
    pub offset: u64,
    /// Rows in the viewport.
    pub len: u64,
}

/// What a paste did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    /// The text (or a Kitty paste event) went to the program.
    Pasted,
    /// The text could run commands (a line break outside bracketed paste, or the end-of-paste
    /// sequence); ask the user and paste again with `allow_unsafe`.
    Unsafe,
    /// There was nothing to paste.
    Empty,
}

/// A libghostty-vt terminal. Not `Sync`: share it behind a mutex.
pub struct Terminal {
    raw: NonNull<sys::GhosttyTerminalImpl>,
    /// `Box::into_raw` of the record the callbacks write; freed in `Drop` after the terminal.
    effects: NonNull<Effects>,
    cols: u16,
    rows: u16,
}

// SAFETY: libghostty-vt has no thread affinity ("no concept of main threads"); it only forbids
// concurrent calls on one handle. `Terminal` is not `Sync` and every call takes `&mut self` or
// is made while the caller has exclusive access, so moving it to another thread is sound. The
// effects record moves with it and is only touched from the thread that owns the terminal.
unsafe impl Send for Terminal {}

fn zero_size() -> Error {
    Error::InvalidArgument {
        field: "size",
        reason: "columns and rows must be at least 1".into(),
    }
}

impl Terminal {
    /// Creates a `cols` × `rows` terminal that keeps at most `scrollback_lines` lines of
    /// history, with the effects of this module registered.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size; [`Error::Vt`] when libghostty-vt fails.
    pub fn new(cols: u16, rows: u16, scrollback_lines: usize) -> Result<Self> {
        if cols == 0 || rows == 0 {
            return Err(zero_size());
        }
        let mut raw: sys::GhosttyTerminal = ptr::null_mut();
        // SAFETY: a null allocator selects the default one; `raw` is a valid out pointer.
        check("ghostty_terminal_new", unsafe {
            sys::ghostty_terminal_new(ptr::null(), &raw mut raw, cols, rows)
        })?;
        Self::adopt(raw, scrollback_lines)
    }

    /// Takes ownership of a terminal libghostty-vt created (new or decoded from a snapshot)
    /// and registers PiArc's effects and limits on it.
    pub(super) fn adopt(raw: sys::GhosttyTerminal, scrollback_lines: usize) -> Result<Self> {
        let raw = NonNull::new(raw).ok_or(Error::Vt {
            call: "ghostty_terminal_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let capture = match RenderState::new() {
            Ok(capture) => capture,
            Err(error) => {
                // SAFETY: the handle is ours and not used again.
                unsafe { sys::ghostty_terminal_free(raw.as_ptr()) };
                return Err(error);
            }
        };
        let effects = NonNull::from(Box::leak(Box::new(Effects::new(capture))));
        let mut terminal = Self {
            raw,
            effects,
            cols: 0,
            rows: 0,
        };
        // Drop frees both on failure from here on.
        terminal.register(scrollback_lines)?;
        terminal.cols = terminal.get_u16(
            "ghostty_terminal_get(COLS)",
            sys::GHOSTTY_TERMINAL_DATA_COLS,
        )?;
        terminal.rows = terminal.get_u16(
            "ghostty_terminal_get(ROWS)",
            sys::GHOSTTY_TERMINAL_DATA_ROWS,
        )?;
        Ok(terminal)
    }

    fn register(&self, scrollback_lines: usize) -> Result<()> {
        // Pointer-typed options (userdata, callbacks) are passed as the value itself; the
        // function pointers have the signatures of the typedefs each option documents.
        self.set(
            "ghostty_terminal_set(USERDATA)",
            sys::GHOSTTY_TERMINAL_OPT_USERDATA,
            self.effects.as_ptr().cast(),
        )?;
        for (call, option, callback) in callbacks() {
            self.set(call, option, callback)?;
        }
        // Value options are passed by pointer (size_t* here). The byte limit defaults to
        // 10,000 bytes (one page, about 1,800 rows of 40 columns), which would cap the
        // scrollback long before the line limit: lift it so the line limit decides.
        let unlimited = usize::MAX;
        self.set(
            "ghostty_terminal_set(SCROLLBACK_MAX_BYTES)",
            sys::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
            (&raw const unlimited).cast(),
        )?;
        let continuation = CONTINUATION_MAX_BYTES;
        let clipboard = CLIPBOARD_WRITE_MAX_BYTES;
        self.set(
            "ghostty_terminal_set(SCROLLBACK_MAX_LINES)",
            sys::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
            (&raw const scrollback_lines).cast(),
        )?;
        self.set(
            "ghostty_terminal_set(CONTINUATION_MAX_BYTES)",
            sys::GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES,
            (&raw const continuation).cast(),
        )?;
        self.set(
            "ghostty_terminal_set(CLIPBOARD_WRITE_MAX_BYTES)",
            sys::GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE_MAX_BYTES,
            (&raw const clipboard).cast(),
        )
    }

    fn set(
        &self,
        call: &'static str,
        option: sys::GhosttyTerminalOption,
        value: *const c_void,
    ) -> Result<()> {
        // SAFETY: the terminal is live; `value` is what `option` documents (a userdata or
        // callback pointer, or a pointer to a value that lives for the call). The userdata
        // record lives until Drop frees it after the terminal.
        check(call, unsafe {
            sys::ghostty_terminal_set(self.raw.as_ptr(), option, value)
        })
    }

    /// Reads one value of the type `T` that `data` documents.
    ///
    /// # Safety
    ///
    /// `T` must be the output type libghostty-vt documents for `data`.
    unsafe fn get<T: Copy>(
        &self,
        data: sys::GhosttyTerminalData,
        init: T,
    ) -> (sys::GhosttyResult, T) {
        let mut value = init;
        // SAFETY: the terminal is live; the caller pairs `data` with `T`.
        let code =
            unsafe { sys::ghostty_terminal_get(self.raw.as_ptr(), data, (&raw mut value).cast()) };
        (code, value)
    }

    fn get_u16(&self, call: &'static str, data: sys::GhosttyTerminalData) -> Result<u16> {
        // SAFETY: COLS and ROWS write a uint16_t.
        let (code, value) = unsafe { self.get(data, 0u16) };
        check(call, code)?;
        Ok(value)
    }

    /// The raw handle, for the other wrappers of this module.
    pub(super) fn raw(&mut self) -> sys::GhosttyTerminal {
        self.raw.as_ptr()
    }

    fn effects_mut(&mut self) -> &mut Effects {
        // SAFETY: the record was leaked from a Box in `adopt` and is freed only in Drop.
        // Callbacks touch it only during calls that need `&mut self` too, so the borrow checker
        // keeps this reference and a running callback apart.
        unsafe { self.effects.as_mut() }
    }

    /// Feeds program output to the parser. Effects are recorded; collect them with
    /// [`take_effects`](Self::take_effects).
    pub fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        // SAFETY: the terminal is live and exclusively borrowed; the buffer outlives the call.
        unsafe { sys::ghostty_terminal_vt_write(self.raw.as_ptr(), bytes.as_ptr(), bytes.len()) };
    }

    /// Takes what the effects recorded since the last call. The marks' tracked points must be
    /// kept or dropped while this terminal is still exclusively borrowed (behind its lock).
    pub fn take_effects(&mut self) -> EffectsOutput {
        let effects = self.effects_mut();
        EffectsOutput {
            replies: std::mem::take(&mut effects.replies),
            title: effects.title.take(),
            pwd: effects.pwd.take(),
            bells: std::mem::take(&mut effects.bells),
            marks: std::mem::take(&mut effects.marks),
            clipboard: std::mem::take(&mut effects.clipboard),
            clipboard_reads_denied: std::mem::take(&mut effects.clipboard_reads_denied),
            reset: std::mem::take(&mut effects.reset),
        }
    }

    /// Whether programs may put text on the clipboard (OSC 52); on by default.
    pub fn set_clipboard_write(&mut self, allowed: bool) {
        self.effects_mut().clipboard_write = allowed;
    }

    /// Resizes the grid. Ends a synchronized-output hold, as libghostty-vt does.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size; [`Error::Vt`] when libghostty-vt fails.
    pub fn resize(
        &mut self,
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    ) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Err(zero_size());
        }
        // SAFETY: the terminal is live and exclusively borrowed.
        check("ghostty_terminal_resize", unsafe {
            sys::ghostty_terminal_resize(self.raw.as_ptr(), cols, rows, cell_width, cell_height)
        })?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Grid width.
    #[must_use]
    pub fn cols(&self) -> u16 {
        self.cols
    }

    /// Grid height.
    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// Which screen is active.
    #[must_use]
    pub fn active_screen(&self) -> ActiveScreen {
        // SAFETY: ACTIVE_SCREEN writes a GhosttyTerminalScreen.
        let (code, screen) = unsafe {
            self.get(
                sys::GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
                sys::GHOSTTY_TERMINAL_SCREEN_PRIMARY,
            )
        };
        if code == sys::GHOSTTY_SUCCESS && screen == sys::GHOSTTY_TERMINAL_SCREEN_ALTERNATE {
            ActiveScreen::Alternate
        } else {
            ActiveScreen::Primary
        }
    }

    /// Rows of the active screen including its scrollback.
    #[must_use]
    pub fn total_rows(&self) -> usize {
        // SAFETY: TOTAL_ROWS writes a size_t.
        let (code, rows) = unsafe { self.get(sys::GHOSTTY_TERMINAL_DATA_TOTAL_ROWS, 0usize) };
        if code == sys::GHOSTTY_SUCCESS {
            rows
        } else {
            usize::from(self.rows)
        }
    }

    /// The viewport's scroll state.
    #[must_use]
    pub fn scrollbar(&self) -> Scrollbar {
        let init = sys::GhosttyTerminalScrollbar {
            total: 0,
            offset: 0,
            len: 0,
        };
        // SAFETY: SCROLLBAR writes a GhosttyTerminalScrollbar.
        let (code, bar) = unsafe { self.get(sys::GHOSTTY_TERMINAL_DATA_SCROLLBAR, init) };
        if code == sys::GHOSTTY_SUCCESS {
            Scrollbar {
                total: bar.total,
                offset: bar.offset,
                len: bar.len,
            }
        } else {
            Scrollbar::default()
        }
    }

    /// The title the program set (OSC 0/2), empty when none.
    pub fn title(&mut self) -> String {
        self.borrowed_string(sys::GHOSTTY_TERMINAL_DATA_TITLE)
    }

    /// The working directory the shell reported (OSC 7), empty when none.
    pub fn pwd(&mut self) -> String {
        self.borrowed_string(sys::GHOSTTY_TERMINAL_DATA_PWD)
    }

    fn borrowed_string(&mut self, data: sys::GhosttyTerminalData) -> String {
        let init = sys::GhosttyString {
            ptr: ptr::null(),
            len: 0,
        };
        // SAFETY: TITLE and PWD write a borrowed GhosttyString.
        let (code, text) = unsafe { self.get(data, init) };
        if code != sys::GHOSTTY_SUCCESS || text.ptr.is_null() {
            return String::new();
        }
        // SAFETY: the string is valid until the next mutating call, which the exclusive borrow
        // rules out until it is copied here.
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(text.ptr, text.len) })
            .into_owned()
    }

    /// Whether DEC private mode `mode` (or ANSI mode with `ansi`) is set.
    #[must_use]
    pub fn mode(&self, mode: u16, ansi: bool) -> bool {
        let init = sys::GhosttyTerminalModeConfig {
            // `ghostty_mode_new` (static inline, invisible to bindgen): value in the low 15
            // bits, the ANSI flag in bit 15.
            mode: (mode & 0x7fff) | (u16::from(ansi) << 15),
            value: false,
        };
        // SAFETY: MODE reads the initialized `mode` field and writes `value`.
        let (code, config) = unsafe { self.get(sys::GHOSTTY_TERMINAL_DATA_MODE, init) };
        code == sys::GHOSTTY_SUCCESS && config.value
    }

    /// Pastes `text` as the terminal's modes require (bracketed paste, or a Kitty paste event);
    /// the bytes to write arrive as replies ([`take_effects`](Self::take_effects)). Text that
    /// could run commands is refused unless `allow_unsafe`.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn paste(&mut self, text: &str, allow_unsafe: bool) -> Result<PasteOutcome> {
        let mime = "text/plain";
        let mimes = [sys::GhosttyString {
            ptr: mime.as_ptr(),
            len: mime.len(),
        }];
        let mut source = text;
        let paste = sys::GhosttyPaste {
            size: size_of::<sys::GhosttyPaste>(),
            location: sys::GHOSTTY_CLIPBOARD_LOCATION_STANDARD,
            source: sys::GHOSTTY_PASTE_SOURCE_CLIPBOARD,
            mimes: mimes.as_ptr(),
            mimes_len: mimes.len(),
            reader: sys::GhosttyMimeReader {
                read: Some(read_paste),
                userdata: (&raw mut source).cast(),
            },
            allow_unsafe,
        };
        // A Kitty paste event makes the program read the text back right away.
        self.effects_mut().paste = Some(text.to_owned());
        let mut pasted = false;
        // SAFETY: the terminal is live and exclusively borrowed; the paste, its MIME array and
        // the reader's userdata (`source`) outlive the call.
        let code = unsafe {
            sys::ghostty_terminal_paste(self.raw.as_ptr(), &raw const paste, &raw mut pasted)
        };
        if code == sys::GHOSTTY_REJECTED {
            self.effects_mut().paste = None;
            return Ok(PasteOutcome::Unsafe);
        }
        check("ghostty_terminal_paste", code)?;
        Ok(if pasted {
            PasteOutcome::Pasted
        } else {
            self.effects_mut().paste = None;
            PasteOutcome::Empty
        })
    }

    /// Stamps a synchronized-output hold that began during the last writes with `now`, the
    /// owner's clock (libghostty-vt has no clock).
    pub fn stamp_hold(&mut self, now: Instant) {
        let effects = self.effects_mut();
        if effects.hold_unstamped {
            effects.hold_unstamped = false;
            effects.hold_since = Some(now);
        }
    }

    /// When the running synchronized-output hold began, if one is running and stamped.
    pub fn hold_since(&mut self) -> Option<Instant> {
        self.effects_mut().hold_since
    }

    /// Ends a hold the program did not end itself. Setting the mode does not invoke the
    /// callback, so the record is cleared here.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when the mode cannot be set.
    pub fn end_hold(&mut self) -> Result<()> {
        let mode = sys::GhosttyTerminalModeConfig {
            mode: MODE_SYNCHRONIZED_OUTPUT,
            value: false,
        };
        // SAFETY: OPT_MODE takes a pointer to a GhosttyTerminalModeConfig that lives for the
        // call; the terminal is exclusively borrowed.
        check("ghostty_terminal_set(MODE)", unsafe {
            sys::ghostty_terminal_set(
                self.raw.as_ptr(),
                sys::GHOSTTY_TERMINAL_OPT_MODE,
                (&raw const mode).cast(),
            )
        })?;
        let effects = self.effects_mut();
        effects.hold_since = None;
        effects.hold_unstamped = false;
        effects.capture_ready = false;
        Ok(())
    }

    /// If a hold began since the last call, swaps its captured render state with `live` and
    /// returns true: `live` then holds the frame the program wanted on screen.
    pub fn take_hold_capture(&mut self, live: &mut RenderState) -> bool {
        let effects = self.effects_mut();
        if !effects.capture_ready {
            return false;
        }
        effects.capture_ready = false;
        std::mem::swap(&mut effects.capture, live);
        true
    }
}

/// The effects callbacks with their option and the error name of setting them.
fn callbacks() -> [(&'static str, sys::GhosttyTerminalOption, *const c_void); 9] {
    type Plain = unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void);
    type With<T> = unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void, *const T);
    let write_pty: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void, *const u8, usize) =
        effects::on_write_pty;
    let title: Plain = effects::on_title_changed;
    let pwd: Plain = effects::on_pwd_changed;
    let bell: Plain = effects::on_bell;
    let reset: Plain = effects::on_reset;
    let hold: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void, bool) =
        effects::on_render_hold;
    let prompt: With<sys::GhosttyTerminalSemanticPrompt> = effects::on_semantic_prompt;
    let clip_write: With<sys::GhosttyClipboardWrite> = effects::on_clipboard_write;
    let clip_read: With<sys::GhosttyClipboardRead> = effects::on_clipboard_read;
    [
        (
            "ghostty_terminal_set(WRITE_PTY)",
            sys::GHOSTTY_TERMINAL_OPT_WRITE_PTY,
            write_pty as *const c_void,
        ),
        (
            "ghostty_terminal_set(TITLE_CHANGED)",
            sys::GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
            title as *const c_void,
        ),
        (
            "ghostty_terminal_set(PWD_CHANGED)",
            sys::GHOSTTY_TERMINAL_OPT_PWD_CHANGED,
            pwd as *const c_void,
        ),
        (
            "ghostty_terminal_set(BELL)",
            sys::GHOSTTY_TERMINAL_OPT_BELL,
            bell as *const c_void,
        ),
        (
            "ghostty_terminal_set(SEMANTIC_PROMPT)",
            sys::GHOSTTY_TERMINAL_OPT_SEMANTIC_PROMPT,
            prompt as *const c_void,
        ),
        (
            "ghostty_terminal_set(CLIPBOARD_WRITE)",
            sys::GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE,
            clip_write as *const c_void,
        ),
        (
            "ghostty_terminal_set(CLIPBOARD_READ)",
            sys::GHOSTTY_TERMINAL_OPT_CLIPBOARD_READ,
            clip_read as *const c_void,
        ),
        (
            "ghostty_terminal_set(RENDER_HOLD)",
            sys::GHOSTTY_TERMINAL_OPT_RENDER_HOLD,
            hold as *const c_void,
        ),
        (
            "ghostty_terminal_set(RESET)",
            sys::GHOSTTY_TERMINAL_OPT_RESET,
            reset as *const c_void,
        ),
    ]
}

/// The paste's MIME reader: writes the text (`userdata` is a `&str`) to `writer`.
unsafe extern "C" fn read_paste(
    userdata: *mut c_void,
    _mime: sys::GhosttyString,
    writer: sys::GhosttyWriter,
) -> bool {
    // SAFETY: `userdata` is the `&str` that `Terminal::paste` keeps alive for the call.
    let Some(text) = (unsafe { userdata.cast::<&str>().as_ref() }) else {
        return false;
    };
    let Some(write) = writer.write else {
        return false;
    };
    // SAFETY: the writer belongs to this call; the text is readable for its length.
    unsafe { write(writer.userdata, text.as_ptr(), text.len()) }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        // SAFETY: the handle came from libghostty-vt and is not used again. Freeing the
        // terminal first guarantees no callback runs while the record below is freed.
        unsafe { sys::ghostty_terminal_free(self.raw.as_ptr()) };
        // SAFETY: the pointer came from Box::leak in `adopt` and nothing refers to it any more.
        drop(unsafe { Box::from_raw(self.effects.as_ptr()) });
    }
}
