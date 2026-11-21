use piarc_ghostty_sys as sys;
use piarc_protocol::term_frame::{Dirty, Wide};

use super::*;

fn terminal(cols: u16, rows: u16) -> Terminal {
    Terminal::new(cols, rows, 1000).expect("terminal")
}

#[test]
fn device_attribute_queries_are_answered_through_write_pty() {
    let mut t = terminal(80, 24);
    t.write(b"\x1b[c");
    let effects = t.take_effects();
    assert_eq!(effects.replies, b"\x1b[?62;22c");
    t.write(b"\x1b[5n"); // device status report
    assert_eq!(t.take_effects().replies, b"\x1b[0n");
    // Cursor position report: row 3, column 5 (1-based).
    t.write(b"\x1b[3;5H\x1b[6n");
    assert_eq!(t.take_effects().replies, b"\x1b[3;5R");
}

#[test]
fn the_working_directory_and_a_reset_are_recorded() {
    let mut t = terminal(80, 24);
    t.write(b"\x1b]7;file://host/tmp/a%20b\x07");
    assert_eq!(
        t.take_effects().pwd.as_deref(),
        Some("file://host/tmp/a%20b")
    );
    assert_eq!(t.pwd(), "file://host/tmp/a%20b");
    t.write(b"\x1b]2;title\x07\x1bc");
    let effects = t.take_effects();
    assert!(effects.reset);
    assert_eq!(effects.title, None, "a reset clears the title it set");
    assert_eq!(t.title(), "");
}

#[test]
fn clipboard_reads_are_denied_and_writes_follow_the_setting() {
    let mut t = terminal(80, 24);
    // OSC 52 read: the program gets an empty clipboard, never the user's.
    t.write(b"\x1b]52;c;?\x07");
    let effects = t.take_effects();
    assert_eq!(effects.replies, b"\x1b]52;c;\x07");
    assert_eq!(effects.clipboard_reads_denied, 1);
    // OSC 52 write ("hello" in base64) reaches the record.
    t.write(b"\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(t.take_effects().clipboard, ["hello"]);
    t.set_clipboard_write(false);
    t.write(b"\x1b]52;c;aGVsbG8=\x07");
    assert!(t.take_effects().clipboard.is_empty());
}

#[test]
fn osc_133_steps_carry_the_command_line_the_exit_code_and_the_cell() {
    let mut t = terminal(40, 5);
    t.write(b"\x1b]133;A\x07$ \x1b]133;B\x07echo hi\r\n\x1b]133;C;cmdline_url=echo%20hi\x07hi\r\n\x1b]133;D;3\x07");
    let marks = t.take_effects().marks;
    let kinds: Vec<SemanticKind> = marks.iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        [
            SemanticKind::PromptStart,
            SemanticKind::InputStart,
            SemanticKind::OutputStart,
            SemanticKind::CommandEnd
        ]
    );
    assert_eq!(marks[2].command.as_deref(), Some("echo hi"));
    assert_eq!(marks[3].exit_code, Some(3));
    let cells: Vec<Option<ScreenPoint>> = marks
        .iter()
        .map(|m| m.at.as_ref().and_then(|p| p.point(&mut t)))
        .collect();
    assert_eq!(
        cells,
        [
            Some(ScreenPoint { y: 0, x: 0 }),
            Some(ScreenPoint { y: 0, x: 2 }),
            Some(ScreenPoint { y: 1, x: 0 }),
            Some(ScreenPoint { y: 2, x: 0 }),
        ]
    );
    // The shell-escaped form of the command line decodes too.
    t.write(b"\x1b]133;C;cmdline=echo\\ there\x07");
    assert_eq!(
        t.take_effects().marks[0].command.as_deref(),
        Some("echo there")
    );
}

#[test]
fn title_and_bell_are_recorded() {
    let mut t = terminal(80, 24);
    t.write(b"\x1b]2;build \xe2\x9c\x93\x07\x07\x07");
    let effects = t.take_effects();
    assert_eq!(effects.title.as_deref(), Some("build ✓"));
    assert_eq!(effects.bells, 2);
    assert!(t.take_effects().is_empty());
}

