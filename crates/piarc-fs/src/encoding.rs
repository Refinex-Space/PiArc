//! Text encodings of files: detection, decoding by range and encoding back (architecture section
//! 6.1.2, "保真写入").
//!
//! Detection only looks further than UTF-8 when the bytes are not UTF-8:
//!
//! 1. A byte order mark decides: UTF-8, UTF-16LE or UTF-16BE.
//! 2. Valid UTF-8 (including a sequence cut by the end of a prefix) is UTF-8.
//! 3. Bytes with a NUL are binary: read as UTF-8 with U+FFFD, as before T16.
//! 4. Anything else goes to `chardetng`, which names a legacy encoding (GBK, Shift_JIS,
//!    windows-1252, …); if it still says UTF-8, invalid sequences become U+FFFD.
//!
//! A byte order mark is part of the decoded text as a leading U+FEFF, the way the tools see it
//! for UTF-8 files. Encoding puts back exactly the file's byte order mark: a leading U+FEFF of
//! the text is dropped and replaced by the encoding's mark, if it has one.

use std::borrow::Cow;

use encoding_rs::{DecoderResult, EncoderResult, Encoding, UTF_8, UTF_16BE, UTF_16LE};

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16LE_BOM: &[u8] = b"\xFF\xFE";
const UTF16BE_BOM: &[u8] = b"\xFE\xFF";

/// The encoding of a text file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    /// UTF-8, with or without a byte order mark.
    Utf8 {
        /// Whether the file starts with `EF BB BF`.
        bom: bool,
    },
    /// UTF-16 with a byte order mark.
    Utf16 {
        /// Big endian (`FE FF`) rather than little endian (`FF FE`).
        big_endian: bool,
    },
    /// A legacy encoding named by detection, never UTF-8 or UTF-16.
    Legacy(&'static Encoding),
}

impl TextEncoding {
    /// UTF-8 without a byte order mark: what new files get.
    pub const NEW_FILE: Self = Self::Utf8 { bom: false };

    /// The encoding's name (`UTF-8`, `UTF-16LE`, `GBK`, …).
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Utf8 { .. } => "UTF-8",
            Self::Utf16 { big_endian: false } => "UTF-16LE",
            Self::Utf16 { big_endian: true } => "UTF-16BE",
            Self::Legacy(encoding) => encoding.name(),
        }
    }

    /// The name for results that only mention encodings other than UTF-8.
    #[must_use]
    pub fn reported(self) -> Option<String> {
        match self {
            Self::Utf8 { .. } => None,
            other => Some(other.name().to_owned()),
        }
    }

    fn encoding(self) -> &'static Encoding {
        match self {
            Self::Utf8 { .. } => UTF_8,
            Self::Utf16 { big_endian: false } => UTF_16LE,
            Self::Utf16 { big_endian: true } => UTF_16BE,
            Self::Legacy(encoding) => encoding,
        }
    }

    fn bom(self) -> &'static [u8] {
        match self {
            Self::Utf8 { bom: true } => UTF8_BOM,
            Self::Utf16 { big_endian: false } => UTF16LE_BOM,
            Self::Utf16 { big_endian: true } => UTF16BE_BOM,
            Self::Utf8 { bom: false } | Self::Legacy(_) => b"",
        }
    }
}

/// The encoding of a file whose content starts with `head` (the whole file, or a prefix of it).
#[must_use]
pub fn detect(head: &[u8]) -> TextEncoding {
    if head.starts_with(UTF8_BOM) {
        return TextEncoding::Utf8 { bom: true };
    }
    if head.starts_with(UTF16LE_BOM) {
        return TextEncoding::Utf16 { big_endian: false };
    }
    if head.starts_with(UTF16BE_BOM) {
        return TextEncoding::Utf16 { big_endian: true };
    }
    match std::str::from_utf8(head) {
        Ok(_) => return TextEncoding::NEW_FILE,
        // Only a sequence cut by the end of the prefix: still UTF-8.
        Err(error) if error.error_len().is_none() => return TextEncoding::NEW_FILE,
        Err(_) => {}
    }
    if head.contains(&0) {
        return TextEncoding::NEW_FILE;
    }
    // ISO-2022-JP is 7-bit, so valid UTF-8: it never gets here.
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(head, true);
    let guess = detector.guess(None, chardetng::Utf8Detection::Allow);
    if guess == UTF_8 || guess == UTF_16LE || guess == UTF_16BE {
        TextEncoding::NEW_FILE
    } else {
        TextEncoding::Legacy(guess)
    }
}

