//! W3C `KeyboardEvent.code` values → libghostty-vt physical keys. `GhosttyKey` follows the
//! W3C UI Events code tables, so the renderer sends `event.code` unchanged and Core maps it.
//! Generated once from the `GHOSTTY_KEY_*` constants of the bindings (names in UPPER_SNAKE_CASE
//! of the W3C code, letters as `KeyA`, digits as `Digit0`); update it with the bindings.

use piarc_ghostty_sys as sys;

use crate::vt::{KeyAction, KeyInput};

/// `GHOSTTY_MODS_SHIFT`.
pub const MOD_SHIFT: u16 = 1;
/// `GHOSTTY_MODS_CTRL`.
pub const MOD_CTRL: u16 = 1 << 1;
/// `GHOSTTY_MODS_ALT` (Option on macOS).
pub const MOD_ALT: u16 = 1 << 2;
/// `GHOSTTY_MODS_SUPER` (Command on macOS, Windows key).
pub const MOD_SUPER: u16 = 1 << 3;
/// The modifier bits a browser `KeyboardEvent` can report.
pub const MODS_MASK: u16 = MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER;

/// Builds the encoder input for a browser key event: `code` is `KeyboardEvent.code`, `text`
/// the character the key produced (`KeyboardEvent.key` when it is one grapheme, empty for
/// named keys), `mods` the `MOD_*` bits.
///
/// The unshifted character comes from the physical key for letters, digits and space (the
/// browser does not report it), otherwise from `text` when Shift is not held. Shift and Alt
/// count as consumed when they produced `text` (a capital letter, a macOS Option character).
/// Control characters are dropped from `text`: the encoder derives Ctrl sequences from the
/// key and the modifiers.
#[must_use]
pub fn key_input(
    action: KeyAction,
    code: &str,
    text: &str,
    mods: u16,
    composing: bool,
) -> KeyInput {
    let mods = mods & MODS_MASK;
    let text: String = if text.chars().any(char::is_control) {
        String::new()
    } else {
        text.to_owned()
    };
    let unshifted = unshifted_for_code(code)
        .or_else(|| {
            let mut chars = text.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if mods & MOD_SHIFT == 0 => Some(c),
                _ => None,
            }
        })
        .map_or(0, u32::from);
    let mut consumed = 0;
    if !text.is_empty() {
        consumed |= mods & MOD_SHIFT;
        if mods & MOD_ALT != 0 && u32::from(text.chars().next().unwrap_or('\0')) != unshifted {
            consumed |= MOD_ALT;
        }
    }
    KeyInput {
        action,
        key: key_for_code(code),
        mods,
        consumed_mods: consumed,
        composing,
        text,
        unshifted,
    }
}

fn unshifted_for_code(code: &str) -> Option<char> {
    if code == "Space" {
        return Some(' ');
    }
    let rest = code
        .strip_prefix("Key")
        .or_else(|| code.strip_prefix("Digit"))?;
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphanumeric() => Some(c.to_ascii_lowercase()),
        _ => None,
    }
}

