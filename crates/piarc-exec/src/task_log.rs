//! The output file of a background task (architecture section 6.11, T32, ADR-0049).
//!
//! [`TaskLog`] appends the bytes of both pipes to the file in the order they were read, as
//! they arrive (no buffering: the model reads the file while the command runs), counts them,
//! splits each pipe into lines and keeps the last [`TAIL_LINES`] of them for the panel, the
//! completion notice and `KillShell`'s preview. [`TaskLog::write`] returns the lines a chunk
//! completed: a Monitor feeds them to the model.
//!
//! Memory stays bounded whatever the command prints: an unfinished line longer than
//! [`MAX_PENDING_BYTES`] is cut into a line of its own, kept lines are shortened to
//! [`MAX_LINE_CHARS`]. A file that cannot be written stops the writing, not the counting; the
//! error is kept for the task's record.
//!
//! [`read_chunk`] reads a byte range of such a file as text, ending on a character boundary.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use piarc_protocol::text::incomplete_utf8_suffix;

use crate::command::Stream;

/// Lines kept from the end of the output.
pub const TAIL_LINES: usize = 50;

/// A kept line is shortened to this many characters.
pub const MAX_LINE_CHARS: usize = 2_000;

/// An unfinished line longer than this (in bytes) becomes a line of its own.
pub const MAX_PENDING_BYTES: usize = 64 * 1024;

/// Appends a task's output to its file; see the module documentation.
#[derive(Debug)]
pub struct TaskLog {
    file: Option<File>,
    bytes: u64,
    /// The unfinished line of each pipe (stdout, stderr), as bytes.
    pending: [Vec<u8>; 2],
    tail: VecDeque<String>,
    lines: u64,
    error: Option<String>,
}

impl TaskLog {
    /// A new, empty file at `path` (its directory is created).
    ///
    /// # Errors
    ///
    /// The directory or the file cannot be created.
    pub fn create(path: &Path) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = File::create(path)?;
        Ok(Self::with_file(file, 0))
    }

    /// Continues the existing file at `path` (a foreground command's spilled output, moved
    /// there); `tail` is the end of what it holds, for the kept lines.
    ///
    /// # Errors
    ///
    /// The file cannot be opened for appending.
    pub fn resume(path: &Path, tail: &str) -> io::Result<Self> {
        let file = OpenOptions::new().append(true).open(path)?;
        let bytes = file.metadata()?.len();
        let mut log = Self::with_file(file, bytes);
        // The first line of `tail` may be cut; it is kept as it is, like any shortened line.
        let mut parts: Vec<&str> = tail.split('\n').collect();
        let unfinished = parts.pop().unwrap_or_default();
        for line in parts {
            log.keep(line.to_owned());
        }
        log.pending[0] = unfinished.as_bytes().to_vec();
        Ok(log)
    }

    fn with_file(file: File, bytes: u64) -> Self {
        Self {
            file: Some(file),
            bytes,
            pending: [Vec::new(), Vec::new()],
            tail: VecDeque::new(),
            lines: 0,
            error: None,
        }
    }

    /// Appends one read of `stream`; returns the lines it completed, without their line end.
    pub fn write(&mut self, stream: Stream, bytes: &[u8]) -> Vec<String> {
        self.append(bytes);
        let pending = &mut self.pending[index(stream)];
        pending.extend_from_slice(bytes);
        let mut done = Vec::new();
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let rest = pending.split_off(end + 1);
            let line = std::mem::replace(pending, rest);
            done.push(decode_line(&line[..end]));
        }
        if pending.len() > MAX_PENDING_BYTES {
            // Cut on a character boundary; the rest starts the next piece.
            let keep = pending.len() - incomplete_utf8_suffix(pending);
            let rest = pending.split_off(keep);
            let line = std::mem::replace(pending, rest);
            done.push(decode_line(&line));
        }
        for line in &done {
            self.keep(line.clone());
        }
        done
    }

    /// Appends text that is already decoded (what a foreground command printed before it
    /// moved to the background); returns the lines it completed.
    pub fn write_text(&mut self, text: &str) -> Vec<String> {
        self.write(Stream::Stdout, text.as_bytes())
    }

    /// The command ended: the unfinished lines of both pipes become lines; returns them.
    pub fn finish(&mut self) -> Vec<String> {
        let mut done = Vec::new();
        for pending in &mut self.pending {
            if !pending.is_empty() {
                done.push(decode_line(&std::mem::take(pending)));
            }
        }
        for line in &done {
            self.keep(line.clone());
        }
        done
    }

    fn append(&mut self, bytes: &[u8]) {
        self.bytes += bytes.len() as u64;
        if let Some(file) = &mut self.file
            && let Err(error) = file.write_all(bytes)
        {
            self.error = Some(format!("cannot write the output file: {error}"));
            self.file = None;
        }
    }

    fn keep(&mut self, line: String) {
        self.lines += 1;
        self.tail.push_back(shorten(line));
        while self.tail.len() > TAIL_LINES {
            self.tail.pop_front();
        }
    }

    /// Bytes of output taken (all written to the file unless [`TaskLog::error`] says
    /// otherwise).
    #[must_use]
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Lines completed so far.
    #[must_use]
    pub fn lines(&self) -> u64 {
        self.lines
    }

    /// The last `n` lines (at most [`TAIL_LINES`]), newest last, with the unfinished lines of
    /// both pipes after them.
    #[must_use]
    pub fn tail(&self, n: usize) -> Vec<String> {
        let mut lines: Vec<String> = self.tail.iter().cloned().collect();
        for pending in &self.pending {
            if !pending.is_empty() {
                lines.push(shorten(decode_line(pending)));
            }
        }
        let skip = lines.len().saturating_sub(n);
        lines.split_off(skip)
    }

    /// Why the file stopped being written.
    #[must_use]
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

