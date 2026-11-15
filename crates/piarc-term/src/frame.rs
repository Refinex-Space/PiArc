//! The frame encoder: turns render-state updates into frames of the draft format in
//! `piarc_protocol::term_frame` for one viewer (ADR-0017 rule 3).
//!
//! The encoder mirrors what the viewer holds: the rows of the last frame (by Core's row
//! handle) and the style table. A row is sent with its cells only when the viewer does not
//! hold its current content. libghostty-vt's per-row dirty flag decides which rows to look at;
//! because the flag is conservative ("every row is currently marked dirty after the viewport
//! scrolls"), a dirty row's cells are compared with what the viewer holds before they are sent,
//! so a scroll by one line sends one new row and 5-byte references for the rest.

use std::collections::HashMap;

use piarc_protocol::term_frame::{
    self, Body, Cell, Colors, Cursor, Dirty, Frame, Row, Style, StyleEntry,
};

use crate::error::Result;
use crate::vt::{CellData, RenderState, RowId};

/// Style table size at which the encoder starts over with a RESET frame (the wire limit is
/// 65,535 ids).
const MAX_STYLES: usize = 32_768;

/// Counters of one encode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EncodeStats {
    /// Nothing changed; the frame is the 14-byte header.
    pub empty: bool,
    /// Rows sent with cells.
    pub rows_with_cells: u32,
    /// Rows sent as a reference to what the viewer holds.
    pub rows_reused: u32,
}

/// Encoder state for one viewer.
pub struct FrameEncoder {
    render: RenderState,
    viewer: Option<u32>,
    seq: u32,
    reset_pending: bool,
    compare_all: bool,
    handles: HashMap<RowId, u32>,
    next_handle: u32,
    held: HashMap<u32, Vec<Cell>>,
    styles: HashMap<Style, u16>,
    sent_cursor: Option<Cursor>,
    sent_colors: Option<Colors>,
    sent_size: (u16, u16),
    scratch: Vec<CellData>,
}

impl FrameEncoder {
    /// An encoder whose first frame resets the viewer.
    ///
    /// # Errors
    ///
    /// [`crate::Error::Vt`] when the render state cannot be allocated.
    pub fn new() -> Result<Self> {
        Ok(Self {
            render: RenderState::new()?,
            viewer: None,
            seq: 0,
            reset_pending: true,
            compare_all: false,
            handles: HashMap::new(),
            next_handle: 1,
            held: HashMap::new(),
            styles: HashMap::new(),
            sent_cursor: None,
            sent_colors: None,
            sent_size: (0, 0),
            scratch: Vec::new(),
        })
    }

    /// The render state to update before [`encode`](Self::encode).
    pub fn render_state(&mut self) -> &mut RenderState {
        &mut self.render
    }

    /// Makes the next frame a RESET frame when `viewer` is not the viewer of the previous
    /// frame, or when `full` is set (the viewer lost its state, for example after a reload).
    pub fn prepare(&mut self, viewer: u32, full: bool) {
        if full || self.viewer != Some(viewer) {
            self.viewer = Some(viewer);
            self.reset_pending = true;
        }
    }

    /// The render state was replaced wholesale (a render-hold capture was swapped in): its
    /// dirty flags describe another baseline, so the next encode compares every row.
    pub fn compare_all_rows(&mut self) {
        self.compare_all = true;
    }

    /// Encodes the update just completed on the render state and marks the render state clean.
    /// `held` flags a frame captured at the start of a synchronized-output hold.
    ///
    /// # Errors
    ///
    /// [`crate::Error::Vt`] when reading the render state fails; the render state stays dirty
    /// and the next frame resets the viewer.
    pub fn encode(&mut self, held: bool) -> Result<(Vec<u8>, EncodeStats)> {
        let result = self.encode_inner(held);
        if result.is_err() {
            self.reset_pending = true;
        }
        result
    }

