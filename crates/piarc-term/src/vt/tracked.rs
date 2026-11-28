//! [`TrackedPoint`]: a cell that libghostty-vt keeps following as the content scrolls, reflows
//! or is pruned from the scrollback (its "tracked grid reference").

use std::ptr::{self, NonNull};

use piarc_ghostty_sys as sys;

use super::terminal::Terminal;

/// A position in the terminal's whole screen (scrollback included): column `x`, row `y` from
/// the top of the scrollback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScreenPoint {
    /// Row from the top of the scrollback (the first, oldest row is 0).
    pub y: u32,
    /// Column.
    pub x: u16,
}

/// A tracked cell. Read it and drop it only while the terminal that created it is exclusively
/// borrowed (it lives next to the terminal, behind the same lock); dropping it after the
/// terminal is freed is allowed.
#[derive(Debug)]
pub struct TrackedPoint {
    raw: NonNull<sys::GhosttyTrackedGridRefImpl>,
}

// SAFETY: the handle has no thread affinity; every use goes through `&mut Terminal` (or the
// terminal's callback), so it is never used by two threads at once.
unsafe impl Send for TrackedPoint {}

impl TrackedPoint {
    /// Tracks the cursor's cell of `terminal`.
    ///
    /// # Safety
    ///
    /// `terminal` must be a live terminal that only the calling thread uses during the call
    /// (a callback of it, or code holding `&mut Terminal`).
    pub(super) unsafe fn at_cursor(terminal: sys::GhosttyTerminal) -> Option<Self> {
        let mut x: u16 = 0;
        let mut y: u16 = 0;
        // SAFETY: CURSOR_X and CURSOR_Y write a uint16_t; the terminal is live (contract).
        let read = unsafe {
            sys::ghostty_terminal_get(
                terminal,
                sys::GHOSTTY_TERMINAL_DATA_CURSOR_X,
                (&raw mut x).cast(),
            ) == sys::GHOSTTY_SUCCESS
                && sys::ghostty_terminal_get(
                    terminal,
                    sys::GHOSTTY_TERMINAL_DATA_CURSOR_Y,
                    (&raw mut y).cast(),
                ) == sys::GHOSTTY_SUCCESS
        };
        if !read {
            return None;
        }
        let point = sys::GhosttyPoint {
            tag: sys::GHOSTTY_POINT_TAG_ACTIVE,
            value: sys::GhosttyPointValue {
                coordinate: sys::GhosttyPointCoordinate { x, y: u32::from(y) },
            },
        };
        let mut raw: sys::GhosttyTrackedGridRef = ptr::null_mut();
        // SAFETY: the terminal is live and used only by this thread (contract); `raw` is a
        // valid out pointer. Tracking does not write VT input.
        let result = unsafe { sys::ghostty_terminal_grid_ref_track(terminal, point, &raw mut raw) };
        (result == sys::GHOSTTY_SUCCESS)
            .then(|| NonNull::new(raw).map(|raw| Self { raw }))
            .flatten()
    }

    /// Where the cell is now in screen coordinates; `None` once it left the scrollback (or
    /// belongs to the other screen and cannot be expressed in this one).
    pub fn point(&self, _terminal: &mut Terminal) -> Option<ScreenPoint> {
        let mut out = sys::GhosttyPointCoordinate { x: 0, y: 0 };
        // SAFETY: the handle is live; the exclusive borrow of the terminal serializes the read
        // with every change to it.
        let result = unsafe {
            sys::ghostty_tracked_grid_ref_point(
                self.raw.as_ptr(),
                sys::GHOSTTY_POINT_TAG_SCREEN,
                &raw mut out,
            )
        };
        (result == sys::GHOSTTY_SUCCESS).then_some(ScreenPoint { y: out.y, x: out.x })
    }
}

impl Drop for TrackedPoint {
    fn drop(&mut self) {
        // SAFETY: the handle came from grid_ref_track and is not used again. Owners keep it
        // behind the terminal's lock, so freeing it is serialized with the terminal.
        unsafe { sys::ghostty_tracked_grid_ref_free(self.raw.as_ptr()) };
    }
}
