//! Sessions with a real PTY (T10-A04): input and output, resizing, exit detection, and a
//! terminal query answered through `WRITE_PTY`. Unix only: ConPTY on Windows is verified on
//! real hardware in W0 (docs/spikes/S07-terminal.md).
#![cfg(unix)]

use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::term_frame::{self, Screen};
use piarc_term::vt::{KeyAction, KeyInput};
use piarc_term::{Event, Program, Session, SessionConfig};

const WAIT: Duration = Duration::from_secs(10);

fn config(program: &str, args: &[&str]) -> SessionConfig {
    SessionConfig {
        cols: 80,
        rows: 24,
        cell_width: 8,
        cell_height: 16,
        program: Program::Command {
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        },
        cwd: Some(std::env::temp_dir()),
        // A plain prompt keeps screen checks independent of the user's shell setup.
        env: vec![("PS1".into(), "$ ".into()), ("ENV".into(), String::new())],
        scrollback_lines: 1000,
        ..SessionConfig::default()
    }
}

fn spawn(program: &str, args: &[&str]) -> (Session, Receiver<Event>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let session = Session::spawn(
        config(program, args),
        Arc::new(move |event| {
            // The test may have stopped listening.
            let _ = tx.lock().expect("lock").send(event);
        }),
    )
    .expect("spawn");
    (session, rx)
}

/// Polls the screen until `predicate` holds or the wait times out.
fn wait_for_screen(session: &Session, what: &str, predicate: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        let text = session.viewport_text().expect("text");
        if predicate(&text) {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}; screen:\n{text}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_exit(rx: &Receiver<Event>) -> Option<u32> {
    let deadline = Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if let Event::Exited { code } = rx.recv_timeout(left).expect("an Exited event") {
            return code;
        }
    }
}

fn key(code: &str, text: &str) -> KeyInput {
    KeyInput {
        action: KeyAction::Press,
        key: piarc_term::keymap::key_for_code(code),
        mods: 0,
        consumed_mods: 0,
        composing: false,
        text: text.into(),
        unshifted: text.chars().next().map_or(0, u32::from),
    }
}

#[test]
fn a_shell_takes_input_and_shows_output() {
    let (session, _events) = spawn("sh", &[]);
    session
        .write(b"echo piarc-$((40+2))\n".to_vec())
        .expect("write");
    wait_for_screen(&session, "the command output", |text| {
        text.lines().any(|line| line == "piarc-42")
    });
}

#[test]
fn key_events_are_encoded_and_written() {
    let (session, _events) = spawn("sh", &[]);
    for (code, text) in [
        ("KeyE", "e"),
        ("KeyC", "c"),
        ("KeyH", "h"),
        ("KeyO", "o"),
        ("Space", " "),
        ("KeyK", "k"),
        ("Enter", ""),
    ] {
        session.key(key(code, text)).expect("key");
    }
    wait_for_screen(&session, "the output of echo k", |text| {
        text.lines().any(|line| line == "k")
    });
}

#[test]
fn resizing_reaches_the_program() {
    let (session, _events) = spawn("sh", &[]);
    session.resize(100, 30, 8, 16).expect("resize");
    session.write(b"stty size\n".to_vec()).expect("write");
    wait_for_screen(&session, "the new size", |text| {
        text.lines().any(|l| l == "30 100")
    });
    let frame = term_frame::decode(&session.frame(1, true).expect("frame")).expect("decode");
    assert_eq!((frame.cols, frame.rows), (100, 30));
}

#[test]
fn the_exit_code_is_reported() {
    let (session, events) = spawn("sh", &["-c", "exit 7"]);
    assert_eq!(wait_for_exit(&events), Some(7));
    assert_eq!(session.exit(), Some(Some(7)));
    // The last screen stays readable.
    assert!(session.frame(1, true).is_ok());
}

#[test]
fn closing_kills_the_program() {
    let (session, events) = spawn("sh", &[]);
    session.close();
    let _ = wait_for_exit(&events);
    assert!(session.write(b"x".to_vec()).is_err());
}

