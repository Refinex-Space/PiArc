//! A command's output as the model gets it (architecture section 6.11): whole up to
//! [`ExecLimits::inline_chars`] characters, otherwise a start and an end around an omission,
//! with the full text saved to a file.
//!
//! [`OutputCapture`] takes the chunks of both pipes in the order they were read and decodes
//! each pipe as UTF-8 on its own (a sequence split between reads waits for the next read;
//! invalid bytes and a sequence left open at the end become U+FFFD). Memory stays bounded
//! whatever the command prints: the first [`ExecLimits::inline_chars`] characters and a rolling
//! end of the output. Once the output outgrows the inline budget, the file is opened through
//! the caller's [`SpillTarget`] and receives everything, start included; a file that cannot be
//! written only costs the full text (the summary says why).

use std::io::{self, BufWriter, Write};

use piarc_protocol::text::incomplete_utf8_suffix;

use crate::command::Stream;
use crate::limits::ExecLimits;

/// Opens the file the full output goes to: its writer and the path to tell the model.
pub type SpillTarget = Box<dyn FnOnce() -> io::Result<(Box<dyn Write + Send>, String)> + Send>;

/// A line end this close to a cut (as a share of the kept text) moves the cut to it, so the
/// kept parts start and end with whole lines when that costs little.
const SNAP_SHARE: usize = 4;

/// The output, ready to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedOutput {
    /// All of it, or its start when [`CapturedOutput::tail`] is present.
    pub head: String,
    /// Its end, when the middle was left out.
    pub tail: Option<String>,
    /// Characters of the whole output.
    pub total_chars: u64,
    /// Characters left out between `head` and `tail`.
    pub omitted_chars: u64,
    /// Where the full text is (as the model is told), when it was saved.
    pub full_output_path: Option<String>,
    /// Why the full text could not be saved.
    pub spill_error: Option<String>,
}

impl CapturedOutput {
    /// Whether part of the output is left out.
    #[must_use]
    pub fn truncated(&self) -> bool {
        self.tail.is_some()
    }
}

/// Collects a running command's output; see the module documentation.
pub struct OutputCapture {
    limits: ExecLimits,
    /// Bytes of an unfinished UTF-8 sequence, per pipe.
    pending: [Vec<u8>; 2],
    /// The first `inline_chars` characters.
    head: String,
    head_chars: usize,
    /// The end of the output, at least `tail_keep` characters once there are that many.
    tail: String,
    tail_chars: usize,
    total_chars: u64,
    target: Option<SpillTarget>,
    spill: Option<(BufWriter<Box<dyn Write + Send>>, String)>,
    spill_error: Option<String>,
}

impl std::fmt::Debug for OutputCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputCapture")
            .field("total_chars", &self.total_chars)
            .field("spilled", &self.spill.is_some())
            .finish_non_exhaustive()
    }
}

impl OutputCapture {
    /// An empty capture; `target` opens the file of the full text when it is needed.
    #[must_use]
    pub fn new(limits: ExecLimits, target: SpillTarget) -> Self {
        Self {
            limits,
            pending: [Vec::new(), Vec::new()],
            head: String::new(),
            head_chars: 0,
            tail: String::new(),
            tail_chars: 0,
            total_chars: 0,
            target: Some(target),
            spill: None,
            spill_error: None,
        }
    }

    /// Characters taken so far.
    #[must_use]
    pub fn total_chars(&self) -> u64 {
        self.total_chars
    }

    /// Adds one read of `stream`.
    pub fn push(&mut self, stream: Stream, bytes: &[u8]) {
        let pending = &mut self.pending[index(stream)];
        pending.extend_from_slice(bytes);
        let complete = pending.len() - incomplete_utf8_suffix(pending);
        let rest = pending.split_off(complete);
        let text = String::from_utf8_lossy(pending).into_owned();
        *pending = rest;
        self.push_text(&text);
    }

