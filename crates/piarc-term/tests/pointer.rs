//! Pointer events, the viewport and parked viewers with a real PTY (T34): without mouse
//! tracking a press, drag and release select text that frames carry back and typing clears;
//! the wheel scrolls the scrollback; a program that tracks the mouse gets the events unless
//! Shift is held; a viewer that parks after an empty frame is woken once by new output.
#![cfg(unix)]

use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::term_frame::{self, Screen, Selection};
use piarc_term::vt::{KeyAction, KeyInput, MouseAction, MouseInput};
use piarc_term::{Event, Program, Session, SessionConfig, keymap};

const WAIT: Duration = Duration::from_secs(10);
const CELL_W: u32 = 8;
const CELL_H: u32 = 16;

fn spawn() -> (Session, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let config = SessionConfig {
        cols: 40,
        rows: 10,
        cell_width: CELL_W,
        cell_height: CELL_H,
        program: Program::Command {
            program: "sh".into(),
            args: Vec::new(),
        },
        cwd: Some(std::env::temp_dir()),
        env: vec![("PS1".into(), "$ ".into()), ("ENV".into(), String::new())],
        scrollback_lines: 1000,
        ..SessionConfig::default()
    };
    let session = Session::spawn(
        config,
        Arc::new(move |event| {
            let _ = tx.lock().expect("lock").send(event);
        }),
    )
    .expect("spawn");
    (session, rx)
}

fn eventually<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_line(session: &Session, line: &str) {
    eventually(line, || {
        let text = session.viewport_text().expect("text");
        text.lines().any(|l| l == line).then_some(())
    });
}

/// The viewport row showing `line`.
fn row_of(session: &Session, line: &str) -> u16 {
    let text = session.viewport_text().expect("text");
    let index = text
        .lines()
        .position(|l| l == line)
        .expect("the line is on screen");
    u16::try_from(index).expect("row")
}

fn pointer(action: MouseAction, button: Option<u8>, col: u16, row: u16, mods: u16) -> MouseInput {
    MouseInput {
        action,
        button,
        mods,
        // Left part of the cell for presses, right part for the rest.
        x: f32::from(col) * 8.0
            + if action == MouseAction::Press {
                1.0
            } else {
                7.0
            },
        y: f32::from(row) * 16.0 + 8.0,
        clicks: 1,
    }
}

fn key(code: &str, text: &str) -> KeyInput {
    keymap::key_input(KeyAction::Press, code, text, 0, false)
}

/// Pulls frames for viewer 1 into `screen` until `done` holds.
fn pull_until(session: &Session, screen: &mut Screen, what: &str, done: impl Fn(&Screen) -> bool) {
    eventually(what, || {
        let bytes = session.frame(1, screen.seq() == 0).expect("frame");
        screen
            .apply(&term_frame::decode(&bytes).expect("decode"))
            .expect("apply");
        done(screen).then_some(())
    });
}

#[test]
fn a_drag_selects_frames_carry_it_and_typing_clears_it() {
    let (session, _events) = spawn();
    session
        .write(b"printf 'alpha beta gamma\\n'\n".to_vec())
        .expect("write");
    wait_for_line(&session, "alpha beta gamma");
    let row = row_of(&session, "alpha beta gamma");
    let mut screen = Screen::new();
    pull_until(&session, &mut screen, "the first frame", |s| s.rows() == 10);

    session
        .mouse(pointer(MouseAction::Press, Some(1), 6, row, 0))
        .expect("press");
    session
        .mouse(pointer(MouseAction::Motion, Some(1), 15, row, 0))
        .expect("drag");
    session
        .mouse(pointer(MouseAction::Release, Some(1), 15, row, 0))
        .expect("release");
    let text = eventually("the selection", || {
        Some(session.selection_text().expect("text")).filter(|t| !t.is_empty())
    });
    assert_eq!(text, "beta gamma");
    pull_until(&session, &mut screen, "the selected row", |s| {
        s.selection(row) == Some(Selection { start: 6, end: 15 })
    });

    // A double click selects the word under the pointer.
    let mut double = pointer(MouseAction::Press, Some(1), 1, row, 0);
    session.mouse(double).expect("first click");
    session
        .mouse(pointer(MouseAction::Release, Some(1), 1, row, 0))
        .expect("up");
    double.clicks = 2;
    session.mouse(double).expect("second click");
    eventually("the word", || {
        (session.selection_text().expect("text") == "alpha").then_some(())
    });

    // Typing clears it, and the frame shows that.
    session.key(key("KeyX", "x")).expect("key");
    eventually("no selection", || {
        session
            .selection_text()
            .expect("text")
            .is_empty()
            .then_some(())
    });
    pull_until(&session, &mut screen, "the cleared row", |s| {
        s.selection(row).is_none()
    });
}

