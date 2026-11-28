//! L1 golden samples of the terminal frame format (T33-A07): `tests/contracts/term-frame/`.
//! `samples.json` pairs the bytes of each frame with its JSON form (schema `TermFrame`);
//! `invalid.json` lists malformed frames with the reason the decoder gives. The renderer's
//! TypeScript decoder runs the same files, and `packages/protocol` checks the JSON forms
//! against the schema. `PIARC_UPDATE_TERM_FRAME_SAMPLES=1` rewrites the files from the frames
//! below; without it they must be current.

use std::path::{Path, PathBuf};

use piarc_protocol::term_frame::{
    self, Body, Cell, Colors, Cursor, CursorStyle, Dirty, Frame, Rgb, Row, Scrollbar, Selection,
    Style, StyleEntry, Wide,
};
use serde_json::{Value, json};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contracts/term-frame")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn cell(text: &str, style: u16) -> Cell {
    Cell {
        wide: Wide::Narrow,
        style,
        text: text.to_owned(),
    }
}

fn row(id: u32, text: &str, cols: u16, style: u16) -> Row {
    let mut cells: Vec<Cell> = text.chars().map(|c| cell(&c.to_string(), style)).collect();
    cells.resize(usize::from(cols), Cell::default());
    Row {
        id,
        selection: None,
        cells: Some(cells),
    }
}

fn palette() -> Box<[Rgb; 256]> {
    let mut palette = Box::new([Rgb::default(); 256]);
    for (i, slot) in palette.iter_mut().enumerate() {
        let v = u8::try_from(i).expect("256");
        *slot = Rgb {
            r: v,
            g: 255 - v,
            b: v / 2,
        };
    }
    palette
}

fn cursor(x: u16, y: u16) -> Cursor {
    Cursor {
        visible: true,
        blinking: false,
        in_viewport: true,
        wide_tail: false,
        password_input: false,
        style: CursorStyle::Block,
        x,
        y,
    }
}

/// A viewer's first frame: colors, a style, wide and combined cells.
fn reset_frame() -> Frame {
    let red = Rgb {
        r: 205,
        g: 49,
        b: 49,
    };
    let mut wide = vec![
        Cell {
            wide: Wide::Wide,
            style: 0,
            text: "中".into(),
        },
        Cell {
            wide: Wide::SpacerTail,
            style: 0,
            text: String::new(),
        },
        cell("👨\u{200d}👩\u{200d}👧", 0),
        cell("e\u{301}", 1),
    ];
    wide.resize(8, Cell::default());
    Frame {
        seq: 1,
        reset: true,
        held: false,
        dirty: Dirty::Full,
        cols: 8,
        rows: 3,
        body: Some(Body {
            cursor: cursor(2, 2),
            colors: Some(Colors {
                background: Rgb {
                    r: 0x1e,
                    g: 0x1e,
                    b: 0x2e,
                },
                foreground: Rgb {
                    r: 0xcd,
                    g: 0xd6,
                    b: 0xf4,
                },
                cursor: None,
                palette: palette(),
            }),
            scrollbar: Scrollbar {
                total: 3,
                offset: 0,
                len: 3,
            },
            styles: vec![StyleEntry {
                id: 1,
                style: Style {
                    fg: Some(red),
                    bg: None,
                    underline: None,
                    flags: 1,
                },
            }],
            rows: vec![
                row(1, "$ ls", 8, 0),
                Row {
                    id: 2,
                    selection: None,
                    cells: Some(wide),
                },
                row(3, "$ ", 8, 0),
            ],
        }),
    }
}

/// Nothing changed since the last frame.
fn empty_frame() -> Frame {
    Frame {
        seq: 2,
        reset: false,
        held: false,
        dirty: Dirty::Clean,
        cols: 8,
        rows: 3,
        body: None,
    }
}

/// A scroll: held rows move, one is selected, one is new.
fn scrolled_frame() -> Frame {
    Frame {
        seq: 3,
        reset: false,
        held: false,
        dirty: Dirty::Full,
        cols: 8,
        rows: 3,
        body: Some(Body {
            cursor: cursor(0, 2),
            colors: None,
            scrollbar: Scrollbar {
                total: 4,
                offset: 1,
                len: 3,
            },
            styles: Vec::new(),
            rows: vec![
                Row {
                    id: 2,
                    selection: None,
                    cells: None,
                },
                Row {
                    id: 3,
                    selection: Some(Selection { start: 0, end: 1 }),
                    cells: None,
                },
                row(4, "ok", 8, 1),
            ],
        }),
    }
}

/// A held frame with every flag and style field set.
fn held_frame() -> Frame {
    Frame {
        seq: 1,
        reset: true,
        held: true,
        dirty: Dirty::Partial,
        cols: 4,
        rows: 1,
        body: Some(Body {
            cursor: Cursor {
                visible: false,
                blinking: true,
                in_viewport: false,
                wide_tail: true,
                password_input: true,
                style: CursorStyle::Bar,
                x: 0,
                y: 0,
            },
            colors: Some(Colors {
                background: Rgb::default(),
                foreground: Rgb {
                    r: 255,
                    g: 255,
                    b: 255,
                },
                cursor: Some(Rgb { r: 0, g: 255, b: 0 }),
                palette: palette(),
            }),
            scrollbar: Scrollbar {
                total: 1,
                offset: 0,
                len: 1,
            },
            styles: vec![StyleEntry {
                id: 7,
                style: Style {
                    fg: Some(Rgb { r: 1, g: 2, b: 3 }),
                    bg: Some(Rgb { r: 4, g: 5, b: 6 }),
                    underline: Some(Rgb { r: 7, g: 8, b: 9 }),
                    flags: 0b1111_1111 | (5 << 8),
                },
            }],
            rows: vec![Row {
                id: 9,
                selection: Some(Selection { start: 1, end: 3 }),
                cells: Some(vec![
                    cell("a", 7),
                    cell("", 0),
                    Cell {
                        wide: Wide::SpacerHead,
                        style: 0,
                        text: String::new(),
                    },
                    cell(" ", 7),
                ]),
            }],
        }),
    }
}

