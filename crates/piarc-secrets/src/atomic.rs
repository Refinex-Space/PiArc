//! Replacing a file atomically: write a temporary file next to it, flush it to disk, rename
//! it over the target. A failure at any step leaves the previous file untouched.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::random;

/// Suffix marker of temporary files: `<file name>.tmp-<random hex>`.
pub const TEMP_MARKER: &str = ".tmp-";

/// The individual file system steps, so tests can make any of them fail.
pub(crate) trait WriteSteps: Send + Sync {
    fn write(&self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        file.write_all(bytes)
    }

    fn sync(&self, file: &File) -> io::Result<()> {
        file.sync_all()
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
}

/// The real steps.
pub(crate) struct RealSteps;

impl WriteSteps for RealSteps {}

/// Replaces `target` with `bytes`. The file is created readable and writable by its owner
/// only (Unix mode 0600; on Windows the data directory's ACL applies).
///
/// # Errors
///
/// [`Error::Io`] for the step that failed; the temporary file is removed and `target` keeps
/// its previous content.
pub fn replace(target: &Path, bytes: &[u8]) -> Result<()> {
    replace_with(&RealSteps, target, bytes)
}

pub(crate) fn replace_with(steps: &dyn WriteSteps, target: &Path, bytes: &[u8]) -> Result<()> {
    let temp = temp_path(target)?;
    let result = write_temp(steps, &temp, bytes).and_then(|()| {
        steps
            .rename(&temp, target)
            .map_err(|e| Error::io("cannot move the new file into place at", target, e))
    });
    if result.is_err() {
        // The temporary file may not exist (creation failed); nothing else to undo.
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_temp(steps: &dyn WriteSteps, temp: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(temp)
        .map_err(|e| Error::io("cannot create", temp, e))?;
    steps
        .write(&mut file, bytes)
        .map_err(|e| Error::io("cannot write", temp, e))?;
    steps
        .sync(&file)
        .map_err(|e| Error::io("cannot flush", temp, e))
}

fn temp_path(target: &Path) -> Result<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| {
            Error::io(
                "cannot name a temporary file for",
                target,
                io::Error::from(io::ErrorKind::InvalidInput),
            )
        })?
        .to_string_lossy()
        .into_owned();
    Ok(target.with_file_name(format!("{name}{TEMP_MARKER}{}", random::hex_id(8)?)))
}

/// Removes temporary files a crashed write left next to `target`. They hold only what was
/// being written (for the vault: ciphertext), so a failure to remove one is not an error.
pub fn remove_leftovers(target: &Path) {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return;
    };
    let prefix = format!("{}{TEMP_MARKER}", name.to_string_lossy());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
}