#[test]
fn a_device_attribute_query_is_answered_through_write_pty() {
    // The program asks the terminal what it is (DA1) and checks the answer itself.
    let script = "stty raw -echo; printf '\\033[c'; reply=$(dd bs=1 count=9 2>/dev/null); \
                  stty sane; if [ \"$reply\" = \"$(printf '\\033[?62;22c')\" ]; \
                  then echo DA-OK; else echo DA-BAD; fi";
    let (session, events) = spawn("sh", &["-c", script]);
    assert_eq!(wait_for_exit(&events), Some(0));
    wait_for_screen(&session, "the answer check", |text| text.contains("DA-OK"));
}

#[test]
fn title_and_bell_become_events() {
    let (_session, events) = spawn(
        "sh",
        &["-c", "printf '\\033]2;piarc title\\007\\007'; sleep 0.2"],
    );
    let mut title = None;
    let mut bells = 0;
    loop {
        match events.recv_timeout(WAIT).expect("events") {
            Event::Title(t) => title = Some(t),
            Event::Bell { count } => bells += count,
            Event::Exited { .. } => break,
            _ => {}
        }
    }
    assert_eq!(title.as_deref(), Some("piarc title"));
    assert_eq!(bells, 1);
}

#[test]
fn frames_of_a_live_session_rebuild_the_formatter_screen() {
    let (session, _events) = spawn("sh", &[]);
    session
        .write(b"printf 'a\\nb\\n\\033[1;33m\\344\\270\\255\\346\\226\\207\\033[0m\\n'\n".to_vec())
        .expect("write");
    wait_for_screen(&session, "the output", |text| text.contains("中文"));
    let mut screen = Screen::new();
    // A first frame resets; later frames only carry changes.
    for full in [true, false, false] {
        let frame = term_frame::decode(&session.frame(3, full).expect("frame")).expect("decode");
        screen.apply(&frame).expect("apply");
    }
    assert_eq!(screen.plain_text(), session.viewport_text().expect("text"));
    let stats = session.stats();
    assert!(stats.frames >= 3 && stats.bytes_read > 0);
}

#[test]
fn the_direct_echo_probe_measures_the_pty_round_trip() {
    let (session, _events) = spawn("cat", &[]);
    let elapsed = session
        .probe_direct_echo(b'Q', Duration::from_secs(5))
        .expect("echo");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
}

/// Real vim on the alternate screen (macOS ships /usr/bin/vim): the screen rebuilt from frames
/// equals the formatter's text while vim runs and after it quits.
#[cfg(target_os = "macos")]
#[test]
fn vim_on_the_alternate_screen_matches_the_formatter() {
    let dir = std::env::temp_dir().join(format!("piarc-term-vim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let file = dir.join("notes.txt");
    std::fs::write(&file, "first line\n中文 second\nthird 😀\n").expect("file");
    let path = file.to_string_lossy().into_owned();
    // With `-u NONE` vim takes its encoding from the locale; where LANG is unset (CI runners,
    // some agent shells) it reads the file as latin1. `--cmd` runs before the file is read.
    let (session, events) = spawn(
        "vim",
        &[
            "-u",
            "NONE",
            "-i",
            "NONE",
            "-N",
            "--cmd",
            "set encoding=utf-8",
            &path,
        ],
    );
    wait_for_screen(&session, "vim's file view", |text| {
        text.contains("中文 second") && text.lines().filter(|l| *l == "~").count() > 3
    });
    let mut screen = Screen::new();
    let mut full = true;
    let compare = |screen: &mut Screen, full: &mut bool| {
        let frame = term_frame::decode(&session.frame(9, *full).expect("frame")).expect("decode");
        *full = false;
        screen.apply(&frame).expect("apply");
        assert_eq!(screen.plain_text(), session.viewport_text().expect("text"));
    };
    compare(&mut screen, &mut full);
    session.write(b"ggAX\x1b".to_vec()).expect("edit");
    wait_for_screen(&session, "the edit", |text| text.contains("first lineX"));
    compare(&mut screen, &mut full);
    session.write(b":q!\r".to_vec()).expect("quit");
    assert_eq!(wait_for_exit(&events), Some(0));
    compare(&mut screen, &mut full);
    let _ = std::fs::remove_dir_all(&dir);
}
