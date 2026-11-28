//! Selections, viewport scrolling and links: what a viewer of the terminal does with its
//! pointer (T34). libghostty-vt's selection gesture turns presses, drags and releases into a
//! selection (cell, word on a double click, line on a triple click); the terminal keeps it as
//! its own tracked state, so it follows the content as output scrolls it, and frames carry it
//! back as each row's selected columns. Text is copied with the formatter over that selection.
//!
//! Every function here takes `&mut Terminal`: the caller holds the terminal's lock (the
//! session's writer thread for pointer events and scrolling, the blocking pool for reads).

use std::ptr::{self, NonNull};
use std::time::Duration;

use piarc_ghostty_sys as sys;

use super::check;
use super::formatter::{self, grid_ref};
use super::terminal::Terminal;
use crate::error::{Error, Result};

/// Where to move the viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollTo {
    /// The top of the scrollback.
    Top,
    /// The active area (where the program writes).
    Bottom,
    /// By `n` rows; up is negative.
    Delta(isize),
    /// So that row `n` (from the top of the scrollback, the scrollbar's row space) is the
    /// first visible row.
    Row(usize),
}

/// A hyperlink (OSC 8) on a viewport row: its target and the columns it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// The URI as the program sent it.
    pub uri: String,
    /// Viewport row.
    pub row: u16,
    /// First column.
    pub start: u16,
    /// Last column (included).
    pub end: u16,
}

/// The pointer's place in a gesture event, in surface pixels (the terminal's drawing area,
/// top-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerAt {
    /// Horizontal position.
    pub x: f32,
    /// Vertical position.
    pub y: f32,
}

/// The surface geometry gestures map pixels with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceGeometry {
    /// Cell width in pixels.
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
}

/// How far apart presses may be to count as one double or triple click. The viewer decides
/// what a repeated click is (the platform's setting, `MouseEvent.detail`); the gesture gets
/// press times that are either well inside or well outside this interval.
const REPEAT_INTERVAL: Duration = Duration::from_secs(1);

/// The state of one pointer's selection gesture over a terminal. Free it with
/// [`SelectionGesture::free`] while the terminal is still borrowed; dropping it without that
/// (the terminal is gone) only frees the handles.
pub struct SelectionGesture {
    gesture: NonNull<sys::GhosttySelectionGestureImpl>,
    press: NonNull<sys::GhosttySelectionGestureEventImpl>,
    drag: NonNull<sys::GhosttySelectionGestureEventImpl>,
    release: NonNull<sys::GhosttySelectionGestureEventImpl>,
    tick: NonNull<sys::GhosttySelectionGestureEventImpl>,
    /// Synthetic press clock (nanoseconds) that encodes the viewer's click count.
    clock: u64,
    /// A Shift press extended the selection: drags move its end, not a new gesture.
    extending: bool,
    freed: bool,
}

// SAFETY: the handles have no thread affinity; every call takes `&mut self` and a
// `&mut Terminal`, so they are never used by two threads at once.
unsafe impl Send for SelectionGesture {}

fn event(
    kind: sys::GhosttySelectionGestureEventType,
) -> Result<NonNull<sys::GhosttySelectionGestureEventImpl>> {
    let mut raw: sys::GhosttySelectionGestureEvent = ptr::null_mut();
    // SAFETY: null allocator = default; `raw` is a valid out pointer; `kind` is a known type.
    check("ghostty_selection_gesture_event_new", unsafe {
        sys::ghostty_selection_gesture_event_new(ptr::null(), &raw mut raw, kind)
    })?;
    NonNull::new(raw).ok_or(Error::Vt {
        call: "ghostty_selection_gesture_event_new",
        code: sys::GHOSTTY_INVALID_VALUE,
    })
}

fn set(
    event: NonNull<sys::GhosttySelectionGestureEventImpl>,
    option: sys::GhosttySelectionGestureEventOption,
    value: *const std::ffi::c_void,
) -> Result<()> {
    // SAFETY: the event is live; `value` points to the type `option` documents and lives for
    // the call (the event copies it).
    check("ghostty_selection_gesture_event_set", unsafe {
        sys::ghostty_selection_gesture_event_set(event.as_ptr(), option, value)
    })
}

