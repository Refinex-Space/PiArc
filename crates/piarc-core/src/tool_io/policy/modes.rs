//! Permission modes of a session (architecture section 6.2.1, T23).
//!
//! - Start: the session's explicit choice, then the mode remembered for the workspace
//!   (`workspaces.default_mode`), then `permissions.defaultMode`, then Manual.
//! - `bypassPermissions` needs `permissions.enableBypassPermissions: true` in the user's own
//!   settings file (or managed settings, which also lock it off, T47); a project file cannot
//!   enable it. The client asks for a second, native
//!   confirmation before it switches.
//! - A project's `bypassPermissions` or `auto` never applies; each session start records the
//!   ignored value in the audit.
//! - `auto` (T46) needs `permissions.enableAutoMode: true` in the user's own settings file and
//!   no `disableAutoMode` anywhere (`piarc_config::auto_mode`). The switch needs no second
//!   confirmation (the user confirmed when enabling it). When the settings turn it off while a
//!   session is in it, the next decision continues in Manual mode (not remembered for the
//!   workspace) and the audit records why.
use super::*;

/// Whether the user enabled bypass mode in their own settings file; managed settings decide
/// first (T47: `permissions.enableBypassPermissions: false` there turns it off for good).
pub(super) fn bypass_enabled(settings: &Settings) -> bool {
    settings
        .user_value("/permissions/enableBypassPermissions")
        .and_then(Value::as_bool)
        == Some(true)
}

/// Whether Auto mode is available (T46; managed settings can lock it off, T47).
pub(super) fn auto_available(settings: &Settings) -> bool {
    piarc_config::auto_mode::read(settings).available()
}

fn available(settings: &Settings) -> piarc_policy::Available {
    piarc_policy::Available {
        bypass: bypass_enabled(settings),
        auto: auto_available(settings),
    }
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
        let modes = available(&settings);
        let reviewer = piarc_config::auto_mode::read(&settings).model;
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
                modes,
            )
        };
        let initial = mode(&settings);
        settings.set_trust(piarc_config::TrustState::Untrusted);
        let mut state = lock(&s.policy);
        state.project_auto = initial == PermissionMode::AcceptEdits && mode(&settings) != initial;
        state.mode = initial;
        state.auto.set_model(reviewer);
        state.publish(id, services);
        Ok(())
    }

    /// Refuse a mode the session may not switch to. Called before the Agent Host records it.
    pub(crate) async fn check_mode(
        &self,
        id: &str,
        mode: PermissionMode,
    ) -> Result<(), ErrorObject> {
        if !matches!(
            mode,
            PermissionMode::BypassPermissions | PermissionMode::Auto
        ) {
            return Ok(());
        }
        let s = self.session(id)?;
        let settings = self
            .services()?
            .trust
            .permission_settings(s.project())
            .await
            .map_err(|e| e.to_error_object())?;
        if available(&settings).allows(mode) {
            if mode == PermissionMode::Auto {
                let reviewer = piarc_config::auto_mode::read(&settings).model;
                lock(&s.policy).auto.set_model(reviewer);
            }
            Ok(())
        } else if mode == PermissionMode::Auto {
            Err(denied(
                "Auto mode is off. Enable it in the permission settings first.",
            ))
        } else {
            Err(denied(
                "Bypass permissions mode is off. Enable it in the permission settings first.",
            ))
        }
    }

    /// Before a decision (T46): a session in Auto mode whose settings no longer allow it
    /// continues in Manual mode; a subagent follows. The audit records the change.
    pub(super) async fn check_auto_mode(
        &self,
        s: &SessionIo,
        services: &Services,
        settings: &Settings,
        p: &PolicyEvaluateParams,
    ) -> Result<(), ErrorObject> {
        if super::super::subagents::current_mode(s) != PermissionMode::Auto
            || auto_available(settings)
        {
            return Ok(());
        }
        let root = super::super::subagents::rule_owner(s);
        let root_id = s
            .subagent
            .as_ref()
            .map_or(p.session_id.as_str(), |link| link.root_id.as_str());
        let demoted = {
            let mut state = lock(&root.policy);
            let demoted = state.mode == PermissionMode::Auto;
            if demoted {
                state.mode = PermissionMode::Default;
                state.auto.demote();
                state.publish(root_id, services);
            }
            demoted
        };
        // A user definition's `auto` under a bypass session: Manual mode for this call.
        let now = super::super::subagents::current_mode(s);
        lock(&s.policy).follow_mode(if now == PermissionMode::Auto {
            PermissionMode::Default
        } else {
            now
        });
        if demoted {
            let detail = json!({"step":"autoModeOff","mode":PermissionMode::Default,
                "conclusion":"ask","source":"automatic"});
            services.audit(root_id, s.project(), &detail).await?;
        }
        Ok(())
    }

    /// The user switched modes: apply it and remember it for the workspace.
    /// Switches session `id` to `mode` without remembering it for the workspace (a project
    /// hook's `setMode`, I122).
    pub(crate) fn session_mode(&self, id: &str, mode: PermissionMode) -> Result<(), ErrorObject> {
        let s = self.session(id)?;
        let services = self.services()?;
        let mut state = lock(&s.policy);
        state.project_auto = false;
        state.mode = mode;
        state.auto.mode_chosen();
        // Selecting Auto mode again lifts a pause (T46).
        if mode == PermissionMode::Auto {
            state.auto.resume();
        }
        state.publish(id, services);
        Ok(())
    }

    pub(crate) async fn changed_mode(
        &self,
        id: &str,
        mode: PermissionMode,
    ) -> Result<(), ErrorObject> {
        self.session_mode(id, mode)?;
        let s = self.session(id)?;
        let services = self.services()?;
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