/// Decodes `bytes` (a whole file) into text, invalid sequences as U+FFFD, a byte order mark as a
/// leading U+FEFF.
#[must_use]
pub fn decode(encoding: TextEncoding, bytes: &[u8]) -> String {
    let (text, _) = decode_range(encoding, bytes, true);
    text
}

/// Decodes a range of a file that starts at a character boundary. Unless `last` (the range
/// reaches the end of the file), a character cut by the end of the range is left out: the
/// result says how many bytes the text covers, and the next range starts there. A range that
/// holds only the start of one character is decoded whole (with U+FFFD), so callers reading
/// tiny ranges make progress.
#[must_use]
pub fn decode_range(encoding: TextEncoding, bytes: &[u8], last: bool) -> (String, usize) {
    let decoder = encoding.encoding();
    let whole = decode_with(decoder, bytes, true);
    if last {
        return (whole, bytes.len());
    }
    // Decoded without `last`, a cut character stays in the decoder: the text is shorter.
    let open = decode_with(decoder, bytes, false);
    if open == whole {
        return (whole, bytes.len());
    }
    // The cut character has at most 4 bytes: the longest prefix that decodes to `open`.
    for cut in 1..=bytes.len().min(4) {
        let keep = bytes.len() - cut;
        if keep > 0 && decode_with(decoder, &bytes[..keep], true) == open {
            return (open, keep);
        }
    }
    (whole, bytes.len())
}

fn decode_with(encoding: &'static Encoding, bytes: &[u8], last: bool) -> String {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len().saturating_mul(3));
    let mut text = String::with_capacity(capacity);
    let (_, _, _) = decoder.decode_to_string(bytes, &mut text, last);
    text
}

/// A character the target encoding cannot represent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unencodable {
    /// The character.
    pub character: char,
    /// 1-based line of the text it is on.
    pub line: u64,
}

/// `text` as the bytes of a file in `encoding`, with the encoding's byte order mark (if any)
/// instead of a leading U+FEFF of the text.
///
/// # Errors
///
/// The first character a legacy encoding cannot represent.
pub fn encode(encoding: TextEncoding, text: &str) -> Result<Vec<u8>, Unencodable> {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut bytes = encoding.bom().to_vec();
    match encoding {
        TextEncoding::Utf8 { .. } => bytes.extend_from_slice(body.as_bytes()),
        TextEncoding::Utf16 { big_endian } => {
            for unit in body.encode_utf16() {
                let pair = if big_endian {
                    unit.to_be_bytes()
                } else {
                    unit.to_le_bytes()
                };
                bytes.extend_from_slice(&pair);
            }
        }
        TextEncoding::Legacy(target) => bytes.extend_from_slice(&encode_legacy(target, body)?),
    }
    Ok(bytes)
}

fn encode_legacy(target: &'static Encoding, text: &str) -> Result<Vec<u8>, Unencodable> {
    let mut encoder = target.new_encoder();
    let mut out = Vec::with_capacity(
        encoder
            .max_buffer_length_from_utf8_without_replacement(text.len())
            .unwrap_or(text.len().saturating_mul(4)),
    );
    let mut rest = text;
    loop {
        let (result, read) =
            encoder.encode_from_utf8_to_vec_without_replacement(rest, &mut out, true);
        match result {
            EncoderResult::InputEmpty => return Ok(out),
            EncoderResult::OutputFull => {
                out.reserve(rest.len().max(16));
                rest = &rest[read..];
            }
            EncoderResult::Unmappable(character) => {
                // `read` includes the unmappable character.
                let before = &text[..text.len() - rest.len() + read - character.len_utf8()];
                let line = before.bytes().filter(|&b| b == b'\n').count() as u64 + 1;
                return Err(Unencodable { character, line });
            }
        }
    }
}

/// Whether `bytes` decode in `encoding` without replacement (tests and diagnostics).
#[must_use]
pub fn decodes_cleanly(encoding: TextEncoding, bytes: &[u8]) -> bool {
    let mut decoder = encoding.encoding().new_decoder_without_bom_handling();
    let mut text = String::with_capacity(bytes.len().saturating_mul(3) + 4);
    let (result, _) = decoder.decode_to_string_without_replacement(bytes, &mut text, true);
    matches!(result, DecoderResult::InputEmpty)
}

/// The line break style the text mostly uses: `Some("\r\n")` when CRLF outnumbers lone LF,
/// `Some("\n")` otherwise, `None` without line breaks.
#[must_use]
pub fn dominant_line_ending(text: &str) -> Option<&'static str> {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    match (crlf, lf) {
        (0, 0) => None,
        (crlf, lf) if crlf > lf => Some("\r\n"),
        _ => Some("\n"),
    }
}

