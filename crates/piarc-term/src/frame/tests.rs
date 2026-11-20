use piarc_protocol::term_frame::{self, Frame, HEADER_BYTES, Screen};

use super::*;
use crate::vt::Terminal;

/// Updates the encoder's render state from `terminal` and encodes one frame.
fn pull(encoder: &mut FrameEncoder, terminal: &mut Terminal) -> (Frame, EncodeStats, usize) {
    encoder
        .render_state()
        .begin_update(terminal)
        .expect("begin");
    encoder.render_state().end_update().expect("end");
    let scrollbar = terminal.scrollbar();
    let (bytes, stats) = encoder.encode(false, scrollbar).expect("encode");
    let frame = term_frame::decode(&bytes).expect("decodes");
    (frame, stats, bytes.len())
}

fn rows_with_cells(frame: &Frame) -> Vec<u16> {
    let body = frame.body.as_ref().expect("body");
    body.rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.cells.is_some())
        .map(|(y, _)| u16::try_from(y).expect("small"))
        .collect()
}

#[test]
fn the_first_frame_resets_and_an_unchanged_terminal_gives_empty_frames() {
    let mut t = Terminal::new(20, 4, 100).expect("terminal");
    t.write(b"hello");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(1, false);
    let (first, stats, _) = pull(&mut encoder, &mut t);
    assert!(first.reset);
    let body = first.body.as_ref().expect("body");
    assert!(body.colors.is_some());
    assert_eq!(stats.rows_with_cells, 4);
    let (second, stats, len) = pull(&mut encoder, &mut t);
    assert!(second.body.is_none());
    assert!(stats.empty);
    assert_eq!(len, HEADER_BYTES);
    assert_eq!(second.seq, first.seq + 1);
}

#[test]
fn frames_carry_only_dirty_rows() {
    let mut t = Terminal::new(20, 4, 100).expect("terminal");
    t.write(b"one\r\ntwo\r\nthree");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(1, false);
    let mut screen = Screen::new();
    let (first, _, _) = pull(&mut encoder, &mut t);
    screen.apply(&first).expect("apply");
    t.write(b"!");
    let (frame, stats, _) = pull(&mut encoder, &mut t);
    assert_eq!(rows_with_cells(&frame), [2], "only the edited row");
    assert_eq!(stats.rows_reused, 3);
    screen.apply(&frame).expect("apply");
    assert_eq!(screen.plain_text(), "one\ntwo\nthree!");
}

#[test]
fn scrolling_output_reuses_rows_by_id_and_sends_only_new_rows() {
    let mut t = Terminal::new(20, 5, 100).expect("terminal");
    t.write(b"l1\r\nl2\r\nl3\r\nl4\r\nl5");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(7, false);
    let mut screen = Screen::new();
    let (first, _, _) = pull(&mut encoder, &mut t);
    screen.apply(&first).expect("apply");
    let ids_before = screen.row_ids().to_vec();
    for n in 6..=8 {
        t.write(format!("\r\nl{n}").as_bytes());
        let (frame, stats, _) = pull(&mut encoder, &mut t);
        assert_eq!(
            rows_with_cells(&frame),
            [4],
            "line {n}: only the new bottom row"
        );
        assert_eq!(stats.rows_with_cells, 1);
        assert_eq!(stats.rows_reused, 4);
        screen.apply(&frame).expect("apply");
    }
    assert_eq!(screen.plain_text(), "l4\nl5\nl6\nl7\nl8");
    // The rows that moved up kept their ids: l4 and l5 were rows 3 and 4 before.
    assert_eq!(&screen.row_ids()[..2], &ids_before[3..]);
}

#[test]
fn a_new_viewer_or_a_full_request_resets() {
    let mut t = Terminal::new(10, 2, 100).expect("terminal");
    t.write(b"x");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(1, false);
    let _ = pull(&mut encoder, &mut t);
    encoder.prepare(1, false);
    assert!(pull(&mut encoder, &mut t).0.body.is_none());
    encoder.prepare(1, true);
    let (full, stats, _) = pull(&mut encoder, &mut t);
    assert!(full.reset);
    assert_eq!(stats.rows_with_cells, 2);
    encoder.prepare(2, false);
    assert!(pull(&mut encoder, &mut t).0.reset, "another viewer");
}

#[test]
fn styles_are_sent_once() {
    let mut t = Terminal::new(10, 2, 100).expect("terminal");
    t.write(b"\x1b[32mgo\x1b[0m");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(1, false);
    let mut screen = Screen::new();
    let (first, _, _) = pull(&mut encoder, &mut t);
    assert_eq!(first.body.as_ref().expect("body").styles.len(), 1);
    screen.apply(&first).expect("apply");
    t.write(b"\r\n\x1b[32mgo\x1b[0m");
    let (second, _, _) = pull(&mut encoder, &mut t);
    assert!(second.body.as_ref().expect("body").styles.is_empty());
    screen.apply(&second).expect("apply");
    let row = screen.row(1).expect("row");
    let style = screen.style(row[0].style).expect("known style");
    assert!(style.fg.is_some());
}
