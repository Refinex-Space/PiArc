//! Terminal frame format, version 2 (ADR-0017, ADR-0023; T10 drafted version 1, T33 finalized
//! this one).
//!
//! Core keeps the only terminal state (libghostty-vt in `piarc-term`). The renderer pulls one
//! frame per animation frame and draws it; it never parses VT. A frame is the change since the
//! previous frame of the same viewer: the cursor, colors when they changed, the scroll state,
//! new style table entries, and the viewport as a list of row ids where only rows the viewer
//! does not hold yet (new rows or rows whose content changed) carry their cells. When output
//! scrolls, existing rows keep their id and travel as a 5-byte reference, so a scroll by one
//! line costs one row. A row covered by the selection says which columns.
//!
//! The Rust codec here ([`encode`], [`decode`]) and the client model ([`Screen`]) have a
//! TypeScript twin in the renderer (`apps/desktop/src/renderer/terminal/frame/`). Both run the
//! golden samples in `tests/contracts/term-frame/` (L1); the decoded form of a frame has a JSON
//! Schema (`TermFrame` in `ahp.schema.json`) that the samples' decoded side is checked against.
//!
//! # Byte layout
//!
//! Little-endian throughout. Strings are UTF-8.
//!
//! ```text
//! frame    = header [body]                      ; body absent when EMPTY is set
//! header   = "PTF" version:u8(=2) flags:u8 dirty:u8 seq:u32 cols:u16 rows:u16   ; 14 bytes
//! flags    : bit0 RESET  the viewer drops its rows and styles before applying the frame
//!            bit1 COLORS a colors section follows the cursor
//!            bit2 EMPTY  nothing changed since the previous frame; no body
//!            bit3 HELD   captured when a synchronized-output hold began (informational)
//! dirty    : 0 clean, 1 partial, 2 full: libghostty-vt's global dirty state for the update
//! body     = cursor [colors] scrollbar styles rowlist
//! cursor   = flags:u8 style:u8 x:u16 y:u16                                       ; 6 bytes
//!            flags bit0 visible, bit1 blinking, bit2 in viewport, bit3 on a wide tail,
//!            bit4 at a password prompt; style 0 bar, 1 block, 2 underline, 3 hollow block
//! colors   = background:rgb foreground:rgb hasCursor:u8 cursor:rgb palette:rgb*256  ; 778 bytes
//! rgb      = r:u8 g:u8 b:u8
//! scrollbar = total:u32 offset:u32 len:u32      ; rows of scrollback + active area, first
//!                                                ; viewport row, viewport rows    ; 12 bytes
//! styles   = count:u16 entry*count
//! entry    = id:u16 fg:color bg:color underline:color flags:u16                  ; 16 bytes
//! color    = tag:u8 r:u8 g:u8 b:u8        ; tag 0 default (rgb ignored), 1 rgb
//!            flags: libghostty-vt style flags (bold, italic, faint, blink, inverse,
//!            invisible, strikethrough, overline in bits 0-7; underline kind in bits 8-10)
//! rowlist  = count:u16(=rows) row*count   ; viewport order: the n-th row is at y = n
//! row      = id:u32 flags:u8 [selection] [cells]
//!            flags bit0: cells follow; bit1: a selection follows
//! selection = start:u16 end:u16           ; selected columns of this row, both included
//! cells    = count:u16(=cols) cell*count
//! cell     = wide:u8 style:u16 len:u8 text:u8*len
//!            wide 0 narrow, 1 wide (the next cell is its spacer tail), 2 spacer tail,
//!            3 spacer head (a wide character wrapped to the next row); len 0 is an empty cell
//! ```
//!
//! # Viewer rules
//!
//! - `seq` counts frames per viewer from 1; a frame whose `seq` is not the previous plus one
//!   is rejected unless RESET is set.
//! - Style id 0 is the default style and is never sent. Other ids stay valid until RESET.
//! - Row ids are Core's handles for libghostty-vt row identities, never reused while the
//!   viewer holds them. A row without cells must be held by the viewer; after applying a
//!   frame the viewer keeps only the rows of its row list.
//! - Selections are not held: every non-empty frame lists the selected columns of each row,
//!   and a row without a selection section has none.
//! - A grapheme longer than 255 UTF-8 bytes is cut at the last whole code point that fits.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

