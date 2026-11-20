//! [`RenderState`]: a copy of everything needed to draw one frame, updated incrementally from a
//! terminal (libghostty-vt's rendering guide), and the reads the frame encoder needs.

use std::ffi::c_void;
use std::ptr::{self, NonNull};

use piarc_ghostty_sys as sys;
use piarc_protocol::term_frame::{Colors, Cursor, CursorStyle, Dirty, Rgb, Style, Wide};

use super::check;
use super::terminal::Terminal;
use crate::error::{Error, Result};

/// libghostty-vt's opaque row identity: equal ids are the same row across updates.
pub type RowId = [u64; 2];

/// A render state with its row iterator and row-cells handles, allocated once and reused.
pub struct RenderState {
    raw: NonNull<sys::GhosttyRenderStateImpl>,
    rows: NonNull<sys::GhosttyRenderStateRowIteratorImpl>,
    cells: NonNull<sys::GhosttyRenderStateRowCellsImpl>,
}

// SAFETY: render state handles have no thread affinity; `RenderState` is not `Sync` and every
// call takes `&self`/`&mut self` of a value only one thread can reach at a time (it lives in a
// mutex or in a terminal's effects record), so moving it between threads is sound.
unsafe impl Send for RenderState {}

/// One cell as the frame encoder needs it: width class, text and resolved style.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CellData {
    /// Width class.
    pub wide: Wide,
    /// The grapheme cluster, empty for an empty cell.
    pub text: String,
    /// Colors resolved to RGB (`None` = the default color) and style flags.
    pub style: Style,
}

fn non_null<T>(call: &'static str, raw: *mut T) -> Result<NonNull<T>> {
    NonNull::new(raw).ok_or(Error::Vt {
        call,
        code: sys::GHOSTTY_INVALID_VALUE,
    })
}

impl RenderState {
    /// Allocates an empty render state.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when an allocation fails.
    pub fn new() -> Result<Self> {
        let mut raw: sys::GhosttyRenderState = ptr::null_mut();
        // SAFETY: null allocator = default allocator; `raw` is a valid out pointer.
        check("ghostty_render_state_new", unsafe {
            sys::ghostty_render_state_new(ptr::null(), &raw mut raw)
        })?;
        let raw = non_null("ghostty_render_state_new", raw)?;
        let mut rows: sys::GhosttyRenderStateRowIterator = ptr::null_mut();
        // SAFETY: as above.
        let result =
            unsafe { sys::ghostty_render_state_row_iterator_new(ptr::null(), &raw mut rows) };
        let rows = match check("ghostty_render_state_row_iterator_new", result)
            .and_then(|()| non_null("ghostty_render_state_row_iterator_new", rows))
        {
            Ok(rows) => rows,
            Err(error) => {
                // SAFETY: `raw` was created above and is not used again.
                unsafe { sys::ghostty_render_state_free(raw.as_ptr()) };
                return Err(error);
            }
        };
        let mut cells: sys::GhosttyRenderStateRowCells = ptr::null_mut();
        // SAFETY: as above.
        let result =
            unsafe { sys::ghostty_render_state_row_cells_new(ptr::null(), &raw mut cells) };
        match check("ghostty_render_state_row_cells_new", result)
            .and_then(|()| non_null("ghostty_render_state_row_cells_new", cells))
        {
            Ok(cells) => Ok(Self { raw, rows, cells }),
            Err(error) => {
                // SAFETY: both handles were created above and are not used again.
                unsafe {
                    sys::ghostty_render_state_row_iterator_free(rows.as_ptr());
                    sys::ghostty_render_state_free(raw.as_ptr());
                }
                Err(error)
            }
        }
    }

