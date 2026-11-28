//! Searching the scrollback and the active area with libghostty-vt's stepped search (its
//! search guide): the terminal's lock is held only while the search is created, fed, read and
//! freed; the matching itself (`tick`) runs on the caller's thread without it, so the IO thread
//! keeps writing output meanwhile.

use std::ptr::{self, NonNull};
use std::sync::{Mutex, MutexGuard, PoisonError};

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use super::tracked::ScreenPoint;
use crate::error::{Error, Result};

/// One match: its first and last cell, in screen coordinates at the time of the search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchMatch {
    /// First cell.
    pub start: ScreenPoint,
    /// Last cell.
    pub end: ScreenPoint,
}

/// Counters of a search, for tests and measurements.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchStats {
    /// `tick` calls (work without the terminal).
    pub ticks: u64,
    /// `feed` calls (each holds the terminal briefly).
    pub feeds: u64,
}

fn lock(terminal: &Mutex<Terminal>) -> MutexGuard<'_, Terminal> {
    terminal.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The search handle; freed under the terminal's lock (its Drop takes it).
struct Search<'m> {
    raw: NonNull<sys::GhosttySearchImpl>,
    terminal: &'m Mutex<Terminal>,
}

impl Drop for Search<'_> {
    fn drop(&mut self) {
        let _terminal = lock(self.terminal);
        // SAFETY: the handle came from search_new and is not used again; freeing releases
        // state it tracks in the terminal, so it runs under the terminal's lock.
        unsafe { sys::ghostty_search_free(self.raw.as_ptr()) };
    }
}

/// Finds every occurrence of `needle` (byte-exact, ASCII letters case-insensitive) in the
/// active screen and its scrollback, newest first. `cancelled` is polled between steps.
///
/// # Errors
///
/// [`Error::InvalidArgument`] for an empty needle; [`Error::Vt`] when libghostty-vt fails;
/// [`Error::Cancelled`] when `cancelled` turned true.
pub fn search(
    terminal: &Mutex<Terminal>,
    needle: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<SearchMatch>, SearchStats)> {
    if needle.is_empty() {
        return Err(Error::InvalidArgument {
            field: "query",
            reason: "must not be empty".into(),
        });
    }
    let raw = {
        let mut guard = lock(terminal);
        let mut raw: sys::GhosttySearch = ptr::null_mut();
        // SAFETY: the terminal is live and locked; `raw` is a valid out pointer.
        check("ghostty_search_new", unsafe {
            sys::ghostty_search_new(ptr::null(), &raw mut raw, guard.raw())
        })?;
        let raw = NonNull::new(raw).ok_or(Error::Vt {
            call: "ghostty_search_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let text = sys::GhosttyString {
            ptr: needle.as_ptr(),
            len: needle.len(),
        };
        // SAFETY: NEEDLE copies the string; it touches the terminal, which is locked.
        let set = check("ghostty_search_set(NEEDLE)", unsafe {
            sys::ghostty_search_set(
                raw.as_ptr(),
                sys::GHOSTTY_SEARCH_OPT_NEEDLE,
                (&raw const text).cast(),
            )
        });
        if let Err(error) = set {
            // SAFETY: created above and not used again; the terminal is still locked.
            unsafe { sys::ghostty_search_free(raw.as_ptr()) };
            return Err(error);
        }
        raw
    };
    // From here on the handle is freed by Search's Drop, which takes the lock itself: never
    // let it drop while a guard of this function is alive.
    let search = Search { raw, terminal };
    let mut stats = SearchStats::default();
    loop {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        let mut status: sys::GhosttySearchStatus = sys::GHOSTTY_SEARCH_STATUS_RUNNING;
        // SAFETY: tick works on data the search copied and never reads the terminal, so it
        // runs without the lock while the IO thread writes.
        check("ghostty_search_tick", unsafe {
            sys::ghostty_search_tick(search.raw.as_ptr(), &raw mut status)
        })?;
        stats.ticks += 1;
        match status {
            sys::GHOSTTY_SEARCH_STATUS_COMPLETE => break,
            sys::GHOSTTY_SEARCH_STATUS_FEED_REQUIRED => {
                let _guard = lock(terminal);
                // SAFETY: feed reads the terminal for a bounded amount of work; locked.
                check("ghostty_search_feed", unsafe {
                    sys::ghostty_search_feed(search.raw.as_ptr())
                })?;
                stats.feeds += 1;
            }
            _ => {}
        }
    }
    let matches = {
        let mut guard = lock(terminal);
        read_matches(&search, &mut guard)
    };
    Ok((matches?, stats))
}

/// The matches, converted to screen coordinates while the terminal is locked (the match grid
/// references are only valid until the next change to it).
fn read_matches(search: &Search<'_>, terminal: &mut Terminal) -> Result<Vec<SearchMatch>> {
    let empty = sys::GhosttySelection {
        start: sys::GhosttyGridRef {
            node: ptr::null_mut(),
            x: 0,
            y: 0,
        },
        end: sys::GhosttyGridRef {
            node: ptr::null_mut(),
            x: 0,
            y: 0,
        },
        rectangle: false,
    };
    let mut selections: Vec<sys::GhosttySelection> = Vec::new();
    loop {
        let mut buffer = sys::GhosttySelectionBuffer {
            ptr: if selections.is_empty() {
                ptr::null_mut()
            } else {
                selections.as_mut_ptr()
            },
            cap: selections.len(),
            len: 0,
        };
        // SAFETY: MATCHES fills a GhosttySelectionBuffer; `ptr` is writable for `cap` entries
        // (or null with cap 0 to ask for the size). It never reads the terminal.
        let code = unsafe {
            sys::ghostty_search_get(
                search.raw.as_ptr(),
                sys::GHOSTTY_SEARCH_DATA_MATCHES,
                (&raw mut buffer).cast(),
            )
        };
        if code == sys::GHOSTTY_OUT_OF_SPACE && buffer.len > selections.len() {
            selections.resize(buffer.len, empty);
            continue;
        }
        check("ghostty_search_get(MATCHES)", code)?;
        selections.truncate(buffer.len);
        break;
    }
    let raw = terminal.raw();
    selections
        .iter()
        .filter_map(|selection| {
            let start = screen_point(raw, &selection.start).transpose()?;
            let end = screen_point(raw, &selection.end).transpose()?;
            Some(start.and_then(|start| end.map(|end| SearchMatch { start, end })))
        })
        .collect()
}

/// A grid reference in screen coordinates; `None` when it is no longer on this screen.
fn screen_point(
    terminal: sys::GhosttyTerminal,
    grid: &sys::GhosttyGridRef,
) -> Result<Option<ScreenPoint>> {
    let mut out = sys::GhosttyPointCoordinate { x: 0, y: 0 };
    // SAFETY: the terminal is live and locked by the caller; the reference is valid until the
    // next change to it.
    let code = unsafe {
        sys::ghostty_terminal_point_from_grid_ref(
            terminal,
            ptr::from_ref(grid),
            sys::GHOSTTY_POINT_TAG_SCREEN,
            &raw mut out,
        )
    };
    if code == sys::GHOSTTY_NO_VALUE {
        return Ok(None);
    }
    check("ghostty_terminal_point_from_grid_ref", code)?;
    Ok(Some(ScreenPoint { y: out.y, x: out.x }))
}
