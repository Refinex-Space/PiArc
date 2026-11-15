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
}

#[test]
fn title_and_bell_are_recorded() {
    let mut t = terminal(80, 24);
    t.write(b"\x1b]2;build \xe2\x9c\x93\x07\x07\x07");
    let effects = t.take_effects();
    assert_eq!(effects.title.as_deref(), Some("build ✓"));
    assert_eq!(effects.bells, 2);
    assert_eq!(t.take_effects(), EffectsOutput::default());
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
    assert!(t.hold_since().is_some());
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
