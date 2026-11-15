//! Cutting UTF-8 for transport: AHP strings must be valid UTF-8, so text read in pieces (file
//! ranges for `fs/read`, pipe reads for `exec/output`) is cut only between characters.

/// Number of trailing bytes of `bytes` that start a UTF-8 sequence the buffer does not
/// complete (0 to 3). Cutting them off, and prepending them to the next piece, keeps every
/// character whole; invalid bytes are not held back.
#[must_use]
pub fn incomplete_utf8_suffix(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue; // a continuation byte: look for its lead byte
        }
        let needed = match byte {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_start_of_a_cut_sequence() {
        let bytes = "a中🙂".as_bytes();
        assert_eq!(incomplete_utf8_suffix(&bytes[..1]), 0);
        assert_eq!(incomplete_utf8_suffix(&bytes[..2]), 1);
        assert_eq!(incomplete_utf8_suffix(&bytes[..3]), 2);
        assert_eq!(incomplete_utf8_suffix(&bytes[..4]), 0);
        assert_eq!(incomplete_utf8_suffix(&bytes[..7]), 3);
        assert_eq!(incomplete_utf8_suffix(bytes), 0);
        assert_eq!(incomplete_utf8_suffix(&[b'a', 0xff]), 0);
        assert_eq!(incomplete_utf8_suffix(&[0x80, 0x80, 0x80]), 0);
        assert_eq!(incomplete_utf8_suffix(&[]), 0);
    }
}
