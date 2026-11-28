//! Splitting streamed strings into deltas.
//!
//! Offsets count Unicode scalar values (`char`s), so a cut never lands inside a UTF-8
//! sequence: each fragment must itself be a valid JSON string on the wire. A cut may land
//! anywhere else, including inside a JSON string value or between the two characters of
//! an escape sequence such as `\"`.

/// Splits `text` into `pieces` fragments of near-equal length (at least one).
///
/// When `text` has fewer characters than `pieces`, the leading fragments are empty, so the
/// number of fragments is always `pieces`.
#[must_use]
pub fn split_even(text: &str, pieces: usize) -> Vec<String> {
    let pieces = pieces.max(1);
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    (0..pieces)
        .map(|index| {
            let start = index * len / pieces;
            let end = (index + 1) * len / pieces;
            chars[start..end].iter().collect()
        })
        .collect()
}

/// Splits `text` at the given character offsets.
///
/// # Errors
///
/// A description of the problem when the offsets are not strictly increasing or are not
/// strictly inside the text (an offset of 0 or of the full length would make an empty
/// fragment).
pub fn split_at_offsets(text: &str, offsets: &[usize]) -> Result<Vec<String>, String> {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut fragments = Vec::with_capacity(offsets.len() + 1);
    let mut start = 0;
    for &offset in offsets {
        if offset <= start || offset >= len {
            return Err(format!(
                "split_at offset {offset} must be greater than {start} and less than {len} \
                 (the character length of {text})"
            ));
        }
        fragments.push(chars[start..offset].iter().collect());
        start = offset;
    }
    fragments.push(chars[start..].iter().collect());
    Ok(fragments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn even_split_keeps_every_character_in_order() {
        let text = r#"{"path":"a b/中文.txt","n":1}"#;
        let pieces = split_even(text, 3);
        assert_eq!(pieces.len(), 3);
        assert!(pieces.iter().all(|piece| !piece.is_empty()));
        assert_eq!(pieces.concat(), text);
    }

    #[test]
    fn even_split_of_short_text_pads_with_empty_leading_fragments() {
        assert_eq!(split_even("{}", 3), vec!["", "{", "}"]);
        assert_eq!(split_even("", 2), vec!["", ""]);
    }

    #[test]
    fn explicit_offsets_can_cut_inside_an_escape_sequence() {
        let text = r#"{"q":"say \"hi\""}"#;
        let backslash = text.find('\\').expect("the text has an escape");
        let pieces = split_at_offsets(text, &[4, backslash + 1]).expect("offsets are valid");
        assert_eq!(pieces[1], r#":"say \"#);
        assert!(pieces[2].starts_with('"'));
        assert_eq!(pieces.concat(), text);
    }

    #[test]
    fn explicit_offsets_count_characters_not_bytes() {
        let pieces = split_at_offsets("中文字", &[1, 2]).expect("offsets are valid");
        assert_eq!(pieces, vec!["中", "文", "字"]);
    }

    #[test]
    fn rejects_offsets_that_are_out_of_order_or_at_the_edges() {
        assert!(split_at_offsets("abcd", &[2, 2]).is_err());
        assert!(split_at_offsets("abcd", &[0]).is_err());
        assert!(split_at_offsets("abcd", &[4]).is_err());
    }
}
