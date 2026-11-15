//! Plaintext scan: searches directory trees byte by byte for secret values a test planted
//! (T08: no credential may appear in the data directory, logs or temporary directories).
//!
//! The scan walks each root without following symbolic links, optionally only files modified
//! since a given time (useful for shared directories such as the system temp directory), and
//! reports every file containing one of the needles. Files it cannot read are listed, not
//! silently ignored. Findings name the needle by index, never by value.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// One file that contains a needle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// The file.
    pub path: PathBuf,
    /// Index of the needle found.
    pub needle: usize,
}

/// What a scan looked at and found.
#[derive(Debug, Default, Clone)]
pub struct ScanReport {
    /// Files read.
    pub files: usize,
    /// Bytes read.
    pub bytes: u64,
    /// Files containing a needle.
    pub findings: Vec<Finding>,
    /// Entries that could not be read, with the reason.
    pub unreadable: Vec<(PathBuf, String)>,
}

/// Searches every regular file under `roots` (recursively) for each of `needles`. With
/// `modified_since`, files last modified before that time are skipped. Missing roots are
/// skipped.
#[must_use]
pub fn scan(roots: &[&Path], needles: &[&[u8]], modified_since: Option<SystemTime>) -> ScanReport {
    let mut report = ScanReport::default();
    let mut pending: Vec<PathBuf> = roots
        .iter()
        .filter(|r| r.exists())
        .map(|r| r.to_path_buf())
        .collect();
    while let Some(path) = pending.pop() {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) => {
                report.unreadable.push((path, e.to_string()));
                continue;
            }
        };
        if metadata.is_dir() {
            match fs::read_dir(&path) {
                Ok(entries) => pending.extend(entries.flatten().map(|e| e.path())),
                Err(e) => report.unreadable.push((path, e.to_string())),
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if let (Some(since), Ok(modified)) = (modified_since, metadata.modified())
            && modified < since
        {
            continue;
        }
        match fs::read(&path) {
            Ok(bytes) => {
                report.files += 1;
                report.bytes += bytes.len() as u64;
                for (index, needle) in needles.iter().enumerate() {
                    if contains(&bytes, needle) {
                        report.findings.push(Finding {
                            path: path.clone(),
                            needle: index,
                        });
                    }
                }
            }
            Err(e) => report.unreadable.push((path, e.to_string())),
        }
    }
    report
}

/// Whether `haystack` contains `needle` (an empty needle never matches).
#[must_use]
pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_needles_in_nested_files_and_skips_old_ones() {
        let root =
            std::env::temp_dir().join(format!("piarc plaintext scan {}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a").join("b")).expect("dirs");
        fs::write(root.join("a").join("b").join("log.txt"), b"x secret-1 y").expect("write");
        fs::write(root.join("clean.bin"), [0u8, 1, 2]).expect("write");
        let report = scan(&[&root], &[b"secret-1", b"secret-2"], None);
        assert_eq!(report.files, 2);
        assert_eq!(report.findings.len(), 1);
        assert_eq!(report.findings[0].needle, 0);
        let later = SystemTime::now() + std::time::Duration::from_secs(60);
        assert!(
            scan(&[&root], &[b"secret-1"], Some(later))
                .findings
                .is_empty()
        );
        let _ = fs::remove_dir_all(&root);
    }
}
