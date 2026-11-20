//! The safe wrapper over libghostty-vt (`piarc-ghostty-sys`): only what PiArc uses — the
//! terminal with its effects, the render state, the key and mouse encoders, focus reports and
//! paste, the formatter (plain text and VT), tracked cells, search and snapshots.
//!
//! This module and the `-sys` crate are the only places with `unsafe`; every block states why
//! it is sound. The wrapper upholds libghostty-vt's threading rules (its "Threads"
//! convention) through Rust's ownership:
//!
//! - Every handle type is `Send` but not `Sync`, and every call that touches a handle takes
//!   `&mut self` or a `&mut Terminal`, so no handle (or a handle borrowed from it) is used by
//!   two threads at once. Callers share a [`Terminal`] behind a mutex.
//! - Callbacks run on the thread of the `vt_write`, `resize` or `paste` call that triggered
//!   them. They only append to the terminal's effects record (capture a render state when a
//!   synchronized-output hold begins, track the cursor cell of an OSC 133 step, answer a
//!   clipboard request), never write VT input to the terminal, never block.
//! - Handles that live inside the terminal's state ([`TrackedPoint`], a search) are used and
//!   freed only while the terminal is exclusively borrowed or locked.
//! - A render state needs the terminal only in [`RenderState::begin_update`]; the caller holds
//!   the terminal's lock for that call alone and finishes with [`RenderState::end_update`]
//!   after releasing it.

mod effects;
mod formatter;
mod key;
mod mouse;
mod render;
mod search;
pub mod snapshot;
mod terminal;
mod tracked;

pub use effects::{EffectsOutput, SemanticKind, SemanticMark};
pub use formatter::{TextOptions, TextRange, plain_text, viewport_text, vt_text};
pub use key::{KeyAction, KeyEncoder, KeyInput};
pub use mouse::{MouseAction, MouseEncoder, MouseGeometry, MouseInput, focus_report};
pub use render::{CellData, RenderState, RowId, RowReader};
pub use search::{SearchMatch, SearchStats, search};
pub use terminal::{
    ActiveScreen, CLIPBOARD_WRITE_MAX_BYTES, CONTINUATION_MAX_BYTES, MODE_BRACKETED_PASTE,
    MODE_FOCUS_EVENTS, PasteOutcome, Scrollbar, Terminal,
};
pub use tracked::{ScreenPoint, TrackedPoint};

use piarc_ghostty_sys as sys;

use crate::error::{Error, Result};

/// Maps a `GhosttyResult` to `Ok` or [`Error::Vt`] naming `call`.
fn check(call: &'static str, code: sys::GhosttyResult) -> Result<()> {
    if code == sys::GHOSTTY_SUCCESS {
        Ok(())
    } else {
        Err(Error::Vt { call, code })
    }
}

/// `GHOSTTY_MODE_SYNCHRONIZED_OUTPUT`: `ghostty_mode_new(2026, false)`, a header macro over a
/// `static inline` function that bindgen cannot see (value in the low 15 bits, ANSI flag in
/// bit 15).
const MODE_SYNCHRONIZED_OUTPUT: sys::GhosttyMode = 2026;

#[cfg(test)]
mod tests;
