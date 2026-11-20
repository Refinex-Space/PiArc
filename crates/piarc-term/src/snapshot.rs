//! Saved terminals (`sessions/<sessionId>/terminals/<terminalId>.snap`, ADR-0017 rule 6): what
//! a terminal showed, so it can be shown again after PiArc restarts.
//!
//! A file holds the same screen three ways, because libghostty-vt's snapshot format is outside
//! its ABI promise (research 1.6): the snapshot itself, the formatter's VT output (sequences
//! that redraw the screen, scrollback and modes in a fresh terminal) and the plain text.
//! Restoring tries them in that order:
//!
//! 1. the snapshot, when the file was written by the same libghostty-vt version and snapshot
//!    format as the running one, and it decodes;
//! 2. else the VT replay, written into a new terminal of the saved size;
//! 3. else (the replay section is damaged) the plain text.
//!
//! Each section carries a 64-bit FNV-1a hash, so damage is noticed instead of drawn.
//!
//! # File layout (little-endian)
//!
//! ```text
//! magic "PIARCTRM" | format:u16 (=1) | cols:u16 | rows:u16
//! | vtVersionLen:u8 | vtVersion (UTF-8, `ghostty_version()`) | snapshotFormat:u16
//! | 3 × section: len:u64 hash:u64 bytes        ; snapshot, VT replay, plain text
//! ```
//!
//! When libghostty-vt is upgraded, decide whether its snapshot format changed and raise
//! [`SNAPSHOT_FORMAT`] if so (crate `AGENTS.md`, upgrade checklist).

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::{Error, Result};
use crate::vt::{self, Terminal, TextOptions, TextRange};

/// The file's magic bytes.
pub const MAGIC: [u8; 8] = *b"PIARCTRM";
/// The layout of this module's files.
pub const FILE_FORMAT: u16 = 1;
/// The libghostty-vt snapshot format this build writes ("Snapshot format version 1" of the
/// snapshot guide for libghostty-vt 1.0.1).
pub const SNAPSHOT_FORMAT: u16 = 1;

/// How a saved terminal came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restored {
    /// From the libghostty-vt snapshot: everything as it was.
    Snapshot,
    /// From the VT replay: screen, scrollback, styles and modes; the parser state and the
    /// alternate screen's history are gone.
    Replay,
    /// From the plain text only.
    Text,
}

/// A terminal saved in memory: the three sections and what wrote them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    /// Columns when saved.
    pub cols: u16,
    /// Rows when saved.
    pub rows: u16,
    /// libghostty-vt version that wrote it.
    pub vt_version: String,
    /// Snapshot format that wrote it.
    pub snapshot_format: u16,
    /// libghostty-vt snapshot; empty when it could not be encoded.
    pub snapshot: Vec<u8>,
    /// Formatter VT output of the active screen.
    pub replay: Vec<u8>,
    /// Plain text of the active screen and its scrollback.
    pub text: String,
    /// Sections whose hash did not match when read (snapshot, replay, text).
    damaged: [bool; 3],
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn corrupt(reason: impl Into<String>) -> Error {
    Error::Snapshot {
        operation: "read",
        reason: reason.into(),
    }
}

impl Saved {
    /// Captures `terminal` (its lock held by the caller).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when the formatter fails. A snapshot that cannot be encoded (an
    /// unfinished sequence longer than the kept continuation) is left empty instead.
    pub fn capture(terminal: &mut Terminal) -> Result<Self> {
        let snapshot = vt::snapshot::encode(terminal).unwrap_or_default();
        let replay = vt::vt_text(terminal)?;
        let text = vt::plain_text(terminal, TextRange::All, TextOptions::default())?;
        Ok(Self {
            cols: terminal.cols(),
            rows: terminal.rows(),
            vt_version: vt::snapshot::library_version(),
            snapshot_format: SNAPSHOT_FORMAT,
            snapshot,
            replay,
            text,
            damaged: [false; 3],
        })
    }