fn empty_selection() -> sys::GhosttySelection {
    let none = sys::GhosttyGridRef {
        node: ptr::null_mut(),
        x: 0,
        y: 0,
    };
    sys::GhosttySelection {
        start: none,
        end: none,
        rectangle: false,
    }
}

impl SelectionGesture {
    /// Creates a gesture with its four reusable events.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when an allocation fails.
    pub fn new() -> Result<Self> {
        let mut raw: sys::GhosttySelectionGesture = ptr::null_mut();
        // SAFETY: null allocator = default; `raw` is a valid out pointer.
        check("ghostty_selection_gesture_new", unsafe {
            sys::ghostty_selection_gesture_new(ptr::null(), &raw mut raw)
        })?;
        let gesture = NonNull::new(raw).ok_or(Error::Vt {
            call: "ghostty_selection_gesture_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        // Built one by one so a failure frees what exists (Drop of a partial value is not run).
        let mut events = Vec::with_capacity(4);
        for kind in [
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_AUTOSCROLL_TICK,
        ] {
            match event(kind) {
                Ok(event) => events.push(event),
                Err(error) => {
                    // SAFETY: created above and not used again; no terminal was ever used.
                    unsafe {
                        for event in events {
                            sys::ghostty_selection_gesture_event_free(event.as_ptr());
                        }
                        sys::ghostty_selection_gesture_free(gesture.as_ptr(), ptr::null_mut());
                    }
                    return Err(error);
                }
            }
        }
        let [press, drag, release, tick] = <[_; 4]>::try_from(events).map_err(|_| Error::Vt {
            call: "ghostty_selection_gesture_event_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let interval = u64::try_from(REPEAT_INTERVAL.as_nanos()).unwrap_or(u64::MAX);
        // The viewer already judged the distance between clicks.
        let distance = f64::from(u32::MAX);
        let gesture = Self {
            gesture,
            press,
            drag,
            release,
            tick,
            clock: 0,
            extending: false,
            freed: false,
        };
        set(
            press,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_INTERVAL_NS,
            (&raw const interval).cast(),
        )?;
        set(
            press,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_DISTANCE,
            (&raw const distance).cast(),
        )?;
        Ok(gesture)
    }

    /// A left-button press at `at`, the viewer's `clicks`-th in a row (1 single, 2 double,
    /// 3 triple). Clears the selection, then selects the word or line under the pointer for a
    /// double or triple click. With `extend` (Shift held) it moves the end of the current
    /// selection to the pointer instead.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn press(
        &mut self,
        terminal: &mut Terminal,
        geometry: SurfaceGeometry,
        at: PointerAt,
        clicks: u8,
        extend: bool,
    ) -> Result<()> {
        let reference = cell_ref(terminal, geometry, at)?;
        if extend && let Some(mut current) = current_selection(terminal)? {
            current.end = reference;
            self.extending = true;
            return install(terminal, Some(&current));
        }
        self.extending = false;
        // Repeated clicks land 1 ns apart (inside the repeat interval), new ones far apart.
        self.clock = if clicks > 1 {
            self.clock.saturating_add(1)
        } else {
            self.clock
                .saturating_add(u64::try_from(REPEAT_INTERVAL.as_nanos() * 10).unwrap_or(u64::MAX))
        };
        let time = self.clock;
        let position = sys::GhosttySurfacePosition {
            x: f64::from(at.x),
            y: f64::from(at.y),
        };
        set(
            self.press,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
            (&raw const reference).cast(),
        )?;
        set(
            self.press,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
            (&raw const position).cast(),
        )?;
        set(
            self.press,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS,
            (&raw const time).cast(),
        )?;
        install(terminal, None)?;
        let selection = self.apply(terminal, self.press)?;
        if selection.is_some() {
            install(terminal, selection.as_ref())?;
        }
        Ok(())
    }

    /// The pointer moved with the button held: extends the selection to `at` (by cells, words
    /// or lines, as the press chose). When the pointer is above or below the surface the
    /// viewport scrolls one row toward it per call; the viewer repeats the event while it stays
    /// there.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn drag(
        &mut self,
        terminal: &mut Terminal,
        geometry: SurfaceGeometry,
        at: PointerAt,
    ) -> Result<()> {
        let reference = cell_ref(terminal, geometry, at)?;
        if self.extending {
            if let Some(mut current) = current_selection(terminal)? {
                current.end = reference;
                install(terminal, Some(&current))?;
            }
            return Ok(());
        }
        let surface = gesture_geometry(terminal, geometry);
        let position = sys::GhosttySurfacePosition {
            x: f64::from(at.x),
            y: f64::from(at.y),
        };
        set(
            self.drag,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
            (&raw const reference).cast(),
        )?;
        set(
            self.drag,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
            (&raw const position).cast(),
        )?;
        set(
            self.drag,
            sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY,
            (&raw const surface).cast(),
        )?;
        if let Some(selection) = self.apply(terminal, self.drag)? {
            install(terminal, Some(&selection))?;
        }
        if self.autoscroll(terminal) {
            let viewport = viewport_cell(terminal, geometry, at);
            set(
                self.tick,
                sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_VIEWPORT,
                (&raw const viewport).cast(),
            )?;
            set(
                self.tick,
                sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY,
                (&raw const surface).cast(),
            )?;
            set(
                self.tick,
                sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
                (&raw const position).cast(),
            )?;
            if let Some(selection) = self.apply(terminal, self.tick)? {
                install(terminal, Some(&selection))?;
            }
        }
        Ok(())
    }

    /// The button went up.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn release(
        &mut self,
        terminal: &mut Terminal,
        geometry: SurfaceGeometry,
        at: PointerAt,
    ) -> Result<()> {
        self.extending = false;
        match cell_ref(terminal, geometry, at) {
            Ok(reference) => set(
                self.release,
                sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
                (&raw const reference).cast(),
            )?,
            Err(_) => set(
                self.release,
                sys::GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
                ptr::null(),
            )?,
        }
        // A release produces no selection (NO_VALUE); it only ends the click sequence's drag.
        self.apply(terminal, self.release).map(|_| ())
    }

    /// Whether the active drag asks to scroll the viewport.
    fn autoscroll(&mut self, terminal: &mut Terminal) -> bool {
        let mut direction: sys::GhosttySelectionGestureAutoscroll =
            sys::GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE;
        // SAFETY: AUTOSCROLL writes a GhosttySelectionGestureAutoscroll; both handles are live
        // and exclusively borrowed.
        let code = unsafe {
            sys::ghostty_selection_gesture_get(
                self.gesture.as_ptr(),
                terminal.raw(),
                sys::GHOSTTY_SELECTION_GESTURE_DATA_AUTOSCROLL,
                (&raw mut direction).cast(),
            )
        };
        code == sys::GHOSTTY_SUCCESS && direction != sys::GHOSTTY_SELECTION_GESTURE_AUTOSCROLL_NONE
    }

    /// Applies `event`; the selection it produced, if any.
    fn apply(
        &mut self,
        terminal: &mut Terminal,
        event: NonNull<sys::GhosttySelectionGestureEventImpl>,
    ) -> Result<Option<sys::GhosttySelection>> {
        let mut selection = empty_selection();
        // SAFETY: gesture, terminal and event are live and exclusively borrowed; the event's
        // grid reference was made from this terminal with no change since.
        let code = unsafe {
            sys::ghostty_selection_gesture_event(
                self.gesture.as_ptr(),
                terminal.raw(),
                event.as_ptr(),
                &raw mut selection,
            )
        };
        if code == sys::GHOSTTY_NO_VALUE {
            return Ok(None);
        }
        check("ghostty_selection_gesture_event", code)?;
        Ok(Some(selection))
    }

    /// Frees the gesture, releasing what it tracks in `terminal`.
    pub fn free(mut self, terminal: &mut Terminal) {
        self.release_handles(terminal.raw());
    }

    fn release_handles(&mut self, terminal: sys::GhosttyTerminal) {
        if self.freed {
            return;
        }
        self.freed = true;
        // SAFETY: the handles came from their `_new` functions and are not used again; the
        // terminal is either live and borrowed by the caller, or null (already freed).
        unsafe {
            for event in [self.press, self.drag, self.release, self.tick] {
                sys::ghostty_selection_gesture_event_free(event.as_ptr());
            }
            sys::ghostty_selection_gesture_free(self.gesture.as_ptr(), terminal);
        }
    }
}

impl Drop for SelectionGesture {
    fn drop(&mut self) {
        // Without a terminal: its page storage already released what the gesture tracked
        // (the header's contract for a freed terminal).
        self.release_handles(ptr::null_mut());
    }
}

/// The viewport cell under `at`, clamped to the grid.
fn viewport_cell(
    terminal: &Terminal,
    geometry: SurfaceGeometry,
    at: PointerAt,
) -> sys::GhosttyPointCoordinate {
    let cell = |position: f32, size: u32, count: u16| -> u32 {
        let index = (f64::from(position.max(0.0)) / f64::from(size.max(1))).floor();
        // Clamped into 0..count, so the cast cannot truncate.
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped to the grid before the cast"
        )]
        let index = index.min(f64::from(count.saturating_sub(1))) as u32;
        index
    };
    sys::GhosttyPointCoordinate {
        x: u16::try_from(cell(at.x, geometry.cell_width, terminal.cols())).unwrap_or(0),
        y: cell(at.y, geometry.cell_height, terminal.rows()),
    }
}

