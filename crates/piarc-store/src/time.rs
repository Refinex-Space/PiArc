//! Timestamps as Unix milliseconds.

/// Parses the UTC timestamps JavaScript's `Date.prototype.toISOString` writes
/// (`2026-11-16T10:20:30.123Z`), also without fraction or with an explicit `+00:00` offset.
/// Returns `None` for anything else.
#[must_use]
pub fn parse_iso8601_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let digits = bytes.get(range)?;
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(digits).ok()?.parse().ok()
    };
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let kept = &fraction[..digits.min(3)];
        millis = kept.parse::<i64>().ok()? * 10_i64.pow(u32::try_from(3 - kept.len()).ok()?);
        rest = &fraction[digits..];
    }
    if rest != "Z" && rest != "+00:00" {
        return None;
    }
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
#[must_use]
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_javascript_iso_strings() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(
            parse_iso8601_ms("2000-03-01T00:00:00.5Z"),
            Some(951_868_800_500)
        );
        assert_eq!(
            parse_iso8601_ms("2026-11-16T10:20:30.123+00:00"),
            Some(1_794_824_430_123)
        );
        for bad in [
            "",
            "2026-11-16",
            "2026-11-16T10:20:30",
            "2026-13-01T00:00:00Z",
            "2026-11-16T10:20:30.Z",
            "2026-11-16T10:20:30+08:00",
        ] {
            assert_eq!(parse_iso8601_ms(bad), None, "{bad}");
        }
    }
}
