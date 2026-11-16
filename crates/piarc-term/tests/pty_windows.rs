//! Sessions with a real ConPTY (W0, T10-A04 on Windows): the Unix cases of `pty.rs` with
//! Windows programs. cmd.exe is the shell; PowerShell writes escape sequences; vim is the one
//! Git for Windows ships (MSYS2, which talks to ConPTY like any console program).
#![cfg(windows)]

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use piarc_protocol::term_frame::{self, Screen};
use piarc_term::vt::{KeyAction, KeyInput};
use piarc_term::{Event, Program, Session, SessionConfig};

const WAIT: Duration = Duration::from_secs(15);

/// cmd.exe with a plain `$ ` prompt (`PROMPT=$$$S`) and no command echo.
const SHELL: (&str, &[&str]) = ("cmd.exe", &["/Q", "/K"]);

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
        env: vec![("PROMPT".into(), "$$$S".into())],
        scrollback_lines: 1000,
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

fn shell() -> (Session, Receiver<Event>) {
    let (session, events) = spawn(SHELL.0, SHELL.1);
    // The screen text drops the prompt's trailing space.
    wait_for_screen(&session, "the prompt", |text| text.starts_with('$'));
    (session, events)
}

fn powershell(script: &str) -> (Session, Receiver<Event>) {
    spawn(
        "powershell.exe",
        &[
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
    )
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
    let (session, _events) = shell();
    // The shell computes the number, so the line is its output, not the echoed input.
    session
        .write(b"for /L %i in (42,1,42) do @echo piarc-%i\r".to_vec())
        .expect("write");
    wait_for_screen(&session, "the command output", |text| {
        text.lines().any(|line| line == "piarc-42")
    });
}

#[test]
fn key_events_are_encoded_and_written() {
    let (session, _events) = shell();
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
    let (session, _events) = shell();
    session.resize(100, 30, 8, 16).expect("resize");
    session
        .write(b"powershell -NoProfile -Command \"$s = $Host.UI.RawUI.WindowSize; 'size ' + $s.Height + ' ' + $s.Width\"\r".to_vec())
        .expect("write");
    wait_for_screen(&session, "the new size", |text| {
        text.lines().any(|l| l == "size 30 100")
    });
    let frame = term_frame::decode(&session.frame(1, true).expect("frame")).expect("decode");
    assert_eq!((frame.cols, frame.rows), (100, 30));
}

#[test]
fn ctrl_c_interrupts_the_running_command() {
    let (session, _events) = shell();
    session
        .write(b"ping -n 30 127.0.0.1\r".to_vec())
        .expect("write");
    wait_for_screen(&session, "a reply from ping", |text| text.contains("TTL="));
    session.write(vec![0x03]).expect("ctrl-c");
    // ping would run for 30 s, longer than the wait: the next command's output only shows up in
    // time if Ctrl+C ended it.
    session.write(b"echo still-here\r".to_vec()).expect("write");
    wait_for_screen(&session, "the shell after Ctrl+C", |text| {
        text.lines().any(|l| l == "still-here")
    });
}

#[test]
fn the_exit_code_is_reported() {
    let (session, events) = spawn("cmd.exe", &["/C", "exit 7"]);
    assert_eq!(wait_for_exit(&events), Some(7));
    assert_eq!(session.exit(), Some(Some(7)));
    // The last screen stays readable.
    assert!(session.frame(1, true).is_ok());
}

#[test]
fn closing_kills_the_program() {
    let (session, events) = shell();
    session.close();
    let _ = wait_for_exit(&events);
    assert!(session.write(b"x".to_vec()).is_err());
}

#[test]
fn title_and_bell_become_events() {
    let (_session, events) = powershell(
        "$Host.UI.RawUI.WindowTitle = 'piarc title'; [Console]::Write([char]7); Start-Sleep -Milliseconds 300",
    );
    let mut titles = Vec::new();
    let mut bells = 0;
    loop {
        match events.recv_timeout(WAIT).expect("events") {
            Event::Title(t) => titles.push(t),
            Event::Bell { count } => bells += count,
            Event::Exited { .. } => break,
        }
    }
    assert!(titles.iter().any(|t| t == "piarc title"), "{titles:?}");
    assert_eq!(bells, 1);
}

#[test]
fn frames_of_a_live_session_rebuild_the_formatter_screen() {
    let (session, _events) = powershell(
        "$e = [char]27; [Console]::OutputEncoding = [Text.Encoding]::UTF8; \
         [Console]::Write(\"a`nb`n$e[1;33m\" + [char]0x4E2D + [char]0x6587 + \"$e[0m`n\"); \
         Start-Sleep -Seconds 5",
    );
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
    // cmd's line input echoes what it reads, like cat in a cooked Unix terminal.
    let (session, _events) = shell();
    let elapsed = session
        .probe_direct_echo(b'Q', Duration::from_secs(5))
        .expect("echo");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
}

/// vim from Git for Windows (`<git>\usr\bin\vim.exe`), found next to `git` on PATH.
fn git_vim() -> PathBuf {
    let output = std::process::Command::new("git")
        .arg("--exec-path")
        .output()
        .expect("git is on PATH");
    // <git>\mingw64\libexec\git-core
    let exec_path = PathBuf::from(String::from_utf8(output.stdout).expect("UTF-8").trim());
    let vim = exec_path
        .ancestors()
        .nth(3)
        .expect("the Git installation")
        .join("usr")
        .join("bin")
        .join("vim.exe");
    assert!(vim.is_file(), "{} is missing", vim.display());
    vim
}

/// Real vim on the alternate screen: the screen rebuilt from frames equals the formatter's text
/// while vim runs and after it quits.
#[test]
fn vim_on_the_alternate_screen_matches_the_formatter() {
    let dir = std::env::temp_dir().join(format!("piarc-term-vim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let file = dir.join("notes.txt");
    std::fs::write(&file, "first line\n中文 second\nthird 😀\n").expect("file");
    let path = file.to_string_lossy().into_owned();
    let (session, events) = spawn(
        &git_vim().to_string_lossy(),
        &["-u", "NONE", "-i", "NONE", "-N", &path],
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
