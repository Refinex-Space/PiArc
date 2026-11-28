//! Daily log files: `<prefix>-YYYY-MM-DD.log` in one directory, a new file when the (UTC) day
//! changes, files older than the retention period removed when a log opens and on every
//! rotation (so at least once a day while the app runs).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Days of logs kept, today included (architecture section 9.3).
pub const RETENTION_DAYS: u32 = 7;

/// Wall-clock time, injectable so tests can move across days.
pub trait Calendar: Send + Sync {
    /// The current time.
    fn now(&self) -> SystemTime;
}

/// The system's clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemCalendar;

impl Calendar for SystemCalendar {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// A day as days since 1970-01-01 (UTC).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Day(pub i64);

impl Day {
    /// The UTC day of `time`.
    #[must_use]
    pub fn of(time: SystemTime) -> Self {
        let seconds = match time.duration_since(UNIX_EPOCH) {
            Ok(since) => i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
            Err(before) => -i64::try_from(before.duration().as_secs()).unwrap_or(i64::MAX),
        };
        Self(seconds.div_euclid(86_400))
    }

    /// `YYYY-MM-DD`.
    #[must_use]
    pub fn label(self) -> String {
        let (year, month, day) = civil_from_days(self.0);
        format!("{year:04}-{month:02}-{day:02}")
    }

    /// Parses a `YYYY-MM-DD` label.
    #[must_use]
    pub fn parse(label: &str) -> Option<Self> {
        let bytes = label.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year: i64 = label.get(0..4)?.parse().ok()?;
        let month: i64 = label.get(5..7)?.parse().ok()?;
        let day: i64 = label.get(8..10)?.parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let parsed = Self(days_from_civil(year, month, day));
        (parsed.label() == label).then_some(parsed)
    }
}

/// One log stream that rotates daily.
pub struct DailyLog {
    dir: PathBuf,
    prefix: String,
    calendar: Arc<dyn Calendar>,
    retention_days: u32,
    current: Mutex<Option<(Day, File)>>,
}

impl std::fmt::Debug for DailyLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DailyLog")
            .field("dir", &self.dir)
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl DailyLog {
    /// Opens the stream `<dir>/<prefix>-<day>.log`, creating `dir`, and removes expired
    /// files of this prefix.
    ///
    /// # Errors
    ///
    /// The I/O error when `dir` cannot be created.
    pub fn open(
        dir: &Path,
        prefix: &str,
        calendar: Arc<dyn Calendar>,
        retention_days: u32,
    ) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let log = Self {
            dir: dir.to_owned(),
            prefix: prefix.to_owned(),
            calendar,
            retention_days: retention_days.max(1),
            current: Mutex::new(None),
        };
        log.remove_expired(Day::of(log.calendar.now()))?;
        Ok(log)
    }

    /// The file a line written now goes to.
    #[must_use]
    pub fn path_for(&self, day: Day) -> PathBuf {
        self.dir
            .join(format!("{}-{}.log", self.prefix, day.label()))
    }

    /// Appends `bytes` to today's file, rotating (and cleaning up) when the day changed.
    ///
    /// # Errors
    ///
    /// The I/O error of opening or writing the file.
    pub fn append(&self, bytes: &[u8]) -> io::Result<()> {
        let today = Day::of(self.calendar.now());
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if current.as_ref().is_none_or(|(day, _)| *day != today) {
            let rotated = current.is_some();
            *current = None;
            if rotated {
                self.remove_expired(today)?;
            }
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path_for(today))?;
            *current = Some((today, file));
        }
        match current.as_mut() {
            Some((_, file)) => file.write_all(bytes),
            None => Ok(()),
        }
    }

    /// Removes this stream's files from before the retention period ending `today`. Returns
    /// the removed files. Other files in the directory are never touched.
    ///
    /// # Errors
    ///
    /// The I/O error when the directory cannot be listed; files that cannot be removed are
    /// skipped.
    pub fn remove_expired(&self, today: Day) -> io::Result<Vec<PathBuf>> {
        let oldest_kept = Day(today.0 - i64::from(self.retention_days) + 1);
        let mut removed = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(day) = name
                .to_str()
                .and_then(|n| n.strip_prefix(self.prefix.as_str()))
                .and_then(|n| n.strip_prefix('-'))
                .and_then(|n| n.strip_suffix(".log"))
                .and_then(Day::parse)
            else {
                continue;
            };
            if day < oldest_kept && fs::remove_file(entry.path()).is_ok() {
                removed.push(entry.path());
            }
        }
        removed.sort();
        Ok(removed)
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian year, month (1–12) and day of `days` after 1970-01-01.
#[must_use]
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_labels_round_trip() {
        assert_eq!(Day(0).label(), "1970-01-01");
        assert_eq!(
            Day::parse("2026-11-16").map(Day::label).as_deref(),
            Some("2026-11-16")
        );
        assert_eq!(Day::parse("2024-02-29").map(|d| d.0), Some(19_782));
        for bad in ["2026-02-30", "2026-13-01", "26-11-16", "2026-11-1x"] {
            assert_eq!(Day::parse(bad), None, "{bad}");
        }
        let before_epoch = UNIX_EPOCH - std::time::Duration::from_secs(1);
        assert_eq!(Day::of(before_epoch).label(), "1969-12-31");
    }
}