#[test]
fn the_formatter_returns_the_viewport_only() {
    let mut t = terminal(10, 3);
    t.write(b"one\r\ntwo\r\nthree\r\nfour\r\n\xe4\xb8\xad\xe6\x96\x87");
    assert_eq!(viewport_text(&mut t).expect("text"), "three\nfour\n中文");
}

#[test]
fn the_render_state_reports_rows_cells_and_styles() {
    let mut t = terminal(6, 2);
    t.write(b"\x1b[1;31mhi\x1b[0m \xe4\xb8\xad");
    let mut state = RenderState::new().expect("state");
    state.begin_update(&mut t).expect("begin");
    state.end_update().expect("end");
    assert_eq!(state.size().expect("size"), (6, 2));
    assert_eq!(state.dirty().expect("dirty"), Dirty::Full);
    let colors = state.colors().expect("colors");
    let cursor = state.cursor().expect("cursor");
    assert_eq!((cursor.x, cursor.y, cursor.in_viewport), (5, 0, true));
    let mut rows = Vec::new();
    state
        .for_each_row(|row| {
            let mut cells = Vec::new();
            row.read_cells(&colors.palette, &mut cells)?;
            rows.push((row.id()?, cells));
            Ok(())
        })
        .expect("rows");
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0].0, rows[1].0, "rows have distinct ids");
    let first = &rows[0].1;
    assert_eq!(first[0].text, "h");
    assert_eq!(
        first[0].style.fg,
        Some(colors.palette[1]),
        "red resolves through the palette"
    );
    assert_eq!(first[0].style.flags & 1, 1, "bold");
    assert_eq!(first[2].text, " ", "a written space is text");
    assert_eq!(first[5].text, "", "an untouched cell has none");
    assert_eq!((first[3].wide, first[3].text.as_str()), (Wide::Wide, "中"));
    assert_eq!(first[4].wide, Wide::SpacerTail);
    state.clean();
    state.begin_update(&mut t).expect("begin");
    state.end_update().expect("end");
    assert_eq!(state.dirty().expect("dirty"), Dirty::Clean);
}

#[test]
fn the_key_encoder_follows_the_cursor_key_mode() {
    let mut t = terminal(80, 24);
    let mut encoder = KeyEncoder::new().expect("encoder");
    let up = KeyInput {
        action: KeyAction::Press,
        key: sys::GHOSTTY_KEY_ARROW_UP,
        mods: 0,
        consumed_mods: 0,
        composing: false,
        text: String::new(),
        unshifted: 0,
    };
    let mut out = Vec::new();
    encoder.sync(&mut t).expect("sync");
    encoder.encode(&up, &mut out).expect("encode");
    assert_eq!(out, b"\x1b[A");
    t.write(b"\x1b[?1h"); // DECCKM: application cursor keys
    out.clear();
    encoder.sync(&mut t).expect("sync");
    encoder.encode(&up, &mut out).expect("encode");
    assert_eq!(out, b"\x1bOA");
    let ctrl_c = KeyInput {
        key: sys::GHOSTTY_KEY_C,
        mods: 2, // GHOSTTY_MODS_CTRL
        text: "c".into(),
        unshifted: u32::from('c'),
        ..up
    };
    out.clear();
    encoder.encode(&ctrl_c, &mut out).expect("encode");
    assert_eq!(out, [3]);
}

#[test]
fn a_render_hold_captures_the_frame_at_its_start() {
    let mut t = terminal(10, 2);
    t.write(b"before");
    // Begin a hold, then keep drawing: the capture must show the screen as it was.
    t.write(b"\x1b[?2026h\r\x1b[2Kafter");
    assert!(t.hold_since().is_none(), "the owner stamps the start");
    let start = std::time::Instant::now();
    t.stamp_hold(start);
    assert_eq!(t.hold_since(), Some(start));
    let mut live = RenderState::new().expect("state");
    assert!(t.take_hold_capture(&mut live));
    let colors = live.colors().expect("colors");
    let mut first = Vec::new();
    live.for_each_row(|row| {
        if first.is_empty() {
            row.read_cells(&colors.palette, &mut first)?;
        }
        Ok(())
    })
    .expect("rows");
    let text: String = first.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(text, "before");
    assert!(!t.take_hold_capture(&mut live), "taken once");
    t.end_hold().expect("end hold");
    assert!(t.hold_since().is_none());
}