fn cell_ref(
    terminal: &mut Terminal,
    geometry: SurfaceGeometry,
    at: PointerAt,
) -> Result<sys::GhosttyGridRef> {
    let cell = viewport_cell(terminal, geometry, at);
    grid_ref(
        terminal.raw(),
        sys::GHOSTTY_POINT_TAG_VIEWPORT,
        cell.x,
        cell.y,
    )
}

fn gesture_geometry(
    terminal: &Terminal,
    geometry: SurfaceGeometry,
) -> sys::GhosttySelectionGestureGeometry {
    sys::GhosttySelectionGestureGeometry {
        columns: u32::from(terminal.cols()).max(1),
        cell_width: geometry.cell_width.max(1),
        padding_left: 0,
        screen_height: (u32::from(terminal.rows()) * geometry.cell_height).max(1),
    }
}

/// The terminal's current selection, if any.
fn current_selection(terminal: &mut Terminal) -> Result<Option<sys::GhosttySelection>> {
    let mut selection = empty_selection();
    // SAFETY: SELECTION writes a GhosttySelection snapshot; the terminal is live and borrowed.
    let code = unsafe {
        sys::ghostty_terminal_get(
            terminal.raw(),
            sys::GHOSTTY_TERMINAL_DATA_SELECTION,
            (&raw mut selection).cast(),
        )
    };
    if code == sys::GHOSTTY_NO_VALUE {
        return Ok(None);
    }
    check("ghostty_terminal_get(SELECTION)", code)?;
    Ok(Some(selection))
}

