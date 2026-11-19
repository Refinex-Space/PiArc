//! The decision ladder of architecture section 6.2.3, as a pure function over facts Core
//! computed for one tool call.
//!
//! ```text
//! 1. enterprise deny (slot, M5)                     → deny
//! 2. PreToolUse hooks (slot, T25): deny → deny; ask → step 4; allow → step 6
//! 3. deny rules                                     → deny
//!    ExitPlanMode: plan mode → ask (the plan card); any other mode → deny
//! 4. ask rules, critical deletion, unresolved command, requiresUserInteraction → ask
//! 5. mode: plan + a write → deny with "present the plan"; bypassPermissions → allow
//!    then protected path writes (Manual, Accept edits) → ask
//! 6. allow rules (all parts), hook allow             → allow
//! 7. mode defaults: outside → ask; read-only → allow; Accept edits edits → allow
//! 8. PermissionRequest hooks (slot, T25) → user
//! ```

use piarc_protocol::policy::PermissionMode;

use crate::rules::Hit;

/// Core's classification of the effective target(s), including symlink resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Boundary {
    /// All targets are within the permitted directories.
    Inside,
    /// The invocation accesses another directory.
    Outside,
    /// A target to be written is protected, even if a rule matches.
    Protected,
}

/// The answer of a hook slot. Slots that are not configured answer [`HookVerdict::None`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum HookVerdict {
    /// No opinion: continue.
    #[default]
    None,
    /// Allow, subject to deny and ask rules and plan mode.
    Allow,
    /// Ask the user.
    Ask,
    /// Refuse with the hook's reason.
    Deny(String),
}

/// How a call proceeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Run without asking.
    Allow,
    /// Ask the user (after the PermissionRequest slot).
    Ask,
    /// Refuse.
    Deny,
}

/// Why a call must ask whatever the mode (step 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MustAsk {
    /// The audit step: `askRule`, `criticalPath`, `unresolved`, `invalidRule`,
    /// `requiresUserInteraction`.
    pub step: &'static str,
    /// The rule involved.
    pub hit: Option<Hit>,
}

/// Facts about one call. Core fills it; tests use doubles.
#[derive(Debug, Clone, Default)]
pub struct Input {
    /// The session's mode.
    pub mode: PermissionMode,
    /// Step 1: an enterprise deny (M5).
    pub enterprise: Option<Hit>,
    /// Step 2: the PreToolUse slot.
    pub hook: HookVerdict,
    /// Step 3.
    pub deny: Option<Hit>,
    /// Step 4.
    pub ask: Option<MustAsk>,
    /// A write tool or a command that is not read-only (plan mode).
    pub write: bool,
    /// `ExitPlanMode`: the user approves the plan in plan mode; there is none to approve in
    /// another mode (T26).
    pub exit_plan: bool,
    /// Writes a protected path.
    pub protected: bool,
    /// An assignment changes command resolution: no automatic allow.
    pub tainted: bool,
    /// Step 6: every part allowed by these rules (or read-only parts).
    pub allow: Vec<Hit>,
    /// Step 6 applies (`allow` may be empty when the other parts are read-only).
    pub allowed: bool,
    /// Accesses paths outside the session's directories.
    pub outside: bool,
    /// Step 7: read-only and inside.
    pub read_only: bool,
    /// Step 7: what Accept edits takes.
    pub accept_edit: bool,
}

/// The decision, with the step and rules recorded in the audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ruling {
    /// What happens.
    pub outcome: Outcome,
    /// Stable step name.
    pub step: &'static str,
    /// Rules that decided it.
    pub hits: Vec<Hit>,
    /// A hook's refusal reason.
    pub reason: Option<String>,
}

impl Ruling {
    fn new(outcome: Outcome, step: &'static str, hits: Vec<Hit>) -> Self {
        Self {
            outcome,
            step,
            hits,
            reason: None,
        }
    }

    /// Whether the call may run now.
    #[must_use]
    pub fn allow(&self) -> bool {
        self.outcome == Outcome::Allow
    }
}

