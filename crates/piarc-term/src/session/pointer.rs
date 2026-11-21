//! Pointer events on the writer thread (T34): the program gets them while it tracks the mouse;
//! otherwise they select text (libghostty-vt's selection gesture) and the wheel scrolls. Kept
//! on the writer thread so presses, drags, releases and keys stay in the order they happened.

use super::{Shared, lock};
use crate::keymap::{self, MOD_SHIFT};
use crate::vt::{
    self, ActiveScreen, KeyAction, KeyEncoder, MouseAction, MouseEncoder, MouseInput, PointerAt,
    ScrollTo, SelectionGesture, SurfaceGeometry, Terminal,
};

/// Mouse tracking modes a program turns on: X10, normal, button-event, any-event.
const MOUSE_TRACKING_MODES: [u16; 4] = [9, 1000, 1002, 1003];

/// Alternate scroll mode: on the alternate screen the wheel sends arrow keys.
const MODE_ALTERNATE_SCROLL: u16 = 1007;

/// Wheel buttons up and down.
const WHEEL_UP: u8 = 4;
const WHEEL_DOWN: u8 = 5;

/// The writer thread's pointer state.
pub(super) struct Pointer {
    gesture: Option<SelectionGesture>,
    /// A left-button selection is in progress: its motion and release stay with it even if
    /// the program turns on mouse tracking or Shift is released meanwhile.
    selecting: bool,
}

fn tracks_mouse(terminal: &Terminal) -> bool {
    MOUSE_TRACKING_MODES
        .iter()
        .any(|&mode| terminal.mode(mode, false))
}

impl Pointer {
    pub(super) fn new(gesture: SelectionGesture) -> Self {
        Self {
            gesture: Some(gesture),
            selecting: false,
        }
    }

    /// Handles one pointer event; bytes for the program land in `out`.
    pub(super) fn handle(
        &mut self,
        shared: &Shared,
        input: &MouseInput,
        mouse: &mut MouseEncoder,
        keys: &mut KeyEncoder,
        out: &mut Vec<u8>,
    ) {
        let geometry = *lock(&shared.geometry);
        let mut terminal = lock(&shared.terminal);
        let wheel = matches!(input.button, Some(WHEEL_UP..=7));
        let shift = input.mods & MOD_SHIFT != 0;
        let to_program = tracks_mouse(&terminal) && !self.selecting && (wheel || !shift);
        if to_program {
            if mouse.sync(&mut terminal, geometry).is_ok() {
                let _ = mouse.encode(input, out);
            }
            return;
        }
        if wheel {
            if input.action == MouseAction::Press {
                wheel_step(&mut terminal, input.button, keys, out);
            }
            return;
        }
        let surface = SurfaceGeometry {
            cell_width: geometry.cell_width,
            cell_height: geometry.cell_height,
        };
        let at = PointerAt {
            x: input.x,
            y: input.y,
        };
        let Some(gesture) = self.gesture.as_mut() else {
            return;
        };
        // A failed step leaves the selection as it was; the next press starts over.
        match (input.action, input.button) {
            (MouseAction::Press, Some(1)) => {
                self.selecting = true;
                let _ = gesture.press(&mut terminal, surface, at, input.clicks.max(1), shift);
            }
            (MouseAction::Motion, _) if self.selecting => {
                let _ = gesture.drag(&mut terminal, surface, at);
            }
            (MouseAction::Release, Some(1)) if self.selecting => {
                self.selecting = false;
                let _ = gesture.release(&mut terminal, surface, at);
            }
            _ => {}
        }
    }

    /// Frees the gesture while the terminal is still alive.
    pub(super) fn free(&mut self, terminal: &mut Terminal) {
        if let Some(gesture) = self.gesture.take() {
            gesture.free(terminal);
        }
    }
}

/// One wheel step without mouse tracking: scroll the scrollback, or on the alternate screen
/// (no scrollback) send an arrow key when the program allows alternate scrolling.
fn wheel_step(
    terminal: &mut Terminal,
    button: Option<u8>,
    keys: &mut KeyEncoder,
    out: &mut Vec<u8>,
) {
    let up = button == Some(WHEEL_UP);
    if button != Some(WHEEL_UP) && button != Some(WHEEL_DOWN) {
        return;
    }
    if terminal.active_screen() == ActiveScreen::Alternate {
        if terminal.mode(MODE_ALTERNATE_SCROLL, false) {
            let code = if up { "ArrowUp" } else { "ArrowDown" };
            let key = keymap::key_input(KeyAction::Press, code, "", 0, false);
            if keys.sync(terminal).is_ok() {
                let _ = keys.encode(&key, out);
            }
        }
        return;
    }
    let _ = vt::scroll_viewport(terminal, ScrollTo::Delta(if up { -1 } else { 1 }));
}