/// The sample frames: one viewer's sequence, then frames that exercise the rest of the format.
fn frames() -> Vec<(&'static str, Frame)> {
    vec![
        ("a viewer's first frame resets it", reset_frame()),
        ("nothing changed", empty_frame()),
        (
            "a scroll moves held rows, selects one and adds one",
            scrolled_frame(),
        ),
        ("a held frame with every flag and style field", held_frame()),
    ]
}

/// Malformed frames: bytes and a part of the reason both decoders give.
fn invalid() -> Vec<(&'static str, Vec<u8>, &'static str)> {
    let valid = term_frame::encode(&frames()[0].1);
    let mut version = valid.clone();
    version[3] = 1;
    let mut flags = valid.clone();
    flags[4] |= 1 << 6;
    let mut cut = valid.clone();
    cut.truncate(valid.len() - 1);
    let mut trailing = valid.clone();
    trailing.push(0);
    let empty_colors: Vec<u8> = {
        let mut header = term_frame::encode(&frames()[1].1);
        header[4] |= 1 << 1;
        header
    };
    let selection = {
        let mut frame = frames()[2].1.clone();
        if let Some(body) = &mut frame.body {
            body.rows[1].selection = Some(Selection { start: 3, end: 8 });
        }
        term_frame::encode(&frame)
    };
    vec![
        ("the draft version 1", version, "unsupported version"),
        ("an unknown flag", flags, "unknown flags"),
        ("cut short", cut, "truncated"),
        ("a trailing byte", trailing, "trailing"),
        (
            "an empty frame with colors",
            empty_colors,
            "cannot carry colors",
        ),
        ("a selection past the last column", selection, "selection"),
    ]
}

fn samples_json() -> Value {
    let cases: Vec<Value> = frames()
        .into_iter()
        .map(|(name, frame)| {
            json!({
                "name": name,
                "hex": hex(&term_frame::encode(&frame)),
                "frame": serde_json::to_value(&frame).expect("json"),
            })
        })
        .collect();
    json!({
        "$comment": "Generated by crates/piarc-protocol/tests/term_frame.rs (PIARC_UPDATE_TERM_FRAME_SAMPLES=1).",
        "version": term_frame::VERSION,
        "cases": cases,
    })
}

fn invalid_json() -> Value {
    let cases: Vec<Value> = invalid()
        .into_iter()
        .map(|(name, bytes, reason)| json!({ "name": name, "hex": hex(&bytes), "reason": reason }))
        .collect();
    json!({
        "$comment": "Generated by crates/piarc-protocol/tests/term_frame.rs (PIARC_UPDATE_TERM_FRAME_SAMPLES=1).",
        "cases": cases,
    })
}

fn check_or_write(file: &str, expected: &Value) {
    let path = dir().join(file);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(expected).expect("pretty")
    );
    if std::env::var_os("PIARC_UPDATE_TERM_FRAME_SAMPLES").is_some() {
        std::fs::create_dir_all(dir()).expect("dir");
        std::fs::write(&path, text).expect("write");
        return;
    }
    let current: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("JSON");
    assert_eq!(
        &current, expected,
        "{file} is stale: run PIARC_UPDATE_TERM_FRAME_SAMPLES=1 cargo test -p piarc-protocol --test term_frame"
    );
}

#[test]
fn the_golden_samples_are_current_and_round_trip() {
    check_or_write("samples.json", &samples_json());
    check_or_write("invalid.json", &invalid_json());
    let samples: Value =
        serde_json::from_str(&std::fs::read_to_string(dir().join("samples.json")).expect("read"))
            .expect("JSON");
    for case in samples["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let bytes = unhex(case["hex"].as_str().expect("hex"));
        let decoded = term_frame::decode(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        let from_json: Frame = serde_json::from_value(case["frame"].clone()).expect("frame");
        assert_eq!(
            decoded, from_json,
            "{name}: bytes and JSON describe the same frame"
        );
        assert_eq!(
            term_frame::encode(&from_json),
            bytes,
            "{name}: encoding is stable"
        );
    }
    let invalid: Value =
        serde_json::from_str(&std::fs::read_to_string(dir().join("invalid.json")).expect("read"))
            .expect("JSON");
    for case in invalid["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let error = term_frame::decode(&unhex(case["hex"].as_str().expect("hex")))
            .expect_err(name)
            .to_string();
        let reason = case["reason"].as_str().expect("reason");
        assert!(error.contains(reason), "{name}: {error}");
    }
}

#[test]
fn the_sample_sequence_builds_one_screen() {
    let mut screen = term_frame::Screen::new();
    for (_, frame) in frames().into_iter().take(3) {
        screen.apply(&frame).expect("in order");
    }
    assert_eq!(
        screen.plain_text(),
        "中👨\u{200d}👩\u{200d}👧e\u{301}\n$\nok"
    );
    assert_eq!(screen.selection(1), Some(Selection { start: 0, end: 1 }));
    assert_eq!(screen.scrollbar().offset, 1);
}