    /// First half of a two-phase update: the only part that needs the terminal. Hold the
    /// terminal's lock for this call alone, then call [`end_update`](Self::end_update).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn begin_update(&mut self, terminal: &mut Terminal) -> Result<()> {
        // SAFETY: both handles are live and exclusively borrowed.
        check("ghostty_render_state_begin_update", unsafe {
            sys::ghostty_render_state_begin_update(self.raw.as_ptr(), terminal.raw())
        })
    }

    /// Second half of the update; touches only this render state's own memory.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn end_update(&mut self) -> Result<()> {
        // SAFETY: the handle is live and exclusively borrowed.
        check("ghostty_render_state_end_update", unsafe {
            sys::ghostty_render_state_end_update(self.raw.as_ptr())
        })
    }

    /// Both phases in one call, with a raw terminal handle (used from the render-hold callback).
    ///
    /// # Safety
    ///
    /// `terminal` must be a live terminal handle that no other thread uses during the call.
    pub(super) unsafe fn update_raw(&mut self, terminal: sys::GhosttyTerminal) -> Result<()> {
        // SAFETY: the caller guarantees `terminal`; `self` is exclusively borrowed.
        check("ghostty_render_state_update", unsafe {
            sys::ghostty_render_state_update(self.raw.as_ptr(), terminal)
        })
    }

    /// Clears both dirty layers once a complete frame was produced from this state.
    pub fn clean(&mut self) {
        // SAFETY: the handle is live and exclusively borrowed. Cleaning cannot fail for a
        // live handle; the result carries nothing to act on.
        let _ = unsafe { sys::ghostty_render_state_clean(self.raw.as_ptr()) };
    }

    /// Reads one value of the type `T` that `data` documents.
    ///
    /// # Safety
    ///
    /// `T` must be the output type libghostty-vt documents for `data`.
    unsafe fn get<T: Copy>(
        &self,
        call: &'static str,
        data: sys::GhosttyRenderStateData,
        init: T,
    ) -> Result<T> {
        let mut value = init;
        // SAFETY: the handle is live; the caller pairs `data` with its output type `T`, and
        // `value` is a valid, initialized out location of that type.
        check(call, unsafe {
            sys::ghostty_render_state_get(self.raw.as_ptr(), data, (&raw mut value).cast())
        })?;
        Ok(value)
    }

    /// The global dirty state of the last update.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn dirty(&self) -> Result<Dirty> {
        // SAFETY: DIRTY writes a GhosttyRenderStateDirty.
        let dirty: sys::GhosttyRenderStateDirty = unsafe {
            self.get(
                "ghostty_render_state_get(DIRTY)",
                sys::GHOSTTY_RENDER_STATE_DATA_DIRTY,
                0,
            )
        }?;
        Ok(match dirty {
            sys::GHOSTTY_RENDER_STATE_DIRTY_FALSE => Dirty::Clean,
            sys::GHOSTTY_RENDER_STATE_DIRTY_PARTIAL => Dirty::Partial,
            _ => Dirty::Full,
        })
    }

    /// Viewport size `(cols, rows)` of the last update.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn size(&self) -> Result<(u16, u16)> {
        // SAFETY: COLS and ROWS write a uint16_t.
        let cols: u16 = unsafe {
            self.get(
                "ghostty_render_state_get(COLS)",
                sys::GHOSTTY_RENDER_STATE_DATA_COLS,
                0,
            )
        }?;
        // SAFETY: as above.
        let rows: u16 = unsafe {
            self.get(
                "ghostty_render_state_get(ROWS)",
                sys::GHOSTTY_RENDER_STATE_DATA_ROWS,
                0,
            )
        }?;
        Ok((cols, rows))
    }

    /// The cursor of the last update.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn cursor(&self) -> Result<Cursor> {
        let init = sys::GhosttyRenderStateCursor {
            size: size_of::<sys::GhosttyRenderStateCursor>(),
            viewport_has_value: false,
            viewport_x: 0,
            viewport_y: 0,
            wide_tail: false,
            visible: false,
            blinking: false,
            password_input: false,
            visual_style: sys::GHOSTTY_CURSOR_STYLE_BLOCK,
        };
        // SAFETY: CURSOR fills a GhosttyRenderStateCursor whose `size` is set.
        let c = unsafe {
            self.get(
                "ghostty_render_state_get(CURSOR)",
                sys::GHOSTTY_RENDER_STATE_DATA_CURSOR,
                init,
            )
        }?;
        Ok(Cursor {
            visible: c.visible,
            blinking: c.blinking,
            in_viewport: c.viewport_has_value,
            wide_tail: c.wide_tail,
            password_input: c.password_input,
            style: match c.visual_style {
                sys::GHOSTTY_CURSOR_STYLE_BAR => CursorStyle::Bar,
                sys::GHOSTTY_CURSOR_STYLE_UNDERLINE => CursorStyle::Underline,
                sys::GHOSTTY_CURSOR_STYLE_BLOCK_HOLLOW => CursorStyle::BlockHollow,
                _ => CursorStyle::Block,
            },
            x: if c.viewport_has_value {
                c.viewport_x
            } else {
                0
            },
            y: if c.viewport_has_value {
                c.viewport_y
            } else {
                0
            },
        })
    }

    /// The colors of the last update.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn colors(&self) -> Result<Colors> {
        let black = sys::GhosttyColorRgb { r: 0, g: 0, b: 0 };
        let init = sys::GhosttyRenderStateColors {
            size: size_of::<sys::GhosttyRenderStateColors>(),
            background: black,
            foreground: black,
            cursor: black,
            cursor_has_value: false,
            palette: [black; 256],
        };
        // SAFETY: COLORS fills a GhosttyRenderStateColors whose `size` is set.
        let c = unsafe {
            self.get(
                "ghostty_render_state_get(COLORS)",
                sys::GHOSTTY_RENDER_STATE_DATA_COLORS,
                init,
            )
        }?;
        let mut palette = Box::new([Rgb::default(); 256]);
        for (slot, color) in palette.iter_mut().zip(c.palette.iter()) {
            *slot = rgb(*color);
        }
        Ok(Colors {
            background: rgb(c.background),
            foreground: rgb(c.foreground),
            cursor: c.cursor_has_value.then(|| rgb(c.cursor)),
            palette,
        })
    }

    /// Calls `visit` for every captured row, top to bottom, with a reader for that row.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails, or what `visit` returns.
    pub fn for_each_row(
        &mut self,
        mut visit: impl FnMut(&mut RowReader<'_>) -> Result<()>,
    ) -> Result<()> {
        let mut iterator = self.rows.as_ptr();
        // SAFETY: ROW_ITERATOR fills the pre-allocated iterator handle passed by pointer; the
        // row data stays valid until the next update, which `&mut self` rules out meanwhile.
        check("ghostty_render_state_get(ROW_ITERATOR)", unsafe {
            sys::ghostty_render_state_get(
                self.raw.as_ptr(),
                sys::GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                (&raw mut iterator).cast(),
            )
        })?;
        // SAFETY: the iterator is live and borrowed through `self`.
        while unsafe { sys::ghostty_render_state_row_iterator_next(self.rows.as_ptr()) } {
            let mut reader = RowReader {
                rows: self.rows,
                cells: self.cells,
                text: Vec::new(),
                _state: std::marker::PhantomData,
            };
            visit(&mut reader)?;
        }
        Ok(())
    }
}

