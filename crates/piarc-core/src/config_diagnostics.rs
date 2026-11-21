//! The configuration diagnostics of a workspace (T24, architecture section 6.14): every
//! settings file PiArc reads for it, PiArc's and Claude Code's, with its load state and
//! the keys it applies, the keys a higher file overrides and the keys PiArc ignores, plus
//! `~/.claude.json` (key names only), the parts of the hooks configuration PiArc does not
//! run (T25: later events and handler types, `async`, matchers its regular expressions reject),
//! and the MCP servers it cannot use (SSE, WebSocket) with the entries it leaves out (T36).
//!
//! The settings are loaded the way a permission decision loads them
//! ([`TrustService::permission_settings`]): same layers, same trust, so the report shows
//! what decisions use. Files are re-read on every call; the settings page asks again when
//! `core/settings` reports a change.

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::error::{Error, Result};
use crate::storage::Storage;
use crate::trust::TrustService;

/// The report of `workspace`, the most recently opened workspace when `None`.
///
/// # Errors
///
/// An unknown workspace path ([`Error::InvalidArgument`]), the database, or loading the
/// settings failed.
pub async fn report(
    storage: &Storage,
    trust: &TrustService,
    workspace: Option<PathBuf>,
) -> Result<Value> {
    let known: Vec<String> = storage
        .run(|db| db.workspaces())
        .await??
        .into_iter()
        .map(|w| w.path)
        .collect();
    let Some(dir) = workspace.or_else(|| known.first().map(PathBuf::from)) else {
        return Ok(
            json!({ "workspaces": known, "workspace": null, "trusted": false, "files": [] }),
        );
    };
    let root = piarc_git::canonical(&dir).map_err(|e| Error::InvalidArgument {
        field: "workspace",
        reason: format!("unknown workspace: {e}"),
    })?;
    let settings = trust.permission_settings(&root).await?;
    let mut files = serde_json::to_value(settings.diagnostics()).map_err(internal)?;
    if let (Some(home), Value::Array(list)) = (storage.dirs().home(), &mut files) {
        let state = piarc_config::claude_state_report(home, &root);
        list.push(serde_json::to_value(state).map_err(internal)?);
    }
    let hooks: Vec<Value> = crate::hooks::config_of(&settings)
        .diagnostics()
        .iter()
        .map(|d| {
            json!({
                "layer": d.source.layer,
                "file": d.source.file.as_deref().map(piarc_fs::display),
                "pointer": d.pointer,
                "kind": match d.kind {
                    piarc_hooks::DiagnosticKind::LaterEvent => "laterEvent",
                    piarc_hooks::DiagnosticKind::UnknownEvent => "unknownEvent",
                    piarc_hooks::DiagnosticKind::UnsupportedType => "unsupportedType",
                    piarc_hooks::DiagnosticKind::UnsupportedField => "unsupportedField",
                    piarc_hooks::DiagnosticKind::InvalidMatcher => "invalidMatcher",
                    piarc_hooks::DiagnosticKind::Invalid => "invalid",
                },
                "message": d.message,
            })
        })
        .collect();
    // MCP servers PiArc cannot use and entries it leaves out (T36): read without expanding
    // variables, so no value of the user's environment reaches the report.
    let mcp = crate::mcp::diagnostics(&settings, &root, storage.dirs().home());
    let shown = piarc_fs::display(&root);
    let mut workspaces = known;
    if !workspaces.contains(&shown) {
        workspaces.insert(0, shown.clone());
    }
    Ok(json!({
        "workspaces": workspaces,
        "workspace": shown,
        "trusted": settings.trust().is_trusted(),
        "files": files,
        "hooks": hooks,
        "mcp": mcp,
    }))
}

fn internal(error: serde_json::Error) -> Error {
    Error::Internal {
        reason: format!("cannot encode the configuration diagnostics: {error}"),
    }
}
