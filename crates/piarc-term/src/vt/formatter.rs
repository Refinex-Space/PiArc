//! Text of the terminal through libghostty-vt's formatter: plain text of the viewport, the
//! active area, the whole screen with its scrollback, its last rows or a range (what an agent
//! reads, and the reference the frame consistency tests compare against), and VT output that
//! recreates the screen (the replay of a snapshot that cannot be decoded).

use std::ptr;

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use super::tracked::ScreenPoint;
use crate::error::Result;

/// Which part of the active screen to format. On the alternate screen (full-screen programs)
/// there is no scrollback: every range covers that screen only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRange {
    /// What the viewport shows (it may be scrolled into the scrollback).
    Viewport,
    /// The active area: the bottom `rows` rows, where the program writes.
    Screen,
    /// The scrollback and the active area.
    All,
    /// The last `n` lines of the scrollback and the active area, counted after the blank
    /// rows at the bottom (below the cursor, typically) are dropped.
    LastRows(u32),
    /// From `start` to `end`, both included, in screen coordinates.
    Between(ScreenPoint, ScreenPoint),
}

/// How rows become lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextOptions {
    /// Join rows the terminal wrapped back into the line the program wrote.
    pub unwrap: bool,
    /// Remove trailing spaces from each line (trailing blank lines always go).
    pub trim: bool,
}

impl Default for TextOptions {
    /// Rows as lines, trimmed: what the screen looks like.
    fn default() -> Self {
        Self {
            unwrap: false,
            trim: true,
        }
    }
}

/// The visible screen as plain text, formatted by libghostty-vt: one line per row, trailing
/// spaces and trailing blank lines removed, wide characters and grapheme clusters written once.
///
/// # Errors
///
/// [`crate::Error::Vt`] when libghostty-vt fails.
pub fn viewport_text(terminal: &mut Terminal) -> Result<String> {
    plain_text(terminal, TextRange::Viewport, TextOptions::default())
}

/// `range` as plain text.
///
/// # Errors
///
/// [`crate::Error::Vt`] when libghostty-vt fails.
pub fn plain_text(
    terminal: &mut Terminal,
    range: TextRange,
    options: TextOptions,
) -> Result<String> {
    match range {
        TextRange::LastRows(n) => last_lines(terminal, n, options),
        _ => format_range(terminal, range, options),
    }
}