    /// The file bytes.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let version = self.vt_version.as_bytes();
        let version = &version[..version.len().min(255)];
        let mut out = Vec::with_capacity(
            64 + version.len() + self.snapshot.len() + self.replay.len() + self.text.len(),
        );
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&FILE_FORMAT.to_le_bytes());
        out.extend_from_slice(&self.cols.to_le_bytes());
        out.extend_from_slice(&self.rows.to_le_bytes());
        out.push(u8::try_from(version.len()).unwrap_or(u8::MAX));
        out.extend_from_slice(version);
        out.extend_from_slice(&self.snapshot_format.to_le_bytes());
        for section in [&self.snapshot[..], &self.replay[..], self.text.as_bytes()] {
            out.extend_from_slice(
                &u64::try_from(section.len())
                    .unwrap_or(u64::MAX)
                    .to_le_bytes(),
            );
            out.extend_from_slice(&fnv1a(section).to_le_bytes());
            out.extend_from_slice(section);
        }
        out
    }

    /// Reads file bytes. A section whose hash does not match is kept but marked damaged.
    ///
    /// # Errors
    ///
    /// [`Error::Snapshot`] when the header is not this format or the file is cut short.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let mut reader = Cursor { bytes, at: 0 };
        if reader.take(MAGIC.len())? != MAGIC {
            return Err(corrupt("not a saved PiArc terminal"));
        }
        let format = reader.u16()?;
        if format != FILE_FORMAT {
            return Err(corrupt(format!("unknown file format {format}")));
        }
        let cols = reader.u16()?;
        let rows = reader.u16()?;
        if cols == 0 || rows == 0 {
            return Err(corrupt("zero size"));
        }
        let version_len = usize::from(reader.take(1)?[0]);
        let vt_version = String::from_utf8_lossy(reader.take(version_len)?).into_owned();
        let snapshot_format = reader.u16()?;
        let mut sections: [(Vec<u8>, bool); 3] = Default::default();
        for section in &mut sections {
            let len = usize::try_from(reader.u64()?).map_err(|_| corrupt("section too large"))?;
            let hash = reader.u64()?;
            let data = reader.take(len)?.to_vec();
            let damaged = fnv1a(&data) != hash;
            *section = (data, damaged);
        }
        let [(snapshot, d0), (replay, d1), (text, d2)] = sections;
        Ok(Self {
            cols,
            rows,
            vt_version,
            snapshot_format,
            snapshot,
            replay,
            text: String::from_utf8_lossy(&text).into_owned(),
            damaged: [d0, d1, d2],
        })
    }

    /// Writes the file atomically (a temporary file next to it, then a rename), creating its
    /// directory.
    ///
    /// # Errors
    ///
    /// [`Error::Snapshot`] when the file cannot be written.
    pub fn write_to(&self, path: &Path) -> Result<()> {
        let fail = |error: std::io::Error| Error::Snapshot {
            operation: "write",
            reason: format!("{}: {error}", path.display()),
        };
        let dir = path.parent().ok_or_else(|| Error::Snapshot {
            operation: "write",
            reason: format!("{} has no directory", path.display()),
        })?;
        fs::create_dir_all(dir).map_err(fail)?;
        let name = path
            .file_name()
            .map_or_else(|| "terminal".into(), |n| n.to_string_lossy().into_owned());
        let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let written = fs::File::create(&temp)
            .and_then(|mut file| {
                file.write_all(&self.to_bytes())
                    .and_then(|()| file.sync_all())
            })
            .and_then(|()| fs::rename(&temp, path));
        if written.is_err() {
            let _ = fs::remove_file(&temp);
        }
        written.map_err(fail)
    }

    /// Reads a file written by [`write_to`](Self::write_to).
    ///
    /// # Errors
    ///
    /// [`Error::Snapshot`] when it cannot be read or is not a saved terminal.
    pub fn read_from(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).map_err(|error| Error::Snapshot {
            operation: "read",
            reason: format!("{}: {error}", path.display()),
        })?;
        Self::from_bytes(&bytes)
    }

    /// Whether the snapshot section can be decoded by this build.
    #[must_use]
    pub fn snapshot_usable(&self) -> bool {
        !self.snapshot.is_empty()
            && !self.damaged[0]
            && self.snapshot_format == SNAPSHOT_FORMAT
            && self.vt_version == vt::snapshot::library_version()
    }

    /// A terminal showing what was saved, by the best usable section (module documentation).
    ///
    /// # Errors
    ///
    /// [`Error::Vt`] when even a plain terminal cannot be created.
    pub fn restore(&self, scrollback_lines: usize) -> Result<(Terminal, Restored)> {
        if self.snapshot_usable()
            && let Ok(terminal) = vt::snapshot::decode(&self.snapshot, scrollback_lines)
        {
            return Ok((terminal, Restored::Snapshot));
        }
        let mut terminal = Terminal::new(self.cols, self.rows, scrollback_lines)?;
        if !self.damaged[1] && !self.replay.is_empty() {
            terminal.write(&self.replay);
            // Replies to queries inside the replay go nowhere: nobody asked.
            drop(terminal.take_effects());
            return Ok((terminal, Restored::Replay));
        }
        if !self.damaged[2] {
            terminal.write(self.text.replace('\n', "\r\n").as_bytes());
            drop(terminal.take_effects());
        }
        Ok((terminal, Restored::Text))
    }
}

struct Cursor<'b> {
    bytes: &'b [u8],
    at: usize,
}

impl<'b> Cursor<'b> {
    fn take(&mut self, n: usize) -> Result<&'b [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len());
        let end = end.ok_or_else(|| corrupt("the file is cut short"))?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u64(&mut self) -> Result<u64> {
        let b = self.take(8)?;
        let mut array = [0u8; 8];
        array.copy_from_slice(b);
        Ok(u64::from_le_bytes(array))
    }
}

#[cfg(test)]
mod tests;