    fn encode_inner(&mut self, held: bool) -> Result<(Vec<u8>, EncodeStats)> {
        let dirty = self.render.dirty()?;
        let (cols, rows) = self.render.size()?;
        let cursor = self.render.cursor()?;
        let colors = self.render.colors()?;
        if self.styles.len() >= MAX_STYLES {
            self.reset_pending = true;
        }
        let reset = self.reset_pending;
        let colors_changed = self.sent_colors.as_ref() != Some(&colors);
        let size_changed = self.sent_size != (cols, rows);
        self.seq = self.seq.checked_add(1).unwrap_or(1);
        if !reset
            && !self.compare_all
            && !size_changed
            && !colors_changed
            && dirty == Dirty::Clean
            && self.sent_cursor == Some(cursor)
        {
            let frame = Frame {
                seq: self.seq,
                reset: false,
                held,
                dirty,
                cols,
                rows,
                body: None,
            };
            let stats = EncodeStats {
                empty: true,
                ..EncodeStats::default()
            };
            return Ok((term_frame::encode(&frame), stats));
        }
        if reset {
            self.held.clear();
            self.styles.clear();
        }
        let compare_all = reset || self.compare_all || size_changed;
        let (rows_list, styles, stats) = self.encode_rows(&colors, compare_all)?;
        let frame = Frame {
            seq: self.seq,
            reset,
            held,
            dirty,
            cols,
            rows,
            body: Some(Body {
                cursor,
                colors: (reset || colors_changed).then(|| colors.clone()),
                styles,
                rows: rows_list,
            }),
        };
        let bytes = term_frame::encode(&frame);
        self.render.clean();
        self.reset_pending = false;
        self.compare_all = false;
        self.sent_cursor = Some(cursor);
        self.sent_colors = Some(colors);
        self.sent_size = (cols, rows);
        Ok((bytes, stats))
    }

    /// Builds the row list: references for rows the viewer holds unchanged, cells otherwise.
    /// Returns the rows, the new style entries and the counters, and replaces what the
    /// encoder believes the viewer holds.
    fn encode_rows(
        &mut self,
        colors: &Colors,
        compare_all: bool,
    ) -> Result<(Vec<Row>, Vec<StyleEntry>, EncodeStats)> {
        let mut list = Vec::new();
        let mut new_styles = Vec::new();
        let mut stats = EncodeStats::default();
        let mut held = HashMap::with_capacity(self.held.len());
        let mut handles = HashMap::with_capacity(self.handles.len());
        let Self {
            render,
            handles: old_handles,
            next_handle,
            held: old_held,
            styles,
            scratch,
            ..
        } = self;
        render.for_each_row(|row| {
            let id = row.id()?;
            let handle = match old_handles.get(&id) {
                Some(handle) => *handle,
                None => {
                    let handle = *next_handle;
                    *next_handle = next_handle.checked_add(1).unwrap_or(1);
                    handle
                }
            };
            handles.insert(id, handle);
            if !compare_all
                && !row.dirty()?
                && let Some(cells) = old_held.remove(&handle)
            {
                held.insert(handle, cells);
                list.push(Row {
                    id: handle,
                    cells: None,
                });
                stats.rows_reused += 1;
                return Ok(());
            }
            row.read_cells(&colors.palette, scratch)?;
            let cells: Vec<Cell> = scratch
                .drain(..)
                .map(|cell| Cell {
                    wide: cell.wide,
                    style: style_id(styles, &mut new_styles, cell.style),
                    text: cell.text,
                })
                .collect();
            let unchanged = old_held.get(&handle) == Some(&cells);
            old_held.remove(&handle);
            if unchanged {
                list.push(Row {
                    id: handle,
                    cells: None,
                });
                stats.rows_reused += 1;
            } else {
                list.push(Row {
                    id: handle,
                    cells: Some(cells.clone()),
                });
                stats.rows_with_cells += 1;
            }
            held.insert(handle, cells);
            Ok(())
        })?;
        self.held = held;
        self.handles = handles;
        Ok((list, new_styles, stats))
    }
}

/// The table id for `style`, adding a new entry to `new` when the viewer has not seen it.
fn style_id(table: &mut HashMap<Style, u16>, new: &mut Vec<StyleEntry>, style: Style) -> u16 {
    if style == Style::default() {
        return 0;
    }
    if let Some(id) = table.get(&style) {
        return *id;
    }
    // MAX_STYLES keeps the table far below u16::MAX; a full table resets on the next frame.
    let id = u16::try_from(table.len() + 1).unwrap_or(u16::MAX);
    table.insert(style, id);
    new.push(StyleEntry { id, style });
    id
}

#[cfg(test)]
mod tests;