mod json;
mod screen;

pub use screen::Screen;

/// The three magic bytes every frame starts with.
pub const MAGIC: [u8; 3] = *b"PTF";
/// The format version this module reads and writes.
pub const VERSION: u8 = 2;
/// Size of the header, the whole of an empty frame.
pub const HEADER_BYTES: usize = 14;
/// Size of the colors section.
pub const COLORS_BYTES: usize = 3 + 3 + 1 + 3 + 256 * 3;
/// Size of the scrollbar section.
pub const SCROLLBAR_BYTES: usize = 12;
/// Longest cell text in bytes.
pub const MAX_CELL_TEXT_BYTES: usize = 255;

const FLAG_RESET: u8 = 1;
const FLAG_COLORS: u8 = 1 << 1;
const FLAG_EMPTY: u8 = 1 << 2;
const FLAG_HELD: u8 = 1 << 3;
const ROW_HAS_CELLS: u8 = 1;
const ROW_HAS_SELECTION: u8 = 1 << 1;

/// One frame. The JSON form (schema `TermFrame`) is for samples and diagnostics; the wire is
/// the byte layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermFrame")]
pub struct Frame {
    /// Per-viewer frame number, from 1.
    #[schemars(with = "u64")]
    pub seq: u32,
    /// The viewer drops its rows and styles first.
    pub reset: bool,
    /// Captured when a synchronized-output hold began.
    pub held: bool,
    /// libghostty-vt's global dirty state for the update that produced the frame.
    pub dirty: Dirty,
    /// Viewport width in cells.
    #[schemars(with = "u64")]
    pub cols: u16,
    /// Viewport height in cells.
    #[schemars(with = "u64")]
    pub rows: u16,
    /// What changed; `None` for an empty frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Body>,
}

/// The changes a non-empty frame carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermFrameBody")]
pub struct Body {
    /// The cursor, always present.
    pub cursor: Cursor,
    /// Colors, when they changed or on RESET.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<Colors>,
    /// The viewport's place in the scrollback.
    pub scrollbar: Scrollbar,
    /// Style table entries the viewer does not have yet.
    pub styles: Vec<StyleEntry>,
    /// The viewport, top to bottom; exactly `rows` entries.
    pub rows: Vec<Row>,
}

/// Global dirty state of the render state update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermDirty")]
pub enum Dirty {
    /// Nothing changed.
    Clean,
    /// Some rows changed.
    Partial,
    /// Everything must be redrawn.
    Full,
}

/// Cursor state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermCursor")]
pub struct Cursor {
    /// Visible according to the terminal modes.
    pub visible: bool,
    /// Should blink according to the terminal modes.
    pub blinking: bool,
    /// Inside the viewport; `x` and `y` are meaningful only then.
    pub in_viewport: bool,
    /// On the spacer tail of a wide character.
    pub wide_tail: bool,
    /// At a password prompt (the shell disabled echo).
    pub password_input: bool,
    /// Visual style.
    pub style: CursorStyle,
    /// Column in the viewport.
    #[schemars(with = "u64")]
    pub x: u16,
    /// Row in the viewport.
    #[schemars(with = "u64")]
    pub y: u16,
}

/// The viewport's place in the scrollback, in rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermScrollbar")]
pub struct Scrollbar {
    /// Rows of scrollback plus the active area.
    #[schemars(with = "u64")]
    pub total: u32,
    /// First viewport row, from the top of the scrollback.
    #[schemars(with = "u64")]
    pub offset: u32,
    /// Rows in the viewport.
    #[schemars(with = "u64")]
    pub len: u32,
}

