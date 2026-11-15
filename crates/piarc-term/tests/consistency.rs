//! Frames against libghostty-vt's formatter (T10-A08): for normal screens, the alternate
//! screen, CJK full-width text, emoji, ZWJ sequences, combining marks, wrapped wide characters
//! and scrolling, the viewport rebuilt from decoded frames must equal the formatter's plain
//! text row by row, and every cell must agree with the formatter's text of its row.
//!
//! The same frames are the shared samples of the renderer's TypeScript decoder
//! (`apps/desktop/src/renderer/terminal/frame/frame-samples.json`): this test fails when the
//! committed file differs from what it would write, and rewrites it when
//! `PIARC_UPDATE_FRAME_SAMPLES=1` is set.

use std::path::PathBuf;

use piarc_protocol::term_frame::{self, Cell, Frame, Rgb, Screen, Style, Wide};
use piarc_term::frame::FrameEncoder;
use piarc_term::vt::{Terminal, viewport_text};
use serde_json::{Value, json};

/// One scripted scenario: chunks of program output, a frame pulled after each.
struct Case {
    name: &'static str,
    cols: u16,
    rows: u16,
    steps: &'static [&'static [u8]],
}

const CASES: &[Case] = &[
    Case {
        name: "normal screen with styles",
        cols: 20,
        rows: 5,
        steps: &[
            b"$ ls\r\n\x1b[1;34mdir\x1b[0m  \x1b[32mrun.sh\x1b[0m\r\n",
            b"\x1b[38;2;255;128;0morange\x1b[0m \x1b[4;3munder\x1b[0m\r\n$ ",
            b"\x1b[7minverse\x1b[0m\x1b[9m strike\x1b[0m",
        ],
    },
    Case {
        name: "alternate screen",
        cols: 20,
        rows: 6,
        steps: &[
            b"shell line\r\n$ vim notes",
            // Enter the alternate screen, clear it and draw a file view like vim does.
            b"\x1b[?1049h\x1b[H\x1b[2Jline one\r\nline two\r\n\x1b[34m~\x1b[0m\r\n\x1b[34m~\x1b[0m\r\n\x1b[6;1H\"notes\" 2L",
            b"\x1b[2;6H\x1b[1mTWO\x1b[0m",
            // Leave it: the shell screen comes back unchanged.
            b"\x1b[?1049l\r\n$ ",
        ],
    },
    Case {
        name: "CJK full-width",
        cols: 12,
        rows: 4,
        steps: &[
            "中文终端测试\r\n半角abc全角ＡＢＣ\r\n".as_bytes(),
            "宽字符换行测试一二三".as_bytes(),
        ],
    },
    Case {
        name: "emoji and ZWJ graphemes",
        cols: 16,
        rows: 4,
        steps: &[
            "smile 😀 ok\r\n".as_bytes(),
            "family 👨\u{200d}👩\u{200d}👧\u{200d}👦!\r\n".as_bytes(),
            "flag 🇨🇳 e\u{301}\u{328}".as_bytes(),
        ],
    },
    Case {
        name: "scrolling output",
        cols: 10,
        rows: 4,
        steps: &[
            b"one\r\ntwo\r\nthree\r\nfour",
            b"\r\nfive",
            b"\r\nsix\r\nseven",
        ],
    },
];

fn rgb_json(rgb: Option<Rgb>) -> Value {
    rgb.map_or(Value::Null, |c| json!([c.r, c.g, c.b]))
}

fn style_json(style: Style) -> Value {
    json!({
        "fg": rgb_json(style.fg),
        "bg": rgb_json(style.bg),
        "underline": rgb_json(style.underline),
        "flags": style.flags,
    })
}

fn wide_code(wide: Wide) -> u8 {
    match wide {
        Wide::Narrow => 0,
        Wide::Wide => 1,
        Wide::SpacerTail => 2,
        Wide::SpacerHead => 3,
    }
}

/// The screen as the TypeScript test compares it: geometry, cursor, every cell with its
/// resolved style, and the plain text.
fn screen_json(screen: &Screen) -> Value {
    let rows: Vec<Value> = (0..screen.rows())
        .map(|y| {
            let cells: Vec<Value> = screen
                .row(y)
                .unwrap_or_default()
                .iter()
                .map(|cell: &Cell| {
                    json!({
                        "wide": wide_code(cell.wide),
                        "text": cell.text,
                        "style": style_json(screen.style(cell.style).unwrap_or_default()),
                    })
                })
                .collect();
            Value::Array(cells)
        })
        .collect();
    let cursor = screen.cursor();
    json!({
        "cols": screen.cols(),
        "rows": screen.rows(),
        "cursor": { "x": cursor.x, "y": cursor.y, "visible": cursor.visible, "inViewport": cursor.in_viewport },
        "cells": rows,
        "plainText": screen.plain_text(),
    })
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(
                    TABLE[usize::try_from((n >> shift) & 63).expect("6 bits")],
                ));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn pull(encoder: &mut FrameEncoder, terminal: &mut Terminal) -> (Vec<u8>, Frame) {
    encoder
        .render_state()
        .begin_update(terminal)
        .expect("begin");
    encoder.render_state().end_update().expect("end");
    let (bytes, _) = encoder.encode(false).expect("encode");
    let frame = term_frame::decode(&bytes).expect("Rust decodes its own frame");
    (bytes, frame)
}