    /// The output as the model gets it; `success` picks the kept parts of a long output
    /// (a short preview after success, a long start and end after failure).
    #[must_use]
    pub fn finish(mut self, success: bool) -> CapturedOutput {
        for stream in [Stream::Stdout, Stream::Stderr] {
            let rest = std::mem::take(&mut self.pending[index(stream)]);
            if !rest.is_empty() {
                self.push_text(&String::from_utf8_lossy(&rest));
            }
        }
        let full_output_path = match self.spill.take() {
            Some((mut writer, path)) => match writer.flush() {
                Ok(()) => Some(path),
                Err(error) => {
                    self.spill_error = Some(format!("cannot write {path}: {error}"));
                    None
                }
            },
            None => None,
        };
        let total = usize::try_from(self.total_chars).unwrap_or(usize::MAX);
        if total <= self.limits.inline_chars {
            return CapturedOutput {
                head: self.head,
                tail: None,
                total_chars: self.total_chars,
                omitted_chars: 0,
                full_output_path,
                spill_error: self.spill_error,
            };
        }
        let (head_keep, tail_keep) = if success {
            let half = self.limits.preview_chars / 2;
            (half, self.limits.preview_chars - half)
        } else {
            (
                self.limits.failure_head_chars,
                self.limits.failure_tail_chars,
            )
        };
        let head = snap_end(first_chars(&self.head, head_keep));
        let tail = snap_start(last_chars(&self.tail, self.tail_chars, tail_keep));
        let kept = head.chars().count() + tail.chars().count();
        CapturedOutput {
            head: head.to_owned(),
            tail: Some(tail.to_owned()),
            total_chars: self.total_chars,
            omitted_chars: self.total_chars.saturating_sub(kept as u64),
            full_output_path,
            spill_error: self.spill_error,
        }
    }

    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let count = text.chars().count();
        self.total_chars += count as u64;
        // Until the budget is full, `head` holds everything taken so far.
        let before = self.head.len();
        let room = self.limits.inline_chars.saturating_sub(self.head_chars);
        if room > 0 {
            let taken = first_chars(text, room);
            self.head.push_str(taken);
            self.head_chars += taken.chars().count();
        }
        self.push_tail(text, count);
        let total = usize::try_from(self.total_chars).unwrap_or(usize::MAX);
        if total > self.limits.inline_chars {
            self.write_spill(before, text);
        }
    }

    /// Keeps the end of the output, trimming only when it grew to twice what is needed.
    fn push_tail(&mut self, text: &str, count: usize) {
        let keep = self
            .limits
            .failure_tail_chars
            .max(self.limits.preview_chars)
            .max(1);
        self.tail.push_str(text);
        self.tail_chars += count;
        if self.tail_chars > keep * 2 {
            let trimmed = last_chars(&self.tail, self.tail_chars, keep).to_owned();
            self.tail = trimmed;
            self.tail_chars = keep;
        }
    }

    /// Appends `text` to the file, opening it on first use and writing the output before
    /// `text` (the first `before` bytes of `head`) first.
    fn write_spill(&mut self, before: usize, text: &str) {
        if self.spill.is_none() {
            let Some(target) = self.target.take() else {
                return;
            };
            match target() {
                Ok((writer, path)) => {
                    let mut writer = BufWriter::new(writer);
                    let written = writer.write_all(&self.head.as_bytes()[..before]);
                    self.spill = Some((writer, path));
                    if let Err(error) = written {
                        self.fail_spill(&error);
                        return;
                    }
                }
                Err(error) => {
                    self.spill_error = Some(format!("cannot save the full output: {error}"));
                    return;
                }
            }
        }
        if let Some((writer, _)) = &mut self.spill
            && let Err(error) = writer.write_all(text.as_bytes())
        {
            self.fail_spill(&error);
        }
    }

    fn fail_spill(&mut self, error: &io::Error) {
        if let Some((_, path)) = self.spill.take() {
            self.spill_error = Some(format!("cannot write {path}: {error}"));
        }
    }
}

fn index(stream: Stream) -> usize {
    match stream {
        Stream::Stdout => 0,
        Stream::Stderr => 1,
    }
}