/// Makes `selection` the terminal's selection (it copies it into tracked state); `None`
/// clears it.
fn install(terminal: &mut Terminal, selection: Option<&sys::GhosttySelection>) -> Result<()> {
    let value = selection.map_or(ptr::null(), |s| ptr::from_ref(s).cast());
    // SAFETY: OPT_SELECTION takes a GhosttySelection* whose references are fresh snapshots of
    // this terminal (no change since they were made), or null to clear.
    check("ghostty_terminal_set(SELECTION)", unsafe {
        sys::ghostty_terminal_set(terminal.raw(), sys::GHOSTTY_TERMINAL_OPT_SELECTION, value)
    })
}

/// Clears the terminal's selection.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn clear_selection(terminal: &mut Terminal) -> Result<()> {
    install(terminal, None)
}

/// Whether the terminal has a selection.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn has_selection(terminal: &mut Terminal) -> Result<bool> {
    Ok(current_selection(terminal)?.is_some())
}

/// The selected text as plain text (wrapped rows joined, trailing spaces trimmed); empty when
/// nothing is selected.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn selection_text(terminal: &mut Terminal) -> Result<String> {
    match current_selection(terminal)? {
        None => Ok(String::new()),
        Some(selection) => formatter::selected_text(terminal, &selection),
    }
}

