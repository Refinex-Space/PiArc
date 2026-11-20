//! [`MouseEncoder`] and [`focus_report`]: mouse and focus events as the bytes the running
//! program asked for (its mouse tracking mode and format: X10, normal, button, any-event;
//! X10, UTF-8, SGR, URXVT, SGR-pixels; focus reports of mode 1004).

use std::ptr::{self, NonNull};

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use crate::error::{Error, Result};

/// Press, release or motion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    /// A button went down (wheel steps are presses of buttons 4–7).
    Press,
    /// A button went up.
    Release,
    /// The pointer moved.
    Motion,
}

/// One mouse event in surface pixels (the terminal's drawing area, top-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MouseInput {
    /// What happened.
    pub action: MouseAction,
    /// 1 left, 2 right, 3 middle, 4–7 wheel up, down, left, right, 8–11 extra buttons;
    /// `None` for motion without a button.
    pub button: Option<u8>,
    /// `keymap::MOD_*` bits.
    pub mods: u16,
    /// Horizontal position in pixels.
    pub x: f32,
    /// Vertical position in pixels.
    pub y: f32,
}

/// Geometry the encoder turns pixels into cells with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseGeometry {
    /// Surface width in pixels.
    pub width: u32,
    /// Surface height in pixels.
    pub height: u32,
    /// Cell width in pixels.
    pub cell_width: u32,
    /// Cell height in pixels.
    pub cell_height: u32,
}

/// A mouse encoder with one reusable event.
pub struct MouseEncoder {
    encoder: NonNull<sys::GhosttyMouseEncoderImpl>,
    event: NonNull<sys::GhosttyMouseEventImpl>,
}

// SAFETY: encoder and event handles have no thread affinity; `MouseEncoder` is not `Sync` and
// every call takes `&mut self`.
unsafe impl Send for MouseEncoder {}

