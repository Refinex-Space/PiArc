use super::*;
use crate::vt::{TextOptions, TextRange};

/// A terminal with scrollback, styles, a wide character, a title and a working directory.
fn busy_terminal() -> Terminal {
    let mut t = Terminal::new(30, 6, 5000).expect("terminal");
    t.write(b"\x1b]2;build\x07\x1b]7;file://host/work\x07");
    for i in 0..500 {
        t.write(format!("\x1b[3{}mline {i}\x1b[0m 中\r\n", i % 8).as_bytes());
    }
    t.write(b"$ cargo t");
    t
}

fn all(t: &mut Terminal) -> String {
    vt::plain_text(t, TextRange::All, TextOptions::default()).expect("text")
}

fn screen(t: &mut Terminal) -> String {
    vt::plain_text(t, TextRange::Screen, TextOptions::default()).expect("text")
}

#[test]
fn a_snapshot_restores_screen_and_scrollback_exactly() {
    let mut original = busy_terminal();
    let saved = Saved::capture(&mut original).expect("capture");
    assert!(saved.snapshot_usable());
    let bytes = saved.to_bytes();
    let read = Saved::from_bytes(&bytes).expect("read");
    assert_eq!(read, saved);
    let (mut restored, how) = read.restore(5000).expect("restore");
    assert_eq!(how, Restored::Snapshot);
    assert_eq!(all(&mut restored), all(&mut original));
    assert_eq!(screen(&mut restored), screen(&mut original));
    assert_eq!(restored.title(), "build");
    assert_eq!(restored.pwd(), "file://host/work");
    // The restored terminal keeps working, with the effects registered.
    restored.write(b"\x1b[c");
    assert_eq!(restored.take_effects().replies, b"\x1b[?62;22c");
}

#[test]
fn another_library_version_replays_the_vt_output() {
    let mut original = busy_terminal();
    let mut saved = Saved::capture(&mut original).expect("capture");
    saved.vt_version = "0.9.0".into();
    let read = Saved::from_bytes(&saved.to_bytes()).expect("read");
    assert!(!read.snapshot_usable());
    let (mut restored, how) = read.restore(5000).expect("restore");
    assert_eq!(how, Restored::Replay);
    assert_eq!(all(&mut restored), all(&mut original));
    assert_eq!(screen(&mut restored), screen(&mut original));
    // Styles came back with the replay: line 1 is red.
    let mut state = vt::RenderState::new().expect("state");
    let mut first_rows = Vec::new();
    for t in [&mut original, &mut restored] {
        state.begin_update(t).expect("begin");
        state.end_update().expect("end");
        let colors = state.colors().expect("colors");
        let mut row = Vec::new();
        state
            .for_each_row(|r| {
                if row.is_empty() {
                    r.read_cells(&colors.palette, &mut row)?;
                }
                Ok(())
            })
            .expect("rows");
        first_rows.push(row);
    }
    assert_eq!(first_rows[0], first_rows[1]);
    // A different snapshot format is not decoded either.
    let mut format = Saved::capture(&mut original).expect("capture");
    format.snapshot_format = SNAPSHOT_FORMAT + 1;
    assert_eq!(format.restore(5000).expect("restore").1, Restored::Replay);
}

#[test]
fn a_damaged_snapshot_falls_back_to_the_replay_and_a_damaged_replay_to_the_text() {
    let mut original = busy_terminal();
    let saved = Saved::capture(&mut original).expect("capture");
    let mut bytes = saved.to_bytes();
    // The snapshot section starts after the header: magic, format, size, version, format.
    let header = 8 + 2 + 2 + 2 + 1 + saved.vt_version.len() + 2;
    let snapshot_at = header + 16;
    bytes[snapshot_at + 40] ^= 0xff;
    let read = Saved::from_bytes(&bytes).expect("read");
    assert!(!read.snapshot_usable());
    let (mut restored, how) = read.restore(5000).expect("restore");
    assert_eq!(how, Restored::Replay);
    assert_eq!(all(&mut restored), all(&mut original));
    // Damage the replay section too: only the text is left.
    let replay_at = snapshot_at + saved.snapshot.len() + 16;
    bytes[replay_at + 10] ^= 0xff;
    let read = Saved::from_bytes(&bytes).expect("read");
    let (mut restored, how) = read.restore(5000).expect("restore");
    assert_eq!(how, Restored::Text);
    assert_eq!(all(&mut restored), all(&mut original));
}

#[test]
fn files_are_written_atomically_and_bad_files_are_refused() {
    let dir = std::env::temp_dir().join(format!("piarc-snap-{}-中 文", std::process::id()));
    let path = dir.join("terminals").join("t-1.snap");
    let mut original = busy_terminal();
    let saved = Saved::capture(&mut original).expect("capture");
    saved.write_to(&path).expect("write");
    assert_eq!(Saved::read_from(&path).expect("read"), saved);
    let names: Vec<String> = std::fs::read_dir(path.parent().expect("dir"))
        .expect("list")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["t-1.snap"], "no temporary file is left");
    let bytes = saved.to_bytes();
    assert!(
        Saved::from_bytes(&bytes[..bytes.len() - 1]).is_err(),
        "cut short"
    );
    assert!(Saved::from_bytes(b"not a terminal").is_err());
    let mut format = bytes;
    format[8] = 9;
    assert!(Saved::from_bytes(&format).is_err(), "unknown file format");
    let _ = std::fs::remove_dir_all(&dir);
}
