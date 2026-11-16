//! Streaming, read-only reading of JSONL files (Pi session files).
//!
//! [`LineReader`] yields one complete line at a time from a byte offset. A line is complete
//! when its `\n` has been read; the last line of a file that Pi is still writing may lack it
//! (Pi appends with `appendFileSync`, no fsync, no lock). Such a line is reported as
//! [`Line::Incomplete`] and not consumed: the next read starts from its first byte again.
//!
//! Memory stays bounded by [`BUFFERED_LINE_LIMIT`] per line plus what the caller's parser keeps:
//! longer lines are parsed straight from the file through [`Line::parse`] without being
//! buffered whole.

use std::io::{self, BufRead, BufReader, Cursor, Read, Seek, SeekFrom};

use serde::de::DeserializeOwned;

/// Lines up to this many bytes are read into memory and parsed from the buffer; longer ones
/// are parsed while streaming from the file.
pub const BUFFERED_LINE_LIMIT: usize = 1024 * 1024;

const READ_BUFFER: usize = 64 * 1024;

/// Reads lines from a byte offset.
pub struct LineReader<R> {
    inner: BufReader<R>,
    offset: u64,
    line: Vec<u8>,
}

impl<R: Read + Seek> LineReader<R> {
    /// Starts reading `source` at `offset`.
    ///
    /// # Errors
    ///
    /// The seek's I/O error.
    pub fn at(mut source: R, offset: u64) -> io::Result<Self> {
        source.seek(SeekFrom::Start(offset))?;
        Ok(Self {
            inner: BufReader::with_capacity(READ_BUFFER, source),
            offset,
            line: Vec::new(),
        })
    }
}

impl<R: Read + Seek> LineReader<R> {
    /// The offset of the next unread byte: just after the last complete line.
    #[must_use]
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// The next line. Returns `None` at the end of the file.
    ///
    /// # Errors
    ///
    /// I/O errors from the file.
    pub fn next_line(&mut self) -> io::Result<Option<Line<'_, R>>> {
        self.line.clear();
        let start = self.offset;
        let found = read_until_newline(&mut self.inner, &mut self.line, BUFFERED_LINE_LIMIT)?;
        if self.line.is_empty() && !found {
            return Ok(None);
        }
        Ok(Some(Line {
            start,
            buffered_newline: found,
            reader: self,
        }))
    }
}

/// One line, borrowed from its [`LineReader`]. Call [`Line::parse`] or [`Line::skip`] to move
/// past it; dropping it without either leaves the reader mid-line only for lines longer than
/// [`BUFFERED_LINE_LIMIT`], so always finish with one of them.
pub struct Line<'a, R> {
    start: u64,
    buffered_newline: bool,
    reader: &'a mut LineReader<R>,
}

/// What reading a line produced.
#[derive(Debug)]
pub enum Parsed<T> {
    /// The line held a value.
    Value(T),
    /// The line was empty or whitespace only.
    Blank,
    /// The line is not valid JSON for `T`; it was skipped.
    Invalid(serde_json::Error),
    /// The file ended before the line's `\n`: the writer has not finished it. Nothing was
    /// consumed; the next read starts again at the line's first byte.
    Incomplete,
}

impl<R: Read + Seek> Line<'_, R> {
    /// Byte offset of the line's first byte.
    #[must_use]
    pub fn start(&self) -> u64 {
        self.start
    }

    /// Parses the line as `T` and moves past it (unless it is incomplete).
    ///
    /// # Errors
    ///
    /// I/O errors from the file.
    pub fn parse<T: DeserializeOwned>(self) -> io::Result<(Parsed<T>, LineBytes)> {
        let Line {
            start,
            buffered_newline,
            reader,
        } = self;
        if buffered_newline {
            let bytes = reader.line.len() as u64;
            reader.offset = start + bytes;
            let parsed = parse_slice(&reader.line);
            return Ok((parsed, LineBytes { start, bytes }));
        }
        if reader.line.len() < BUFFERED_LINE_LIMIT {
            // The file ended before the newline: go back to the line's start.
            reader.offset = start;
            reader.inner.seek(SeekFrom::Start(start))?;
            return Ok((Parsed::Incomplete, LineBytes { start, bytes: 0 }));
        }
        // A long line: continue parsing from the file, then consume up to its newline.
        let head = std::mem::take(&mut reader.line);
        let mut rest = UntilNewline::new(&mut reader.inner);
        let result = serde_json::from_reader::<_, T>(Cursor::new(head.as_slice()).chain(&mut rest));
        rest.drain()?;
        if let Some(error) = rest.error.take() {
            return Err(error);
        }
        let found = rest.found_newline;
        let bytes = head.len() as u64 + rest.consumed;
        reader.line = head;
        if !found {
            // The writer has not finished this long line: go back to its start.
            reader.offset = start;
            reader.inner.seek(SeekFrom::Start(start))?;
            return Ok((Parsed::Incomplete, LineBytes { start, bytes: 0 }));
        }
        reader.offset = start + bytes;
        let parsed = match result {
            Ok(value) => Parsed::Value(value),
            Err(error) => Parsed::Invalid(error),
        };
        Ok((parsed, LineBytes { start, bytes }))
    }
}

/// Where a consumed line was in the file, including its `\n`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineBytes {
    /// Offset of the first byte.
    pub start: u64,
    /// Length including the newline; 0 for an incomplete line.
    pub bytes: u64,
}

fn parse_slice<T: DeserializeOwned>(line: &[u8]) -> Parsed<T> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Parsed::Blank;
    }
    match serde_json::from_slice(line) {
        Ok(value) => Parsed::Value(value),
        Err(error) => Parsed::Invalid(error),
    }
}

