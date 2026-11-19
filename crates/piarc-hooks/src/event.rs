//! The hook events PiArc runs (architecture section 6.3.2, M2) and the ones it recognizes but
//! does not run yet.

use std::time::Duration;

/// An event that runs hooks. M2 has these eleven; the others of Claude Code's set arrive with
/// the tasks in [`LATER_EVENTS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HookEvent {
    /// A session was created, resumed or forked, or its context was compacted.
    SessionStart,
    /// A session is closing.
    SessionEnd,
    /// The user submitted input, before it reaches the Agent Host.
    UserPromptSubmit,
    /// Before a tool call (step 2 of the decision ladder).
    PreToolUse,
    /// Before the user is asked to approve a tool call (step 8 of the decision ladder).
    PermissionRequest,
    /// After a tool call succeeded.
    PostToolUse,
    /// After a tool call failed.
    PostToolUseFailure,
    /// The agent is about to finish its response.
    Stop,
    /// Before the context is compacted.
    PreCompact,
    /// After the context was compacted.
    PostCompact,
    /// Core notifies the user (an approval waits, a turn finished).
    Notification,
}

/// What a hook's plain (non-JSON) stdout becomes on exit 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlainStdout {
    /// Added to the model's context.
    Context,
    /// Instructions for the compaction summary.
    Instructions,
    /// Not used.
    Ignored,
}

/// Where the stderr of an exit 2 goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitTwo {
    /// The action is blocked; stderr is the reason.
    Blocks,
    /// The action proceeds; the model reads stderr next to the tool result.
    ToModel,
    /// The action proceeds; the user sees stderr.
    ToUser,
    /// Exit 2 means nothing here.
    Ignored,
}

/// Timeouts of hook commands. A handler's own `timeout` replaces the event's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    /// Every event without its own default: 600 s.
    pub default: Duration,
    /// `UserPromptSubmit`: 30 s.
    pub user_prompt_submit: Duration,
    /// `SessionEnd` handlers without a `timeout`: 1.5 s, so closing a session is not held up.
    pub session_end: Duration,
    /// The most a `SessionEnd` handler's own `timeout` may ask for: 60 s.
    pub session_end_max: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            default: Duration::from_secs(600),
            user_prompt_submit: Duration::from_secs(30),
            session_end: Duration::from_millis(1500),
            session_end_max: Duration::from_secs(60),
        }
    }
}

impl HookEvent {
    /// Every event, in Claude Code's documentation order.
    pub const ALL: [Self; 11] = [
        Self::SessionStart,
        Self::SessionEnd,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PostToolUse,
        Self::PostToolUseFailure,
        Self::Stop,
        Self::PreCompact,
        Self::PostCompact,
        Self::Notification,
    ];