/// The first `n` characters of `text`.
fn first_chars(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// The last `n` characters of `text`, which has `count` characters.
fn last_chars(text: &str, count: usize, n: usize) -> &str {
    if count <= n {
        return text;
    }
    match text.char_indices().nth(count - n) {
        Some((at, _)) => &text[at..],
        None => "",
    }
}

/// `head` cut after its last line end, when that line end is near its end.
fn snap_end(head: &str) -> &str {
    match head.rfind('\n') {
        Some(at) if head.len() - at <= head.len() / SNAP_SHARE => &head[..=at],
        _ => head,
    }
}

/// `tail` cut after its first line end, when that line end is near its start.
fn snap_start(tail: &str) -> &str {
    match tail.find('\n') {
        Some(at) if at < tail.len() / SNAP_SHARE => &tail[at + 1..],
        _ => tail,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    fn limits() -> ExecLimits {
        ExecLimits {
            inline_chars: 100,
            preview_chars: 20,
            failure_head_chars: 30,
            failure_tail_chars: 40,
            ..ExecLimits::default()
        }
    }

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("sink").extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn capture(sink: &Sink) -> OutputCapture {
        let sink = sink.clone();
        OutputCapture::new(
            limits(),
            Box::new(move || {
                Ok((
                    Box::new(sink) as Box<dyn Write + Send>,
                    "~/out.txt".to_owned(),
                ))
            }),
        )
    }

    fn text(sink: &Sink) -> String {
        String::from_utf8(sink.0.lock().expect("sink").clone()).expect("utf-8")
    }

    #[test]
    fn short_output_is_kept_whole_and_not_saved() {
        let sink = Sink::default();
        let mut c = capture(&sink);
        c.push(Stream::Stdout, "out ".as_bytes());
        c.push(Stream::Stderr, "错误\n".as_bytes());
        let out = c.finish(true);
        assert_eq!(out.head, "out 错误\n");
        assert!(!out.truncated());
        assert_eq!(out.total_chars, 7);
        assert_eq!(out.full_output_path, None);
        assert!(text(&sink).is_empty());
    }

    #[test]
    fn utf8_split_between_reads_is_joined_per_pipe() {
        let sink = Sink::default();
        let mut c = capture(&sink);
        let bytes = "中文".as_bytes();
        c.push(Stream::Stdout, &bytes[..2]);
        c.push(Stream::Stderr, b"e");
        c.push(Stream::Stdout, &bytes[2..]);
        c.push(Stream::Stdout, &[0xe4]);
        assert_eq!(c.finish(true).head, "e中文\u{fffd}");
    }

    #[test]
    fn long_success_keeps_a_preview_and_saves_everything() {
        let sink = Sink::default();
        let mut c = capture(&sink);
        let full: String = (0..50).map(|i| format!("line {i:02}\n")).collect();
        for piece in full.as_bytes().chunks(7) {
            c.push(Stream::Stdout, piece);
        }
        let out = c.finish(true);
        assert_eq!(text(&sink), full);
        assert_eq!(out.full_output_path.as_deref(), Some("~/out.txt"));
        assert_eq!(out.total_chars, full.chars().count() as u64);
        assert!(out.head.starts_with("line 00\n"));
        assert!(out.head.chars().count() <= 10);
        let tail = out.tail.expect("tail");
        assert!(full.ends_with(&tail));
        assert!(tail.chars().count() <= 10);
        assert_eq!(
            out.omitted_chars,
            out.total_chars - (out.head.chars().count() + tail.chars().count()) as u64
        );
    }

    #[test]
    fn long_failure_keeps_a_longer_start_and_end() {
        let sink = Sink::default();
        let mut c = capture(&sink);
        let full = "x".repeat(500);
        c.push(Stream::Stderr, full.as_bytes());
        let out = c.finish(false);
        assert_eq!(out.head, "x".repeat(30));
        assert_eq!(out.tail.as_deref(), Some("x".repeat(40).as_str()));
        assert_eq!(out.omitted_chars, 430);
        assert_eq!(text(&sink), full);
    }

    #[test]
    fn a_target_that_fails_costs_only_the_file() {
        let mut c = OutputCapture::new(limits(), Box::new(|| Err(io::Error::other("disk full"))));
        c.push(Stream::Stdout, "y".repeat(300).as_bytes());
        let out = c.finish(true);
        assert!(out.truncated());
        assert_eq!(out.full_output_path, None);
        assert!(out.spill_error.expect("error").contains("disk full"));
    }

    #[test]
    fn memory_stays_bounded() {
        let sink = Sink::default();
        let mut c = capture(&sink);
        let chunk = "z".repeat(10_000);
        for _ in 0..100 {
            c.push(Stream::Stdout, chunk.as_bytes());
        }
        assert!(c.head.len() <= 100);
        assert!(c.tail.len() <= 2 * 40 + 10_000);
        assert_eq!(c.finish(true).total_chars, 1_000_000);
        assert_eq!(text(&sink).len(), 1_000_000);
    }
}
