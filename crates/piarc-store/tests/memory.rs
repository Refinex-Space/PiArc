//! T13-A04: indexing a 100 MB session file raises Core's memory by at most 32 MB.
//!
//! Heap: a counting global allocator records the peak of live Rust allocations while the file
//! is indexed. SQLite allocates with the C allocator; its page cache is capped at
//! `CACHE_KIB` per connection, and the index writes one row per file, so SQLite's share stays
//! within that cap (it is added to the reported total).
//!
//! `cargo test -p piarc-store --release --test memory -- --nocapture` prints the numbers.

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use piarc_store::{CACHE_KIB, FileOutcome, Store};
use support::{Rng, SessionWriter, TempDir};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards to the system allocator and only adds bookkeeping.
#[expect(
    unsafe_code,
    reason = "a counting global allocator for the memory measurement"
)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: same contract as the caller's.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) };
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const TARGET_BYTES: u64 = 100 * 1024 * 1024;
const BUDGET_BYTES: usize = 32 * 1024 * 1024;

#[test]
fn indexing_a_100_mb_session_stays_within_32_mb() {
    let dir = TempDir::new("memory");
    let sessions = dir.path().join("sessions");
    let mut writer = SessionWriter::create(&sessions, "/work/大 仓库", "s-big", Some(3));
    let mut rng = Rng::new(7);
    // Realistic shapes: long tool results (file reads), a few multi-megabyte lines, images.
    let mut batch = String::new();
    let mut written = 0_u64;
    let mut entries = 0_u64;
    while written < TARGET_BYTES {
        let line = if entries % 4000 == 3999 {
            writer.tool_result(&"一行很长的输出 ".repeat(200_000))
        } else {
            match rng.below(4) {
                0 => writer.user("请继续"),
                1 => writer.assistant("好的", "mock-large", rng.below(9000), rng.below(900)),
                _ => writer.tool_result(&"fn main() { println!(\"hello\"); }\n".repeat(80)),
            }
        };
        written += line.len() as u64 + 1;
        entries += 1;
        batch.push_str(&line);
        batch.push('\n');
        if batch.len() > 8 * 1024 * 1024 {
            writer.append_partial(&batch);
            batch.clear();
        }
    }
    writer.append_partial(&batch);
    drop(batch);
    let size = std::fs::metadata(&writer.path).expect("size").len();
    assert!(size >= TARGET_BYTES, "{size}");

    let mut store = Store::open(&dir.path().join("core.sqlite"), 0).expect("store");
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let started = Instant::now();
    let mut skipped = Vec::new();
    let outcome = store.sync_file(&writer.path, &mut skipped).expect("index");
    let elapsed = started.elapsed();
    let heap_peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    let sqlite_cap = usize::try_from(CACHE_KIB).unwrap_or(0) * 1024;
    let total = heap_peak + sqlite_cap;

    assert_eq!(outcome, FileOutcome::Rescanned { entries });
    assert!(skipped.is_empty());
    let record = store.session("s-big").expect("read").expect("indexed");
    assert_eq!(
        u64::try_from(record.meta.message_count).unwrap_or(0),
        entries
    );
    println!(
        "T13-A04: file {:.1} MiB, {entries} entries, indexed in {:.2} s; Rust heap peak +{:.2} MiB, SQLite page cache cap {:.2} MiB, total {:.2} MiB (budget 32 MiB)",
        size as f64 / 1_048_576.0,
        elapsed.as_secs_f64(),
        heap_peak as f64 / 1_048_576.0,
        sqlite_cap as f64 / 1_048_576.0,
        total as f64 / 1_048_576.0,
    );
    assert!(
        total <= BUDGET_BYTES,
        "memory {total} exceeds {BUDGET_BYTES}"
    );
}
