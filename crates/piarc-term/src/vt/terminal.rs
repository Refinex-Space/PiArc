//! [`Terminal`]: one libghostty-vt terminal with PiArc's effects registered.

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::time::Instant;

use piarc_ghostty_sys as sys;

use super::effects::{self, Effects, EffectsOutput};
use super::render::RenderState;
use super::{MODE_SYNCHRONIZED_OUTPUT, check};
use crate::error::{Error, Result};

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

impl Terminal {
    /// Creates a `cols` × `rows` terminal that keeps at most `scrollback_lines` lines of
    /// history, with the effects of this module registered.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a zero size; [`Error::Vt`] when libghostty-vt fails.
    pub fn new(cols: u16, rows: u16, scrollback_lines: usize) -> Result<Self> {
        if cols == 0 || rows == 0 {
            return Err(Error::InvalidArgument {
                field: "size",
                reason: "columns and rows must be at least 1".into(),
            });
        }
        let capture = RenderState::new()?;
        let mut raw: sys::GhosttyTerminal = ptr::null_mut();
        // SAFETY: a null allocator selects the default one; `raw` is a valid out pointer.
        check("ghostty_terminal_new", unsafe {
            sys::ghostty_terminal_new(ptr::null(), &raw mut raw, cols, rows)
        })?;
        let raw = NonNull::new(raw).ok_or(Error::Vt {
            call: "ghostty_terminal_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let effects = NonNull::from(Box::leak(Box::new(Effects::new(capture))));
        let terminal = Self {
            raw,
            effects,
            cols,
            rows,
        };
        terminal.register(scrollback_lines)?;
        Ok(terminal)
    }

    fn register(&self, scrollback_lines: usize) -> Result<()> {
        let write_pty: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void, *const u8, usize) =
            effects::on_write_pty;
        let title: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void) =
            effects::on_title_changed;
        let bell: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void) = effects::on_bell;
        let hold: unsafe extern "C" fn(sys::GhosttyTerminal, *mut c_void, bool) =
            effects::on_render_hold;
        // Pointer-typed options (userdata, callbacks) are passed as the value itself; the
        // function pointers have the signatures of the typedefs each option documents.
        self.set(
            "ghostty_terminal_set(USERDATA)",
            sys::GHOSTTY_TERMINAL_OPT_USERDATA,
            self.effects.as_ptr().cast(),
        )?;
        self.set(
            "ghostty_terminal_set(WRITE_PTY)",
            sys::GHOSTTY_TERMINAL_OPT_WRITE_PTY,
            write_pty as *const c_void,
        )?;
        self.set(
            "ghostty_terminal_set(TITLE_CHANGED)",
            sys::GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
            title as *const c_void,
        )?;
        self.set(
            "ghostty_terminal_set(BELL)",
            sys::GHOSTTY_TERMINAL_OPT_BELL,
            bell as *const c_void,
        )?;
        self.set(
            "ghostty_terminal_set(RENDER_HOLD)",
            sys::GHOSTTY_TERMINAL_OPT_RENDER_HOLD,
            hold as *const c_void,
        )?;
        // Value options are passed by pointer (size_t* here).
        self.set(
            "ghostty_terminal_set(SCROLLBACK_MAX_LINES)",
            sys::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
            (&raw const scrollback_lines).cast(),
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

    /// The raw handle, for the other wrappers of this module.
    pub(super) fn raw(&mut self) -> sys::GhosttyTerminal {
        self.raw.as_ptr()
    }

    fn effects_mut(&mut self) -> &mut Effects {
        // SAFETY: the record was leaked from a Box in `new` and is freed only in Drop. Callbacks
        // touch it only during vt_write/resize, which need `&mut self` too, so the borrow
        // checker keeps this reference and a running callback apart.
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

    /// Takes what the effects recorded since the last call.
    pub fn take_effects(&mut self) -> EffectsOutput {
        let effects = self.effects_mut();
        EffectsOutput {
            replies: std::mem::take(&mut effects.replies),
            title: effects.title.take(),
            bells: std::mem::take(&mut effects.bells),
        }
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
            return Err(Error::InvalidArgument {
                field: "size",
                reason: "columns and rows must be at least 1".into(),
            });
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

    /// When the running synchronized-output hold began, if one is running.
    pub fn hold_since(&mut self) -> Option<Instant> {
        self.effects_mut().hold_since
    }

    /// Ends a hold the program did not end itself (libghostty-vt has no clock). Setting the
    /// mode does not invoke the callback, so the record is cleared here.
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

impl Drop for Terminal {
    fn drop(&mut self) {
        // SAFETY: the handle came from ghostty_terminal_new and is not used again. Freeing the
        // terminal first guarantees no callback runs while the record below is freed.
        unsafe { sys::ghostty_terminal_free(self.raw.as_ptr()) };
        // SAFETY: the pointer came from Box::leak in `new` and nothing refers to it any more.
        drop(unsafe { Box::from_raw(self.effects.as_ptr()) });
    }
}
