//! Git rollbacks that can be undone (ADR-0085 rule 7): before git replaces the files, their
//! bytes go to the checkpoint object store (pinned while the record lives) and their index
//! entries are noted; undo writes the bytes back only over the content the rollback left.
//! Records live in Core's memory for the toast's "Undo"; the newest [`KEPT`] are kept.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use piarc_checkpoint::{ObjectStore, Pin, hash_of};
use piarc_git::{GitError, Reader, Writer, index};

/// Rollbacks kept for undo.
const KEPT: usize = 32;

/// One file of a rollback.
pub(crate) struct RestoredFile {
    /// Relative to the top level.
    pub path: String,
    /// The bytes before (pinned) and their hash; `None`: there was no file.
    pub before: Option<(Pin, [u8; 32])>,
    /// The index entry before (mode, object id).
    pub index: Option<(String, String)>,
    /// The content's hash after the rollback; `None`: no file.
    pub after: Option<[u8; 32]>,
}

/// One rollback.
pub(crate) struct Restore {
    pub session: String,
    pub root: PathBuf,
    pub files: Vec<RestoredFile>,
}

/// The rollbacks of a Core.
#[derive(Default)]
pub(crate) struct Restores {
    entries: Mutex<VecDeque<(String, Restore)>>,
    next: AtomicU64,
}

impl Restores {
    /// Keeps `restore` and returns its id.
    pub fn insert(&self, restore: Restore) -> String {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        let id = format!("git-{}-{n}", crate::storage::now_ms());
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if entries.len() >= KEPT {
            entries.pop_front();
        }
        entries.push_back((id.clone(), restore));
        id
    }

    /// Takes rollback `id` of session `session`.
    pub fn take(&self, id: &str, session: &str) -> Option<Restore> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = entries
            .iter()
            .position(|(key, r)| key == id && r.session == session)?;
        entries.remove(at).map(|(_, r)| r)
    }
}

/// Saves `paths` before a rollback.
///
/// # Errors
///
/// The reader's errors; storing bytes failed (`GitError::Wait`).
pub(crate) async fn snapshot(
    reader: &Reader,
    store: &ObjectStore,
    paths: &[String],
) -> Result<Vec<RestoredFile>, GitError> {
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let before = match index::worktree_bytes(&reader.repo.root, path) {
            Some(bytes) => {
                let pin = store
                    .put(&bytes)
                    .map_err(|e| GitError::Wait(std::io::Error::other(e.to_string())))?;
                let hash = pin.hash();
                Some((pin, hash))
            }
            None => None,
        };
        files.push(RestoredFile {
            path: path.clone(),
            before,
            index: index::index_entry(reader, path).await?,
            after: None,
        });
    }
    Ok(files)
}

/// Notes what the files hold after the rollback.
pub(crate) fn settle(root: &Path, files: &mut [RestoredFile]) {
    for file in files {
        file.after = index::worktree_bytes(root, &file.path).map(|b| hash_of(&b));
    }
}

/// Replaces a file under the session's path lock: (path, expected hash, content); `None` when
/// the session is not open.
pub(crate) type PutBack<'a> =
    &'a dyn Fn(&Path, Option<[u8; 32]>, Option<&[u8]>) -> Option<Result<(), String>>;

/// Writes one file back for undo; `put_back` replaces under the path lock when the session is
/// open. Returns whether the file still had the rollback's content.
pub(crate) fn write_back(
    root: &Path,
    store: &ObjectStore,
    file: &RestoredFile,
    put_back: PutBack<'_>,
) -> Result<bool, String> {
    let full = root.join(&file.path);
    let now = index::worktree_bytes(root, &file.path).map(|b| hash_of(&b));
    if now != file.after {
        return Ok(false);
    }
    let content = match &file.before {
        Some((_, hash)) => Some(store.get(hash).map_err(|e| e.to_string())?),
        None => None,
    };
    if let Some(result) = put_back(&full, file.after, content.as_deref()) {
        return result.map(|()| true);
    }
    match &content {
        Some(bytes) => {
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&full, bytes).map_err(|e| e.to_string())?;
        }
        None => match std::fs::remove_file(&full) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        },
    }
    Ok(true)
}

/// Puts the index entry of `file` back.
///
/// # Errors
///
/// The writer's errors.
pub(crate) async fn restore_entry(writer: &Writer, file: &RestoredFile) -> Result<(), GitError> {
    let entry = file
        .index
        .as_ref()
        .map(|(mode, oid)| (mode.as_str(), oid.as_str()));
    index::set_index_entry(writer, &file.path, entry).await
}
