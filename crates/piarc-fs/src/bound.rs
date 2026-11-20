//! Authorized directory objects (ADR-0036). Canonical spelling is used for policy and
//! display; opening and publishing use descriptors and one non-link component at a time.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata, OpenOptions};

use crate::{Error, Result, display};

/// The deepest existing directory at a canonical target when authority is acquired.
/// Holding its descriptor prevents reuse of its identity while this grant is live.
#[derive(Clone, Debug)]
pub struct DirectoryBinding {
    path: PathBuf,
    dir: Arc<Dir>,
    identity: (u64, u64),
}

impl PartialEq for DirectoryBinding {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.identity == other.identity
    }
}

impl Eq for DirectoryBinding {}

fn normal(component: Component<'_>) -> io::Result<&OsStr> {
    match component {
        Component::Normal(name) => Ok(name),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a canonical component",
        )),
    }
}

fn changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the authorized directory changed",
    )
}

fn is_redirect(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt as WindowsMetadataExt;
        // Reparse points include junctions and filesystem-specific tags, in addition to links.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        WindowsMetadataExt::file_attributes(metadata) & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

/// cap-primitives 4.0.3 derives ambient paths for a few Windows operations. Its verbatim
/// prefix conversion loses the root of a UNC share. Keep the canonical UNC/drive spelling
/// and hold every directory from the volume root without delete sharing through the call.
#[cfg(windows)]
pub(crate) fn with_pinned_windows_path<T>(
    expected: &Dir,
    canonical: &Path,
    op: impl FnOnce(&Path) -> io::Result<T>,
) -> io::Result<T> {
    let root = canonical
        .ancestors()
        .last()
        .filter(|_| canonical.is_absolute())
        .ok_or_else(changed)?;
    let mut handles = vec![Dir::open_ambient_dir(root, cap_std::ambient_authority())?];
    for part in canonical
        .strip_prefix(root)
        .map_err(|_| changed())?
        .components()
    {
        let parent = handles.last().ok_or_else(changed)?;
        let dir = parent.open_dir_nofollow(normal(part)?)?;
        if is_redirect(&dir.dir_metadata()?) {
            return Err(changed());
        }
        handles.push(dir);
    }
    let held = handles.last().ok_or_else(changed)?.dir_metadata()?;
    let want = expected.dir_metadata()?;
    if (held.dev(), held.ino()) != (want.dev(), want.ino()) || held.ino() == 0 {
        return Err(changed());
    }
    op(canonical)
}

impl DirectoryBinding {
    /// Pin the canonical target's directory (or its nearest existing ancestor).
    ///
    /// # Errors
    /// The target is not canonical, a component cannot be inspected or its identity changed.
    pub fn capture(canonical: &Path) -> Result<Self> {
        let root = canonical
            .ancestors()
            .last()
            .filter(|p| p.has_root())
            .ok_or_else(|| {
                Error::coded(canonical, "EINVAL", "expected an absolute canonical path")
            })?;
        let dir = Dir::open_ambient_dir(root, cap_std::ambient_authority())
            .map_err(|e| Error::io(root, e))?;
        let base = Self::new(root.to_owned(), dir).map_err(|e| Error::io(root, e))?;
        base.descend(canonical).map_err(|e| Error::io(canonical, e))
    }

    pub(crate) fn existing_directory(canonical: &Path) -> Result<Self> {
        let binding = Self::capture(canonical)?;
        if binding.path != canonical {
            return Err(Error::coded(
                canonical,
                "ENOTDIR",
                "expected an existing directory",
            ));
        }
        binding.verify()?;
        Ok(binding)
    }

    fn new(path: PathBuf, dir: Dir) -> io::Result<Self> {
        let m = dir.dir_metadata()?;
        if is_redirect(&m) {
            return Err(changed());
        }
        Ok(Self {
            path,
            identity: (m.dev(), m.ino()),
            dir: Arc::new(dir),
        })
    }

    fn descend(&self, target: &Path) -> io::Result<Self> {
        let suffix = target.strip_prefix(&self.path).map_err(|_| changed())?;
        let mut current = self.clone();
        for part in suffix.components() {
            let name = normal(part)?;
            match current.dir.symlink_metadata(name) {
                Ok(m) if is_redirect(&m) => return Err(changed()),
                Ok(m) if m.is_dir() => {
                    let child = current.dir.open_dir_nofollow(name)?;
                    current = Self::new(current.path.join(name), child)?;
                }
                Ok(_) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => break,
                Err(e) => return Err(e),
            }
        }
        Ok(current)
    }

    /// Confirm that the original location still denotes this directory object.
    ///
    /// # Errors
    /// The directory moved, was replaced, or can no longer be identified.
    pub fn verify(&self) -> Result<()> {
        self.verify_io().map_err(|_| Error::ApprovalMismatch {
            path: display(&self.path),
        })
    }

    pub(crate) fn verify_io(&self) -> io::Result<()> {
        // This lookup only checks identity. It never supplies an I/O handle.
        // Also reject a link back to the moved directory under its old name.
        if std::fs::canonicalize(&self.path)? != self.path {
            return Err(changed());
        }
        let current =
            Dir::open_ambient_dir(&self.path, cap_std::ambient_authority())?.dir_metadata()?;
        if current.ino() == 0 || (current.dev(), current.ino()) != self.identity {
            return Err(changed());
        }
        Ok(())
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn bind(&self, target: &Path) -> Result<BoundPath> {
        self.verify()?;
        let directory = self.descend(target).map_err(|e| Error::io(target, e))?;
        Ok(BoundPath {
            path: target.to_owned(),
            directory,
        })
    }

    /// Open an approved regular file, relative to this retained directory.
    ///
    /// # Errors
    /// The target lies outside the binding, the directory changed, or the file cannot be read.
    pub fn open_file(&self, canonical: &Path) -> Result<File> {
        self.bind(canonical)?.open_file()
    }
}

/// Open one regular entry of an already-authorized directory, never following a replacement link.
pub(crate) fn open_regular_at(dir: &Dir, name: &OsStr) -> io::Result<File> {
    if Path::new(name).file_name() != Some(name) {
        return Err(changed());
    }
    let observed = dir.symlink_metadata(name)?;
    if is_redirect(&observed) || !observed.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_fs_ext::OpenOptionsSyncExt as _;
        // The directory entry can change between stat and open. Never wait for a FIFO writer.
        options.nonblock(true);
    }
    let file = dir.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if is_redirect(&metadata) || !metadata.is_file() {
        return Err(changed());
    }
    Ok(file.into_std())
}

/// One checked target, paired with its nearest existing directory.
pub(crate) struct BoundPath {
    path: PathBuf,
    directory: DirectoryBinding,
}

impl BoundPath {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn verify(&self) -> Result<()> {
        self.directory.verify()
    }

    pub(crate) fn verify_io(&self) -> io::Result<()> {
        self.directory.verify_io()
    }

    pub(crate) fn open_dir(&self) -> Result<Dir> {
        self.verify()?;
        if self.path != self.directory.path {
            return Err(Error::coded(&self.path, "ENOTDIR", "not a directory"));
        }
        self.directory
            .dir
            .try_clone()
            .map_err(|e| Error::io(&self.path, e))
    }

    pub(crate) fn metadata(&self) -> Result<Metadata> {
        self.verify()?;
        if self.directory.path == self.path {
            return self
                .directory
                .dir
                .dir_metadata()
                .map_err(|e| Error::io(&self.path, e));
        }
        let (parent, name) = self.parent()?;
        let m = parent
            .symlink_metadata(name)
            .map_err(|e| Error::io(&self.path, e))?;
        if is_redirect(&m) {
            return Err(Error::ApprovalMismatch {
                path: display(&self.path),
            });
        }
        Ok(m)
    }

    pub(crate) fn open_file(&self) -> Result<File> {
        self.verify()?;
        let (parent, name) = self.parent()?;
        let file = open_regular_at(parent, name).map_err(|e| Error::io(&self.path, e))?;
        self.verify()?;
        Ok(file)
    }

    pub(crate) fn parent(&self) -> Result<(&Dir, &OsStr)> {
        if self.directory.path == self.path {
            return Err(Error::coded(&self.path, "EISDIR", "is a directory"));
        }
        if self.path.parent() != Some(self.directory.path.as_path()) {
            return Err(Error::NotFound {
                path: display(self.path.parent().unwrap_or(&self.path)),
            });
        }
        let name = self
            .path
            .file_name()
            .ok_or_else(|| Error::coded(&self.path, "EINVAL", "missing file name"))?;
        Ok((&self.directory.dir, name))
    }

    /// Removes the regular file at the target (a rewind deleting a file the session created).
    pub(crate) fn remove_file(&self) -> Result<()> {
        self.verify()?;
        let (parent, name) = self.parent()?;
        let m = parent
            .symlink_metadata(name)
            .map_err(|e| Error::io(&self.path, e))?;
        if is_redirect(&m) || !m.is_file() {
            return Err(Error::coded(&self.path, "EISDIR", "not a regular file"));
        }
        #[cfg(windows)]
        let removed = with_pinned_windows_path(parent, &self.directory.path, |p| {
            std::fs::remove_file(p.join(name))
        });
        #[cfg(not(windows))]
        let removed = parent.remove_file(name);
        removed.map_err(|e| Error::io(&self.path, e))?;
        self.verify()
    }

    pub(crate) fn mkdir(&self) -> Result<bool> {
        self.verify()?;
        let mut dir = self
            .directory
            .dir
            .try_clone()
            .map_err(|e| Error::io(&self.path, e))?;
        let mut created = false;
        #[cfg(windows)]
        let mut path = self.directory.path.clone();
        let suffix =
            self.path
                .strip_prefix(&self.directory.path)
                .map_err(|_| Error::ApprovalMismatch {
                    path: display(&self.path),
                })?;
        for part in suffix.components() {
            let name = normal(part).map_err(|e| Error::io(&self.path, e))?;
            #[cfg(windows)]
            let making =
                with_pinned_windows_path(&dir, &path, |p| std::fs::create_dir(p.join(name)));
            #[cfg(not(windows))]
            let making = dir.create_dir(name);
            match making {
                Ok(()) => created = true,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(Error::io(&self.path, e)),
            }
            #[cfg(windows)]
            path.push(name);
            dir = dir
                .open_dir_nofollow(name)
                .map_err(|e| Error::io(&self.path, e))?;
        }
        self.verify()?;
        Ok(created)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn a_non_regular_input_is_refused_without_waiting_for_a_writer() {
        use std::sync::mpsc;
        use std::time::Duration;
        let tree = TempTree::new("fifo-type");
        let path = tree.path("stream");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .expect("make fixture")
                .success()
        );
        let canonical = path.canonicalize().expect("fixture");
        let binding = DirectoryBinding::capture(&canonical).expect("bind");
        let (send, recv) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let error = binding.open_file(&canonical).expect_err("special input");
            send.send(error).expect("receiver");
        });
        let answer = recv.recv_timeout(Duration::from_secs(2));
        if answer.is_err() {
            // Release an incorrectly blocking reader so the failure cannot strand a test thread.
            drop(
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(path)
                    .expect("release reader"),
            );
        }
        worker.join().expect("reader exited");
        assert!(answer.is_ok(), "opening a FIFO waited for a writer");
    }
}