fn index(stream: Stream) -> usize {
    match stream {
        Stream::Stdout => 0,
        Stream::Stderr => 1,
    }
}

/// `line` cut to [`MAX_LINE_CHARS`] characters and an ellipsis.
fn shorten(mut line: String) -> String {
    if let Some((at, _)) = line.char_indices().nth(MAX_LINE_CHARS) {
        line.truncate(at);
        line.push('…');
    }
    line
}

/// A line's bytes as text: invalid sequences replaced, a trailing `\r` dropped.
fn decode_line(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// A byte range of a task's output file, as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// The bytes read, decoded (invalid sequences replaced).
    pub text: String,
    /// Where the next read starts.
    pub next_offset: u64,
    /// Bytes in the file.
    pub total_bytes: u64,
}

/// Reads at most `max` bytes of `path` from `offset`. Unless the read reaches the end of the
/// file, it stops before a character cut in two (the next read starts with it).
///
/// # Errors
///
/// The file cannot be opened or read.
pub fn read_chunk(path: &Path, offset: u64, max: usize) -> io::Result<Chunk> {
    let mut file = File::open(path)?;
    let total_bytes = file.metadata()?.len();
    let start = offset.min(total_bytes);
    file.seek(SeekFrom::Start(start))?;
    let wanted = usize::try_from(total_bytes - start)
        .unwrap_or(usize::MAX)
        .min(max);
    let mut bytes = vec![0_u8; wanted];
    file.read_exact(&mut bytes)?;
    let at_end = start + wanted as u64 == total_bytes;
    if !at_end {
        let cut = incomplete_utf8_suffix(&bytes);
        bytes.truncate(bytes.len() - cut);
    }
    Ok(Chunk {
        next_offset: start + bytes.len() as u64,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("piarc-task-log {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_bytes_in_order_and_splits_each_pipe_into_lines() {
        let root = dir("lines");
        let path = root.join("tasks").join("bg-1.log");
        let mut log = TaskLog::create(&path).expect("create");
        assert_eq!(log.write(Stream::Stdout, b"one\ntw"), ["one"]);
        assert!(log.write(Stream::Stderr, "错".as_bytes()).is_empty());
        assert_eq!(log.write(Stream::Stdout, b"o\r\nthree"), ["two"]);
        assert_eq!(log.write(Stream::Stderr, "误\n".as_bytes()), ["错误"]);
        assert_eq!(log.tail(10), ["one", "two", "错误", "three"]);
        assert_eq!(log.finish(), ["three"]);
        assert_eq!(log.lines(), 4);
        let written = std::fs::read(&path).expect("read");
        assert_eq!(written, "one\ntw错o\r\nthree误\n".as_bytes());
        assert_eq!(log.bytes(), written.len() as u64);
        assert_eq!(log.tail(2), ["错误", "three"]);
        std::fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn memory_stays_bounded_without_line_ends() {
        let root = dir("long");
        let mut log = TaskLog::create(&root.join("x.log")).expect("create");
        let mut lines = 0;
        for _ in 0..40 {
            lines += log.write(Stream::Stdout, &[b'a'; 10_000]).len();
        }
        assert!(lines >= 5, "{lines}");
        assert!(log.pending[0].len() <= MAX_PENDING_BYTES);
        assert!(
            log.tail(TAIL_LINES)
                .iter()
                .all(|l| l.chars().count() <= MAX_LINE_CHARS + 1)
        );
        assert_eq!(log.bytes(), 400_000);
        std::fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn resumes_a_spilled_file_and_reads_ranges_on_character_boundaries() {
        let root = dir("resume");
        std::fs::create_dir_all(&root).expect("dir");
        let path = root.join("spilled.log");
        std::fs::write(&path, "前文\n第二行").expect("seed");
        let mut log = TaskLog::resume(&path, "前文\n第二行").expect("resume");
        assert_eq!(
            log.write(Stream::Stdout, "继续\n".as_bytes()),
            ["第二行继续"]
        );
        assert_eq!(log.tail(5), ["前文", "第二行继续"]);
        let all = std::fs::read_to_string(&path).expect("read");
        assert_eq!(all, "前文\n第二行继续\n");
        // "前" is three bytes: a read of four stops after it, the next read starts with "文".
        let first = read_chunk(&path, 0, 4).expect("chunk");
        assert_eq!((first.text.as_str(), first.next_offset), ("前", 3));
        let second = read_chunk(&path, first.next_offset, 1024).expect("chunk");
        assert_eq!(second.text, "文\n第二行继续\n");
        assert_eq!(second.next_offset, second.total_bytes);
        let past = read_chunk(&path, 10_000, 10).expect("past the end");
        assert_eq!(
            (past.text.as_str(), past.next_offset),
            ("", past.total_bytes)
        );
        std::fs::remove_dir_all(&root).expect("cleanup");
    }
}