/// Moves the viewport.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn scroll_viewport(terminal: &mut Terminal, to: ScrollTo) -> Result<()> {
    let (tag, value) = match to {
        ScrollTo::Top => (
            sys::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_TOP,
            sys::GhosttyTerminalScrollViewportValue { delta: 0 },
        ),
        ScrollTo::Bottom => (
            sys::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM,
            sys::GhosttyTerminalScrollViewportValue { delta: 0 },
        ),
        ScrollTo::Delta(delta) => (
            sys::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA,
            sys::GhosttyTerminalScrollViewportValue { delta },
        ),
        ScrollTo::Row(row) => (
            sys::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_ROW,
            sys::GhosttyTerminalScrollViewportValue { row },
        ),
    };
    // SAFETY: the terminal is live and borrowed; the tag matches the union field set above.
    check("ghostty_terminal_scroll_viewport", unsafe {
        sys::ghostty_terminal_scroll_viewport(
            terminal.raw(),
            sys::GhosttyTerminalScrollViewport { tag, value },
        )
    })
}

/// The OSC 8 hyperlink at viewport cell (`col`, `row`), with the run of cells on that row that
/// carry the same URI; `None` when the cell has none.
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn link_at(terminal: &mut Terminal, col: u16, row: u16) -> Result<Option<Link>> {
    if col >= terminal.cols() || row >= terminal.rows() {
        return Ok(None);
    }
    let raw = terminal.raw();
    let uri_at = |x: u16| -> Result<Vec<u8>> {
        let reference = grid_ref(raw, sys::GHOSTTY_POINT_TAG_VIEWPORT, x, u32::from(row))?;
        hyperlink(&reference)
    };
    let uri = uri_at(col)?;
    if uri.is_empty() {
        return Ok(None);
    }
    let mut start = col;
    while start > 0 && uri_at(start - 1)? == uri {
        start -= 1;
    }
    let mut end = col;
    while end + 1 < terminal.cols() && uri_at(end + 1)? == uri {
        end += 1;
    }
    Ok(Some(Link {
        uri: String::from_utf8_lossy(&uri).into_owned(),
        row,
        start,
        end,
    }))
}

/// The hyperlink URI bytes of a cell; empty for none.
fn hyperlink(reference: &sys::GhosttyGridRef) -> Result<Vec<u8>> {
    let mut len = 0usize;
    // SAFETY: a null buffer with length 0 asks for the size; the reference is a fresh snapshot.
    let code = unsafe {
        sys::ghostty_grid_ref_hyperlink_uri(
            ptr::from_ref(reference),
            ptr::null_mut(),
            0,
            &raw mut len,
        )
    };
    if code == sys::GHOSTTY_SUCCESS {
        return Ok(Vec::new());
    }
    if code != sys::GHOSTTY_OUT_OF_SPACE {
        check("ghostty_grid_ref_hyperlink_uri", code)?;
    }
    let mut buffer = vec![0u8; len];
    // SAFETY: the buffer is writable for `len` bytes, the size the library asked for.
    check("ghostty_grid_ref_hyperlink_uri", unsafe {
        sys::ghostty_grid_ref_hyperlink_uri(
            ptr::from_ref(reference),
            buffer.as_mut_ptr(),
            buffer.len(),
            &raw mut len,
        )
    })?;
    buffer.truncate(len);
    Ok(buffer)
}
