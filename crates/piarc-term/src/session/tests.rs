use std::time::{Duration, Instant};

use piarc_protocol::term_frame::{self, Frame, Screen};

use super::*;

/// One frame as `Session::frame` makes it, at `now` on the injected clock.
fn pull(terminal: &mut Terminal, frames: &mut FrameEncoder, now: Instant) -> Frame {
    frames.prepare(1, false);
    let (held, updated) = update_locked(terminal, frames, now).expect("update");
    if updated {
        frames.render_state().end_update().expect("end");
    }
    let (bytes, _) = frames.encode(held, terminal.scrollbar()).expect("encode");
    term_frame::decode(&bytes).expect("decode")
}

#[test]
fn a_render_hold_freezes_frames_until_core_ends_it() {
    let mut t = Terminal::new(20, 2, 100).expect("terminal");
    let mut frames = FrameEncoder::new().expect("encoder");
    let mut screen = Screen::new();
    let start = Instant::now();
    t.write(b"before");
    screen
        .apply(&pull(&mut t, &mut frames, start))
        .expect("apply");
    assert_eq!(screen.plain_text(), "before");
    // The program starts synchronized output and redraws; the IO thread stamps the start.
    t.write(b"\x1b[?2026h\r\x1b[2Kduring");
    t.stamp_hold(start);
    let first = pull(&mut t, &mut frames, start + Duration::from_millis(10));
    assert!(first.held, "the frame captured when the hold began");
    screen.apply(&first).expect("apply");
    assert_eq!(
        screen.plain_text(),
        "before",
        "the screen as the hold began"
    );
    // More output while held: no new frame content, whatever is pulled.
    t.write(b"\r\x1b[2Kstill drawing");
    for ms in [100, 500, 999] {
        let frame = pull(&mut t, &mut frames, start + Duration::from_millis(ms));
        assert!(
            frame.held && frame.body.is_none(),
            "at {ms} ms: an empty held frame"
        );
        screen.apply(&frame).expect("apply");
    }
    assert_eq!(screen.plain_text(), "before");
    // One second on the injected clock: Core ends the hold itself.
    let after = pull(&mut t, &mut frames, start + HOLD_TIMEOUT);
    assert!(!after.held);
    screen.apply(&after).expect("apply");
    assert_eq!(screen.plain_text(), "still drawing");
    assert!(t.hold_since().is_none());
    assert!(!t.mode(2026, false), "synchronized output is off");
}

#[test]
fn a_hold_the_program_ends_in_time_shows_its_result_at_once() {
    let mut t = Terminal::new(12, 2, 100).expect("terminal");
    let mut frames = FrameEncoder::new().expect("encoder");
    let start = Instant::now();
    pull(&mut t, &mut frames, start);
    t.write(b"\x1b[?2026hdone\x1b[?2026l");
    t.stamp_hold(start);
    let mut screen = Screen::new();
    let mut frames = FrameEncoder::new().expect("encoder");
    let held = pull(&mut t, &mut frames, start);
    // The capture of the hold's start comes first, then the finished screen.
    screen.apply(&held).expect("apply");
    let next = pull(&mut t, &mut frames, start);
    assert!(!next.held);
    screen.apply(&next).expect("apply");
    assert_eq!(screen.plain_text(), "done");
}

#[test]
fn osc_7_urls_become_paths() {
    assert_eq!(threads::pwd_path("file://host/tmp/a%20b"), "/tmp/a b");
    assert_eq!(
        threads::pwd_path("file:///Users/x/%E4%B8%AD"),
        "/Users/x/中"
    );
    assert_eq!(
        threads::pwd_path("kitty-shell-cwd://h/x"),
        "kitty-shell-cwd://h/x"
    );
    assert_eq!(threads::pwd_path("file://host"), "file://host");
}