/// Cursor shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermCursorStyle")]
pub enum CursorStyle {
    /// Vertical bar.
    Bar,
    /// Filled block.
    #[default]
    Block,
    /// Underline.
    Underline,
    /// Hollow block.
    BlockHollow,
}

/// An RGB color; `"#rrggbb"` in the JSON form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Rgb {
    /// Red.
    pub r: u8,
    /// Green.
    pub g: u8,
    /// Blue.
    pub b: u8,
}

/// Terminal colors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermColors")]
pub struct Colors {
    /// Default background.
    pub background: Rgb,
    /// Default foreground.
    pub foreground: Rgb,
    /// Cursor color set by the program, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Rgb>,
    /// The 256-color palette.
    #[serde(with = "json::palette")]
    #[schemars(with = "json::PaletteSchema")]
    pub palette: Box<[Rgb; 256]>,
}

/// A resolved cell style: palette indices are already turned into RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermStyle")]
pub struct Style {
    /// Foreground, or the default foreground.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<Rgb>,
    /// Background, or the default background.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<Rgb>,
    /// Underline color, or the foreground.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<Rgb>,
    /// libghostty-vt style flags (see the module documentation).
    #[schemars(with = "u64")]
    pub flags: u16,
}

/// A style table entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermStyleEntry")]
pub struct StyleEntry {
    /// Index the cells refer to; never 0.
    #[schemars(with = "u64")]
    pub id: u16,
    /// The style.
    pub style: Style,
}

/// One viewport row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermRow")]
pub struct Row {
    /// Core's row handle.
    #[schemars(with = "u64")]
    pub id: u32,
    /// Selected columns of this row, both included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Selection>,
    /// The cells, when the viewer does not hold this row's current content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<Cell>>,
}

/// The selected columns of a row, both included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermSelection")]
pub struct Selection {
    /// First selected column.
    #[schemars(with = "u64")]
    pub start: u16,
    /// Last selected column.
    #[schemars(with = "u64")]
    pub end: u16,
}

/// Width class of a cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermWide")]
pub enum Wide {
    /// One column.
    #[default]
    Narrow,
    /// Two columns; the next cell is its spacer tail.
    Wide,
    /// Second column of a wide character; has no text of its own.
    SpacerTail,
    /// Placeholder at the end of a row whose wide character wrapped to the next row.
    SpacerHead,
}

/// One cell.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "TermCell")]
pub struct Cell {
    /// Width class.
    pub wide: Wide,
    /// Style table id; 0 is the default style.
    #[schemars(with = "u64")]
    pub style: u16,
    /// The grapheme cluster; empty for an empty cell.
    pub text: String,
}

/// A frame that cannot be decoded or applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError {
    reason: String,
}

impl FrameError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid terminal frame: {}", self.reason)
    }
}

impl std::error::Error for FrameError {}

/// Encodes `frame`.
///
/// # Panics
///
/// When the frame breaks the format's own limits: a body whose row list is not `rows` long,
/// a row whose cell list is not `cols` long, or more than 65,535 style entries. The encoder in
/// `piarc-term` builds frames that respect them.
#[must_use]
pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + frame.body.as_ref().map_or(0, body_hint));
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    let mut flags = 0;
    if frame.reset {
        flags |= FLAG_RESET;
    }
    if frame.held {
        flags |= FLAG_HELD;
    }
    match &frame.body {
        None => flags |= FLAG_EMPTY,
        Some(body) if body.colors.is_some() => flags |= FLAG_COLORS,
        Some(_) => {}
    }
    out.push(flags);
    out.push(match frame.dirty {
        Dirty::Clean => 0,
        Dirty::Partial => 1,
        Dirty::Full => 2,
    });
    out.extend_from_slice(&frame.seq.to_le_bytes());
    out.extend_from_slice(&frame.cols.to_le_bytes());
    out.extend_from_slice(&frame.rows.to_le_bytes());
    if let Some(body) = &frame.body {
        assert_eq!(
            body.rows.len(),
            usize::from(frame.rows),
            "row list must cover the viewport"
        );
        encode_cursor(&mut out, &body.cursor);
        if let Some(colors) = &body.colors {
            encode_colors(&mut out, colors);
        }
        for value in [
            body.scrollbar.total,
            body.scrollbar.offset,
            body.scrollbar.len,
        ] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        let count = u16::try_from(body.styles.len()).expect("at most 65,535 style entries");
        out.extend_from_slice(&count.to_le_bytes());
        for entry in &body.styles {
            out.extend_from_slice(&entry.id.to_le_bytes());
            for color in [entry.style.fg, entry.style.bg, entry.style.underline] {
                encode_color(&mut out, color);
            }
            out.extend_from_slice(&entry.style.flags.to_le_bytes());
        }
        encode_rows(&mut out, frame, &body.rows);
    }
    out
}

