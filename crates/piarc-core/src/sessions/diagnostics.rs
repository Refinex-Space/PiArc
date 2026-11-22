//! The diagnostic bundle (T45, architecture section 10.5): [`Hub::prepare_diagnostics`]
//! assembles it in memory (`piarc_telemetry::bundle`: logs, versions, the user's settings files
//! and a workspace's configuration diagnostics, all redacted) and answers its manifest, so the
//! client shows the file list and the redaction summary; [`Hub::export_diagnostics`] writes that
//! same bundle once the user picked a place in the main process's save dialog. Only the latest
//! prepared bundle is kept.

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use piarc_protocol::ErrorKind;
use piarc_telemetry::{Bundle, BundleInput};
use serde_json::{Value, json};

use super::Hub;
use crate::error::{Error, Result};

/// The prepared bundle and its id.
#[derive(Default)]
pub(crate) struct PreparedBundle(Mutex<Option<(String, Bundle)>>);

fn io_error(what: &str, error: &std::io::Error) -> Error {
    Error::Feature {
        kind: ErrorKind::IoError,
        retryable: false,
        message: format!("{what}: {error}"),
        details: None,
    }
}

fn joined(error: &tokio::task::JoinError) -> Error {
    Error::Internal {
        reason: format!("the diagnostic bundle task failed: {error}"),
    }
}

impl Hub {
    /// Assembles the diagnostic bundle (`app`: the client's versions; `workspace`: whose
    /// configuration diagnostics to include, the most recent workspace when `None`) and answers
    /// `{id, files: [{name, bytes}], redactions: {<kind>: n}, excluded}`.
    pub(crate) async fn prepare_diagnostics(
        &self,
        workspace: Option<PathBuf>,
        app: Value,
    ) -> Result<Value> {
        // Missing diagnostics (no workspace yet, a settings error) leave that file out.
        let diagnostics = self.config_diagnostics(workspace).await.ok();
        let dirs = self.ctx.storage.dirs().clone();
        let protocol = piarc_protocol::PROTOCOL_VERSION;
        let input = BundleInput {
            logs_dir: dirs.logs(),
            home: std::env::home_dir(),
            versions: json!({
                "app": app,
                "core": env!("CARGO_PKG_VERSION"),
                "protocol": format!("{}.{}", protocol.major, protocol.minor),
            }),
            settings: vec![
                ("settings.json".into(), dirs.user_settings()),
                (
                    "pi-settings.json".into(),
                    dirs.data().join("pi").join("settings.json"),
                ),
                (
                    "pi-models.json".into(),
                    dirs.data().join("pi").join("models.json"),
                ),
            ],
            diagnostics,
        };
        let bundle = tokio::task::spawn_blocking(move || piarc_telemetry::assemble(&input))
            .await
            .map_err(|e| joined(&e))?
            .map_err(|e| io_error("cannot read the logs", &e))?;
        let since_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let id = format!("diag-{since_epoch:x}");
        let mut answer = bundle.manifest();
        answer["id"] = json!(id);
        *self
            .ctx
            .diagnostics
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some((id, bundle));
        Ok(answer)
    }

    /// Writes the prepared bundle `id` to `path` as a ZIP archive and answers `{path, bytes}`.
    /// The bundle stays prepared, so a failed write can be retried elsewhere.
    pub(crate) async fn export_diagnostics(&self, id: String, path: PathBuf) -> Result<Value> {
        let bundle = {
            let prepared = self
                .ctx
                .diagnostics
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match prepared.as_ref() {
                Some((current, bundle)) if *current == id => bundle.clone(),
                _ => {
                    return Err(Error::InvalidArgument {
                        field: "id",
                        reason: "no diagnostic bundle with this id is prepared".into(),
                    });
                }
            }
        };
        let target = path.clone();
        tokio::task::spawn_blocking(move || bundle.write_zip(&target))
            .await
            .map_err(|e| joined(&e))?
            .map_err(|e| io_error("cannot write the diagnostic bundle", &e))?;
        let bytes = std::fs::metadata(&path).map_or(0, |m| m.len());
        tracing::info!(target: "piarc_core", bytes, "diagnostic bundle exported");
        Ok(json!({ "path": path, "bytes": bytes }))
    }
}