#[test]
fn the_wheel_scrolls_the_scrollback_and_typing_returns_to_the_bottom() {
    let (session, _events) = spawn();
    session
        .write(b"i=0; while [ $i -lt 60 ]; do echo row-$i; i=$((i+1)); done\n".to_vec())
        .expect("write");
    wait_for_line(&session, "row-59");
    let mut screen = Screen::new();
    pull_until(&session, &mut screen, "the bottom", |s| {
        let bar = s.scrollbar();
        bar.total > 10 && bar.offset + bar.len == bar.total
    });
    let bottom = screen.scrollbar();
    for _ in 0..3 {
        session
            .mouse(pointer(MouseAction::Press, Some(4), 0, 0, 0))
            .expect("wheel up");
    }
    pull_until(&session, &mut screen, "three rows up", |s| {
        s.scrollbar().offset + 3 == bottom.offset
    });
    session.scroll(piarc_term::vt::ScrollTo::Top).expect("top");
    pull_until(&session, &mut screen, "the top", |s| {
        s.scrollbar().offset == 0
    });
    session.key(key("KeyY", "y")).expect("key");
    pull_until(&session, &mut screen, "the bottom again", |s| {
        s.scrollbar().offset == bottom.offset
    });
}

#[test]
fn a_program_that_tracks_the_mouse_gets_presses_unless_shift_is_held() {
    let (session, _events) = spawn();
    // Normal tracking (1000), then `cat -v` shows the reports it reads.
    session
        .write(b"printf '\\033[?1000h'; stty -echo; echo tracking; cat -v\n".to_vec())
        .expect("write");
    // The mode is on once the line after it is on screen.
    wait_for_line(&session, "tracking");
    session
        .mouse(pointer(MouseAction::Press, Some(1), 2, 3, 0))
        .expect("press");
    session
        .mouse(pointer(MouseAction::Release, Some(1), 2, 3, 0))
        .expect("release");
    session.write(b"\n".to_vec()).expect("newline");
    eventually("the mouse report", || {
        let text = session.viewport_text().expect("text");
        text.contains("^[[M").then_some(())
    });
    assert!(session.selection_text().expect("text").is_empty());
    // With Shift the press selects instead (the program still tracks).
    session
        .mouse(pointer(
            MouseAction::Press,
            Some(1),
            0,
            0,
            keymap::MOD_SHIFT,
        ))
        .expect("shift press");
    session
        .mouse(pointer(
            MouseAction::Motion,
            Some(1),
            5,
            0,
            keymap::MOD_SHIFT,
        ))
        .expect("shift drag");
    session
        .mouse(pointer(
            MouseAction::Release,
            Some(1),
            5,
            0,
            keymap::MOD_SHIFT,
        ))
        .expect("shift release");
    eventually("a selection", || {
        (!session.selection_text().expect("text").is_empty()).then_some(())
    });
}

#[test]
fn a_parked_viewer_is_woken_once_by_new_output() {
    let (session, events) = spawn();
    wait_for_line(&session, "$");
    let mut screen = Screen::new();
    pull_until(&session, &mut screen, "the prompt", |s| s.rows() == 10);
    // Pull until nothing changes, parking on the empty frame.
    eventually("an empty parked frame", || {
        let bytes = session.frame_parking(1, false, true).expect("frame");
        let frame = term_frame::decode(&bytes).expect("decode");
        screen.apply(&frame).expect("apply");
        frame.body.is_none().then_some(())
    });
    while events.try_recv().is_ok() {}
    session.write(b"echo woken\n".to_vec()).expect("write");
    let woke = eventually("the output event", || {
        events
            .recv_timeout(Duration::from_millis(50))
            .ok()
            .filter(|e| matches!(e, Event::Output))
    });
    assert!(matches!(woke, Event::Output));
    wait_for_line(&session, "woken");
    session.write(b"echo again\n".to_vec()).expect("write");
    wait_for_line(&session, "again");
    // A grace for a second event that must not come (it would follow the output at once).
    std::thread::sleep(Duration::from_millis(100));
    let more: Vec<Event> = events.try_iter().collect();
    assert!(
        !more.iter().any(|e| matches!(e, Event::Output)),
        "one wake per parking: {more:?}"
    );
}

#[test]
fn default_colors_reach_frames_and_programs() {
    use piarc_protocol::term_frame::Rgb;
    let (session, _events) = spawn();
    let mut screen = Screen::new();
    pull_until(&session, &mut screen, "the first frame", |s| s.rows() == 10);
    let light = Rgb {
        r: 0xf8,
        g: 0xf9,
        b: 0xfa,
    };
    let ink = Rgb {
        r: 0x1d,
        g: 0x20,
        b: 0x27,
    };
    session
        .set_colors(piarc_term::DefaultColors {
            foreground: Some(ink),
            background: Some(light),
            cursor: None,
        })
        .expect("colors");
    pull_until(&session, &mut screen, "the new colors", |s| {
        s.colors()
            .is_some_and(|c| c.background == light && c.foreground == ink)
    });
    // A program asking for the background (OSC 11) gets the theme's: the first 23 bytes of
    // the reply, read raw so no line ending is needed.
    session
        .write(
            b"stty raw -echo; printf '\\033]11;?\\007'; dd bs=1 count=23 2>/dev/null | cat -v; stty sane; echo\n"
                .to_vec(),
        )
        .expect("write");
    eventually("the color report", || {
        let text = session.viewport_text().expect("text");
        text.contains("rgb:f8f8/f9f9/fafa").then_some(())
    });
}