/// Checks every row of `screen` against the formatter, cell by cell.
fn assert_matches_formatter(case: &str, step: usize, screen: &Screen, formatted: &str) {
    let lines: Vec<&str> = formatted.split('\n').collect();
    for y in 0..screen.rows() {
        let expected = lines.get(usize::from(y)).copied().unwrap_or("");
        assert_eq!(
            screen.row_text(y),
            expected,
            "{case}, step {step}, row {y}: frame and formatter disagree"
        );
        // Cell by cell: walking the row's cells must consume the formatter's line exactly,
        // grapheme by grapheme, with spacer cells contributing nothing.
        let mut rest = expected;
        for (x, cell) in screen.row(y).unwrap_or_default().iter().enumerate() {
            match cell.wide {
                Wide::SpacerTail | Wide::SpacerHead => {
                    assert!(
                        cell.text.is_empty(),
                        "{case}, row {y}, col {x}: spacer has text"
                    );
                }
                Wide::Narrow | Wide::Wide => {
                    let text = if cell.text.is_empty() {
                        " "
                    } else {
                        cell.text.as_str()
                    };
                    if rest.is_empty() {
                        assert_eq!(
                            text, " ",
                            "{case}, row {y}, col {x}: text past the line end"
                        );
                    } else {
                        assert!(
                            rest.starts_with(text),
                            "{case}, row {y}, col {x}: cell {text:?} vs formatter {rest:?}"
                        );
                        rest = &rest[text.len()..];
                    }
                }
            }
        }
        assert!(
            rest.is_empty(),
            "{case}, row {y}: formatter has more text: {rest:?}"
        );
    }
    assert_eq!(
        screen.plain_text(),
        formatted,
        "{case}, step {step}: whole screen"
    );
}

fn run_case(case: &Case) -> Value {
    let mut terminal = Terminal::new(case.cols, case.rows, 100).expect("terminal");
    let mut encoder = FrameEncoder::new().expect("encoder");
    encoder.prepare(1, false);
    let mut screen = Screen::new();
    let mut frames = Vec::new();
    for (step, bytes) in case.steps.iter().enumerate() {
        terminal.write(bytes);
        let (encoded, frame) = pull(&mut encoder, &mut terminal);
        screen.apply(&frame).expect("frames apply in order");
        let formatted = viewport_text(&mut terminal).expect("formatter");
        assert_matches_formatter(case.name, step, &screen, &formatted);
        let rows_with_cells: Vec<usize> = frame
            .body
            .as_ref()
            .map(|body| {
                body.rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| row.cells.is_some())
                    .map(|(y, _)| y)
                    .collect()
            })
            .unwrap_or_default();
        frames.push(json!({
            "bytes": base64(&encoded),
            "seq": frame.seq,
            "reset": frame.reset,
            "empty": frame.body.is_none(),
            "rowsWithCells": rows_with_cells,
        }));
    }
    json!({
        "name": case.name,
        "frames": frames,
        "screen": screen_json(&screen),
    })
}

#[test]
fn frames_match_the_formatter_and_the_shared_samples_are_current() {
    let cases: Vec<Value> = CASES.iter().map(run_case).collect();
    let samples = json!({
        "$comment": "Generated by crates/piarc-term/tests/consistency.rs (PIARC_UPDATE_FRAME_SAMPLES=1). Frames of the draft terminal frame format and the screen they build; the renderer's TypeScript decoder must produce the same screen.",
        "cases": cases,
    });
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&samples).expect("JSON")
    );
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/renderer/terminal/frame/frame-samples.json");
    if std::env::var_os("PIARC_UPDATE_FRAME_SAMPLES").is_some() {
        std::fs::write(&path, &text).expect("write samples");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == text,
        "{} is out of date; rerun with PIARC_UPDATE_FRAME_SAMPLES=1",
        path.display()
    );
}

#[test]
fn the_scrolling_case_sends_only_new_rows() {
    let case = &CASES[4];
    let value = run_case(case);
    let frames = value["frames"].as_array().expect("frames");
    // "\r\nfive" scrolls one line: only the new bottom row carries cells.
    assert_eq!(frames[1]["rowsWithCells"], json!([3]));
    // Two more lines: two new rows.
    assert_eq!(frames[2]["rowsWithCells"], json!([2, 3]));
}