/// The `GhosttyKey` for a W3C `code`, or `GHOSTTY_KEY_UNIDENTIFIED`.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one flat lookup table, one arm per key"
)]
pub fn key_for_code(code: &str) -> sys::GhosttyKey {
    match code {
        "AltLeft" => sys::GHOSTTY_KEY_ALT_LEFT,
        "AltRight" => sys::GHOSTTY_KEY_ALT_RIGHT,
        "ArrowDown" => sys::GHOSTTY_KEY_ARROW_DOWN,
        "ArrowLeft" => sys::GHOSTTY_KEY_ARROW_LEFT,
        "ArrowRight" => sys::GHOSTTY_KEY_ARROW_RIGHT,
        "ArrowUp" => sys::GHOSTTY_KEY_ARROW_UP,
        "AudioVolumeDown" => sys::GHOSTTY_KEY_AUDIO_VOLUME_DOWN,
        "AudioVolumeMute" => sys::GHOSTTY_KEY_AUDIO_VOLUME_MUTE,
        "AudioVolumeUp" => sys::GHOSTTY_KEY_AUDIO_VOLUME_UP,
        "Backquote" => sys::GHOSTTY_KEY_BACKQUOTE,
        "Backslash" => sys::GHOSTTY_KEY_BACKSLASH,
        "Backspace" => sys::GHOSTTY_KEY_BACKSPACE,
        "BracketLeft" => sys::GHOSTTY_KEY_BRACKET_LEFT,
        "BracketRight" => sys::GHOSTTY_KEY_BRACKET_RIGHT,
        "BrowserBack" => sys::GHOSTTY_KEY_BROWSER_BACK,
        "BrowserFavorites" => sys::GHOSTTY_KEY_BROWSER_FAVORITES,
        "BrowserForward" => sys::GHOSTTY_KEY_BROWSER_FORWARD,
        "BrowserHome" => sys::GHOSTTY_KEY_BROWSER_HOME,
        "BrowserRefresh" => sys::GHOSTTY_KEY_BROWSER_REFRESH,
        "BrowserSearch" => sys::GHOSTTY_KEY_BROWSER_SEARCH,
        "BrowserStop" => sys::GHOSTTY_KEY_BROWSER_STOP,
        "CapsLock" => sys::GHOSTTY_KEY_CAPS_LOCK,
        "Comma" => sys::GHOSTTY_KEY_COMMA,
        "ContextMenu" => sys::GHOSTTY_KEY_CONTEXT_MENU,
        "ControlLeft" => sys::GHOSTTY_KEY_CONTROL_LEFT,
        "ControlRight" => sys::GHOSTTY_KEY_CONTROL_RIGHT,
        "Convert" => sys::GHOSTTY_KEY_CONVERT,
        "Copy" => sys::GHOSTTY_KEY_COPY,
        "Cut" => sys::GHOSTTY_KEY_CUT,
        "Delete" => sys::GHOSTTY_KEY_DELETE,
        "Digit0" => sys::GHOSTTY_KEY_DIGIT_0,
        "Digit1" => sys::GHOSTTY_KEY_DIGIT_1,
        "Digit2" => sys::GHOSTTY_KEY_DIGIT_2,
        "Digit3" => sys::GHOSTTY_KEY_DIGIT_3,
        "Digit4" => sys::GHOSTTY_KEY_DIGIT_4,
        "Digit5" => sys::GHOSTTY_KEY_DIGIT_5,
        "Digit6" => sys::GHOSTTY_KEY_DIGIT_6,
        "Digit7" => sys::GHOSTTY_KEY_DIGIT_7,
        "Digit8" => sys::GHOSTTY_KEY_DIGIT_8,
        "Digit9" => sys::GHOSTTY_KEY_DIGIT_9,
        "Eject" => sys::GHOSTTY_KEY_EJECT,
        "End" => sys::GHOSTTY_KEY_END,
        "Enter" => sys::GHOSTTY_KEY_ENTER,
        "Equal" => sys::GHOSTTY_KEY_EQUAL,
        "Escape" => sys::GHOSTTY_KEY_ESCAPE,
        "F1" => sys::GHOSTTY_KEY_F1,
        "F10" => sys::GHOSTTY_KEY_F10,
        "F11" => sys::GHOSTTY_KEY_F11,
        "F12" => sys::GHOSTTY_KEY_F12,
        "F13" => sys::GHOSTTY_KEY_F13,
        "F14" => sys::GHOSTTY_KEY_F14,
        "F15" => sys::GHOSTTY_KEY_F15,
        "F16" => sys::GHOSTTY_KEY_F16,
        "F17" => sys::GHOSTTY_KEY_F17,
        "F18" => sys::GHOSTTY_KEY_F18,
        "F19" => sys::GHOSTTY_KEY_F19,
        "F2" => sys::GHOSTTY_KEY_F2,
        "F20" => sys::GHOSTTY_KEY_F20,
        "F21" => sys::GHOSTTY_KEY_F21,
        "F22" => sys::GHOSTTY_KEY_F22,
        "F23" => sys::GHOSTTY_KEY_F23,
        "F24" => sys::GHOSTTY_KEY_F24,
        "F25" => sys::GHOSTTY_KEY_F25,
        "F3" => sys::GHOSTTY_KEY_F3,
        "F4" => sys::GHOSTTY_KEY_F4,
        "F5" => sys::GHOSTTY_KEY_F5,
        "F6" => sys::GHOSTTY_KEY_F6,
        "F7" => sys::GHOSTTY_KEY_F7,
        "F8" => sys::GHOSTTY_KEY_F8,
        "F9" => sys::GHOSTTY_KEY_F9,
        "Fn" => sys::GHOSTTY_KEY_FN,
        "FnLock" => sys::GHOSTTY_KEY_FN_LOCK,
        "Help" => sys::GHOSTTY_KEY_HELP,
        "Home" => sys::GHOSTTY_KEY_HOME,
        "Insert" => sys::GHOSTTY_KEY_INSERT,
        "IntlBackslash" => sys::GHOSTTY_KEY_INTL_BACKSLASH,
        "IntlRo" => sys::GHOSTTY_KEY_INTL_RO,
        "IntlYen" => sys::GHOSTTY_KEY_INTL_YEN,
        "KanaMode" => sys::GHOSTTY_KEY_KANA_MODE,
        "KeyA" => sys::GHOSTTY_KEY_A,
        "KeyB" => sys::GHOSTTY_KEY_B,
        "KeyC" => sys::GHOSTTY_KEY_C,
        "KeyD" => sys::GHOSTTY_KEY_D,
        "KeyE" => sys::GHOSTTY_KEY_E,
        "KeyF" => sys::GHOSTTY_KEY_F,
        "KeyG" => sys::GHOSTTY_KEY_G,
        "KeyH" => sys::GHOSTTY_KEY_H,
        "KeyI" => sys::GHOSTTY_KEY_I,
        "KeyJ" => sys::GHOSTTY_KEY_J,
        "KeyK" => sys::GHOSTTY_KEY_K,
        "KeyL" => sys::GHOSTTY_KEY_L,
        "KeyM" => sys::GHOSTTY_KEY_M,
        "KeyN" => sys::GHOSTTY_KEY_N,
        "KeyO" => sys::GHOSTTY_KEY_O,
        "KeyP" => sys::GHOSTTY_KEY_P,
        "KeyQ" => sys::GHOSTTY_KEY_Q,
        "KeyR" => sys::GHOSTTY_KEY_R,
        "KeyS" => sys::GHOSTTY_KEY_S,
        "KeyT" => sys::GHOSTTY_KEY_T,
        "KeyU" => sys::GHOSTTY_KEY_U,
        "KeyV" => sys::GHOSTTY_KEY_V,
        "KeyW" => sys::GHOSTTY_KEY_W,
        "KeyX" => sys::GHOSTTY_KEY_X,
        "KeyY" => sys::GHOSTTY_KEY_Y,
        "KeyZ" => sys::GHOSTTY_KEY_Z,
        "LaunchApp1" => sys::GHOSTTY_KEY_LAUNCH_APP_1,
        "LaunchApp2" => sys::GHOSTTY_KEY_LAUNCH_APP_2,
        "LaunchMail" => sys::GHOSTTY_KEY_LAUNCH_MAIL,
        "MediaPlayPause" => sys::GHOSTTY_KEY_MEDIA_PLAY_PAUSE,
        "MediaSelect" => sys::GHOSTTY_KEY_MEDIA_SELECT,
        "MediaStop" => sys::GHOSTTY_KEY_MEDIA_STOP,
        "MediaTrackNext" => sys::GHOSTTY_KEY_MEDIA_TRACK_NEXT,
        "MediaTrackPrevious" => sys::GHOSTTY_KEY_MEDIA_TRACK_PREVIOUS,
        "MetaLeft" => sys::GHOSTTY_KEY_META_LEFT,
        "MetaRight" => sys::GHOSTTY_KEY_META_RIGHT,
        "Minus" => sys::GHOSTTY_KEY_MINUS,
        "NonConvert" => sys::GHOSTTY_KEY_NON_CONVERT,
        "NumLock" => sys::GHOSTTY_KEY_NUM_LOCK,
        "Numpad0" => sys::GHOSTTY_KEY_NUMPAD_0,
        "Numpad1" => sys::GHOSTTY_KEY_NUMPAD_1,
        "Numpad2" => sys::GHOSTTY_KEY_NUMPAD_2,
        "Numpad3" => sys::GHOSTTY_KEY_NUMPAD_3,
        "Numpad4" => sys::GHOSTTY_KEY_NUMPAD_4,
        "Numpad5" => sys::GHOSTTY_KEY_NUMPAD_5,
        "Numpad6" => sys::GHOSTTY_KEY_NUMPAD_6,
        "Numpad7" => sys::GHOSTTY_KEY_NUMPAD_7,
        "Numpad8" => sys::GHOSTTY_KEY_NUMPAD_8,
        "Numpad9" => sys::GHOSTTY_KEY_NUMPAD_9,
        "NumpadAdd" => sys::GHOSTTY_KEY_NUMPAD_ADD,
        "NumpadBackspace" => sys::GHOSTTY_KEY_NUMPAD_BACKSPACE,
        "NumpadBegin" => sys::GHOSTTY_KEY_NUMPAD_BEGIN,
        "NumpadClear" => sys::GHOSTTY_KEY_NUMPAD_CLEAR,
        "NumpadClearEntry" => sys::GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY,
        "NumpadComma" => sys::GHOSTTY_KEY_NUMPAD_COMMA,
        "NumpadDecimal" => sys::GHOSTTY_KEY_NUMPAD_DECIMAL,
        "NumpadDelete" => sys::GHOSTTY_KEY_NUMPAD_DELETE,
        "NumpadDivide" => sys::GHOSTTY_KEY_NUMPAD_DIVIDE,
        "NumpadDown" => sys::GHOSTTY_KEY_NUMPAD_DOWN,
        "NumpadEnd" => sys::GHOSTTY_KEY_NUMPAD_END,
        "NumpadEnter" => sys::GHOSTTY_KEY_NUMPAD_ENTER,
        "NumpadEqual" => sys::GHOSTTY_KEY_NUMPAD_EQUAL,
        "NumpadHome" => sys::GHOSTTY_KEY_NUMPAD_HOME,
        "NumpadInsert" => sys::GHOSTTY_KEY_NUMPAD_INSERT,
        "NumpadLeft" => sys::GHOSTTY_KEY_NUMPAD_LEFT,
        "NumpadMemoryAdd" => sys::GHOSTTY_KEY_NUMPAD_MEMORY_ADD,
        "NumpadMemoryClear" => sys::GHOSTTY_KEY_NUMPAD_MEMORY_CLEAR,
        "NumpadMemoryRecall" => sys::GHOSTTY_KEY_NUMPAD_MEMORY_RECALL,
        "NumpadMemoryStore" => sys::GHOSTTY_KEY_NUMPAD_MEMORY_STORE,
        "NumpadMemorySubtract" => sys::GHOSTTY_KEY_NUMPAD_MEMORY_SUBTRACT,
        "NumpadMultiply" => sys::GHOSTTY_KEY_NUMPAD_MULTIPLY,
        "NumpadPageDown" => sys::GHOSTTY_KEY_NUMPAD_PAGE_DOWN,
        "NumpadPageUp" => sys::GHOSTTY_KEY_NUMPAD_PAGE_UP,
        "NumpadParenLeft" => sys::GHOSTTY_KEY_NUMPAD_PAREN_LEFT,
        "NumpadParenRight" => sys::GHOSTTY_KEY_NUMPAD_PAREN_RIGHT,
        "NumpadRight" => sys::GHOSTTY_KEY_NUMPAD_RIGHT,
        "NumpadSeparator" => sys::GHOSTTY_KEY_NUMPAD_SEPARATOR,
        "NumpadSubtract" => sys::GHOSTTY_KEY_NUMPAD_SUBTRACT,
        "NumpadUp" => sys::GHOSTTY_KEY_NUMPAD_UP,
        "PageDown" => sys::GHOSTTY_KEY_PAGE_DOWN,
        "PageUp" => sys::GHOSTTY_KEY_PAGE_UP,
        "Paste" => sys::GHOSTTY_KEY_PASTE,
        "Pause" => sys::GHOSTTY_KEY_PAUSE,
        "Period" => sys::GHOSTTY_KEY_PERIOD,
        "Power" => sys::GHOSTTY_KEY_POWER,
        "PrintScreen" => sys::GHOSTTY_KEY_PRINT_SCREEN,
        "Quote" => sys::GHOSTTY_KEY_QUOTE,
        "ScrollLock" => sys::GHOSTTY_KEY_SCROLL_LOCK,
        "Semicolon" => sys::GHOSTTY_KEY_SEMICOLON,
        "ShiftLeft" => sys::GHOSTTY_KEY_SHIFT_LEFT,
        "ShiftRight" => sys::GHOSTTY_KEY_SHIFT_RIGHT,
        "Slash" => sys::GHOSTTY_KEY_SLASH,
        "Sleep" => sys::GHOSTTY_KEY_SLEEP,
        "Space" => sys::GHOSTTY_KEY_SPACE,
        "Tab" => sys::GHOSTTY_KEY_TAB,
        "WakeUp" => sys::GHOSTTY_KEY_WAKE_UP,
        _ => sys::GHOSTTY_KEY_UNIDENTIFIED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_w3c_codes() {
        assert_eq!(key_for_code("KeyA"), sys::GHOSTTY_KEY_A);
        assert_eq!(key_for_code("Digit7"), sys::GHOSTTY_KEY_DIGIT_7);
        assert_eq!(key_for_code("ArrowUp"), sys::GHOSTTY_KEY_ARROW_UP);
        assert_eq!(key_for_code("BracketLeft"), sys::GHOSTTY_KEY_BRACKET_LEFT);
        assert_eq!(key_for_code("NumpadEnter"), sys::GHOSTTY_KEY_NUMPAD_ENTER);
        assert_eq!(key_for_code("F12"), sys::GHOSTTY_KEY_F12);
        assert_eq!(key_for_code("MetaLeft"), sys::GHOSTTY_KEY_META_LEFT);
        assert_eq!(key_for_code("LaunchApp1"), sys::GHOSTTY_KEY_LAUNCH_APP_1);
        assert_eq!(key_for_code("Unknown"), sys::GHOSTTY_KEY_UNIDENTIFIED);
    }

    #[test]
    fn builds_encoder_input_from_browser_events() {
        let a = key_input(KeyAction::Press, "KeyA", "A", MOD_SHIFT, false);
        assert_eq!(
            (a.key, a.unshifted, a.consumed_mods),
            (sys::GHOSTTY_KEY_A, u32::from('a'), MOD_SHIFT)
        );
        let ctrl_c = key_input(KeyAction::Press, "KeyC", "c", MOD_CTRL, false);
        assert_eq!((ctrl_c.consumed_mods, ctrl_c.text.as_str()), (0, "c"));
        let option_a = key_input(KeyAction::Press, "KeyA", "å", MOD_ALT, false);
        assert_eq!(option_a.consumed_mods, MOD_ALT);
        let enter = key_input(KeyAction::Press, "Enter", "\r", 0, false);
        assert_eq!((enter.text.as_str(), enter.unshifted), ("", 0));
        let slash = key_input(KeyAction::Press, "Slash", "/", 0, false);
        assert_eq!(slash.unshifted, u32::from('/'));
        assert_eq!(
            key_input(KeyAction::Press, "KeyA", "a", 0xffff, false).mods,
            MODS_MASK
        );
    }
}
