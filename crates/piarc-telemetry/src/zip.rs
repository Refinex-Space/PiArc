//! A ZIP archive of uncompressed ("stored") entries for the diagnostic bundle: the bundle is a few
//! megabytes of text, every system opens such an archive, and no compression library is needed.
//! Format: PKWARE APPNOTE 6.3 sections 4.3 (local headers, central directory, end record),
//! UTF-8 names (general purpose bit 11), CRC-32 of each entry.

use std::io::{self, Write};
use std::time::SystemTime;

use crate::rotation::{Day, civil_from_days};

/// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) as ZIP uses it.
#[must_use]
pub fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0_u32; 256];
        for (n, entry) in table.iter_mut().enumerate() {
            let mut c = u32::try_from(n).unwrap_or_default();
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *entry = c;
        }
        table
    });
    !bytes.iter().fold(!0_u32, |crc, byte| {
        table[usize::from((crc as u8) ^ byte)] ^ (crc >> 8)
    })
}

/// The MS-DOS date and time fields of `time` (UTC, two-second resolution, 1980 at the earliest).
fn dos_time(time: SystemTime) -> (u16, u16) {
    let seconds = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let day = Day::of(time);
    let (year, month, date) = civil_from_days(day.0);
    if year < 1980 {
        return (0x21, 0);
    }
    let in_day = seconds % 86_400;
    let field = |value: u64| u16::try_from(value).unwrap_or(0);
    let year = u64::try_from(year - 1980).unwrap_or(0).min(127);
    let date = field(
        (year << 9) | (u64::try_from(month).unwrap_or(1) << 5) | u64::try_from(date).unwrap_or(1),
    );
    let clock = field(((in_day / 3600) << 11) | (((in_day / 60) % 60) << 5) | ((in_day % 60) / 2));
    (date, clock)
}

fn u16_of(value: usize) -> io::Result<u16> {
    u16::try_from(value).map_err(|_| io::Error::other("a ZIP field exceeds 16 bits"))
}

fn u32_of(value: usize) -> io::Result<u32> {
    u32::try_from(value).map_err(|_| io::Error::other("the bundle exceeds the ZIP format's 4 GiB"))
}

/// Writes `entries` (name with `/`, contents) as a ZIP archive to `out`, stamped `time`.
///
/// # Errors
///
/// The write error, or an entry or archive too large for the format without ZIP64.
pub fn write_archive(
    out: &mut impl Write,
    entries: &[(&str, &[u8])],
    time: SystemTime,
) -> io::Result<()> {
    let mut archive = ArchiveWriter::new(out, time);
    for (name, data) in entries {
        archive.add(name, data)?;
    }
    archive.finish()
}

/// A ZIP archive written one entry at a time: only the central directory stays in memory, so an
/// archive of many large files (the data export) never holds them all at once.
pub struct ArchiveWriter<'a, W: Write> {
    out: &'a mut W,
    date: u16,
    clock: u16,
    central: Vec<u8>,
    offset: usize,
    count: usize,
}

impl<'a, W: Write> ArchiveWriter<'a, W> {
    /// An empty archive written to `out`, every entry stamped `time`.
    pub fn new(out: &'a mut W, time: SystemTime) -> Self {
        let (date, clock) = dos_time(time);
        Self {
            out,
            date,
            clock,
            central: Vec::new(),
            offset: 0,
            count: 0,
        }
    }

