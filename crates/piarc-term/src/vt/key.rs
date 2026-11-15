//! [`KeyEncoder`]: turns a key event into the bytes the running program expects, following the
//! terminal's modes (cursor key mode, keypad mode, Kitty keyboard flags, …).

use std::ptr::{self, NonNull};

use piarc_ghostty_sys as sys;

use super::check;
use super::terminal::Terminal;
use crate::error::{Error, Result};

/// Press, repeat or release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    /// Key went down.
    Press,
    /// Auto-repeat while held.
    Repeat,
    /// Key went up.
    Release,
}

/// One key event, as the renderer reported it and the key map translated it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInput {
    /// Press, repeat or release.
    pub action: KeyAction,
    /// The physical key (`GhosttyKey`, W3C `code` order); `GHOSTTY_KEY_UNIDENTIFIED` when
    /// unknown.
    pub key: sys::GhosttyKey,
    /// `GHOSTTY_MODS_*` bits held during the event.
    pub mods: u16,
    /// Modifiers that produced `text` (Shift for capitals, Option for macOS characters).
    pub consumed_mods: u16,
    /// Part of an input-method composition.
    pub composing: bool,
    /// The text the key produced, without Ctrl or Meta transformations; empty for keys that
    /// produce none (arrows, Enter, function keys). Never C0 control characters.
    pub text: String,
    /// The key's character without Shift (`a` for `A`), 0 when unknown.
    pub unshifted: u32,
}

/// A key encoder with one reusable event.
pub struct KeyEncoder {
    encoder: NonNull<sys::GhosttyKeyEncoderImpl>,
    event: NonNull<sys::GhosttyKeyEventImpl>,
}

// SAFETY: encoder and event handles have no thread affinity; `KeyEncoder` is not `Sync` and
// every call takes `&mut self`.
unsafe impl Send for KeyEncoder {}

impl KeyEncoder {
    /// Creates an encoder with libghostty-vt's defaults (legacy encoding).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when an allocation fails.
    pub fn new() -> Result<Self> {
        let mut encoder: sys::GhosttyKeyEncoder = ptr::null_mut();
        // SAFETY: null allocator = default; `encoder` is a valid out pointer.
        check("ghostty_key_encoder_new", unsafe {
            sys::ghostty_key_encoder_new(ptr::null(), &raw mut encoder)
        })?;
        let encoder = NonNull::new(encoder).ok_or(Error::Vt {
            call: "ghostty_key_encoder_new",
            code: sys::GHOSTTY_INVALID_VALUE,
        })?;
        let mut event: sys::GhosttyKeyEvent = ptr::null_mut();
        // SAFETY: as above.
        let result = unsafe { sys::ghostty_key_event_new(ptr::null(), &raw mut event) };
        match check("ghostty_key_event_new", result).and_then(|()| {
            NonNull::new(event).ok_or(Error::Vt {
                call: "ghostty_key_event_new",
                code: sys::GHOSTTY_INVALID_VALUE,
            })
        }) {
            Ok(event) => Ok(Self { encoder, event }),
            Err(error) => {
                // SAFETY: created above and not used again.
                unsafe { sys::ghostty_key_encoder_free(encoder.as_ptr()) };
                Err(error)
            }
        }
    }

    /// Copies the terminal's input modes into the encoder. A program can change them with any
    /// write, so call this right before encoding, with the terminal's lock held.
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt fails.
    pub fn sync(&mut self, terminal: &mut Terminal) -> Result<()> {
        // SAFETY: both handles are live and exclusively borrowed.
        check("ghostty_key_encoder_set_from_terminal", unsafe {
            sys::ghostty_key_encoder_set_from_terminal(self.encoder.as_ptr(), terminal.raw())
        })
    }

    /// Appends the encoding of `input` to `out`. Many events produce nothing (a bare
    /// modifier, a release in legacy mode).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when libghostty-vt rejects the event.
    pub fn encode(&mut self, input: &KeyInput, out: &mut Vec<u8>) -> Result<()> {
        let event = self.event.as_ptr();
        let action = match input.action {
            KeyAction::Press => sys::GHOSTTY_KEY_ACTION_PRESS,
            KeyAction::Repeat => sys::GHOSTTY_KEY_ACTION_REPEAT,
            KeyAction::Release => sys::GHOSTTY_KEY_ACTION_RELEASE,
        };
        let text = sys::GhosttyString {
            ptr: input.text.as_ptr(),
            len: input.text.len(),
        };
        // SAFETY: the event is live and exclusively borrowed. The event keeps a pointer to the
        // text without copying it; `input.text` outlives the encode call below, and the text
        // is cleared again before this function returns.
        unsafe {
            check(
                "ghostty_key_event_set_action",
                sys::ghostty_key_event_set_action(event, action),
            )?;
            check(
                "ghostty_key_event_set_key",
                sys::ghostty_key_event_set_key(event, input.key),
            )?;
            check(
                "ghostty_key_event_set_mods",
                sys::ghostty_key_event_set_mods(event, input.mods),
            )?;
            check(
                "ghostty_key_event_set_consumed_mods",
                sys::ghostty_key_event_set_consumed_mods(event, input.consumed_mods),
            )?;
            check(
                "ghostty_key_event_set_composing",
                sys::ghostty_key_event_set_composing(event, input.composing),
            )?;
            check(
                "ghostty_key_event_set_unshifted_codepoint",
                sys::ghostty_key_event_set_unshifted_codepoint(event, input.unshifted),
            )?;
            check(
                "ghostty_key_event_set_utf8",
                sys::ghostty_key_event_set_utf8(event, text),
            )?;
        }
        let result = self.encode_event(out);
        let cleared = sys::GhosttyString {
            ptr: ptr::null(),
            len: 0,
        };
        // SAFETY: a zero-length string clears the text; the library does not read its pointer.
        unsafe { sys::ghostty_key_event_set_utf8(event, cleared) };
        result
    }

    fn encode_event(&mut self, out: &mut Vec<u8>) -> Result<()> {
        let mut buffer = [0u8; 128];
        let mut written = 0usize;
        // SAFETY: encoder and event are live; the buffer is writable for its length.
        let code = unsafe {
            sys::ghostty_key_encoder_encode(
                self.encoder.as_ptr(),
                self.event.as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len(),
                &raw mut written,
            )
        };
        if code == sys::GHOSTTY_OUT_OF_SPACE {
            let mut large = vec![0u8; written];
            // SAFETY: as above, with the size the library asked for.
            check("ghostty_key_encoder_encode", unsafe {
                sys::ghostty_key_encoder_encode(
                    self.encoder.as_ptr(),
                    self.event.as_ptr(),
                    large.as_mut_ptr(),
                    large.len(),
                    &raw mut written,
                )
            })?;
            out.extend_from_slice(large.get(..written).unwrap_or_default());
            return Ok(());
        }
        check("ghostty_key_encoder_encode", code)?;
        out.extend_from_slice(buffer.get(..written).unwrap_or_default());
        Ok(())
    }
}

impl Drop for KeyEncoder {
    fn drop(&mut self) {
        // SAFETY: both handles came from their `_new` functions and are not used again.
        unsafe {
            sys::ghostty_key_event_free(self.event.as_ptr());
            sys::ghostty_key_encoder_free(self.encoder.as_ptr());
        }
    }
}
