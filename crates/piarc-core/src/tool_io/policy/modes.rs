//! Permission modes of a session (architecture section 6.2.1, T23).
//!
//! - Start: the session's explicit choice, then the mode remembered for the workspace
//!   (`workspaces.default_mode`), then `permissions.defaultMode`, then Manual.
//! - `bypassPermissions` needs `permissions.enableBypassPermissions: true` in the user's own
//!   settings file; a project file cannot enable it. The client asks for a second, native
//!   confirmation before it switches.
//! - A project's `bypassPermissions` or `auto` never applies; each session start records the
//!   ignored value in the audit.
use super::*;

/// Whether the user enabled bypass mode in their own settings file.
pub(super) fn bypass_enabled(settings: &Settings) -> bool {
    settings
        .layer(piarc_config::ids::USER)
        .and_then(|v| v.pointer("/permissions/enableBypassPermissions"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn mode_name(mode: PermissionMode) -> Option<String> {
    serde_json::to_value(mode)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn parse_mode(text: &str) -> Option<PermissionMode> {
    serde_json::from_value(Value::String(text.to_owned())).ok()
}

impl ToolIo {
    pub(crate) async fn set_initial_mode(
        &self,
        id: &str,
        explicit: Option<PermissionMode>,
    ) -> Result<(), ErrorObject> {
        let s = self.session(id)?;
        let services = self.services()?;
        let mut settings = services
            .trust
            .permission_settings(s.project())
            .await
            .map_err(|e| e.to_error_object())?;
        let workspace = display(s.project());
        let remembered = services
            .storage
            .run(move |db| db.workspace_mode(&workspace))
            .await
            .map_err(|e| e.to_error_object())?
            .map_err(|e| e.to_error_object())?
            .as_deref()
            .and_then(parse_mode);
        let bypass = bypass_enabled(&settings);
        for (layer, mode) in settings.ignored_modes().to_vec() {
            let detail = json!({"step":"ignoredProjectMode","layer":layer,"mode":mode,
                "conclusion":"deny","source":"automatic"});
            services.audit(id, s.project(), &detail).await?;
        }
        let mode = |settings: &Settings| {
            piarc_policy::starting_mode(
                explicit,
                remembered,
                settings
                    .get("/permissions/defaultMode")
                    .and_then(Value::as_str),
                bypass,
            )
        };
        let initial = mode(&settings);
        settings.set_trust(piarc_config::TrustState::Untrusted);
        let mut state = lock(&s.policy);
        state.project_auto = initial == PermissionMode::AcceptEdits && mode(&settings) != initial;
        state.mode = initial;
        state.publish(id, services);
        Ok(())
    }

    /// Refuse a mode the session may not switch to. Called before the Agent Host records it.
    pub(crate) async fn check_mode(
        &self,
        id: &str,
        mode: PermissionMode,
    ) -> Result<(), ErrorObject> {
        if mode != PermissionMode::BypassPermissions {
            return Ok(());
        }
        let s = self.session(id)?;
        let settings = self
            .services()?
            .trust
            .permission_settings(s.project())
            .await
            .map_err(|e| e.to_error_object())?;
        if bypass_enabled(&settings) {
            Ok(())
        } else {
            Err(denied(
                "Bypass permissions mode is off. Enable it in the permission settings first.",
            ))
        }
    }

    /// The user switched modes: apply it and remember it for the workspace.
    pub(crate) async fn changed_mode(
        &self,
        id: &str,
        mode: PermissionMode,
    ) -> Result<(), ErrorObject> {
        let s = self.session(id)?;
        let services = self.services()?;
        {
            let mut state = lock(&s.policy);
            state.project_auto = false;
            state.mode = mode;
            state.publish(id, services);
        }
        let workspace = display(s.project());
        let name = mode_name(mode);
        services
            .storage
            .run(move |db| db.set_workspace_mode(&workspace, name.as_deref()))
            .await
            .map_err(|e| e.to_error_object())?
            .map_err(|e| e.to_error_object())?;
        Ok(())
    }
}
