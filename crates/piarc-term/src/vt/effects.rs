//! The effects PiArc registers on every terminal (T10): `WRITE_PTY` (query replies),
//! `TITLE_CHANGED`, `BELL` and `RENDER_HOLD`. The rest (pwd, OSC 133, clipboard, …) is T33's.
//!
//! The callbacks only record what happened in [`Effects`], the terminal's userdata. The thread
//! that called `vt_write` collects the record with [`super::Terminal::take_effects`] after the
//! call and acts on it outside the terminal: replies go to the PTY writer, title and bell
//! become events. That keeps the callbacks short and keeps them from writing to the terminal.

use std::ffi::c_void;
use std::time::Instant;

use piarc_ghostty_sys as sys;

use super::render::RenderState;

/// What the callbacks recorded. Owned by the terminal (heap-allocated, its address is the
/// userdata pointer) and only touched by callbacks or by code holding `&mut Terminal`.
pub(crate) struct Effects {
    /// Bytes the terminal wants written back to the PTY, in order.
    pub(crate) replies: Vec<u8>,
    /// The new title, when it changed since the last collection.
    pub(crate) title: Option<String>,
    /// Bells since the last collection.
    pub(crate) bells: u32,
    /// When the current synchronized-output hold began; `None` outside a hold.
    pub(crate) hold_since: Option<Instant>,
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
            bells: 0,
            hold_since: None,
            capture_ready: false,
            capture,
        }
    }
}

/// What [`super::Terminal::take_effects`] hands over after a write.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EffectsOutput {
    /// Bytes to write to the PTY (device attribute answers, mode reports, …).
    pub replies: Vec<u8>,
    /// The new title, if it changed.
    pub title: Option<String>,
    /// Number of bells.
    pub bells: u32,
}

/// Recovers the [`Effects`] record from a callback's userdata.
///
/// # Safety
///
/// `userdata` must be the pointer `Terminal::new` registered, and the caller must be running
/// inside a callback, when no Rust reference to the record exists (the terminal is borrowed
/// mutably by the `vt_write` or `resize` call that is executing).
unsafe fn effects<'a>(userdata: *mut c_void) -> Option<&'a mut Effects> {
    // SAFETY: per the contract above the pointer is either null or the live, unaliased record.
    unsafe { userdata.cast::<Effects>().as_mut() }
}

pub(super) unsafe extern "C" fn on_write_pty(
    _terminal: sys::GhosttyTerminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    // SAFETY: libghostty-vt passes the userdata registered by Terminal::new, from inside the
    // vt_write that holds the only borrow of the terminal.
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
    let mut title = sys::GhosttyString {
        ptr: std::ptr::null(),
        len: 0,
    };
    // SAFETY: reading the terminal from a callback is allowed (the effects guide reads it in
    // its title example); DATA_TITLE writes a borrowed GhosttyString into `title`.
    let result = unsafe {
        sys::ghostty_terminal_get(
            terminal,
            sys::GHOSTTY_TERMINAL_DATA_TITLE,
            (&raw mut title).cast(),
        )
    };
    let text = if result == sys::GHOSTTY_SUCCESS && !title.ptr.is_null() {
        // SAFETY: the string is valid until the next mutating call on the terminal, and it
        // is copied before this callback returns.
        let bytes = unsafe { std::slice::from_raw_parts(title.ptr, title.len) };
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        String::new()
    };
    effects.title = Some(text);
}

pub(super) unsafe extern "C" fn on_bell(_terminal: sys::GhosttyTerminal, userdata: *mut c_void) {
    // SAFETY: as in on_write_pty.
    if let Some(effects) = unsafe { effects(userdata) } {
        effects.bells = effects.bells.saturating_add(1);
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
        effects.hold_since = Some(Instant::now());
    } else {
        effects.hold_since = None;
        effects.capture_ready = false;
    }
}
