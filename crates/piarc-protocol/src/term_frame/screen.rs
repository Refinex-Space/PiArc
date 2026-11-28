//! The viewer side of the frame protocol: applies frames in order and holds what the renderer
//! draws. Rust tests use it to compare frames with libghostty-vt's formatter; the renderer's
//! TypeScript `Screen` follows the same rules.

use std::collections::HashMap;

use super::{Cell, Colors, Cursor, Frame, FrameError, Scrollbar, Selection, Style, Wide};

/// The state a viewer rebuilds from frames.
#[derive(Debug, Default)]
pub struct Screen {
    seq: u32,
    cols: u16,
    rows: u16,
    cursor: Cursor,
    colors: Option<Colors>,
    styles: HashMap<u16, Style>,
    held: HashMap<u32, Vec<Cell>>,
    viewport: Vec<u32>,
    selections: Vec<Option<Selection>>,
    scrollbar: Scrollbar,
}

impl Screen {
    /// An empty screen that expects a RESET frame first.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies `frame`. On error the screen is unchanged and the viewer should ask for a
    /// RESET frame.
    ///
    /// # Errors
    ///
    /// [`FrameError`] when the frame is out of order (its `seq` is not the previous plus one
    /// and it does not reset), the first frame does not reset, a RESET frame is empty, a row
    /// without cells is not held, or a cell refers to an unknown style.
    pub fn apply(&mut self, frame: &Frame) -> Result<(), FrameError> {
        if !frame.reset {
            if self.seq == 0 {
                return Err(FrameError::new("the first frame must reset"));
            }
            if Some(frame.seq) != self.seq.checked_add(1) {
                return Err(FrameError::new(format!(
                    "frame {} arrived after frame {}",
                    frame.seq, self.seq
                )));
            }
        }
        let Some(body) = &frame.body else {
            if frame.reset {
                return Err(FrameError::new("a RESET frame must have a body"));
            }
            self.seq = frame.seq;
            return Ok(());
        };
        let mut styles = if frame.reset {
            HashMap::new()
        } else {
            self.styles.clone()
        };
        for entry in &body.styles {
            styles.insert(entry.id, entry.style);
        }
        let mut old = if frame.reset {
            HashMap::new()
        } else {
            self.held.clone()
        };
        let mut held = HashMap::with_capacity(body.rows.len());
        let mut viewport = Vec::with_capacity(body.rows.len());
        let mut selections = Vec::with_capacity(body.rows.len());
        for row in &body.rows {
            let cells = match &row.cells {
                Some(cells) => {
                    if let Some(cell) = cells
                        .iter()
                        .find(|cell| cell.style != 0 && !styles.contains_key(&cell.style))
                    {
                        return Err(FrameError::new(format!("unknown style {}", cell.style)));
                    }
                    cells.clone()
                }
                None => match held.get(&row.id) {
                    Some(cells) => Vec::clone(cells),
                    None => old
                        .remove(&row.id)
                        .ok_or_else(|| FrameError::new(format!("row {} is not held", row.id)))?,
                },
            };
            held.insert(row.id, cells);
            viewport.push(row.id);
            selections.push(row.selection);
        }
        self.seq = frame.seq;
        self.cols = frame.cols;
        self.rows = frame.rows;
        self.cursor = body.cursor;
        if let Some(colors) = &body.colors {
            self.colors = Some(colors.clone());
        } else if frame.reset {
            self.colors = None;
        }
        self.styles = styles;
        self.held = held;
        self.viewport = viewport;
        self.selections = selections;
        self.scrollbar = body.scrollbar;
        Ok(())
    }

    /// The `seq` of the last applied frame, 0 before the first.
    #[must_use]
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// Viewport width.
    #[must_use]
    pub fn cols(&self) -> u16 {
        self.cols
    }

    /// Viewport height.
    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    /// The cursor of the last non-empty frame.
    #[must_use]
    pub fn cursor(&self) -> &Cursor {
        &self.cursor
    }

    /// The colors, once a frame carried them.
    #[must_use]
    pub fn colors(&self) -> Option<&Colors> {
        self.colors.as_ref()
    }

    /// The style for a cell's style id; id 0 is the default style.
    #[must_use]
    pub fn style(&self, id: u16) -> Option<Style> {
        if id == 0 {
            Some(Style::default())
        } else {
            self.styles.get(&id).copied()
        }
    }

    /// The selected columns of viewport row `y`, if any.
    #[must_use]
    pub fn selection(&self, y: u16) -> Option<Selection> {
        self.selections.get(usize::from(y)).copied().flatten()
    }

    /// The viewport's place in the scrollback.
    #[must_use]
    pub fn scrollbar(&self) -> Scrollbar {
        self.scrollbar
    }

    /// Row ids of the viewport, top to bottom.
    #[must_use]
    pub fn row_ids(&self) -> &[u32] {
        &self.viewport
    }

    /// The cells of viewport row `y`.
    #[must_use]
    pub fn row(&self, y: u16) -> Option<&[Cell]> {
        let id = self.viewport.get(usize::from(y))?;
        self.held.get(id).map(Vec::as_slice)
    }

    /// Row `y` as text: each grapheme once, empty cells as spaces, spacer cells skipped,
    /// trailing spaces removed (the formatter's plain-text rules).
    #[must_use]
    pub fn row_text(&self, y: u16) -> String {
        let mut text = String::new();
        for cell in self.row(y).unwrap_or_default() {
            match cell.wide {
                Wide::SpacerTail | Wide::SpacerHead => {}
                Wide::Narrow | Wide::Wide if cell.text.is_empty() => text.push(' '),
                Wide::Narrow | Wide::Wide => text.push_str(&cell.text),
            }
        }
        text.truncate(text.trim_end_matches(' ').len());
        text
    }

    /// The viewport as plain text: one line per row, trailing blank lines removed.
    #[must_use]
    pub fn plain_text(&self) -> String {
        let mut lines: Vec<String> = (0..self.rows).map(|y| self.row_text(y)).collect();
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        lines.join("\n")
    }
}