fn press(key: sys::GhosttyKey, text: &str, mods: u16) -> KeyInput {
    KeyInput {
        action: KeyAction::Press,
        key,
        mods,
        consumed_mods: 0,
        composing: false,
        text: text.into(),
        unshifted: text.chars().next().map_or(0, u32::from),
    }
}

fn encode_key(encoder: &mut KeyEncoder, t: &mut Terminal, input: &KeyInput) -> Vec<u8> {
    let mut out = Vec::new();
    encoder.sync(t).expect("sync");
    encoder.encode(input, &mut out).expect("encode");
    out
}

#[test]
fn keys_follow_the_kitty_keyboard_protocol_when_the_program_asks() {
    let mut t = terminal(80, 24);
    let mut encoder = KeyEncoder::new().expect("encoder");
    let escape = press(sys::GHOSTTY_KEY_ESCAPE, "", 0);
    let ctrl_a = press(sys::GHOSTTY_KEY_A, "a", 2);
    let enter = press(sys::GHOSTTY_KEY_ENTER, "", 0);
    // Legacy encoding first.
    assert_eq!(encode_key(&mut encoder, &mut t, &escape), b"\x1b");
    assert_eq!(encode_key(&mut encoder, &mut t, &ctrl_a), [1]);
    assert_eq!(encode_key(&mut encoder, &mut t, &enter), b"\r");
    // The program pushes Kitty flag 1 (disambiguate escape codes).
    t.write(b"\x1b[>1u");
    assert_eq!(encode_key(&mut encoder, &mut t, &escape), b"\x1b[27u");
    assert_eq!(encode_key(&mut encoder, &mut t, &ctrl_a), b"\x1b[97;5u");
    assert_eq!(
        encode_key(&mut encoder, &mut t, &enter),
        b"\r",
        "Enter stays legacy"
    );
    // And pops it again.
    t.write(b"\x1b[<u");
    assert_eq!(encode_key(&mut encoder, &mut t, &escape), b"\x1b");
}

fn click(action: MouseAction, button: Option<u8>, x: f32, y: f32) -> MouseInput {
    MouseInput {
        action,
        button,
        mods: 0,
        x,
        y,
        clicks: 1,
    }
}

fn encode_mouse(encoder: &mut MouseEncoder, t: &mut Terminal, input: &MouseInput) -> Vec<u8> {
    let geometry = MouseGeometry {
        width: 80 * 10,
        height: 24 * 20,
        cell_width: 10,
        cell_height: 20,
    };
    let mut out = Vec::new();
    encoder.sync(t, geometry).expect("sync");
    encoder.encode(input, &mut out).expect("encode");
    out
}

#[test]
fn mouse_events_follow_the_tracking_mode_and_format() {
    let mut t = terminal(80, 24);
    let mut encoder = MouseEncoder::new().expect("encoder");
    // Cell (3, 1) in pixels: column 3 is x 30–39, row 1 is y 20–39.
    let down = click(MouseAction::Press, Some(1), 35.0, 25.0);
    let up = click(MouseAction::Release, Some(1), 35.0, 25.0);
    let wheel = click(MouseAction::Press, Some(4), 35.0, 25.0);
    assert!(
        encode_mouse(&mut encoder, &mut t, &down).is_empty(),
        "nothing while the program does not track the mouse"
    );
    // Normal tracking with SGR encoding: 1-based cell, M for press, m for release.
    t.write(b"\x1b[?1000h\x1b[?1006h");
    assert_eq!(encode_mouse(&mut encoder, &mut t, &down), b"\x1b[<0;4;2M");
    assert_eq!(encode_mouse(&mut encoder, &mut t, &up), b"\x1b[<0;4;2m");
    assert_eq!(encode_mouse(&mut encoder, &mut t, &wheel), b"\x1b[<64;4;2M");
    let motion = click(MouseAction::Motion, None, 55.0, 25.0);
    assert!(
        encode_mouse(&mut encoder, &mut t, &motion).is_empty(),
        "normal tracking reports no motion"
    );
    // Any-event tracking reports it.
    t.write(b"\x1b[?1003h");
    assert_eq!(
        encode_mouse(&mut encoder, &mut t, &motion),
        b"\x1b[<35;6;2M"
    );
    // Without SGR the X10 format: button + 32, column + 33, row + 33.
    t.write(b"\x1b[?1006l");
    assert_eq!(
        encode_mouse(&mut encoder, &mut t, &down),
        [0x1b, b'[', b'M', 32, 36, 34]
    );
}