impl Drop for RenderState {
    fn drop(&mut self) {
        // SAFETY: the handles were created in `new` and are not used again.
        unsafe {
            sys::ghostty_render_state_row_cells_free(self.cells.as_ptr());
            sys::ghostty_render_state_row_iterator_free(self.rows.as_ptr());
            sys::ghostty_render_state_free(self.raw.as_ptr());
        }
    }
}

fn rgb(color: sys::GhosttyColorRgb) -> Rgb {
    Rgb {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

/// Reads the current row of [`RenderState::for_each_row`].
pub struct RowReader<'a> {
    rows: NonNull<sys::GhosttyRenderStateRowIteratorImpl>,
    cells: NonNull<sys::GhosttyRenderStateRowCellsImpl>,
    text: Vec<u8>,
    _state: std::marker::PhantomData<&'a mut RenderState>,
}

impl RowReader<'_> {
    /// # Safety
    ///
    /// `T` must be the output type libghostty-vt documents for `data`.
    unsafe fn row_get<T: Copy>(
        &self,
        call: &'static str,
        data: sys::GhosttyRenderStateRowData,
        init: T,
    ) -> Result<T> {
        let mut value = init;
        // SAFETY: the iterator is positioned on a row (inside for_each_row); the caller pairs
        // `data` with its output type `T`.
        check(call, unsafe {
            sys::ghostty_render_state_row_get(self.rows.as_ptr(), data, (&raw mut value).cast())
        })?;
        Ok(value)
    }

    /// The row's identity across updates.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn id(&self) -> Result<RowId> {
        // SAFETY: ID writes a GhosttyRenderStateRowId.
        let id = unsafe {
            self.row_get(
                "ghostty_render_state_row_get(ID)",
                sys::GHOSTTY_RENDER_STATE_ROW_DATA_ID,
                sys::GhosttyRenderStateRowId { bits: [0, 0] },
            )
        }?;
        Ok(id.bits)
    }

    /// Whether the row changed in the last update (conservative: may be set for unchanged
    /// rows, for example after the viewport scrolled).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn dirty(&self) -> Result<bool> {
        // SAFETY: ROW DIRTY writes a bool.
        unsafe {
            self.row_get(
                "ghostty_render_state_row_get(DIRTY)",
                sys::GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
                false,
            )
        }
    }

    /// The selected columns of this row (both included), if the selection covers it.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn selection(&self) -> Result<Option<(u16, u16)>> {
        let mut value = sys::GhosttyRenderStateRowSelection {
            size: size_of::<sys::GhosttyRenderStateRowSelection>(),
            start_x: 0,
            end_x: 0,
        };
        // SAFETY: SELECTION fills a sized GhosttyRenderStateRowSelection for the current row.
        let code = unsafe {
            sys::ghostty_render_state_row_get(
                self.rows.as_ptr(),
                sys::GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                (&raw mut value).cast(),
            )
        };
        if code == sys::GHOSTTY_NO_VALUE {
            return Ok(None);
        }
        check("ghostty_render_state_row_get(SELECTION)", code)?;
        Ok(Some((value.start_x, value.end_x)))
    }

    /// Reads the row's cells into `out` (cleared first), resolving colors with `palette`.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn read_cells(&mut self, palette: &[Rgb; 256], out: &mut Vec<CellData>) -> Result<()> {
        out.clear();
        let mut cells = self.cells.as_ptr();
        // SAFETY: ROW_DATA_CELLS fills the pre-allocated cells handle passed by pointer for the
        // current row; it stays valid until the next update.
        check("ghostty_render_state_row_get(CELLS)", unsafe {
            sys::ghostty_render_state_row_get(
                self.rows.as_ptr(),
                sys::GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                (&raw mut cells).cast(),
            )
        })?;
        // SAFETY: the cells handle is live and positioned by `next`.
        while unsafe { sys::ghostty_render_state_row_cells_next(self.cells.as_ptr()) } {
            let cell = self.read_cell(palette)?;
            out.push(cell);
        }
        Ok(())
    }

    /// # Safety
    ///
    /// `T` must be the output type libghostty-vt documents for `data`, and any buffer it
    /// describes must be writable for its stated capacity.
    unsafe fn cells_get<T: Copy>(
        &self,
        data: sys::GhosttyRenderStateRowCellsData,
        value: &mut T,
    ) -> sys::GhosttyResult {
        // SAFETY: the cells handle is positioned on a cell; the caller pairs `data` with `T`.
        unsafe {
            sys::ghostty_render_state_row_cells_get(
                self.cells.as_ptr(),
                data,
                std::ptr::from_mut(value).cast::<c_void>(),
            )
        }
    }

    fn read_cell(&mut self, palette: &[Rgb; 256]) -> Result<CellData> {
        let mut raw: sys::GhosttyCell = 0;
        // SAFETY: RAW writes a GhosttyCell.
        check("ghostty_render_state_row_cells_get(RAW)", unsafe {
            self.cells_get(sys::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &mut raw)
        })?;
        // SAFETY: WIDE writes a GhosttyCellWide.
        let wide = match unsafe {
            cell_value::<sys::GhosttyCellWide>(raw, sys::GHOSTTY_CELL_DATA_WIDE, 0)
        } {
            sys::GHOSTTY_CELL_WIDE_WIDE => Wide::Wide,
            sys::GHOSTTY_CELL_WIDE_SPACER_TAIL => Wide::SpacerTail,
            sys::GHOSTTY_CELL_WIDE_SPACER_HEAD => Wide::SpacerHead,
            _ => Wide::Narrow,
        };
        // SAFETY: HAS_TEXT and HAS_STYLING write a bool, CONTENT_TAG a GhosttyCellContentTag.
        let (has_text, has_styling, tag) = unsafe {
            (
                cell_value::<bool>(raw, sys::GHOSTTY_CELL_DATA_HAS_TEXT, false),
                cell_value::<bool>(raw, sys::GHOSTTY_CELL_DATA_HAS_STYLING, false),
                cell_value::<sys::GhosttyCellContentTag>(
                    raw,
                    sys::GHOSTTY_CELL_DATA_CONTENT_TAG,
                    0,
                ),
            )
        };
        let text = if has_text {
            self.read_text()?
        } else {
            String::new()
        };
        let has_own_bg = tag == sys::GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE
            || tag == sys::GHOSTTY_CELL_CONTENT_BG_COLOR_RGB;
        let style = if has_styling || has_own_bg {
            self.read_style(palette)?
        } else {
            Style::default()
        };
        Ok(CellData { wide, text, style })
    }

    fn read_text(&mut self) -> Result<String> {
        if self.text.len() < 64 {
            self.text.resize(64, 0);
        }
        loop {
            let mut buffer = sys::GhosttyBuffer {
                ptr: self.text.as_mut_ptr(),
                cap: self.text.len(),
                len: 0,
            };
            // SAFETY: GRAPHEMES_UTF8 fills a GhosttyBuffer; `ptr` is writable for `cap` bytes.
            let code = unsafe {
                self.cells_get(
                    sys::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
                    &mut buffer,
                )
            };
            if code == sys::GHOSTTY_OUT_OF_SPACE && buffer.len > self.text.len() {
                self.text.resize(buffer.len, 0);
                continue;
            }
            check("ghostty_render_state_row_cells_get(GRAPHEMES_UTF8)", code)?;
            let bytes = self.text.get(..buffer.len).unwrap_or_default();
            return Ok(String::from_utf8_lossy(bytes).into_owned());
        }
    }

    fn read_style(&mut self, palette: &[Rgb; 256]) -> Result<Style> {
        let none = sys::GhosttyStyleColor {
            tag: 0,
            value: sys::GhosttyStyleColorValue { palette: 0 },
        };
        let mut style = sys::GhosttyStyle {
            fg_color: none,
            bg_color: none,
            underline_color: none,
            flags: 0,
            reserved: 0,
        };
        // SAFETY: STYLE writes a GhosttyStyle.
        check("ghostty_render_state_row_cells_get(STYLE)", unsafe {
            self.cells_get(sys::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &mut style)
        })?;
        Ok(Style {
            fg: self.resolved(sys::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR)?,
            bg: self.resolved(sys::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR)?,
            underline: style_color(style.underline_color, palette),
            flags: style.flags,
        })
    }

    /// FG_COLOR / BG_COLOR: the cell's own color resolved to RGB, `None` for the default.
    fn resolved(&mut self, data: sys::GhosttyRenderStateRowCellsData) -> Result<Option<Rgb>> {
        let mut color = sys::GhosttyColorRgb { r: 0, g: 0, b: 0 };
        // SAFETY: FG_COLOR and BG_COLOR write a GhosttyColorRgb.
        let code = unsafe { self.cells_get(data, &mut color) };
        if code == sys::GHOSTTY_NO_VALUE {
            return Ok(None);
        }
        check(
            "ghostty_render_state_row_cells_get(FG_COLOR/BG_COLOR)",
            code,
        )?;
        Ok(Some(rgb(color)))
    }
}

