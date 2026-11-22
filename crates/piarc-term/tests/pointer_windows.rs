//! The cases of `pointer.rs` in a real ConPTY (W3, I163): cmd.exe makes the output and vim from
//! Git for Windows tracks the mouse.
#![cfg(windows)]

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::term_frame::{self, Screen, Selection};
use piarc_term::vt::{KeyAction, KeyInput, MouseAction, MouseInput};
use piarc_term::{Event, Program, Session, SessionConfig, keymap};

const WAIT: Duration = Duration::from_secs(15);
const CELL_W: u32 = 8;
const CELL_H: u32 = 16;

fn spawn(program: &str, args: &[&str]) -> (Session, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let config = SessionConfig {
        cols: 40,
        rows: 10,
        cell_width: CELL_W,
        cell_height: CELL_H,
        program: Program::Command {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        },
        cwd: Some(std::env::temp_dir()),
        env: vec![("PROMPT".into(), "$$$S".into())],
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

/// cmd.exe with a `$ ` prompt and no command echo, once the prompt is on screen.
fn shell() -> (Session, Receiver<Event>) {
    let (session, events) = spawn("cmd.exe", &["/Q", "/K"]);
    wait_for_line(&session, "$");
    (session, events)
}

/// A program shipped with Git for Windows (`<git>\usr\bin\<name>`).
fn git_program(name: &str) -> PathBuf {
    let output = std::process::Command::new("git")
        .arg("--exec-path")
        .output()
        .expect("git is on PATH");
    // <git>\mingw64\libexec\git-core
    let exec_path = PathBuf::from(String::from_utf8(output.stdout).expect("UTF-8").trim());
    let program = exec_path
        .ancestors()
        .nth(3)
        .expect("the Git installation")
        .join("usr")
        .join("bin")
        .join(name);
    assert!(program.is_file(), "{} is missing", program.display());
    program
}

fn eventually<T>(session: &Session, what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}; screen:\n{}",
            session.viewport_text().unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_line(session: &Session, line: &str) {
    eventually(session, line, || {
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
    eventually(session, what, || {
        let bytes = session.frame(1, screen.seq() == 0).expect("frame");
        screen
            .apply(&term_frame::decode(&bytes).expect("decode"))
            .expect("apply");
        done(screen).then_some(())
    });
}

#[test]
fn a_drag_selects_frames_carry_it_and_typing_clears_it() {
    let (session, _events) = shell();
    // The loop prints the line; the echoed command line differs from it.
    session
        .write(b"for %w in (gamma) do @echo alpha beta %w\r".to_vec())
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
    let text = eventually(&session, "the selection", || {
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
    eventually(&session, "the word", || {
        (session.selection_text().expect("text") == "alpha").then_some(())
    });

    // Typing clears it, and the frame shows that.
    session.key(key("KeyX", "x")).expect("key");
    eventually(&session, "no selection", || {
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
    let (session, _events) = shell();
    session
        .write(b"for /L %i in (0,1,59) do @echo row-%i\r".to_vec())
        .expect("write");
    wait_for_line(&session, "row-59");
    // cmd's prompt follows the loop's output: wait for it so the scrollback stops growing.
    eventually(&session, "the prompt after the loop", || {
        let text = session.viewport_text().expect("text");
        let mut lines = text.lines().filter(|l| !l.is_empty());
        (lines.next_back() == Some("$")).then_some(())
    });
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

/// vim with `mouse=a` turns on mouse tracking through ConPTY: a click moves its cursor (the
/// terminal makes no selection), while a Shift drag still selects.
#[test]
fn a_program_that_tracks_the_mouse_gets_presses_unless_shift_is_held() {
    let dir = std::env::temp_dir().join(format!("piarc-term-mouse-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let file = dir.join("lines.txt");
    std::fs::write(&file, "first line\nsecond line\nthird line\n").expect("file");
    let path = file.to_string_lossy().into_owned();
    let (session, _events) = spawn(
        &git_program("vim.exe").to_string_lossy(),
        &[
            "-u",
            "NONE",
            "-i",
            "NONE",
            "-N",
            "--cmd",
            "set encoding=utf-8 mouse=a ttymouse=sgr",
            &path,
        ],
    );
    wait_for_line(&session, "second line");
    // vim turns tracking on as it starts; give the mode change time to pass through ConPTY.
    std::thread::sleep(Duration::from_millis(500));
    let row = row_of(&session, "second line");
    // A click on the `c` of `second`, then insert an X before it. Mouse reports and keys go
    // through one writer queue, so vim reads them in this order.
    session
        .mouse(pointer(MouseAction::Press, Some(1), 2, row, 0))
        .expect("press");
    session
        .mouse(pointer(MouseAction::Release, Some(1), 2, row, 0))
        .expect("release");
    session.write(b"iX\x1b".to_vec()).expect("insert");
    wait_for_line(&session, "seXcond line");
    assert!(session.selection_text().expect("text").is_empty());
    // With Shift the drag selects instead (vim still tracks).
    for (action, col) in [
        (MouseAction::Press, 0),
        (MouseAction::Motion, 5),
        (MouseAction::Release, 5),
    ] {
        session
            .mouse(pointer(action, Some(1), col, 0, keymap::MOD_SHIFT))
            .expect("shift drag");
    }
    eventually(&session, "a selection", || {
        (!session.selection_text().expect("text").is_empty()).then_some(())
    });
    session.write(b":q!\r".to_vec()).expect("quit");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_parked_viewer_is_woken_once_by_new_output() {
    let (session, events) = shell();
    let mut screen = Screen::new();
    pull_until(&session, &mut screen, "the prompt", |s| s.rows() == 10);
    // Pull until nothing changes, parking on the empty frame.
    eventually(&session, "an empty parked frame", || {
        let bytes = session.frame_parking(1, false, true).expect("frame");
        let frame = term_frame::decode(&bytes).expect("decode");
        screen.apply(&frame).expect("apply");
        frame.body.is_none().then_some(())
    });
    while events.try_recv().is_ok() {}
    session.write(b"echo woken\r".to_vec()).expect("write");
    let woke = eventually(&session, "the output event", || {
        events
            .recv_timeout(Duration::from_millis(50))
            .ok()
            .filter(|e| matches!(e, Event::Output))
    });
    assert!(matches!(woke, Event::Output));
    wait_for_line(&session, "woken");
    session.write(b"echo again\r".to_vec()).expect("write");
    wait_for_line(&session, "again");
    // A grace for a second event that must not come (it would follow the output at once).
    std::thread::sleep(Duration::from_millis(100));
    let more: Vec<Event> = events.try_iter().collect();
    assert!(
        !more.iter().any(|e| matches!(e, Event::Output)),
        "one wake per parking: {more:?}"
    );
}

/// Unlike `pointer.rs` there is no OSC 11 answer to check: conhost draws its own buffer into
/// the pseudo console and does not pass a program's color query on, so nothing answers it
/// (W3: Git's bash waited 5 s for a reply that never came).
#[test]
fn default_colors_reach_frames() {
    use piarc_protocol::term_frame::Rgb;
    let (session, _events) = shell();
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
}