#[test]
fn pastes_are_bracketed_and_unsafe_text_is_refused() {
    let mut t = terminal(80, 24);
    assert_eq!(t.paste("ls", false).expect("paste"), PasteOutcome::Pasted);
    assert_eq!(t.take_effects().replies, b"ls");
    // A line break outside bracketed paste would run the command: refused until allowed.
    assert_eq!(
        t.paste("rm -rf x\n", false).expect("paste"),
        PasteOutcome::Unsafe
    );
    assert!(t.take_effects().replies.is_empty());
    assert_eq!(t.paste("a\nb", true).expect("paste"), PasteOutcome::Pasted);
    assert_eq!(t.take_effects().replies, b"a\rb");
    // In bracketed paste mode the text is framed and line breaks are safe.
    t.write(b"\x1b[?2004h");
    assert!(t.mode(MODE_BRACKETED_PASTE, false));
    assert_eq!(t.paste("a\nb", false).expect("paste"), PasteOutcome::Pasted);
    assert_eq!(t.take_effects().replies, b"\x1b[200~a\nb\x1b[201~");
    // The end-of-paste sequence inside the text could escape the frame.
    assert_eq!(
        t.paste("x\x1b[201~y", false).expect("paste"),
        PasteOutcome::Unsafe
    );
    assert_eq!(t.paste("", false).expect("paste"), PasteOutcome::Empty);
}

#[test]
fn focus_reports_follow_mode_1004() {
    let mut t = terminal(80, 24);
    assert!(!t.mode(MODE_FOCUS_EVENTS, false));
    t.write(b"\x1b[?1004h");
    assert!(t.mode(MODE_FOCUS_EVENTS, false));
    assert_eq!(focus_report(true).expect("report"), b"\x1b[I");
    assert_eq!(focus_report(false).expect("report"), b"\x1b[O");
}

#[test]
fn search_finds_matches_in_ten_thousand_rows_of_scrollback() {
    let t = std::sync::Mutex::new(Terminal::new(40, 10, 20_000).expect("terminal"));
    {
        let mut guard = t.lock().expect("lock");
        let mut out = String::new();
        for i in 0..10_000 {
            if i % 1000 == 7 {
                out.push_str(&format!("line {i} NEEDLE-{i}\r\n"));
            } else {
                out.push_str(&format!("line {i}\r\n"));
            }
        }
        guard.write(out.as_bytes());
    }
    let (matches, stats) = search(&t, "needle-", &|| false).expect("search");
    assert_eq!(matches.len(), 10, "ASCII letters match case-insensitively");
    // Newest first; line i is screen row i (nothing was pruned).
    let rows: Vec<u32> = matches.iter().map(|m| m.start.y).collect();
    let expected: Vec<u32> = (0..10).rev().map(|k| k * 1000 + 7).collect();
    assert_eq!(rows, expected);
    for m in &matches {
        let line = format!("line {} ", m.start.y);
        let start = u16::try_from(line.len()).expect("short");
        assert_eq!((m.start.x, m.end.x, m.end.y), (start, start + 6, m.start.y));
    }
    assert!(stats.feeds >= 1 && stats.ticks >= 1);
    assert!(matches!(
        search(&t, "", &|| false),
        Err(crate::Error::InvalidArgument { .. })
    ));
    assert!(matches!(
        search(&t, "line", &|| true),
        Err(crate::Error::Cancelled)
    ));
}

