//! LF-delimited JSON frame codec (ADR-0009, rule 1).
//!
//! Byte-buffer only, no I/O: the transport (`piarc-host`) feeds bytes read from the Agent
//! Host's stdout into [`FrameDecoder::decode`] and writes the output of [`encode_frame`]
//! to its stdin. `@piarc/protocol` has a TypeScript twin (`framing.ts`); both pass the
//! shared byte-level cases in `tests/contracts/framing/`.
//!
//! Rules:
//!
//! - Frames are split on the LF byte (`0x0A`) only. U+2028 and U+2029 inside JSON strings
//!   are ordinary characters (their UTF-8 encodings contain no `0x0A`).
//! - A partial frame is buffered until the next input; one input may yield many frames.
//! - Empty frames (two consecutive LFs) are skipped.
//! - A frame whose content exceeds the limit (default [`DEFAULT_MAX_FRAME_BYTES`]) is
//!   reported once as [`Error::FrameTooLarge`] and discarded up to the next LF; frames
//!   after it decode normally. The buffer never grows beyond the limit.
//! - Invalid UTF-8 and invalid JSON are reported per frame as structured errors; decoding
//!   never panics.
//! - Encoding writes compact JSON, which never contains a raw LF, and appends one LF.

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// Default limit for the content of one frame (excluding the LF): 8 MiB.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

const LF: u8 = b'\n';

/// Incremental decoder for LF-delimited JSON frames.
#[derive(Debug)]
pub struct FrameDecoder {
    max_frame_bytes: usize,
    buffer: Vec<u8>,
    /// Inside an oversized frame that was already reported; skip until the next LF.
    discarding: bool,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    /// Creates a decoder with the default frame limit.
    #[must_use]
    pub fn new() -> Self {
        Self::with_max_frame_bytes(DEFAULT_MAX_FRAME_BYTES)
    }

    /// Creates a decoder whose frames may hold at most `max_frame_bytes` bytes of content.
    #[must_use]
    pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
        Self {
            max_frame_bytes,
            buffer: Vec::new(),
            discarding: false,
        }
    }

    /// The configured frame limit in bytes.
    #[must_use]
    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    /// Feeds `input` and returns every frame it completes, in order. Each element is the
    /// parsed JSON value or the error for that frame.
    pub fn decode(&mut self, input: &[u8]) -> Vec<Result<Value>> {
        let mut frames = Vec::new();
        let mut rest = input;
        while let Some(end) = rest.iter().position(|&b| b == LF) {
            let (line, after) = (&rest[..end], &rest[end + 1..]);
            rest = after;
            if self.discarding {
                self.discarding = false;
                continue;
            }
            if self.buffer.len() + line.len() > self.max_frame_bytes {
                self.buffer.clear();
                frames.push(Err(self.too_large()));
                continue;
            }
            let frame = if self.buffer.is_empty() {
                parse_frame(line)
            } else {
                self.buffer.extend_from_slice(line);
                let frame = parse_frame(&self.buffer);
                self.buffer.clear();
                frame
            };
            frames.extend(frame);
        }
        if !self.discarding && !rest.is_empty() {
            if self.buffer.len() + rest.len() > self.max_frame_bytes {
                self.buffer = Vec::new();
                self.discarding = true;
                frames.push(Err(self.too_large()));
            } else {
                self.buffer.extend_from_slice(rest);
            }
        }
        frames
    }

    fn too_large(&self) -> Error {
        Error::FrameTooLarge {
            limit: self.max_frame_bytes,
        }
    }
}

/// Parses one frame's content. `None` for an empty frame.
fn parse_frame(bytes: &[u8]) -> Option<Result<Value>> {
    if bytes.is_empty() {
        return None;
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => {
            return Some(Err(Error::InvalidUtf8 {
                reason: e.to_string(),
            }));
        }
    };
    Some(serde_json::from_str(text).map_err(|e| Error::InvalidJson {
        reason: e.to_string(),
    }))
}

/// Serializes `value` as one frame: compact JSON followed by LF.
///
/// # Errors
///
/// [`Error::Encode`] when `value` cannot be serialized to JSON (for example a map with
/// non-string keys).
pub fn encode_frame<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| Error::Encode {
        reason: e.to_string(),
    })?;
    bytes.push(LF);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rpc_error::ErrorKind;

    #[test]
    fn keeps_the_buffer_within_the_limit_while_discarding() {
        let mut decoder = FrameDecoder::with_max_frame_bytes(4);
        let first = decoder.decode(b"123456");
        assert_eq!(first.len(), 1);
        assert!(matches!(first[0], Err(Error::FrameTooLarge { limit: 4 })));
        for _ in 0..3 {
            assert!(decoder.decode(b"789").is_empty());
            assert!(decoder.buffer.is_empty());
        }
        let after = decoder.decode(b"0\n1\n");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].as_ref().ok(), Some(&json!(1)));
    }

    #[test]
    fn accepts_a_frame_exactly_at_the_limit() {
        let mut decoder = FrameDecoder::with_max_frame_bytes(4);
        let frames = decoder.decode(b"1234\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].as_ref().ok(), Some(&json!(1234)));
    }

    #[test]
    fn reports_structured_errors() {
        let mut decoder = FrameDecoder::new();
        let frames = decoder.decode(b"\xff\n{\n");
        let kinds: Vec<ErrorKind> = frames
            .iter()
            .map(|f| f.as_ref().expect_err("both frames are invalid").kind())
            .collect();
        assert_eq!(kinds, [ErrorKind::ParseError, ErrorKind::ParseError]);
    }

    #[test]
    fn reports_unencodable_values() {
        let mut map = std::collections::BTreeMap::new();
        map.insert(vec![1_u8], 1);
        let error = encode_frame(&map).expect_err("non-string keys cannot be encoded");
        assert_eq!(error.kind(), ErrorKind::InternalError);
    }
}
