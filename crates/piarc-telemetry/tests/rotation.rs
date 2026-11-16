//! T13-A06: logs rotate daily and files older than seven days are removed (injected clock).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use piarc_telemetry::{
    AGENT_HOST_PREFIX, AGENT_HOST_TARGET, CORE_PREFIX, Calendar, DailyLog, Day, Installed,
    RETENTION_DAYS, install_with,
};

/// A clock the test moves by hand.
struct TestCalendar(AtomicU64);

impl TestCalendar {
    fn at(day: Day, hour: u64) -> Arc<Self> {
        let seconds = u64::try_from(day.0).expect("after 1970") * 86_400 + hour * 3600;
        Arc::new(Self(AtomicU64::new(seconds)))
    }

    fn advance(&self, hours: u64) {
        self.0.fetch_add(hours * 3600, Ordering::SeqCst);
    }
}

impl Calendar for TestCalendar {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(self.0.load(Ordering::SeqCst))
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piarc-logs {name} 中文 {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("list")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn day(label: &str) -> Day {
    Day::parse(label).expect("valid day")
}

#[test]
fn rotates_daily_and_keeps_seven_days() {
    let dir = temp_dir("rotation");
    // Ten days of old logs, and files that are not ours.
    for offset in 1..=10 {
        let label = Day(day("2026-11-16").0 - offset).label();
        std::fs::write(dir.join(format!("core-{label}.log")), "old\n").expect("old log");
    }
    std::fs::write(dir.join("core-notes.log"), "keep").expect("other file");
    std::fs::write(dir.join("other-2026-01-01.log"), "keep").expect("other prefix");

    let clock = TestCalendar::at(day("2026-11-16"), 22);
    let log = DailyLog::open(&dir, "core", Arc::clone(&clock) as _, RETENTION_DAYS).expect("open");
    // Opening removed everything before 2026-11-10 (today and the six days before it stay).
    assert_eq!(
        names(&dir),
        [
            "core-2026-11-10.log",
            "core-2026-11-11.log",
            "core-2026-11-12.log",
            "core-2026-11-13.log",
            "core-2026-11-14.log",
            "core-2026-11-15.log",
            "core-notes.log",
            "other-2026-01-01.log",
        ]
    );

    log.append(b"first\n").expect("write");
    clock.advance(1); // 23:00 the same day
    log.append(b"second\n").expect("write");
    assert_eq!(
        std::fs::read_to_string(dir.join("core-2026-11-16.log")).expect("today"),
        "first\nsecond\n"
    );

    clock.advance(2); // 01:00 the next day: a new file, and the oldest kept day expires
    log.append(b"third\n").expect("write");
    assert_eq!(
        std::fs::read_to_string(dir.join("core-2026-11-17.log")).expect("tomorrow"),
        "third\n"
    );
    let listed = names(&dir);
    assert!(
        !listed.contains(&"core-2026-11-10.log".to_owned()),
        "{listed:?}"
    );
    assert!(
        listed.contains(&"core-2026-11-11.log".to_owned()),
        "{listed:?}"
    );

    // Six days later only the last seven days remain (2026-11-17 is the oldest kept); foreign
    // files remain.
    clock.advance(24 * 6);
    log.append(b"later\n").expect("write");
    assert_eq!(
        names(&dir),
        [
            "core-2026-11-17.log",
            "core-2026-11-23.log",
            "core-notes.log",
            "other-2026-01-01.log",
        ]
    );
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[test]
fn the_global_subscriber_splits_core_and_agent_host_logs() {
    let dir = temp_dir("subscriber");
    let clock = TestCalendar::at(day("2026-11-16"), 9);
    assert_eq!(
        install_with(&dir, Arc::clone(&clock) as _).expect("install"),
        Installed::Files
    );
    tracing::info!(target: "piarc_core", "core says hello");
    tracing::debug!(target: "piarc_core", "below the level");
    tracing::info!(target: AGENT_HOST_TARGET, session = "s-1", "[session s-1] agent line");
    clock.advance(24);
    tracing::warn!(target: "piarc_core", "next day");

    let read = |prefix: &str, label: &str| {
        std::fs::read_to_string(dir.join(format!("{prefix}-{label}.log"))).unwrap_or_default()
    };
    let core = read(CORE_PREFIX, "2026-11-16");
    assert!(core.contains("core says hello"), "{core}");
    assert!(!core.contains("below the level"));
    assert!(!core.contains("agent line"));
    let host = read(AGENT_HOST_PREFIX, "2026-11-16");
    assert!(
        host.contains("agent line") && host.contains("s-1"),
        "{host}"
    );
    assert!(read(CORE_PREFIX, "2026-11-17").contains("next day"));
    piarc_telemetry::detach();
    std::fs::remove_dir_all(dir).expect("cleanup");
}