/// Appends bytes up to and including the next `\n` to `out`, but at most `limit` bytes.
/// Returns whether the newline was read.
fn read_until_newline<B: BufRead>(
    input: &mut B,
    out: &mut Vec<u8>,
    limit: usize,
) -> io::Result<bool> {
    loop {
        let available = match input.fill_buf() {
            Ok(buffer) => buffer,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(false);
        }
        let room = limit.saturating_sub(out.len());
        let window = &available[..available.len().min(room)];
        if let Some(at) = window.iter().position(|&b| b == b'\n') {
            out.extend_from_slice(&window[..=at]);
            input.consume(at + 1);
            return Ok(true);
        }
        let taken = window.len();
        out.extend_from_slice(window);
        input.consume(taken);
        if out.len() >= limit {
            return Ok(false);
        }
    }
}

/// A reader that ends at the next `\n` (not included), for streaming one long line into a
/// parser. Records how many bytes it consumed, newline included.
struct UntilNewline<'a, B> {
    input: &'a mut B,
    consumed: u64,
    found_newline: bool,
    error: Option<io::Error>,
}

impl<'a, B: BufRead> UntilNewline<'a, B> {
    fn new(input: &'a mut B) -> Self {
        Self {
            input,
            consumed: 0,
            found_newline: false,
            error: None,
        }
    }

    /// Consumes the rest of the line after a parser stopped early.
    fn drain(&mut self) -> io::Result<()> {
        let mut sink = [0_u8; 8 * 1024];
        while !self.found_newline && self.error.is_none() {
            if self.read(&mut sink)? == 0 {
                break;
            }
        }
        Ok(())
    }
}

impl<B: BufRead> Read for UntilNewline<'_, B> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.found_newline || buf.is_empty() {
            return Ok(0);
        }
        let available = match self.input.fill_buf() {
            Ok(available) => available,
            Err(error) => {
                // Remember it: serde_json would turn it into a parse error.
                let reported = io::Error::new(error.kind(), error.to_string());
                self.error = Some(error);
                return Err(reported);
            }
        };
        if available.is_empty() {
            return Ok(0);
        }
        let window = &available[..available.len().min(buf.len())];
        let (count, newline) = match window.iter().position(|&b| b == b'\n') {
            Some(at) => (at, true),
            None => (window.len(), false),
        };
        buf[..count].copy_from_slice(&window[..count]);
        let consumed = count + usize::from(newline);
        self.input.consume(consumed);
        self.consumed += consumed as u64;
        self.found_newline = newline;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn lines(data: &[u8], offset: u64) -> (Vec<String>, u64) {
        let mut reader = LineReader::at(Cursor::new(data.to_vec()), offset).expect("seek");
        let mut out = Vec::new();
        while let Some(line) = reader.next_line().expect("read") {
            let (parsed, _) = line.parse::<Value>().expect("io");
            match parsed {
                Parsed::Value(v) => out.push(v.to_string()),
                Parsed::Blank => out.push("blank".into()),
                Parsed::Invalid(_) => out.push("invalid".into()),
                Parsed::Incomplete => {
                    out.push("incomplete".into());
                    break;
                }
            }
        }
        (out, reader.offset())
    }

    #[test]
    fn complete_lines_and_an_unfinished_last_line() {
        let data = b"{\"a\":1}\n\n{broken\n{\"b\":2}\n{\"c\":";
        let (out, offset) = lines(data, 0);
        assert_eq!(
            out,
            ["{\"a\":1}", "blank", "invalid", "{\"b\":2}", "incomplete"]
        );
        assert_eq!(offset, 25, "stops before the unfinished line");
        let (out, offset) = lines(data, 25);
        assert_eq!(out, ["incomplete"]);
        assert_eq!(offset, 25);
    }

    #[test]
    fn crlf_lines_parse() {
        let (out, offset) = lines(b"{\"a\":1}\r\n{\"b\":2}\r\n", 0);
        assert_eq!(out, ["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(offset, 18);
    }

    #[test]
    fn long_lines_stream_and_resume() {
        let big = "x".repeat(BUFFERED_LINE_LIMIT * 2 + 17);
        let first = format!("{{\"text\":\"{big}\"}}\n");
        let mut data = first.clone().into_bytes();
        data.extend_from_slice(b"{\"after\":true}\n");
        let (out, offset) = lines(&data, 0);
        assert_eq!(out.len(), 2);
        assert!(out[0].len() > BUFFERED_LINE_LIMIT * 2);
        assert_eq!(out[1], "{\"after\":true}");
        assert_eq!(offset, data.len() as u64);

        // The same long line without its newline is incomplete and not consumed.
        let unfinished = &first.as_bytes()[..first.len() - 1];
        let mut reader = LineReader::at(Cursor::new(unfinished.to_vec()), 0).expect("seek");
        let line = reader.next_line().expect("read").expect("a line");
        assert!(matches!(
            line.parse::<Value>().expect("io").0,
            Parsed::Incomplete
        ));
        assert_eq!(reader.offset(), 0);
        let line = reader.next_line().expect("read").expect("again");
        assert_eq!(line.start(), 0);
    }

    #[test]
    fn a_long_invalid_line_is_skipped_to_its_newline() {
        let mut data = format!("{{\"text\": {}", "1".repeat(BUFFERED_LINE_LIMIT + 5)).into_bytes();
        data.extend_from_slice(b" oops\n{\"ok\":1}\n");
        let (out, _) = lines(&data, 0);
        assert_eq!(out, ["invalid", "{\"ok\":1}"]);
    }
}
