use super::*;

const A: &[u8] = b"\x1b]133;A\x07";
const B: &[u8] = b"\x1b]133;B\x07";

fn terminal(cols: u16, rows: u16, scrollback: usize) -> Terminal {
    Terminal::new(cols, rows, scrollback).expect("terminal")
}

/// Feeds `bytes` and applies the marks, as the IO thread does.
fn feed(t: &mut Terminal, log: &mut CommandLog, bytes: &[u8]) -> Vec<CommandChange> {
    t.write(bytes);
    t.take_effects()
        .marks
        .into_iter()
        .flat_map(|mark| log.apply(mark))
        .collect()
}

/// One command as a shell with integration prints it: prompt, typed line, output, end.
fn command(line: &str, output: &str, exit: Option<i32>, cmdline: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(A);
    bytes.extend_from_slice(b"$ ");
    bytes.extend_from_slice(B);
    bytes.extend_from_slice(line.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    if cmdline {
        bytes.extend_from_slice(
            format!("\x1b]133;C;cmdline={}\x07", line.replace(' ', "\\ ")).as_bytes(),
        );
    } else {
        bytes.extend_from_slice(b"\x1b]133;C\x07");
    }
    bytes.extend_from_slice(output.as_bytes());
    match exit {
        Some(code) => bytes.extend_from_slice(format!("\x1b]133;D;{code}\x07").as_bytes()),
        None => bytes.extend_from_slice(b"\x1b]133;D\x07"),
    }
    bytes
}

#[test]
fn a_command_has_its_line_output_and_exit_code() {
    let mut t = terminal(40, 10, 1000);
    let mut log = CommandLog::default();
    let changes = feed(
        &mut t,
        &mut log,
        &command("ls -l", "one\r\ntwo\r\n", Some(2), true),
    );
    assert_eq!(
        changes,
        [
            CommandChange::Started {
                seq: 1,
                command: Some("ls -l".into())
            },
            CommandChange::Finished {
                seq: 1,
                exit_code: Some(2)
            },
        ]
    );
    let last = log.last(&mut t).expect("format").expect("a command");
    assert_eq!(last.command, "ls -l");
    assert_eq!(last.state, CommandState::Finished);
    assert_eq!(last.exit_code, Some(2));
    assert_eq!(last.output, "one\ntwo");
    assert_eq!(last.output_start, Some(ScreenPoint { y: 1, x: 0 }));
    assert!(last.output_complete);
}

#[test]
fn the_command_line_comes_from_the_screen_when_the_shell_sends_none() {
    let mut t = terminal(40, 10, 1000);
    let mut log = CommandLog::default();
    feed(
        &mut t,
        &mut log,
        &command("make  test", "ok\r\n", Some(0), false),
    );
    let last = log.last(&mut t).expect("format").expect("a command");
    assert_eq!(last.command, "make  test");
    assert_eq!(last.output, "ok");
}

#[test]
fn a_running_command_shows_its_output_so_far() {
    let mut t = terminal(40, 10, 1000);
    let mut log = CommandLog::default();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(A);
    bytes.extend_from_slice(b"$ ");
    bytes.extend_from_slice(B);
    bytes.extend_from_slice(b"tail -f log\r\n\x1b]133;C\x07first\r\nsecond");
    let changes = feed(&mut t, &mut log, &bytes);
    assert_eq!(changes.len(), 1);
    let last = log.last(&mut t).expect("format").expect("a command");
    assert_eq!(last.state, CommandState::Running);
    assert_eq!(last.output, "first\nsecond");
    assert_eq!(log.finished_after(0), None);
    feed(&mut t, &mut log, b"\r\n\x1b]133;D;130\x07");
    assert_eq!(log.finished_after(0), Some(1));
    let last = log.last(&mut t).expect("format").expect("a command");
    assert_eq!(
        (last.exit_code, last.output.as_str()),
        (Some(130), "first\nsecond")
    );
}

#[test]
fn a_prompt_without_an_end_finishes_the_command_without_an_exit_code() {
    let mut t = terminal(40, 10, 1000);
    let mut log = CommandLog::default();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(A);
    bytes.extend_from_slice(b"$ ");
    bytes.extend_from_slice(B);
    bytes.extend_from_slice(b"true\r\n\x1b]133;C\x07");
    feed(&mut t, &mut log, &bytes);
    let changes = feed(&mut t, &mut log, A);
    assert_eq!(
        changes,
        [CommandChange::Finished {
            seq: 1,
            exit_code: None
        }]
    );
    // A second end for the same command is ignored.
    assert!(feed(&mut t, &mut log, b"\x1b]133;D;0\x07").is_empty());
}

#[test]
fn boundaries_follow_the_content_and_vanish_with_the_scrollback() {
    let mut t = terminal(20, 4, 10);
    let mut log = CommandLog::default();
    feed(&mut t, &mut log, &command("echo a", "a\r\n", Some(0), true));
    feed(&mut t, &mut log, &command("echo b", "b\r\n", Some(1), true));
    // Scroll the first command into the scrollback, still present.
    let filler: String = (0..5).map(|i| format!("x{i}\r\n")).collect();
    feed(&mut t, &mut log, filler.as_bytes());
    let first = log.get(1, &mut t).expect("format").expect("kept");
    assert_eq!((first.output.as_str(), first.exit_code), ("a", Some(0)));
    // Push it out of the scrollback (libghostty-vt prunes whole pages, so the limit of 10
    // lines keeps more than 10 rows; a few thousand rows certainly drop the first page).
    let filler: String = (0..5000).map(|i| format!("y{i}\r\n")).collect();
    feed(&mut t, &mut log, filler.as_bytes());
    let first = log
        .get(1, &mut t)
        .expect("format")
        .expect("kept in the log");
    assert_eq!(first.output_start, None);
    assert!(!first.output_complete);
    assert_eq!(first.output, "");
    assert_eq!(first.command, "echo a", "the reported line stays");
}

#[test]
fn the_log_keeps_the_newest_commands() {
    let mut t = terminal(20, 4, 100);
    let mut log = CommandLog::default();
    for i in 0..(MAX_COMMANDS + 3) {
        feed(
            &mut t,
            &mut log,
            &command(&format!("c{i}"), "", Some(0), true),
        );
    }
    assert_eq!(
        log.last_seq(),
        u64::try_from(MAX_COMMANDS + 3).expect("fits")
    );
    assert!(log.get(1, &mut t).expect("format").is_none());
    assert!(log.get(4, &mut t).expect("format").is_some());
}

#[test]
fn a_reset_forgets_the_boundaries() {
    let mut t = terminal(20, 4, 100);
    let mut log = CommandLog::default();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(A);
    bytes.extend_from_slice(B);
    bytes.extend_from_slice(b"vim\r\n\x1b]133;C\x07");
    feed(&mut t, &mut log, &bytes);
    t.write(b"\x1bc");
    assert!(t.take_effects().reset);
    log.reset();
    let last = log.last(&mut t).expect("format").expect("a command");
    assert_eq!(last.state, CommandState::Finished);
    assert_eq!(last.output_start, None);
}