fn encode_rows(out: &mut Vec<u8>, frame: &Frame, rows: &[Row]) {
    out.extend_from_slice(&frame.rows.to_le_bytes());
    for row in rows {
        out.extend_from_slice(&row.id.to_le_bytes());
        let flags = if row.cells.is_some() {
            ROW_HAS_CELLS
        } else {
            0
        } | if row.selection.is_some() {
            ROW_HAS_SELECTION
        } else {
            0
        };
        out.push(flags);
        if let Some(selection) = row.selection {
            out.extend_from_slice(&selection.start.to_le_bytes());
            out.extend_from_slice(&selection.end.to_le_bytes());
        }
        if let Some(cells) = &row.cells {
            assert_eq!(
                cells.len(),
                usize::from(frame.cols),
                "a row has `cols` cells"
            );
            out.extend_from_slice(&frame.cols.to_le_bytes());
            for cell in cells {
                encode_cell(out, cell);
            }
        }
    }
}

fn body_hint(body: &Body) -> usize {
    let cells: usize = body
        .rows
        .iter()
        .filter_map(|row| row.cells.as_ref())
        .map(|cells| 2 + cells.len() * 5)
        .sum();
    6 + COLORS_BYTES
        + SCROLLBAR_BYTES
        + 2
        + body.styles.len() * 16
        + 2
        + body.rows.len() * 9
        + cells
}

fn encode_cursor(out: &mut Vec<u8>, cursor: &Cursor) {
    let flags = u8::from(cursor.visible)
        | u8::from(cursor.blinking) << 1
        | u8::from(cursor.in_viewport) << 2
        | u8::from(cursor.wide_tail) << 3
        | u8::from(cursor.password_input) << 4;
    out.push(flags);
    out.push(match cursor.style {
        CursorStyle::Bar => 0,
        CursorStyle::Block => 1,
        CursorStyle::Underline => 2,
        CursorStyle::BlockHollow => 3,
    });
    out.extend_from_slice(&cursor.x.to_le_bytes());
    out.extend_from_slice(&cursor.y.to_le_bytes());
}

fn encode_rgb(out: &mut Vec<u8>, rgb: Rgb) {
    out.extend_from_slice(&[rgb.r, rgb.g, rgb.b]);
}

fn encode_colors(out: &mut Vec<u8>, colors: &Colors) {
    encode_rgb(out, colors.background);
    encode_rgb(out, colors.foreground);
    out.push(u8::from(colors.cursor.is_some()));
    encode_rgb(out, colors.cursor.unwrap_or_default());
    for rgb in colors.palette.iter() {
        encode_rgb(out, *rgb);
    }
}

fn encode_color(out: &mut Vec<u8>, color: Option<Rgb>) {
    match color {
        None => out.extend_from_slice(&[0, 0, 0, 0]),
        Some(rgb) => out.extend_from_slice(&[1, rgb.r, rgb.g, rgb.b]),
    }
}