    /// The configuration key and `hook_event_name`.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::SessionEnd => "SessionEnd",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PermissionRequest => "PermissionRequest",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
            Self::Stop => "Stop",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::Notification => "Notification",
        }
    }

    /// The event called `name`.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|event| event.name() == name)
    }

    /// Whether the event's matcher filters anything. `UserPromptSubmit` and `Stop` always fire:
    /// a matcher there is ignored.
    #[must_use]
    pub fn uses_matcher(self) -> bool {
        !matches!(self, Self::UserPromptSubmit | Self::Stop)
    }

    /// Whether a handler's `if` condition applies: only on tool events. Elsewhere a handler with
    /// `if` never runs.
    #[must_use]
    pub fn is_tool_event(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PermissionRequest
                | Self::PostToolUse
                | Self::PostToolUseFailure
        )
    }

    /// The timeout of a handler that sets none.
    #[must_use]
    pub fn default_timeout(self, timeouts: &Timeouts) -> Duration {
        match self {
            Self::UserPromptSubmit => timeouts.user_prompt_submit,
            Self::SessionEnd => timeouts.session_end,
            _ => timeouts.default,
        }
    }

    /// The timeout of a handler: its own, or the event's default. `SessionEnd` caps its own.
    #[must_use]
    pub fn timeout(self, own: Option<Duration>, timeouts: &Timeouts) -> Duration {
        match (self, own) {
            (Self::SessionEnd, Some(own)) => own.min(timeouts.session_end_max),
            (_, Some(own)) => own,
            (_, None) => self.default_timeout(timeouts),
        }
    }

    /// What plain stdout becomes.
    #[must_use]
    pub fn plain_stdout(self) -> PlainStdout {
        match self {
            Self::SessionStart | Self::UserPromptSubmit => PlainStdout::Context,
            Self::PreCompact => PlainStdout::Instructions,
            _ => PlainStdout::Ignored,
        }
    }

    /// What exit code 2 does.
    #[must_use]
    pub fn exit_two(self) -> ExitTwo {
        match self {
            Self::PreToolUse | Self::UserPromptSubmit | Self::Stop | Self::PreCompact => {
                ExitTwo::Blocks
            }
            Self::PostToolUse | Self::PostToolUseFailure => ExitTwo::ToModel,
            Self::SessionStart | Self::SessionEnd | Self::PostCompact => ExitTwo::ToUser,
            Self::PermissionRequest | Self::Notification => ExitTwo::Ignored,
        }
    }

    /// Whether the event uses the JSON output's `systemMessage` and `continue`. `SessionEnd`,
    /// `PreCompact`, `PostCompact` and `Notification` discard them.
    #[must_use]
    pub fn uses_common_fields(self) -> bool {
        !matches!(
            self,
            Self::SessionEnd | Self::PreCompact | Self::PostCompact | Self::Notification
        )
    }
}

/// Events of Claude Code's set that PiArc recognizes but does not run yet, with the task that
/// adds them ("unscheduled" when none does). Configuration naming them is reported, not run.
pub const LATER_EVENTS: &[(&str, &str)] = &[
    ("SubagentStart", "T38"),
    ("SubagentStop", "T38"),
    ("PostToolBatch", "T38"),
    ("UserPromptExpansion", "T41"),
    ("InstructionsLoaded", "T41"),
    ("CwdChanged", "T41"),
    ("FileChanged", "T41"),
    ("ConfigChange", "T41"),
    ("StopFailure", "T41"),
    ("WorktreeCreate", "T48"),
    ("WorktreeRemove", "T48"),
    ("PreModelSwitch", "T48"),
    ("PostModelSwitch", "T48"),
    ("Elicitation", "T48"),
    ("ElicitationResult", "T48"),
    ("PermissionDenied", "T48"),
    ("TaskCreated", "unscheduled"),
    ("TaskCompleted", "unscheduled"),
    ("MessageDisplay", "unscheduled"),
    ("Setup", "unscheduled"),
    ("DirectoryAdded", "unscheduled"),
    ("TeammateIdle", "unscheduled"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_later_events_are_distinct() {
        for event in HookEvent::ALL {
            assert_eq!(HookEvent::parse(event.name()), Some(event));
            assert!(LATER_EVENTS.iter().all(|(name, _)| *name != event.name()));
        }
        assert_eq!(HookEvent::parse("preToolUse"), None);
    }

    #[test]
    fn timeouts_follow_the_event_and_the_handler() {
        let t = Timeouts::default();
        assert_eq!(
            HookEvent::PreToolUse.timeout(None, &t),
            Duration::from_secs(600)
        );
        assert_eq!(
            HookEvent::UserPromptSubmit.timeout(None, &t),
            Duration::from_secs(30)
        );
        assert_eq!(
            HookEvent::UserPromptSubmit.timeout(Some(Duration::from_secs(5)), &t),
            Duration::from_secs(5)
        );
        assert_eq!(
            HookEvent::SessionEnd.timeout(None, &t),
            Duration::from_millis(1500)
        );
        assert_eq!(
            HookEvent::SessionEnd.timeout(Some(Duration::from_secs(600)), &t),
            Duration::from_secs(60)
        );
    }
}
