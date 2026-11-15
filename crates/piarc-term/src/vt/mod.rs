//! The safe wrapper over libghostty-vt (`piarc-ghostty-sys`): only what PiArc uses — the
//! terminal with its effects, the render state, the key encoder and the plain-text formatter.
//!
//! This module and the `-sys` crate are the only places with `unsafe`; every block states why
//! it is sound. The wrapper upholds libghostty-vt's threading rules (its "Threads"
//! convention) through Rust's ownership:
//!
//! - Every handle type is `Send` but not `Sync`, and every call that touches a handle takes
//!   `&mut self` or a `&mut Terminal`, so no handle (or a handle borrowed from it) is used by
//!   two threads at once. Callers share a [`Terminal`] behind a mutex.
//! - Callbacks run on the thread of the `vt_write` or `resize` call that triggered them. They
//!   only append to the terminal's [`Effects`] record (and capture a render state when a
//!   synchronized-output hold begins), never write to the terminal, never block.
//! - A render state needs the terminal only in [`RenderState::begin_update`]; the caller holds
//!   the terminal's lock for that call alone and finishes with [`RenderState::end_update`]
//!   after releasing it.

mod effects;
mod formatter;
mod key;
mod render;
mod terminal;

pub use effects::EffectsOutput;
pub use formatter::viewport_text;
pub use key::{KeyAction, KeyEncoder, KeyInput};
pub use render::{CellData, RenderState, RowId, RowReader};
pub use terminal::Terminal;

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
