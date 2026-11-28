//! Removing a workspace from the list (the sidebar's "Remove project"). Its folder, its
//! sessions' files and what the user chose for it stay; the workspace and its sessions are not
//! listed until the folder is opened again (`record_workspace` lists it again). Its running
//! sessions close and its background tasks stop first: the client asks the user before that
//! with [`Hub::workspace_work`].

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::snapshot::SnapshotMsg;
use super::{Hub, Routes, canonical_dir, lock, path_text};
use crate::error::{Error, Result};

impl Hub {
    /// The sessions in a turn and the running background tasks of workspace `path`:
    /// `{ sessions, tasks }`.
    pub async fn workspace_work(&self, path: PathBuf) -> Result<Value> {
        let key = workspace_key(path).await?;
        let sessions = self
            .ctx
            .snapshots
            .running_sessions()
            .iter()
            .filter(|s| s.workspace.as_deref() == Some(key.as_str()))
            .count();
        let tasks = self.ctx.tool_io.tasks().running_in(&key);
        Ok(json!({ "sessions": sessions, "tasks": tasks }))
    }

    /// Removes workspace `path` from the list: stops its background tasks, closes its sessions
    /// and its Agent Host, then marks its row so neither it nor its sessions are listed.
    pub async fn remove_workspace(&self, path: PathBuf) -> Result<()> {
        let key = workspace_key(path).await?;
        // Until it is marked, it does not open again (a client resuming the session that just
        // closed would otherwise list it again, or keep it open behind the list).
        let _removing = Removing::start(&self.routes, PathBuf::from(&key));
        self.ctx.tool_io.tasks().workspace_removed(&key).await;
        self.close_open_workspace(PathBuf::from(&key)).await;
        let name = PathBuf::from(&key)
            .file_name()
            .map_or_else(|| key.clone(), |n| n.to_string_lossy().into_owned());
        let row = key.clone();
        self.ctx
            .storage
            .run(move |store| store.remove_workspace(&row, &name))
            .await??;
        self.ctx.snapshots.send(SnapshotMsg::Reload);
        tracing::info!(target: "piarc_core::sessions", workspace = %key, "workspace removed from the list");
        Ok(())
    }
}

/// Marks a workspace as being removed for as long as it lives.
struct Removing {
    routes: Arc<Mutex<Routes>>,
    path: PathBuf,
}

impl Removing {
    fn start(routes: &Arc<Mutex<Routes>>, path: PathBuf) -> Self {
        *lock(routes).removing.entry(path.clone()).or_default() += 1;
        Self {
            routes: Arc::clone(routes),
            path,
        }
    }
}

impl Drop for Removing {
    fn drop(&mut self) {
        let mut routes = lock(&self.routes);
        if let Some(count) = routes.removing.get_mut(&self.path) {
            *count -= 1;
            if *count == 0 {
                routes.removing.remove(&self.path);
            }
        }
    }
}

/// The key of workspace `path` in the list: its canonical spelling, or the path as given when
/// the folder no longer exists (a folder moved or deleted is removed under the name it was
/// listed by).
async fn workspace_key(path: PathBuf) -> Result<String> {
    if !path.is_absolute() {
        return Err(Error::InvalidArgument {
            field: "path",
            reason: "must be an absolute path".into(),
        });
    }
    match canonical_dir(path.clone(), "path").await {
        Ok(dir) => Ok(path_text(&dir)),
        Err(_) => Ok(path_text(&path)),
    }
}