/// `text` with every line break (`\r\n` or `\n`) written as `ending`.
#[must_use]
pub fn with_line_endings<'a>(text: &'a str, ending: &str) -> Cow<'a, str> {
    let lf = if text.contains("\r\n") {
        Cow::Owned(text.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(text)
    };
    if ending == "\n" {
        lf
    } else {
        Cow::Owned(lf.replace('\n', ending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gbk(text: &str) -> Vec<u8> {
        encode(TextEncoding::Legacy(encoding_rs::GBK), text).expect("GBK")
    }

    #[test]
    fn detects_boms_utf8_binary_and_legacy_text() {
        assert_eq!(detect(b"\xEF\xBB\xBFa"), TextEncoding::Utf8 { bom: true });
        assert_eq!(
            detect(b"\xFF\xFEa\0"),
            TextEncoding::Utf16 { big_endian: false }
        );
        assert_eq!(
            detect(b"\xFE\xFF\0a"),
            TextEncoding::Utf16 { big_endian: true }
        );
        assert_eq!(detect("中文 ok".as_bytes()), TextEncoding::NEW_FILE);
        // A prefix that cuts the last character is still UTF-8.
        assert_eq!(detect(&"中".as_bytes()[..2]), TextEncoding::NEW_FILE);
        assert_eq!(detect(b"\x89PNG\0\xff"), TextEncoding::NEW_FILE);
        let legacy = detect(&gbk(
            "这是一个用简体中文写的文件，编码是国标。\r\n第二行也是中文。\r\n",
        ));
        assert_eq!(legacy.name(), "GBK");
        assert_eq!(legacy.reported().as_deref(), Some("GBK"));
    }

    #[test]
    fn decoding_by_range_never_cuts_a_character() {
        let text = "前言：甲乙丙丁\r\n戊己庚辛\r\n";
        let bytes = gbk(text);
        let encoding = TextEncoding::Legacy(encoding_rs::GBK);
        let mut offset = 0;
        let mut collected = String::new();
        while offset < bytes.len() {
            let end = (offset + 3).min(bytes.len());
            let (piece, used) = decode_range(encoding, &bytes[offset..end], end == bytes.len());
            assert!(used > 0);
            collected.push_str(&piece);
            offset += used;
        }
        assert_eq!(collected, text);
    }

    #[test]
    fn utf16_ranges_keep_surrogate_pairs_together() {
        let encoding = TextEncoding::Utf16 { big_endian: false };
        let bytes = encode(encoding, "\u{feff}a🙂b").expect("UTF-16");
        assert_eq!(&bytes[..2], UTF16LE_BOM);
        // BOM (2) + a (2) + half of the pair (2): the pair is left for the next range.
        let (first, used) = decode_range(encoding, &bytes[..6], false);
        assert_eq!((first.as_str(), used), ("\u{feff}a", 4));
        let (rest, _) = decode_range(encoding, &bytes[4..], true);
        assert_eq!(rest, "🙂b");
        assert_eq!(decode(encoding, &bytes), "\u{feff}a🙂b");
    }

    #[test]
    fn encoding_keeps_exactly_the_files_byte_order_mark() {
        let with = TextEncoding::Utf8 { bom: true };
        assert_eq!(encode(with, "\u{feff}x").expect("utf8"), b"\xEF\xBB\xBFx");
        assert_eq!(encode(with, "x").expect("utf8"), b"\xEF\xBB\xBFx");
        assert_eq!(
            encode(TextEncoding::NEW_FILE, "\u{feff}x").expect("utf8"),
            b"x"
        );
        let encoding = TextEncoding::Legacy(encoding_rs::GBK);
        let bytes = encode(encoding, "中文\r\n").expect("GBK");
        assert!(decodes_cleanly(encoding, &bytes));
        assert_eq!(decode(encoding, &bytes), "中文\r\n");
    }

    #[test]
    fn reports_the_line_of_an_unencodable_character() {
        let error = encode(
            TextEncoding::Legacy(encoding_rs::GBK),
            "第一行\n第二行 🙂\n",
        )
        .expect_err("emoji is not GBK");
        assert_eq!(
            error,
            Unencodable {
                character: '🙂',
                line: 2
            }
        );
    }

    #[test]
    fn line_endings_follow_the_dominant_style() {
        assert_eq!(dominant_line_ending("a\r\nb\r\nc\n"), Some("\r\n"));
        assert_eq!(dominant_line_ending("a\nb\r\n"), Some("\n"));
        assert_eq!(dominant_line_ending("one line"), None);
        assert_eq!(with_line_endings("a\nb\r\nc", "\r\n"), "a\r\nb\r\nc");
        assert_eq!(with_line_endings("a\r\nb\n", "\n"), "a\nb\n");
    }
}