fn encode_cell(out: &mut Vec<u8>, cell: &Cell) {
    out.push(match cell.wide {
        Wide::Narrow => 0,
        Wide::Wide => 1,
        Wide::SpacerTail => 2,
        Wide::SpacerHead => 3,
    });
    out.extend_from_slice(&cell.style.to_le_bytes());
    let text = truncate_text(&cell.text);
    out.push(u8::try_from(text.len()).expect("truncate_text keeps at most 255 bytes"));
    out.extend_from_slice(text.as_bytes());
}

/// The longest prefix of `text` of whole code points that fits [`MAX_CELL_TEXT_BYTES`].
#[must_use]
pub fn truncate_text(text: &str) -> &str {
    if text.len() <= MAX_CELL_TEXT_BYTES {
        return text;
    }
    let mut end = MAX_CELL_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Reads frames field by field, failing on truncation.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], FrameError> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| FrameError::new(format!("truncated at byte {}", self.at)))?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, FrameError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, FrameError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, FrameError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn rgb(&mut self) -> Result<Rgb, FrameError> {
        let b = self.take(3)?;
        Ok(Rgb {
            r: b[0],
            g: b[1],
            b: b[2],
        })
    }

    fn color(&mut self) -> Result<Option<Rgb>, FrameError> {
        let tag = self.u8()?;
        let rgb = self.rgb()?;
        match tag {
            0 => Ok(None),
            1 => Ok(Some(rgb)),
            other => Err(FrameError::new(format!("unknown color tag {other}"))),
        }
    }
}

/// Decodes one frame.
///
/// # Errors
///
/// [`FrameError`] for a wrong magic or version, a truncated frame, trailing bytes, unknown
/// enum values, invalid UTF-8, or a row or cell count that does not match the viewport.
pub fn decode(bytes: &[u8]) -> Result<Frame, FrameError> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(3)? != MAGIC {
        return Err(FrameError::new("bad magic"));
    }
    let version = r.u8()?;
    if version != VERSION {
        return Err(FrameError::new(format!("unsupported version {version}")));
    }
    let flags = r.u8()?;
    if flags & !(FLAG_RESET | FLAG_COLORS | FLAG_EMPTY | FLAG_HELD) != 0 {
        return Err(FrameError::new(format!("unknown flags {flags:#04x}")));
    }
    let dirty = match r.u8()? {
        0 => Dirty::Clean,
        1 => Dirty::Partial,
        2 => Dirty::Full,
        other => return Err(FrameError::new(format!("unknown dirty state {other}"))),
    };
    let seq = r.u32()?;
    let cols = r.u16()?;
    let rows = r.u16()?;
    let body = if flags & FLAG_EMPTY == 0 {
        Some(decode_body(&mut r, flags & FLAG_COLORS != 0, cols, rows)?)
    } else if flags & FLAG_COLORS != 0 {
        return Err(FrameError::new("an empty frame cannot carry colors"));
    } else {
        None
    };
    if r.at != bytes.len() {
        return Err(FrameError::new(format!(
            "{} trailing bytes",
            bytes.len() - r.at
        )));
    }
    Ok(Frame {
        seq,
        reset: flags & FLAG_RESET != 0,
        held: flags & FLAG_HELD != 0,
        dirty,
        cols,
        rows,
        body,
    })
}