fn format_range(terminal: &mut Terminal, range: TextRange, options: TextOptions) -> Result<String> {
    let selection = selection(terminal, range)?;
    let formatter = Formatter::new(terminal)?;
    formatter.set_bool(
        "ghostty_formatter_set(UNWRAP)",
        sys::GHOSTTY_FORMATTER_OPT_UNWRAP,
        options.unwrap,
    )?;
    formatter.set_bool(
        "ghostty_formatter_set(TRIM)",
        sys::GHOSTTY_FORMATTER_OPT_TRIM,
        options.trim,
    )?;
    if let Some(selection) = &selection {
        formatter.select(selection)?;
    }
    let bytes = formatter.format()?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The text of `selection` (a fresh snapshot of this terminal's selection): wrapped rows
/// joined, trailing spaces trimmed, as a copy should give it.
pub(super) fn selected_text(
    terminal: &mut Terminal,
    selection: &sys::GhosttySelection,
) -> Result<String> {
    let formatter = Formatter::new(terminal)?;
    formatter.set_bool(
        "ghostty_formatter_set(UNWRAP)",
        sys::GHOSTTY_FORMATTER_OPT_UNWRAP,
        true,
    )?;
    formatter.set_bool(
        "ghostty_formatter_set(TRIM)",
        sys::GHOSTTY_FORMATTER_OPT_TRIM,
        true,
    )?;
    formatter.select(selection)?;
    let bytes = formatter.format()?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The last `n` lines: formats a window of the bottom rows, wide enough to hold `n` lines
/// after the trailing blank rows the formatter drops, growing it when blank rows took more.
fn last_lines(terminal: &mut Terminal, n: u32, options: TextOptions) -> Result<String> {
    if n == 0 {
        return Ok(String::new());
    }
    let total = u32::try_from(terminal.total_rows()).unwrap_or(u32::MAX);
    let wanted = usize::try_from(n).unwrap_or(usize::MAX);
    let mut window = n.saturating_add(u32::from(terminal.rows()));
    loop {
        let start = total.saturating_sub(window);
        let end = ScreenPoint {
            y: total.saturating_sub(1),
            x: u16::MAX,
        };
        let range = TextRange::Between(ScreenPoint { y: start, x: 0 }, end);
        let text = format_range(terminal, range, options)?;
        let lines: Vec<&str> = text.split('\n').collect();
        if lines.len() >= wanted || start == 0 {
            let skip = lines.len().saturating_sub(wanted);
            return Ok(lines[skip..].join("\n"));
        }
        window = window.saturating_mul(2);
    }
}

/// VT sequences that recreate the active screen (scrollback, styles and every extra: cursor,
/// modes, palette, working directory, …) when written to a fresh terminal of the same size.
///
/// # Errors
///
/// [`crate::Error::Vt`] when libghostty-vt fails.
pub fn vt_text(terminal: &mut Terminal) -> Result<Vec<u8>> {
    let formatter = Formatter::new(terminal)?;
    let emit: sys::GhosttyFormatterFormat = sys::GHOSTTY_FORMATTER_FORMAT_VT;
    formatter.set(
        "ghostty_formatter_set(EMIT)",
        sys::GHOSTTY_FORMATTER_OPT_EMIT,
        (&raw const emit).cast(),
    )?;
    // GHOSTTY_FORMATTER_EXTRAS_ALL, a macro bindgen does not see.
    let extras: u32 = 0xfff;
    formatter.set(
        "ghostty_formatter_set(EXTRAS)",
        sys::GHOSTTY_FORMATTER_OPT_EXTRAS,
        (&raw const extras).cast(),
    )?;
    formatter.format()
}

/// A formatter over a terminal that stays exclusively borrowed for its lifetime.
struct Formatter<'t> {
    raw: sys::GhosttyFormatter,
    _terminal: std::marker::PhantomData<&'t mut Terminal>,
}

impl<'t> Formatter<'t> {
    fn new(terminal: &'t mut Terminal) -> Result<Self> {
        let mut raw: sys::GhosttyFormatter = ptr::null_mut();
        // SAFETY: the terminal is live and exclusively borrowed for as long as the formatter
        // exists (`'t`).
        check("ghostty_formatter_terminal_new", unsafe {
            sys::ghostty_formatter_terminal_new(ptr::null(), &raw mut raw, terminal.raw())
        })?;
        Ok(Self {
            raw,
            _terminal: std::marker::PhantomData,
        })
    }

    fn set(
        &self,
        call: &'static str,
        option: sys::GhosttyFormatterOption,
        value: *const std::ffi::c_void,
    ) -> Result<()> {
        // SAFETY: the formatter is live; `value` points to the type `option` documents and
        // lives for the call (the formatter copies it).
        check(call, unsafe {
            sys::ghostty_formatter_set(self.raw, option, value)
        })
    }

    fn set_bool(
        &self,
        call: &'static str,
        option: sys::GhosttyFormatterOption,
        value: bool,
    ) -> Result<()> {
        self.set(call, option, (&raw const value).cast())
    }

    fn select(&self, selection: &sys::GhosttySelection) -> Result<()> {
        // The grid refs are valid until the next change to the terminal, which the exclusive
        // borrow rules out.
        self.set(
            "ghostty_formatter_set(SELECTION)",
            sys::GHOSTTY_FORMATTER_OPT_SELECTION,
            ptr::from_ref(selection).cast(),
        )
    }

    fn format(&self) -> Result<Vec<u8>> {
        let mut out: *mut u8 = ptr::null_mut();
        let mut len = 0usize;
        // SAFETY: the formatter is live; the library allocates the output with the default
        // allocator and reports its length.
        check("ghostty_formatter_format_alloc", unsafe {
            sys::ghostty_formatter_format_alloc(self.raw, ptr::null(), &raw mut out, &raw mut len)
        })?;
        if out.is_null() {
            return Ok(Vec::new());
        }
        // SAFETY: `out` points to `len` bytes the library allocated for us.
        let bytes = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
        // SAFETY: the buffer came from format_alloc with the default allocator.
        unsafe { sys::ghostty_free(ptr::null(), out, len) };
        Ok(bytes)
    }
}

impl Drop for Formatter<'_> {
    fn drop(&mut self) {
        // SAFETY: created in `new`, not used again; the terminal is still borrowed.
        unsafe { sys::ghostty_formatter_free(self.raw) };
    }
}

/// The selection for `range`; `None` formats the whole active screen.
fn selection(terminal: &mut Terminal, range: TextRange) -> Result<Option<sys::GhosttySelection>> {
    let cols = terminal.cols();
    let rows = terminal.rows();
    let last_col = cols.saturating_sub(1);
    let total = u32::try_from(terminal.total_rows()).unwrap_or(u32::MAX);
    let last_row = total.saturating_sub(1);
    let raw = terminal.raw();
    let (start, end) = match range {
        TextRange::All => return Ok(None),
        TextRange::Viewport => (
            grid_ref(raw, sys::GHOSTTY_POINT_TAG_VIEWPORT, 0, 0)?,
            grid_ref(
                raw,
                sys::GHOSTTY_POINT_TAG_VIEWPORT,
                last_col,
                u32::from(rows) - 1,
            )?,
        ),
        TextRange::Screen => (
            grid_ref(raw, sys::GHOSTTY_POINT_TAG_ACTIVE, 0, 0)?,
            grid_ref(
                raw,
                sys::GHOSTTY_POINT_TAG_ACTIVE,
                last_col,
                u32::from(rows) - 1,
            )?,
        ),
        TextRange::LastRows(_) => return Ok(None),
        TextRange::Between(start, end) => {
            let clamp = |p: ScreenPoint| (p.x.min(last_col), p.y.min(last_row));
            let (sx, sy) = clamp(start);
            let (ex, ey) = clamp(end);
            (
                grid_ref(raw, sys::GHOSTTY_POINT_TAG_SCREEN, sx, sy)?,
                grid_ref(raw, sys::GHOSTTY_POINT_TAG_SCREEN, ex, ey)?,
            )
        }
    };
    Ok(Some(sys::GhosttySelection {
        start,
        end,
        rectangle: false,
    }))
}

pub(super) fn grid_ref(
    terminal: sys::GhosttyTerminal,
    tag: sys::GhosttyPointTag,
    x: u16,
    y: u32,
) -> Result<sys::GhosttyGridRef> {
    let point = sys::GhosttyPoint {
        tag,
        value: sys::GhosttyPointValue {
            coordinate: sys::GhosttyPointCoordinate { x, y },
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
