use super::*;

fn cell(text: &str) -> Cell {
    Cell {
        wide: Wide::Narrow,
        style: 0,
        text: text.to_owned(),
    }
}

fn row_of(text: &str, cols: u16) -> Vec<Cell> {
    let mut cells: Vec<Cell> = text.chars().map(|c| cell(&c.to_string())).collect();
    cells.resize(usize::from(cols), Cell::default());
    cells
}

fn palette() -> Box<[Rgb; 256]> {
    let mut palette = Box::new([Rgb::default(); 256]);
    for (i, slot) in palette.iter_mut().enumerate() {
        let v = u8::try_from(i).expect("256 entries");
        *slot = Rgb { r: v, g: v, b: v };
    }
    palette
}

fn full_frame() -> Frame {
    let red = Rgb { r: 255, g: 0, b: 0 };
    let mut wide_row = vec![
        Cell {
            wide: Wide::Wide,
            style: 1,
            text: "中".into(),
        },
        Cell {
            wide: Wide::SpacerTail,
            style: 1,
            text: String::new(),
        },
        cell("👨\u{200d}👩\u{200d}👧"),
        cell("e\u{301}"),
    ];
    wide_row.resize(6, Cell::default());
    Frame {
        seq: 1,
        reset: true,
        held: false,
        dirty: Dirty::Full,
        cols: 6,
        rows: 2,
        body: Some(Body {
            cursor: Cursor {
                visible: true,
                blinking: true,
                in_viewport: true,
                wide_tail: false,
                password_input: true,
                style: CursorStyle::Underline,
                x: 3,
                y: 1,
            },
            colors: Some(Colors {
                background: Rgb { r: 1, g: 2, b: 3 },
                foreground: Rgb { r: 4, g: 5, b: 6 },
                cursor: Some(red),
                palette: palette(),
            }),
            styles: vec![StyleEntry {
                id: 1,
                style: Style {
                    fg: Some(red),
                    bg: None,
                    underline: Some(Rgb { r: 0, g: 0, b: 9 }),
                    flags: 0b11 | (2 << 8),
                },
            }],
            rows: vec![
                Row {
                    id: 10,
                    cells: Some(row_of("$ ls", 6)),
                },
                Row {
                    id: 11,
                    cells: Some(wide_row),
                },
            ],
        }),
    }
}

#[test]
fn a_full_frame_round_trips() {
    let frame = full_frame();
    let bytes = encode(&frame);
    assert_eq!(&bytes[..3], b"PTF");
    assert_eq!(decode(&bytes), Ok(frame));
}

#[test]
fn an_empty_frame_is_the_header_only() {
    let frame = Frame {
        seq: 7,
        reset: false,
        held: false,
        dirty: Dirty::Clean,
        cols: 80,
        rows: 24,
        body: None,
    };
    let bytes = encode(&frame);
    assert_eq!(bytes.len(), HEADER_BYTES);
    assert_eq!(decode(&bytes), Ok(frame));
}

#[test]
fn reused_rows_cost_five_bytes() {
    let mut frame = full_frame();
    let with_cells = encode(&frame).len();
    if let Some(body) = &mut frame.body {
        body.rows[0].cells = None;
    }
    let without = encode(&frame).len();
    assert_eq!(with_cells - without, 2 + 6 * 4 + "$ ls".len());
}

#[test]
fn malformed_frames_are_rejected() {
    let bytes = encode(&full_frame());
    for cut in [0, 2, HEADER_BYTES, bytes.len() - 1] {
        assert!(decode(&bytes[..cut]).is_err(), "truncated at {cut}");
    }
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(decode(&trailing).is_err());
    let mut magic = bytes.clone();
    magic[0] = b'X';
    assert!(decode(&magic).is_err());
    let mut version = bytes.clone();
    version[3] = 2;
    assert!(decode(&version).is_err());
    let mut rows = bytes;
    rows[12] = 3; // rows = 3, but only two rows follow
    assert!(decode(&rows).is_err());
}

#[test]
fn long_graphemes_are_cut_at_a_code_point() {
    let long = "é".repeat(200); // 400 bytes
    let cut = truncate_text(&long);
    assert_eq!(cut.len(), 254);
    assert!(long.starts_with(cut));
    assert_eq!(truncate_text("abc"), "abc");
}

#[test]
fn the_screen_reuses_rows_by_id_when_scrolling() {
    let mut screen = Screen::new();
    screen.apply(&full_frame()).expect("first frame");
    assert_eq!(screen.row_text(0), "$ ls");
    assert_eq!(screen.row_text(1), "中👨\u{200d}👩\u{200d}👧e\u{301}");
    // Scroll by one line: row 11 moves up and keeps its cells; row 12 is new.
    let scrolled = Frame {
        seq: 2,
        reset: false,
        held: false,
        dirty: Dirty::Full,
        cols: 6,
        rows: 2,
        body: Some(Body {
            cursor: Cursor::default(),
            colors: None,
            styles: Vec::new(),
            rows: vec![
                Row {
                    id: 11,
                    cells: None,
                },
                Row {
                    id: 12,
                    cells: Some(row_of("ok", 6)),
                },
            ],
        }),
    };
    screen.apply(&scrolled).expect("scroll frame");
    assert_eq!(screen.row_ids(), [11, 12]);
    assert_eq!(screen.plain_text(), "中👨\u{200d}👩\u{200d}👧e\u{301}\nok");
    assert!(screen.colors().is_some(), "colors persist until a reset");
    // Row 10 was evicted: a frame that refers to it is rejected and changes nothing.
    let stale = Frame {
        seq: 3,
        body: Some(Body {
            rows: vec![
                Row {
                    id: 10,
                    cells: None,
                },
                Row {
                    id: 12,
                    cells: None,
                },
            ],
            ..scrolled.body.clone().expect("body")
        }),
        ..scrolled.clone()
    };
    assert!(screen.apply(&stale).is_err());
    assert_eq!(screen.seq(), 2);
    assert_eq!(screen.row_ids(), [11, 12]);
}

#[test]
fn the_screen_rejects_out_of_order_and_unknown_styles() {
    let mut screen = Screen::new();
    let mut not_reset = full_frame();
    not_reset.reset = false;
    assert!(
        screen.apply(&not_reset).is_err(),
        "the first frame must reset"
    );
    screen.apply(&full_frame()).expect("first frame");
    let mut skipped = full_frame();
    skipped.reset = false;
    skipped.seq = 3;
    assert!(screen.apply(&skipped).is_err());
    let mut unknown_style = full_frame();
    if let Some(body) = &mut unknown_style.body {
        body.styles.clear();
    }
    assert!(Screen::new().apply(&unknown_style).is_err());
    let empty = Frame {
        seq: 2,
        reset: false,
        held: false,
        dirty: Dirty::Clean,
        cols: 6,
        rows: 2,
        body: None,
    };
    screen
        .apply(&empty)
        .expect("an empty frame only advances seq");
    assert_eq!(screen.seq(), 2);
    assert_eq!(screen.row_text(0), "$ ls");
}
