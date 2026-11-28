//! The read-screen API (T33-A01): the formatter's plain text of the active screen equals the
//! terminal state cell by cell (read through the render state, the same data frames are built
//! from), with wide characters, wrapped lines and the alternate screen; the scrollback ranges
//! and unwrapping agree with it.

use piarc_protocol::term_frame::Wide;
use piarc_term::vt::{RenderState, Terminal, TextOptions, TextRange, plain_text};

/// The active area as the render state holds it: per row, each grapheme once, empty cells as
/// spaces, spacer cells skipped, trailing spaces and trailing blank rows removed. Also checks
/// that every wide cell is followed by its spacer tail.
fn render_state_text(terminal: &mut Terminal) -> String {
    let mut state = RenderState::new().expect("render state");
    state.begin_update(terminal).expect("begin");
    state.end_update().expect("end");
    let colors = state.colors().expect("colors");
    let mut lines = Vec::new();
    let mut cells = Vec::new();
    state
        .for_each_row(|row| {
            row.read_cells(&colors.palette, &mut cells)?;
            let mut line = String::new();
            for (x, cell) in cells.iter().enumerate() {
                match cell.wide {
                    Wide::SpacerTail | Wide::SpacerHead => {}
                    Wide::Wide => {
                        assert_eq!(
                            cells.get(x + 1).map(|c| c.wide),
                            Some(Wide::SpacerTail),
                            "a wide cell is followed by its tail"
                        );
                        line.push_str(&cell.text);
                    }
                    Wide::Narrow if cell.text.is_empty() => line.push(' '),
                    Wide::Narrow => line.push_str(&cell.text),
                }
            }
            line.truncate(line.trim_end_matches(' ').len());
            lines.push(line);
            Ok(())
        })
        .expect("rows");
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

fn screen(terminal: &mut Terminal) -> String {
    plain_text(terminal, TextRange::Screen, TextOptions::default()).expect("text")
}

fn assert_same(case: &str, terminal: &mut Terminal) -> String {
    let formatted = screen(terminal);
    assert_eq!(
        formatted,
        render_state_text(terminal),
        "{case}: the read-screen text and the terminal state differ"
    );
    formatted
}

#[test]
fn wide_characters_read_as_the_cells_show_them() {
    let mut t = Terminal::new(12, 4, 1000).expect("terminal");
    t.write("中文 ok\r\n😀x 👨\u{200d}👩\u{200d}👧\r\ne\u{301}t\u{e9} ＡＢ".as_bytes());
    let text = assert_same("wide", &mut t);
    assert_eq!(
        text,
        "中文 ok\n😀x 👨\u{200d}👩\u{200d}👧\ne\u{301}t\u{e9} ＡＢ"
    );
}

#[test]
fn wrapped_lines_are_rows_or_one_line_unwrapped() {
    let mut t = Terminal::new(10, 5, 1000).expect("terminal");
    // 25 characters wrap over three rows; a wide character at the edge wraps with a spacer
    // head left behind.
    t.write(b"abcdefghijklmnopqrstuvwxy\r\n");
    t.write("123456789中尾".as_bytes());
    let text = assert_same("wrap", &mut t);
    assert_eq!(text, "abcdefghij\nklmnopqrst\nuvwxy\n123456789\n中尾");
    let unwrapped = plain_text(
        &mut t,
        TextRange::Screen,
        TextOptions {
            unwrap: true,
            trim: true,
        },
    )
    .expect("text");
    assert_eq!(unwrapped, "abcdefghijklmnopqrstuvwxy\n123456789中尾");
}

#[test]
fn the_alternate_screen_reads_as_shown_and_the_primary_comes_back() {
    let mut t = Terminal::new(20, 4, 1000).expect("terminal");
    for i in 0..10 {
        t.write(format!("shell {i}\r\n").as_bytes());
    }
    t.write(b"$ ");
    let primary = assert_same("primary", &mut t);
    // A full-screen program: alternate screen, cleared, drawn with cursor addressing.
    t.write(b"\x1b[?1049h\x1b[2J\x1b[1;1Hvim \xe4\xb8\xad\x1b[3;5H~ line");
    let alternate = assert_same("alternate", &mut t);
    assert_eq!(alternate, "vim 中\n\n    ~ line");
    // Every range covers the alternate screen only: it has no scrollback.
    for range in [TextRange::All, TextRange::LastRows(100)] {
        assert_eq!(
            plain_text(&mut t, range, TextOptions::default()).expect("text"),
            alternate,
            "{range:?} on the alternate screen"
        );
    }
    t.write(b"\x1b[?1049l");
    assert_eq!(assert_same("back", &mut t), primary);
}

#[test]
fn scrollback_ranges_cover_the_history() {
    let mut t = Terminal::new(20, 3, 1000).expect("terminal");
    let lines: Vec<String> = (0..8).map(|i| format!("line {i}")).collect();
    t.write(lines.join("\r\n").as_bytes());
    assert_same("scrolled", &mut t);
    assert_eq!(screen(&mut t), "line 5\nline 6\nline 7");
    assert_eq!(
        plain_text(&mut t, TextRange::All, TextOptions::default()).expect("text"),
        lines.join("\n")
    );
    assert_eq!(
        plain_text(&mut t, TextRange::LastRows(4), TextOptions::default()).expect("text"),
        "line 4\nline 5\nline 6\nline 7"
    );
    assert_eq!(
        plain_text(&mut t, TextRange::LastRows(0), TextOptions::default()).expect("text"),
        ""
    );
    assert_eq!(
        plain_text(&mut t, TextRange::LastRows(1000), TextOptions::default()).expect("text"),
        lines.join("\n")
    );
}

#[test]
fn ten_thousand_lines_stay_in_the_scrollback() {
    let mut t = Terminal::new(80, 24, 10_000).expect("terminal");
    let text: String = (0..10_000).map(|i| format!("row {i}\r\n")).collect();
    t.write(text.as_bytes());
    assert!(t.total_rows() >= 10_000, "kept {} rows", t.total_rows());
    let all = plain_text(&mut t, TextRange::All, TextOptions::default()).expect("text");
    assert!(all.starts_with("row 0\nrow 1\n"), "{}", &all[..40]);
    assert!(all.ends_with("row 9999"));
}

#[test]
fn the_last_lines_skip_the_blank_rows_below_the_cursor() {
    let mut t = Terminal::new(20, 24, 1000).expect("terminal");
    t.write(b"one\r\ntwo\r\nthree\r\n");
    let last = |t: &mut Terminal, n| {
        plain_text(t, TextRange::LastRows(n), TextOptions::default()).expect("text")
    };
    assert_eq!(last(&mut t, 2), "two\nthree");
    assert_eq!(last(&mut t, 10), "one\ntwo\nthree");
    // Many blank lines printed on purpose still count only after the last content.
    t.write(&b"\r\n".repeat(60));
    t.write(b"four");
    assert_eq!(last(&mut t, 1), "four");
    assert_eq!(last(&mut t, 3), "\n\nfour");
}
