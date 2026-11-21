//! Context engineering requests of the Agent Host (T27, ADR-0043, capability `context`):
//!
//! - `context/settings`: the automatic compaction settings of the session's workspace
//!   (`autoCompactEnabled`, `autoCompactWindow` clamped to 100,000–1,000,000), from the same
//!   merged layers as the permission settings;
//! - `fs/changes`: files the session read or wrote that changed outside it, by comparing the
//!   file state table with the disk before a model request (metadata first, the hash only when
//!   it differs, each version reported once);
//! - `fs/forgetReads`: after a compaction the read ranges are forgotten (I72), the hashes stay.

use std::io;
use std::path::Path;

use piarc_fs::Snapshot;
use piarc_protocol::ErrorObject;
use piarc_protocol::context::{
    ChangedFile, ContextSessionParams, ContextSettings, FsChangesResult, FsForgetReadsResult,
};
use serde_json::Value;

use super::{ToolIo, answer, lock, to_value};

/// Where the settings turn automatic compaction off.
const ENABLED_POINTER: &str = "/autoCompactEnabled";
/// Where the settings give the automatic compaction window, in tokens.
const WINDOW_POINTER: &str = "/autoCompactWindow";
/// The window's accepted range, as Claude Code's `autoCompactWindow`.
pub(crate) const AUTO_COMPACT_WINDOW: std::ops::RangeInclusive<u64> = 100_000..=1_000_000;

/// The automatic compaction settings in `settings`.
pub(crate) fn context_settings(settings: &piarc_config::Settings) -> ContextSettings {
    let enabled = settings
        .get(ENABLED_POINTER)
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let window = settings
        .get(WINDOW_POINTER)
        .and_then(Value::as_f64)
        .filter(|tokens| tokens.is_finite() && *tokens > 0.0)
        .map(|tokens| {
            // Clamped first, so the conversion stays inside u64.
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "the value is clamped to a positive range far below u64::MAX"
            )]
            let clamped = tokens.clamp(
                *AUTO_COMPACT_WINDOW.start() as f64,
                *AUTO_COMPACT_WINDOW.end() as f64,
            ) as u64;
            clamped
        });
    ContextSettings {
        auto_compact_enabled: enabled,
        auto_compact_window: window,
    }
}

impl ToolIo {
    /// `context/settings`; the defaults when Core has no settings service (tests of the I/O
    /// alone).
    pub(super) async fn context_settings(
        &self,
        p: &ContextSessionParams,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id.0)?;
        let Some(services) = &self.policy else {
            return to_value(&ContextSettings {
                auto_compact_enabled: true,
                auto_compact_window: None,
            });
        };
        let settings = services
            .trust
            .permission_settings(s.project())
            .await
            .map_err(|e| e.to_error_object())?;
        to_value(&context_settings(&settings))
    }

    /// The settings' default model and effort of a new session in `root` (T31, I113): `model`
    /// with an alias resolved through the merged `modelAliases`, and `effortLevel`.
    pub(crate) async fn session_defaults(
        &self,
        root: &Path,
    ) -> (Option<String>, Option<piarc_protocol::models::EffortLevel>) {
        let Some(services) = &self.policy else {
            return (None, None);
        };
        let Ok(settings) = services.trust.permission_settings(root).await else {
            return (None, None);
        };
        let model = settings
            .get("/model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty() && *m != "default" && *m != "inherit")
            .and_then(|m| super::subagents::resolve_model_setting(m, &settings));
        let effort = settings
            .get("/effortLevel")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        (model, effort)
    }

    /// `fs/changes`.
    pub(super) async fn external_changes(
        &self,
        p: &ContextSessionParams,
    ) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id.0)?;
        answer(move || {
            let changes = lock(&s.files).external_changes(metadata, |key| {
                Snapshot::of_file(Path::new(key)).map(|snapshot| snapshot.sha256)
            });
            to_value(&FsChangesResult {
                files: changes
                    .into_iter()
                    .map(|(path, change)| ChangedFile { path, change })
                    .collect(),
            })
        })
        .await
    }

    /// `fs/forgetReads`.
    pub(super) fn forget_reads(&self, p: &ContextSessionParams) -> Result<Value, ErrorObject> {
        let s = self.session(&p.session_id.0)?;
        let files = lock(&s.files).forget_read_ranges();
        to_value(&FsForgetReadsResult {
            files: files as u64,
        })
    }
}

/// A file's size and modification time; a directory or other non-file counts as gone.
fn metadata(key: &str) -> io::Result<piarc_fs::Metadata> {
    let metadata = std::fs::metadata(key)?;
    if !metadata.is_file() {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    Ok((metadata.len(), metadata.modified().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(json: &str) -> piarc_config::Settings {
        let dir = std::env::temp_dir().join(format!(
            "piarc-context-settings-{}-{}",
            std::process::id(),
            json.len()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("settings.json"), json).expect("write");
        let table = piarc_config::LayerTable::piarc(&dir, &dir);
        let loaded = piarc_config::Settings::load(table, piarc_config::TrustState::Untrusted);
        std::fs::remove_dir_all(&dir).ok();
        loaded
    }

    #[test]
    fn reads_the_switch_and_clamps_the_window() {
        let defaults = context_settings(&settings("{}"));
        assert!(defaults.auto_compact_enabled);
        assert_eq!(defaults.auto_compact_window, None);
        let off = context_settings(&settings(r#"{"autoCompactEnabled": false}"#));
        assert!(!off.auto_compact_enabled);
        for (window, expected) in [
            (300_000, 300_000),
            (50_000, 100_000),
            (5_000_000, 1_000_000),
        ] {
            let s = context_settings(&settings(&format!(r#"{{"autoCompactWindow": {window}}}"#)));
            assert_eq!(s.auto_compact_window, Some(expected), "{window}");
        }
    }
}
