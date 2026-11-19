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

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::io::{self, Write};
use std::path::Path;
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
    // This entry point also serves Core-owned spill files. Workspace writes start from the
    // directory that was bound before the original file was opened.
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("missing target parent"))?
        .canonicalize()?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("missing target name"))?;
    let dir = Dir::open_ambient_dir(&parent, cap_std::ambient_authority())?;
    replace_in(&dir, &parent, name, original, write, || Ok(())).map(drop)
}

pub(crate) fn replace_bound(
    target: &crate::bound::BoundPath,
    original: Option<&Metadata>,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> crate::Result<Metadata> {
    let (dir, name) = target.parent()?;
    target.verify()?;
    let parent = target
        .path()
        .parent()
        .ok_or_else(|| crate::Error::coded(target.path(), "EINVAL", "no parent"))?;
    replace_in(dir, parent, name, original, write, || target.verify_io())
        .map_err(|e| crate::Error::io(target.path(), e))
}

fn replace_in(
    dir: &Dir,
    parent: &Path,
    name: &OsStr,
    original: Option<&Metadata>,
    write: impl FnOnce(&mut File) -> io::Result<()>,
    verify: impl Fn() -> io::Result<()>,
) -> io::Result<Metadata> {
    let temp = format!(
        ".{}.piarc-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let mut file = create_temp(dir, &temp, original)?;
    let written = write(&mut file)
        .and_then(|()| keep_permissions(&file, original))
        .and_then(|()| file.sync_all())
        .and_then(|()| file.metadata());
    drop(file);
    let result = written.and_then(|metadata| {
        rename(dir, parent, &temp, name, &verify)?;
        Ok(metadata)
    });
    if result.is_err() {
        // The original directory also owns cleanup after it was moved.
        #[cfg(windows)]
        let _ = crate::bound::with_pinned_windows_path(dir, parent, |p| {
            std::fs::remove_file(p.join(&temp))
        });
        #[cfg(not(windows))]
        let _ = dir.remove_file(&temp);
    }
    result
}

fn create_temp(dir: &Dir, temp: &str, original: Option<&Metadata>) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        use std::os::windows::fs::MetadataExt as _;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if let Some(metadata) = original {
            options.attributes(metadata.file_attributes() & (HIDDEN | SYSTEM));
        }
    }
    #[cfg(unix)]
    if original.is_some() {
        use cap_std::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    dir.open_with(temp, &options)
        .map(cap_std::fs::File::into_std)
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

fn rename(
    dir: &Dir,
    parent: &Path,
    temp: &str,
    target: &OsStr,
    verify: &impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    #[cfg(windows)]
    {
        const ATTEMPTS: u32 = 5;
        let mut attempt = 1;
        loop {
            verify()?;
            match crate::bound::with_pinned_windows_path(dir, parent, |p| {
                std::fs::rename(p.join(temp), p.join(target))
            }) {
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
    {
        let _ = parent;
        verify()?;
        dir.rename(temp, dir, target)
    }
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
    fn moving_the_directory_during_save_keeps_the_original_and_removes_staging() {
        let tree = TempTree::new("archive-during-save");
        tree.file("workspace/doc/number.txt", "1");
        let root = tree.path("workspace");
        let scope = crate::Scope::new(&root, &root).expect("scope");
        let target = scope
            .bind("doc/number.txt", crate::Access::Write)
            .expect("directory");
        let old = target
            .open_file()
            .expect("original")
            .metadata()
            .expect("metadata");
        let dir = root.join("doc");
        let archived = root.join("previous");
        replace_bound(&target, Some(&old), |file| {
            file.write_all(b"2")?;
            std::fs::rename(&dir, &archived)
        })
        .expect_err("moved before commit");
        assert_eq!(
            std::fs::read(archived.join("number.txt")).expect("original"),
            b"1"
        );
        assert!(leftovers(&archived).is_empty());
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
