//! Link smoke test: the prebuilt library resolves and its version matches the lock file.

#![allow(unsafe_code, reason = "calls the raw bindings directly")]

use std::ptr;

use piarc_ghostty_sys as sys;

#[test]
fn creates_writes_and_frees_a_terminal() {
    let mut terminal: sys::GhosttyTerminal = ptr::null_mut();
    // SAFETY: a null allocator selects the default one; `terminal` is a valid out pointer.
    let result = unsafe { sys::ghostty_terminal_new(ptr::null(), &raw mut terminal, 80, 24) };
    assert_eq!(result, sys::GHOSTTY_SUCCESS);
    assert!(!terminal.is_null());
    let text = b"hello";
    // SAFETY: `terminal` is live and the buffer outlives the call.
    unsafe { sys::ghostty_terminal_vt_write(terminal, text.as_ptr(), text.len()) };
    let mut x: u16 = 0;
    // SAFETY: CURSOR_X writes a uint16_t into the out pointer.
    let result = unsafe {
        sys::ghostty_terminal_get(
            terminal,
            sys::GHOSTTY_TERMINAL_DATA_CURSOR_X,
            (&raw mut x).cast(),
        )
    };
    assert_eq!(result, sys::GHOSTTY_SUCCESS);
    assert_eq!(x, 5);
    // SAFETY: `terminal` came from ghostty_terminal_new and is not used afterwards.
    unsafe { sys::ghostty_terminal_free(terminal) };
}

#[test]
fn the_linked_library_is_the_locked_version() {
    let lock = include_str!("../ghostty-vt.lock.json");
    let version = std::str::from_utf8(sys::GHOSTTY_VT_VERSION)
        .expect("ASCII")
        .trim_end_matches('\0');
    assert!(lock.contains(&format!("\"version\": \"{version}\"")));
}
