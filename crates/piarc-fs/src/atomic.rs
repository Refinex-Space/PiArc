//! Replacing a file without ever leaving it half written (architecture section 6.1.2,
//! "保真写入"): the new content goes to a temporary file in the same directory, is flushed to
//! disk, and the temporary file is renamed over the target. A failure before the rename removes
//! the temporary file and leaves the target as it was.
//!
//! - The temporary file is `.<name>.piarc-<pid>-<n>.tmp`, created exclusively, so concurrent
//!   writers in this or another Core never share one.
//! - Unix: the new file gets the old file's permission bits (a new file gets the default
//!   `0o666` less the umask). Windows: it gets the old file's hidden and system attributes;
//!   ACLs come from the directory as for any new file.
//! - `std::fs::rename` replaces an existing target on both platforms: `rename(2)` on Unix; on
//!   Windows 10 1607 and later `FileRenameInfoEx` with POSIX semantics where the file system
//!   supports it, otherwise `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` (Rust 1.99
//!   documentation). On Windows another process holding the target open without sharing delete
//!   access (a virus scanner, an indexer) makes the rename fail with access denied for a
//!   moment, so it is retried a few times there.
//! - Renaming breaks hard links: the other names keep the old content.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Distinguishes the temporary files of this process.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Replaces (or creates) `target` with `bytes`. `original` is the target's metadata when it
/// exists.
///
/// # Errors
///
/// Creating, writing, flushing or renaming the temporary file failed; the target is unchanged.
pub(crate) fn replace(target: &Path, bytes: &[u8], original: Option<&Metadata>) -> io::Result<()> {
    replace_with(target, original, |file| file.write_all(bytes))
}

/// [`replace`] with the content written by `write` (tests inject failures here).
pub(crate) fn replace_with(
    target: &Path,
    original: Option<&Metadata>,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let temp = temp_path(target)?;
    let mut file = create_temp(&temp, original)?;
    let written = write(&mut file)
        .and_then(|()| keep_permissions(&file, original))
        .and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| rename(&temp, target));
    if result.is_err() {
        // Best effort: the error that matters is the one returned.
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn temp_path(target: &Path) -> io::Result<PathBuf> {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the target has no parent directory or file name",
        ));
    };
    Ok(dir.join(format!(
        ".{}.piarc-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    )))
}

fn create_temp(temp: &Path, original: Option<&Metadata>) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if let Some(metadata) = original {
            options.attributes(metadata.file_attributes() & (HIDDEN | SYSTEM));
        }
    }
    #[cfg(unix)]
    if original.is_some() {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(temp)
}

/// Unix: the old file's permission bits, exactly (creation applies the umask).
fn keep_permissions(file: &File, original: Option<&Metadata>) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(metadata) = original {
        file.set_permissions(metadata.permissions())?;
    }
    #[cfg(not(unix))]
    let _ = (file, original);
    Ok(())
}

fn rename(temp: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        const ATTEMPTS: u32 = 5;
        let mut attempt = 1;
        loop {
            match std::fs::rename(temp, target) {
                Err(error)
                    if error.kind() == io::ErrorKind::PermissionDenied && attempt < ATTEMPTS =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(20 * u64::from(attempt)));
                    attempt += 1;
                }
                other => return other,
            }
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(temp, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("listed")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn replacement_stages_private_contents_privately() {
        use std::os::unix::fs::PermissionsExt as _;
        let tree = TempTree::new("private-staging");
        tree.file("private", "original");
        let target = tree.path("private");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).expect("mode");
        let original = target.metadata().expect("metadata");
        replace_with(&target, Some(&original), |file| {
            assert_eq!(file.metadata()?.permissions().mode() & 0o077, 0);
            Ok(())
        })
        .expect("replace");
    }

    #[test]
    fn replaces_and_creates_files() {
        let tree = TempTree::new("atomic-replace");
        tree.file("d 目录/a.txt", "old");
        let target = tree.path("d 目录/a.txt");
        let metadata = std::fs::metadata(&target).expect("exists");
        replace(&target, b"new", Some(&metadata)).expect("replaced");
        assert_eq!(std::fs::read(&target).expect("reads"), b"new");
        let created = tree.path("d 目录/b.txt");
        replace(&created, b"fresh", None).expect("created");
        assert_eq!(std::fs::read(&created).expect("reads"), b"fresh");
        assert!(leftovers(&tree.path("d 目录")).is_empty());
    }

    #[test]
    fn a_failure_while_writing_leaves_the_target_intact_and_no_temporary_file() {
        let tree = TempTree::new("atomic-failure");
        tree.file("d/a.txt", "the original content\n");
        let target = tree.path("d/a.txt");
        let metadata = std::fs::metadata(&target).expect("exists");
        let error = replace_with(&target, Some(&metadata), |file| {
            // Half the content reaches the disk, then the disk is full.
            file.write_all(b"the new co")?;
            Err(io::Error::from(io::ErrorKind::StorageFull))
        })
        .expect_err("the write fails");
        assert_eq!(error.kind(), io::ErrorKind::StorageFull);
        assert_eq!(
            std::fs::read_to_string(&target).expect("reads"),
            "the original content\n"
        );
        assert!(leftovers(&tree.path("d")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_permission_bits() {
        use std::os::unix::fs::PermissionsExt as _;
        let tree = TempTree::new("atomic-mode");
        tree.file("run.sh", "#!/bin/sh\n");
        let target = tree.path("run.sh");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o751)).expect("chmod");
        let metadata = std::fs::metadata(&target).expect("exists");
        replace(&target, b"#!/bin/sh\necho hi\n", Some(&metadata)).expect("replaced");
        let mode = std::fs::metadata(&target)
            .expect("exists")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o751);
    }
}