#[test]
fn a_search_holds_the_terminal_only_while_it_feeds() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let t = Arc::new(Mutex::new(
        Terminal::new(80, 24, 200_000).expect("terminal"),
    ));
    {
        let mut guard = t.lock().expect("lock");
        let block: String = (0..10_000)
            .map(|i| format!("row {i} some text to scan\r\n"))
            .collect();
        for _ in 0..10 {
            guard.write(block.as_bytes());
        }
    }
    let searching = Arc::new(AtomicBool::new(true));
    let writer = {
        let (t, searching) = (Arc::clone(&t), Arc::clone(&searching));
        std::thread::spawn(move || {
            // The IO thread's part: write a line, measure how long the lock took.
            let mut waits = Vec::new();
            while searching.load(Ordering::Acquire) {
                let asked = Instant::now();
                let mut guard = t.lock().expect("lock");
                waits.push(asked.elapsed());
                guard.write(b"new output\r\n");
                drop(guard);
                std::thread::sleep(Duration::from_micros(200));
            }
            waits
        })
    };
    let started = Instant::now();
    let (matches, stats) = search(&t, "zzz-not-there", &|| false).expect("search");
    let took = started.elapsed();
    searching.store(false, Ordering::Release);
    let waits = writer.join().expect("writer");
    assert!(matches.is_empty());
    let longest = waits.iter().max().copied().unwrap_or_default();
    eprintln!(
        "search {took:?}, {} feeds, {} ticks; writer locked {} times, longest wait {longest:?}",
        stats.feeds,
        stats.ticks,
        waits.len()
    );
    assert!(waits.len() > 1, "the writer kept writing during the search");
    assert!(
        longest < Duration::from_millis(50),
        "the writer waited {longest:?} for the terminal"
    );
}

const CELL: SurfaceGeometry = SurfaceGeometry {
    cell_width: 10,
    cell_height: 20,
};

/// The left part of viewport cell (`col`, `row`) in surface pixels of `CELL`: a press there
/// starts the selection at that cell.
fn at(col: u16, row: u16) -> PointerAt {
    PointerAt {
        x: f32::from(col) * 10.0 + 2.0,
        y: f32::from(row) * 20.0 + 10.0,
    }
}

/// The right part of the cell: a drag there includes it (a drag includes a cell once the
/// pointer passes its middle, as terminals do).
fn to(col: u16, row: u16) -> PointerAt {
    PointerAt {
        x: f32::from(col) * 10.0 + 8.0,
        y: f32::from(row) * 20.0 + 10.0,
    }
}

/// The selected columns of each viewport row, from a fresh render state.
fn selected_columns(t: &mut Terminal) -> Vec<Option<(u16, u16)>> {
    let mut state = RenderState::new().expect("state");
    state.begin_update(t).expect("begin");
    state.end_update().expect("end");
    let mut rows = Vec::new();
    state
        .for_each_row(|row| {
            rows.push(row.selection()?);
            Ok(())
        })
        .expect("rows");
    rows
}

#[test]
fn a_drag_selects_cells_and_the_text_is_copied_unwrapped() {
    let mut t = terminal(10, 3);
    t.write(b"hello world, wrapped\r\nnext");
    let mut gesture = SelectionGesture::new().expect("gesture");
    gesture
        .press(&mut t, CELL, at(6, 0), 1, false)
        .expect("press");
    assert!(
        !has_selection(&mut t).expect("query"),
        "a click alone selects nothing"
    );
    gesture.drag(&mut t, CELL, to(3, 1)).expect("drag");
    gesture.release(&mut t, CELL, to(3, 1)).expect("release");
    assert_eq!(
        selected_columns(&mut t),
        [Some((6, 9)), Some((0, 3)), None],
        "frames carry the selection as each row's columns"
    );
    // Rows the terminal wrapped come back as one line.
    assert_eq!(selection_text(&mut t).expect("text"), "world, w");
    gesture
        .press(&mut t, CELL, at(0, 2), 1, false)
        .expect("press");
    assert!(
        !has_selection(&mut t).expect("query"),
        "a new click clears it"
    );
    assert_eq!(selection_text(&mut t).expect("text"), "");
    gesture.free(&mut t);
}