fn decode_body(
    r: &mut Reader<'_>,
    has_colors: bool,
    cols: u16,
    rows: u16,
) -> Result<Body, FrameError> {
    let cursor = decode_cursor(r)?;
    let colors = if has_colors {
        let background = r.rgb()?;
        let foreground = r.rgb()?;
        let has_cursor = r.u8()? != 0;
        let cursor = r.rgb()?;
        let mut palette = Box::new([Rgb::default(); 256]);
        for slot in palette.iter_mut() {
            *slot = r.rgb()?;
        }
        Some(Colors {
            background,
            foreground,
            cursor: has_cursor.then_some(cursor),
            palette,
        })
    } else {
        None
    };
    let scrollbar = Scrollbar {
        total: r.u32()?,
        offset: r.u32()?,
        len: r.u32()?,
    };
    let style_count = r.u16()?;
    let mut styles = Vec::with_capacity(usize::from(style_count));
    for _ in 0..style_count {
        let id = r.u16()?;
        if id == 0 {
            return Err(FrameError::new(
                "style id 0 is reserved for the default style",
            ));
        }
        let fg = r.color()?;
        let bg = r.color()?;
        let underline = r.color()?;
        let flags = r.u16()?;
        styles.push(StyleEntry {
            id,
            style: Style {
                fg,
                bg,
                underline,
                flags,
            },
        });
    }
    let list = decode_rows(r, cols, rows)?;
    Ok(Body {
        cursor,
        colors,
        scrollbar,
        styles,
        rows: list,
    })
}

fn decode_rows(r: &mut Reader<'_>, cols: u16, rows: u16) -> Result<Vec<Row>, FrameError> {
    let row_count = r.u16()?;
    if row_count != rows {
        return Err(FrameError::new(format!(
            "row list has {row_count} rows, the viewport {rows}"
        )));
    }
    let mut list = Vec::with_capacity(usize::from(rows));
    for _ in 0..rows {
        let id = r.u32()?;
        let flags = r.u8()?;
        if flags & !(ROW_HAS_CELLS | ROW_HAS_SELECTION) != 0 {
            return Err(FrameError::new(format!("unknown row flags {flags:#04x}")));
        }
        let selection = if flags & ROW_HAS_SELECTION != 0 {
            let start = r.u16()?;
            let end = r.u16()?;
            if start > end || end >= cols {
                return Err(FrameError::new(format!(
                    "selection {start}..={end} outside {cols} columns"
                )));
            }
            Some(Selection { start, end })
        } else {
            None
        };
        let cells = if flags & ROW_HAS_CELLS != 0 {
            Some(decode_cells(r, cols)?)
        } else {
            None
        };
        list.push(Row {
            id,
            selection,
            cells,
        });
    }
    Ok(list)
}

fn decode_cursor(r: &mut Reader<'_>) -> Result<Cursor, FrameError> {
    let flags = r.u8()?;
    let style = match r.u8()? {
        0 => CursorStyle::Bar,
        1 => CursorStyle::Block,
        2 => CursorStyle::Underline,
        3 => CursorStyle::BlockHollow,
        other => return Err(FrameError::new(format!("unknown cursor style {other}"))),
    };
    let x = r.u16()?;
    let y = r.u16()?;
    Ok(Cursor {
        visible: flags & 1 != 0,
        blinking: flags & 2 != 0,
        in_viewport: flags & 4 != 0,
        wide_tail: flags & 8 != 0,
        password_input: flags & 16 != 0,
        style,
        x,
        y,
    })
}

fn decode_cells(r: &mut Reader<'_>, cols: u16) -> Result<Vec<Cell>, FrameError> {
    let count = r.u16()?;
    if count != cols {
        return Err(FrameError::new(format!(
            "a row has {count} cells, the viewport {cols} columns"
        )));
    }
    let mut cells = Vec::with_capacity(usize::from(count));
    for _ in 0..count {
        let wide = match r.u8()? {
            0 => Wide::Narrow,
            1 => Wide::Wide,
            2 => Wide::SpacerTail,
            3 => Wide::SpacerHead,
            other => return Err(FrameError::new(format!("unknown width class {other}"))),
        };
        let style = r.u16()?;
        let len = r.u8()?;
        let text = std::str::from_utf8(r.take(usize::from(len))?)
            .map_err(|_| FrameError::new("cell text is not UTF-8"))?;
        cells.push(Cell {
            wide,
            style,
            text: text.to_owned(),
        });
    }
    Ok(cells)
}

#[cfg(test)]
mod tests;
