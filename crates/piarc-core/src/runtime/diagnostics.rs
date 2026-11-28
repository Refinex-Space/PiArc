//! The diagnostic bundle's entry points (T45): prepare (the preview the client shows) and export
//! (after the user chose a place in the main process's save dialog); results as JSON.

use std::path::PathBuf;

use super::CoreRuntime;
use crate::error::{Error, Result};

type Done = Box<dyn FnOnce(Result<serde_json::Value>) + Send + 'static>;

impl CoreRuntime {
    /// Assembles the diagnostic bundle and answers its manifest with an id (`app_json`: the
    /// client's versions as a JSON object; `workspace`: whose configuration diagnostics to add,
    /// the most recent workspace when `None`).
    ///
    /// # Errors
    ///
    /// Malformed `app_json`; otherwise as [`open_workspace`](Self::open_workspace).
    pub fn prepare_diagnostics(
        &self,
        workspace: Option<PathBuf>,
        app_json: &str,
        on_done: Done,
    ) -> Result<()> {
        let app = serde_json::from_str::<serde_json::Value>(app_json)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or(Error::InvalidArgument {
                field: "app",
                reason: "a JSON object".into(),
            })?;
        self.on_sessions(on_done, move |hub| async move {
            hub.prepare_diagnostics(workspace, app).await
        })
    }

    /// Writes the prepared bundle `id` to `path` (absolute) as a ZIP archive.
    ///
    /// # Errors
    ///
    /// A relative `path`; otherwise as [`open_workspace`](Self::open_workspace).
    pub fn export_diagnostics(&self, id: String, path: PathBuf, on_done: Done) -> Result<()> {
        if !path.is_absolute() {
            return Err(Error::InvalidArgument {
                field: "path",
                reason: "an absolute path".into(),
            });
        }
        self.on_sessions(on_done, move |hub| async move {
            hub.export_diagnostics(id, path).await
        })
    }

    /// Writes every session to `path` (absolute) as a ZIP archive: each conversation as Markdown
    /// in the client's words (`labels_json`, see [`crate::sessions::ExportLabels`]) and its
    /// original records, with an index. Answers `{path, bytes, sessions}`.
    ///
    /// # Errors
    ///
    /// A relative `path` or malformed labels; otherwise as
    /// [`open_workspace`](Self::open_workspace).
    pub fn export_sessions(&self, path: PathBuf, labels_json: &str, on_done: Done) -> Result<()> {
        if !path.is_absolute() {
            return Err(Error::InvalidArgument {
                field: "path",
                reason: "an absolute path".into(),
            });
        }
        let labels = crate::sessions::ExportLabels::parse(labels_json)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.export_sessions(path, labels).await
        })
    }
}