/// Steps 1–7, ending in [`Outcome::Ask`] for step 8.
#[must_use]
pub fn decide(input: &Input) -> Ruling {
    use Outcome::{Allow, Ask, Deny};
    if let Some(hit) = &input.enterprise {
        return Ruling::new(Deny, "enterpriseDeny", vec![hit.clone()]);
    }
    if let HookVerdict::Deny(reason) = &input.hook {
        let mut r = Ruling::new(Deny, "hookDeny", Vec::new());
        r.reason = Some(reason.clone());
        return r;
    }
    if let Some(hit) = &input.deny {
        return Ruling::new(Deny, "denyRule", vec![hit.clone()]);
    }
    if input.exit_plan {
        return if input.mode == PermissionMode::Plan {
            Ruling::new(Ask, "planApproval", Vec::new())
        } else {
            Ruling::new(Deny, "notInPlanMode", Vec::new())
        };
    }
    if let Some(ask) = &input.ask {
        return Ruling::new(Ask, ask.step, ask.hit.iter().cloned().collect());
    }
    if input.hook == HookVerdict::Ask {
        return Ruling::new(Ask, "hookAsk", Vec::new());
    }
    match input.mode {
        PermissionMode::Plan if input.write => return Ruling::new(Deny, "planMode", Vec::new()),
        PermissionMode::BypassPermissions => {
            return Ruling::new(Allow, "bypassPermissions", Vec::new());
        }
        _ => {}
    }
    if input.protected {
        return Ruling::new(Ask, "protectedPath", Vec::new());
    }
    if !input.tainted {
        if input.allowed && !input.allow.is_empty() {
            return Ruling::new(Allow, "allowRule", input.allow.clone());
        }
        if input.hook == HookVerdict::Allow {
            return Ruling::new(Allow, "hookAllow", Vec::new());
        }
    }
    if input.outside {
        return Ruling::new(Ask, "outsideWorkspace", Vec::new());
    }
    if !input.tainted {
        if input.read_only || input.allowed {
            return Ruling::new(Allow, "readOnly", Vec::new());
        }
        if input.mode == PermissionMode::AcceptEdits && input.accept_edit {
            return Ruling::new(Allow, "acceptEdits", Vec::new());
        }
    }
    Ruling::new(Ask, "ask", Vec::new())
}

/// Step 8: the PermissionRequest slot answers before the user sees the card. It cannot
/// approve a critical deletion, a tool that needs the user's own input or a plan (the user
/// chooses the mode to continue in).
#[must_use]
pub fn after_permission_request(ruling: Ruling, verdict: &HookVerdict) -> Ruling {
    if ruling.outcome != Outcome::Ask
        || matches!(
            ruling.step,
            "criticalPath" | "requiresUserInteraction" | "planApproval"
        )
    {
        return ruling;
    }
    match verdict {
        HookVerdict::Allow => Ruling::new(Outcome::Allow, "permissionRequestHook", ruling.hits),
        HookVerdict::Deny(reason) => {
            let mut r = Ruling::new(Outcome::Deny, "permissionRequestHook", ruling.hits);
            r.reason = Some(reason.clone());
            r
        }
        HookVerdict::None | HookVerdict::Ask => ruling,
    }
}

/// The starting mode: the session's explicit choice, then the mode remembered for the
/// workspace, then `permissions.defaultMode`, then Manual. `bypassPermissions` needs the user
/// to have enabled it; `auto` and `dontAsk` are not available (M5, headless only).
#[must_use]
pub fn starting_mode(
    explicit: Option<PermissionMode>,
    remembered: Option<PermissionMode>,
    setting: Option<&str>,
    bypass_enabled: bool,
) -> PermissionMode {
    let usable = |m: PermissionMode| m != PermissionMode::BypassPermissions || bypass_enabled;
    if let Some(mode) = explicit.filter(|m| usable(*m)) {
        return mode;
    }
    if let Some(mode) = remembered.filter(|m| usable(*m)) {
        return mode;
    }
    match setting {
        Some("acceptEdits") => PermissionMode::AcceptEdits,
        Some("plan") => PermissionMode::Plan,
        Some("bypassPermissions") if bypass_enabled => PermissionMode::BypassPermissions,
        _ => PermissionMode::Default,
    }
}

/// The reason the model receives when plan mode refuses a call.
pub const PLAN_MODE_REFUSAL: &str = "Permission denied: plan mode is on, so files cannot be changed and only read-only commands can run. Keep investigating with read-only tools, then submit your plan with ExitPlanMode and wait for the user to approve it before changing anything.";

/// The reason the model receives for `ExitPlanMode` outside plan mode.
pub const NOT_IN_PLAN_MODE: &str =
    "Plan mode is off, so there is no plan to approve. Continue with the task in the current mode.";

#[cfg(test)]
mod tests;