    /// Appends the entry `name` (with `/`) holding `data`.
    ///
    /// # Errors
    ///
    /// The write error, or an entry, an entry count or an archive too large for the format
    /// without ZIP64 (4 GiB, 65,535 entries).
    pub fn add(&mut self, name: &str, data: &[u8]) -> io::Result<()> {
        let name = name.as_bytes();
        let crc = crc32(data);
        let size = u32_of(data.len())?;
        u16_of(self.count + 1)?;
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        header.extend_from_slice(&10_u16.to_le_bytes()); // version needed: stored
        header.extend_from_slice(&0x0800_u16.to_le_bytes()); // UTF-8 names
        header.extend_from_slice(&0_u16.to_le_bytes()); // method: stored
        header.extend_from_slice(&self.clock.to_le_bytes());
        header.extend_from_slice(&self.date.to_le_bytes());
        header.extend_from_slice(&crc.to_le_bytes());
        header.extend_from_slice(&size.to_le_bytes());
        header.extend_from_slice(&size.to_le_bytes());
        header.extend_from_slice(&u16_of(name.len())?.to_le_bytes());
        header.extend_from_slice(&0_u16.to_le_bytes()); // extra field length
        header.extend_from_slice(name);
        let offset = u32_of(self.offset)?;
        u32_of(self.offset + header.len() + data.len())?;
        self.out.write_all(&header)?;
        self.out.write_all(data)?;

        let central = &mut self.central;
        central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
        central.extend_from_slice(&0x031e_u16.to_le_bytes()); // made by: Unix, 3.0
        central.extend_from_slice(&10_u16.to_le_bytes());
        central.extend_from_slice(&0x0800_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&self.clock.to_le_bytes());
        central.extend_from_slice(&self.date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&u16_of(name.len())?.to_le_bytes());
        central.extend_from_slice(&[0; 8]); // extra, comment, disk start, internal attributes
        central.extend_from_slice(&(0o100_644_u32 << 16).to_le_bytes()); // a regular file, 0644
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
        self.offset += header.len() + data.len();
        self.count += 1;
        Ok(())
    }

    /// Writes the central directory and the end record.
    ///
    /// # Errors
    ///
    /// The write error, or a directory past the format's 4 GiB.
    pub fn finish(self) -> io::Result<()> {
        let count = u16_of(self.count)?;
        let mut end = Vec::with_capacity(22);
        end.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        end.extend_from_slice(&[0; 4]); // this disk, disk with the directory
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&u32_of(self.central.len())?.to_le_bytes());
        end.extend_from_slice(&u32_of(self.offset)?.to_le_bytes());
        end.extend_from_slice(&0_u16.to_le_bytes()); // comment length
        self.out.write_all(&self.central)?;
        self.out.write_all(&end)?;
        self.out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn an_archive_has_one_local_header_per_entry_and_an_end_record() {
        let mut out = Vec::new();
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_795_000_000);
        write_archive(&mut out, &[("a.txt", b"alpha"), ("日志/b.log", b"")], at).expect("written");
        assert_eq!(&out[..4], &[0x50, 0x4b, 0x03, 0x04]);
        let end = out.len() - 22;
        assert_eq!(&out[end..end + 4], &[0x50, 0x4b, 0x05, 0x06]);
        assert_eq!(u16::from_le_bytes([out[end + 10], out[end + 11]]), 2);
        assert!(
            out.windows("日志/b.log".len())
                .any(|w| w == "日志/b.log".as_bytes())
        );
    }

    #[test]
    fn entries_added_one_at_a_time_make_the_same_archive() {
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_795_000_000);
        let entries: [(&str, &[u8]); 3] = [("a.txt", b"alpha"), ("b/c.md", b"# c"), ("d", b"")];
        let mut whole = Vec::new();
        write_archive(&mut whole, &entries, at).expect("written");
        let mut streamed = Vec::new();
        let mut archive = ArchiveWriter::new(&mut streamed, at);
        for (name, data) in entries {
            archive.add(name, data).expect("added");
        }
        archive.finish().expect("finished");
        assert_eq!(whole, streamed);
        // Each local header's offset in the central directory points at its signature.
        let end = streamed.len() - 22;
        let directory = u32::from_le_bytes(streamed[end + 16..end + 20].try_into().expect("4"));
        let first = usize::try_from(directory).expect("fits");
        let offset = u32::from_le_bytes(streamed[first + 42..first + 46].try_into().expect("4"));
        assert_eq!(offset, 0);
    }
}