/// Reads one `GhosttyCellData` value of type `T` from a raw cell; `default` when the library
/// reports no value.
///
/// # Safety
///
/// `T` must be the output type libghostty-vt documents for `data`.
unsafe fn cell_value<T: Copy>(cell: sys::GhosttyCell, data: sys::GhosttyCellData, default: T) -> T {
    let mut value = default;
    // SAFETY: ghostty_cell_get only reads the 64-bit cell value; the caller pairs `data` with
    // its output type `T`.
    let code = unsafe { sys::ghostty_cell_get(cell, data, (&raw mut value).cast()) };
    if code == sys::GHOSTTY_SUCCESS {
        value
    } else {
        default
    }
}

/// Resolves a style color: none, a palette index, or RGB.
fn style_color(color: sys::GhosttyStyleColor, palette: &[Rgb; 256]) -> Option<Rgb> {
    match i32::from(color.tag) {
        sys::GHOSTTY_STYLE_COLOR_PALETTE => {
            // SAFETY: the tag says the union holds a palette index.
            let index = unsafe { color.value.palette };
            Some(palette[usize::from(index)])
        }
        sys::GHOSTTY_STYLE_COLOR_RGB => {
            // SAFETY: the tag says the union holds an RGB value.
            Some(rgb(unsafe { color.value.rgb }))
        }
        _ => None,
    }
}