#[test]
fn double_and_triple_clicks_select_a_word_and_a_line() {
    let mut t = terminal(30, 3);
    t.write(b"cargo test --release\r\nsecond line");
    let mut gesture = SelectionGesture::new().expect("gesture");
    gesture.press(&mut t, CELL, at(7, 0), 1, false).expect("1");
    gesture.release(&mut t, CELL, at(7, 0)).expect("up");
    gesture.press(&mut t, CELL, at(7, 0), 2, false).expect("2");
    gesture.release(&mut t, CELL, at(7, 0)).expect("up");
    assert_eq!(selection_text(&mut t).expect("word"), "test");
    gesture.press(&mut t, CELL, at(7, 0), 3, false).expect("3");
    gesture.release(&mut t, CELL, at(7, 0)).expect("up");
    assert_eq!(
        selection_text(&mut t).expect("line"),
        "cargo test --release"
    );
    // A press counted as a new single click is not a double click, however close in time.
    gesture.press(&mut t, CELL, at(2, 1), 1, false).expect("1");
    gesture.release(&mut t, CELL, at(2, 1)).expect("up");
    assert!(!has_selection(&mut t).expect("query"));
    gesture.free(&mut t);
}

#[test]
fn shift_extends_the_selection_and_clearing_removes_it() {
    let mut t = terminal(20, 2);
    t.write(b"alpha beta gamma");
    let mut gesture = SelectionGesture::new().expect("gesture");
    gesture
        .press(&mut t, CELL, at(0, 0), 1, false)
        .expect("press");
    gesture.drag(&mut t, CELL, to(4, 0)).expect("drag");
    gesture.release(&mut t, CELL, to(4, 0)).expect("release");
    assert_eq!(selection_text(&mut t).expect("text"), "alpha");
    gesture
        .press(&mut t, CELL, at(9, 0), 1, true)
        .expect("shift press");
    gesture.release(&mut t, CELL, at(9, 0)).expect("release");
    assert_eq!(selection_text(&mut t).expect("text"), "alpha beta");
    clear_selection(&mut t).expect("clear");
    assert!(!has_selection(&mut t).expect("query"));
    assert_eq!(selected_columns(&mut t), [None, None]);
    gesture.free(&mut t);
}

#[test]
fn the_viewport_scrolls_through_the_scrollback() {
    let mut t = terminal(20, 4);
    for i in 0..30 {
        t.write(format!("line {i}\r\n").as_bytes());
    }
    let bottom = t.scrollbar();
    assert_eq!(bottom.len, 4);
    assert_eq!(
        bottom.offset + bottom.len,
        bottom.total,
        "starts at the bottom"
    );
    scroll_viewport(&mut t, ScrollTo::Delta(-5)).expect("up");
    assert_eq!(t.scrollbar().offset, bottom.offset - 5);
    scroll_viewport(&mut t, ScrollTo::Row(2)).expect("row");
    assert_eq!(t.scrollbar().offset, 2);
    assert!(viewport_text(&mut t).expect("text").starts_with("line 2"));
    scroll_viewport(&mut t, ScrollTo::Top).expect("top");
    assert_eq!(t.scrollbar().offset, 0);
    scroll_viewport(&mut t, ScrollTo::Bottom).expect("bottom");
    assert_eq!(t.scrollbar(), bottom);
}

#[test]
fn osc_8_links_are_found_with_their_extent() {
    let mut t = terminal(40, 2);
    t.write(b"see \x1b]8;;https://example.com/a?b=1\x1b\\the docs\x1b]8;;\x1b\\ here");
    assert_eq!(
        link_at(&mut t, 0, 0).expect("none"),
        None,
        "plain text has no link"
    );
    let link = link_at(&mut t, 6, 0).expect("link").expect("a link");
    assert_eq!(
        link,
        Link {
            uri: "https://example.com/a?b=1".into(),
            row: 0,
            start: 4,
            end: 11,
        }
    );
    assert_eq!(link_at(&mut t, 12, 0).expect("after"), None);
    assert_eq!(link_at(&mut t, 99, 9).expect("outside"), None);
}

#[test]
fn default_colors_answer_color_queries() {
    use piarc_protocol::term_frame::Rgb;
    let mut t = terminal(10, 2);
    let light = Rgb {
        r: 0xf8,
        g: 0xf9,
        b: 0xfa,
    };
    t.set_default_colors(None, Some(light), None)
        .expect("colors");
    t.write(b"\x1b]11;?\x07");
    let replies = String::from_utf8(t.take_effects().replies).expect("utf-8");
    assert!(replies.contains("rgb:f8f8/f9f9/fafa"), "{replies:?}");
}
