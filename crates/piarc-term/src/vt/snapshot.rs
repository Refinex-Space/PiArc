//! libghostty-vt snapshots: the complete state of a terminal as bytes (its snapshot guide).
//! The byte format is versioned apart from the library and outside its ABI promise, so only a
//! snapshot written by the same library version is decoded (`crate::snapshot` checks the file
//! header before calling [`decode`]).

use std::ffi::CStr;
use std::ptr;

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use crate::error::{Error, Result};

/// The full version of the libghostty-vt library that is loaded (`ghostty_version()`, for
/// example `1.0.1`).
#[must_use]
pub fn library_version() -> String {
    // SAFETY: ghostty_version returns a static NUL-terminated string or null.
    let raw = unsafe { sys::ghostty_version() };
    if raw.is_null() {
        return String::new();
    }
    // SAFETY: non-null, NUL-terminated and static per the header.
    unsafe { CStr::from_ptr(raw) }
        .to_string_lossy()
        .into_owned()
}

/// Encodes `terminal` completely: both screens, scrollback, modes, colors and unfinished input.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails (for example when an unfinished sequence is longer
/// than the continuation the terminal keeps).
pub fn encode(terminal: &mut Terminal) -> Result<Vec<u8>> {
    let mut out: *mut u8 = ptr::null_mut();
    let mut len = 0usize;
    // SAFETY: the terminal is live and exclusively borrowed (no concurrent writes, as the
    // header requires); the library allocates the output with the default allocator.
    check("ghostty_snapshot_encode_alloc", unsafe {
        sys::ghostty_snapshot_encode_alloc(terminal.raw(), ptr::null(), &raw mut out, &raw mut len)
    })?;
    if out.is_null() {
        return Ok(Vec::new());
    }
    // SAFETY: `out` points to `len` bytes the library allocated.
    let bytes = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
    // SAFETY: allocated by encode_alloc with the default allocator.
    unsafe { sys::ghostty_free(ptr::null(), out, len) };
    Ok(bytes)
}

/// Decodes a snapshot into a new terminal with PiArc's effects registered.
///
/// # Errors
///
/// [`Error::Vt`] when the bytes are not a snapshot this library can read.
pub fn decode(bytes: &[u8], scrollback_lines: usize) -> Result<Terminal> {
    let mut decoder: sys::GhosttySnapshotDecoder = ptr::null_mut();
    // SAFETY: the bytes outlive the decoder (it is freed before this function returns).
    check("ghostty_snapshot_decoder_new_buf", unsafe {
        sys::ghostty_snapshot_decoder_new_buf(
            ptr::null(),
            &raw mut decoder,
            bytes.as_ptr(),
            bytes.len(),
        )
    })?;
    let mut raw: sys::GhosttyTerminal = ptr::null_mut();
    // SAFETY: the decoder is live; on success `raw` receives a terminal we own.
    let code = unsafe { sys::ghostty_snapshot_decoder_decode(decoder, &raw mut raw) };
    // SAFETY: created above and not used again; the terminal stays ours.
    unsafe { sys::ghostty_snapshot_decoder_free(decoder) };
    check("ghostty_snapshot_decoder_decode", code)?;
    if raw.is_null() {
        return Err(Error::Vt {
            call: "ghostty_snapshot_decoder_decode",
            code: sys::GHOSTTY_INVALID_VALUE,
        });
    }
    Terminal::adopt(raw, scrollback_lines)
}
