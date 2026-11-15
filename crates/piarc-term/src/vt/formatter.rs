//! Plain text of the viewport through libghostty-vt's formatter: what an agent reads, and the
//! reference the frame consistency tests compare against.

use std::ptr;

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use crate::error::Result;

/// The visible screen as plain text, formatted by libghostty-vt: one line per row, trailing
/// spaces and trailing blank lines removed, wide characters and grapheme clusters written once.
///
/// # Errors
///
/// [`crate::Error::Vt`] when libghostty-vt fails.
pub fn viewport_text(terminal: &mut Terminal) -> Result<String> {
    let cols = terminal.cols();
    let rows = terminal.rows();
    let raw = terminal.raw();
    let start = grid_ref(raw, 0, 0)?;
    let end = grid_ref(raw, cols.saturating_sub(1), rows.saturating_sub(1))?;
    let selection = sys::GhosttySelection {
        start,
        end,
        rectangle: false,
    };
    let mut formatter: sys::GhosttyFormatter = ptr::null_mut();
    // SAFETY: the terminal is live and exclusively borrowed for as long as the formatter
    // exists (it is freed before this function returns).
    check("ghostty_formatter_terminal_new", unsafe {
        sys::ghostty_formatter_terminal_new(ptr::null(), &raw mut formatter, raw)
    })?;
    let text = format_selection(formatter, &selection);
    // SAFETY: created above, not used again; free accepts any handle it returned.
    unsafe { sys::ghostty_formatter_free(formatter) };
    text
}

fn format_selection(
    formatter: sys::GhosttyFormatter,
    selection: &sys::GhosttySelection,
) -> Result<String> {
    // SAFETY: OPT_SELECTION copies the selection; the grid refs are valid until the next
    // change to the terminal, which the exclusive borrow in viewport_text rules out.
    check("ghostty_formatter_set(SELECTION)", unsafe {
        sys::ghostty_formatter_set(
            formatter,
            sys::GHOSTTY_FORMATTER_OPT_SELECTION,
            ptr::from_ref(selection).cast(),
        )
    })?;
    let mut out: *mut u8 = ptr::null_mut();
    let mut len = 0usize;
    // SAFETY: the formatter is live; the library allocates the output with the default
    // allocator and reports its length.
    check("ghostty_formatter_format_alloc", unsafe {
        sys::ghostty_formatter_format_alloc(formatter, ptr::null(), &raw mut out, &raw mut len)
    })?;
    if out.is_null() {
        return Ok(String::new());
    }
    // SAFETY: `out` points to `len` bytes the library allocated for us.
    let text =
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(out, len) }).into_owned();
    // SAFETY: the buffer came from format_alloc with the default allocator.
    unsafe { sys::ghostty_free(ptr::null(), out, len) };
    Ok(text)
}

fn grid_ref(terminal: sys::GhosttyTerminal, x: u16, y: u16) -> Result<sys::GhosttyGridRef> {
    let point = sys::GhosttyPoint {
        tag: sys::GHOSTTY_POINT_TAG_VIEWPORT,
        value: sys::GhosttyPointValue {
            coordinate: sys::GhosttyPointCoordinate { x, y: u32::from(y) },
        },
    };
    let mut out = sys::GhosttyGridRef {
        node: ptr::null_mut(),
        x: 0,
        y: 0,
    };
    // SAFETY: the terminal is live and exclusively borrowed by the caller; `out` is a valid
    // out pointer.
    check("ghostty_terminal_grid_ref", unsafe {
        sys::ghostty_terminal_grid_ref(terminal, point, &raw mut out)
    })?;
    Ok(out)
}