impl MouseEncoder {
    /// Creates an encoder (no tracking until synced with a terminal).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when an allocation fails.
    pub fn new() -> Result<Self> {
        let mut encoder: sys::GhosttyMouseEncoder = ptr::null_mut();
        // SAFETY: null allocator = default; `encoder` is a valid out pointer.
        check("ghostty_mouse_encoder_new", unsafe {
            sys::ghostty_mouse_encoder_new(ptr::null(), &raw mut encoder)
        })?;
        let encoder = NonNull::new(encoder).ok_or(Error::Vt {
            call: "ghostty_mouse_encoder_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let mut event: sys::GhosttyMouseEvent = ptr::null_mut();
        // SAFETY: as above.
        let result = unsafe { sys::ghostty_mouse_event_new(ptr::null(), &raw mut event) };
        match check("ghostty_mouse_event_new", result).and_then(|()| {
            NonNull::new(event).ok_or(Error::Vt {
                call: "ghostty_mouse_event_new",
                code: sys::GHOSTTY_INVALID_VALUE,
            })
        }) {
            Ok(event) => Ok(Self { encoder, event }),
            Err(error) => {
                // SAFETY: created above and not used again.
                unsafe { sys::ghostty_mouse_encoder_free(encoder.as_ptr()) };
                Err(error)
            }
        }
    }

    /// Copies the terminal's mouse tracking mode and format into the encoder; call it right
    /// before encoding, with the terminal's lock held.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn sync(&mut self, terminal: &mut Terminal, geometry: MouseGeometry) -> Result<()> {
        // SAFETY: both handles are live and exclusively borrowed.
        check("ghostty_mouse_encoder_set_from_terminal", unsafe {
            sys::ghostty_mouse_encoder_set_from_terminal(self.encoder.as_ptr(), terminal.raw())
        })?;
        let size = sys::GhosttyMouseEncoderSize {
            size: size_of::<sys::GhosttyMouseEncoderSize>(),
            screen_width: geometry.width,
            screen_height: geometry.height,
            cell_width: geometry.cell_width.max(1),
            cell_height: geometry.cell_height.max(1),
            padding_top: 0,
            padding_bottom: 0,
            padding_right: 0,
            padding_left: 0,
        };
        // SAFETY: OPT_SIZE takes a pointer to a sized GhosttyMouseEncoderSize for the call.
        check("ghostty_mouse_encoder_set(SIZE)", unsafe {
            sys::ghostty_mouse_encoder_set(
                self.encoder.as_ptr(),
                sys::GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
                (&raw const size).cast(),
            )
        })
    }

    /// Appends the encoding of `input` to `out`; nothing when the program does not track this
    /// kind of event.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidArgument`] for a button out of range; [`Error::Vt`] when libghostty-vt
    /// rejects the event.
    pub fn encode(&mut self, input: &MouseInput, out: &mut Vec<u8>) -> Result<()> {
        let event = self.event.as_ptr();
        let action = match input.action {
            MouseAction::Press => sys::GHOSTTY_MOUSE_ACTION_PRESS,
            MouseAction::Release => sys::GHOSTTY_MOUSE_ACTION_RELEASE,
            MouseAction::Motion => sys::GHOSTTY_MOUSE_ACTION_MOTION,
        };
        let button = match input.button {
            None => None,
            Some(b @ 1..=11) => Some(sys::GhosttyMouseButton::from(b)),
            Some(_) => {
                return Err(Error::InvalidArgument {
                    field: "button",
                    reason: "must be between 1 and 11".into(),
                });
            }
        };
        // SAFETY: the event is live and exclusively borrowed.
        unsafe {
            check(
                "ghostty_mouse_event_set_action",
                sys::ghostty_mouse_event_set_action(event, action),
            )?;
            match button {
                Some(button) => check(
                    "ghostty_mouse_event_set_button",
                    sys::ghostty_mouse_event_set_button(event, button),
                )?,
                None => check(
                    "ghostty_mouse_event_clear_button",
                    sys::ghostty_mouse_event_clear_button(event),
                )?,
            }
            check(
                "ghostty_mouse_event_set_mods",
                sys::ghostty_mouse_event_set_mods(event, input.mods),
            )?;
            check(
                "ghostty_mouse_event_set_position",
                sys::ghostty_mouse_event_set_position(
                    event,
                    sys::GhosttyMousePosition {
                        x: input.x,
                        y: input.y,
                    },
                ),
            )?;
        }
        let mut buffer = [0u8; 128];
        let mut written = 0usize;
        // SAFETY: encoder and event are live; 128 bytes is enough for any event per the header.
        check("ghostty_mouse_encoder_encode", unsafe {
            sys::ghostty_mouse_encoder_encode(
                self.encoder.as_ptr(),
                event,
                buffer.as_mut_ptr(),
                buffer.len(),
                &raw mut written,
            )
        })?;
        out.extend_from_slice(buffer.get(..written).unwrap_or_default());
        Ok(())
    }
}

impl Drop for MouseEncoder {
    fn drop(&mut self) {
        // SAFETY: both handles came from their `_new` functions and are not used again.
        unsafe {
            sys::ghostty_mouse_event_free(self.event.as_ptr());
            sys::ghostty_mouse_encoder_free(self.encoder.as_ptr());
        }
    }
}

/// The focus report for `gained` (`CSI I` or `CSI O`); send it only when the program turned
/// on focus reports (mode 1004, [`super::MODE_FOCUS_EVENTS`]).
///
/// # Errors
///
/// [`Error::Vt`] when libghostty-vt fails.
pub fn focus_report(gained: bool) -> Result<Vec<u8>> {
    let event = if gained {
        sys::GHOSTTY_FOCUS_GAINED
    } else {
        sys::GHOSTTY_FOCUS_LOST
    };
    let mut buffer = [0u8; 16];
    let mut written = 0usize;
    // SAFETY: the buffer is writable for its length; a focus report is three bytes.
    check("ghostty_focus_encode", unsafe {
        sys::ghostty_focus_encode(event, buffer.as_mut_ptr(), buffer.len(), &raw mut written)
    })?;
    Ok(buffer.get(..written).unwrap_or_default().to_vec())
}
