//! What the Git panel needs from the tool I/O (ADR-0085 rules 5 and 7): the content-addressed
//! store that keeps a rollback's bytes, forgetting files a Git operation rewrote, and writing a
//! rollback's bytes back under the path lock.

use std::path::{Path, PathBuf};

use piarc_protocol::{ErrorKind, ErrorObject};

use super::{ToolIo, lock};

impl ToolIo {
    /// The checkpoint object store, when checkpoints are open.
    pub(crate) fn snapshot_store(&self) -> Option<piarc_checkpoint::ObjectStore> {
        self.checkpoints.as_ref().map(|cp| cp.store().clone())
    }

    /// Forgets `paths` in the file states of every open session whose file root contains
    /// them: git replaced them, so an agent reads them again before changing them.
    pub(crate) fn forget_paths(&self, paths: &[PathBuf]) {
        let sessions: Vec<_> = lock(&self.sessions).values().cloned().collect();
        for session in sessions {
            let mut states = lock(&session.files);
            for path in paths {
                if path.starts_with(session.scope.root()) {
                    states.forget(&session.scope.key(path));
                }
            }
        }
    }

    /// Forgets every file of the open sessions whose file root is `root` or inside it: a
    /// checkout or pull rewrote an unknown set of files.
    pub(crate) fn forget_root(&self, root: &Path) {
        let sessions: Vec<_> = lock(&self.sessions).values().cloned().collect();
        for session in sessions {
            if session.scope.root().starts_with(root) {
                *lock(&session.files) = piarc_fs::FileStates::default();
            }
        }
    }

    /// Puts `content` (or removes the file, for `None`) at `path` of session `session_id`
    /// when the file still has the content whose SHA-256 is `expected` (`None`: no file);
    /// the replaced bytes go to the snapshot store first.
    ///
    /// # Errors
    ///
    /// `sessionNotFound`, the file changed since (`fileModified`), or the write failed.
    pub(crate) fn put_back_bytes(
        &self,
        session_id: &str,
        path: &Path,
        expected: Option<[u8; 32]>,
        content: Option<&[u8]>,
    ) -> Result<(), ErrorObject> {
        let session = self.session(session_id)?;
        let store = self.snapshot_store().ok_or_else(|| {
            ErrorObject::new(ErrorKind::InternalError, "checkpoints are not open", false)
        })?;
        let requested = path.to_string_lossy().into_owned();
        let spec = piarc_fs::Replacement {
            requested: &requested,
            expected,
            content,
            snapshots: &store,
        };
        piarc_fs::replace(&session.scope, &session.files, &self.locks, &spec)
            .map(drop)
            .map_err(|e| e.to_error_object())
    }
}
