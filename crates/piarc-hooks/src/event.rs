//! The hook events PiArc runs (architecture section 6.3.2: M2, and M3 from T38), the handler
//! types each takes, and the events PiArc recognizes but does not run yet.

use std::time::Duration;

/// An event that runs hooks: M2's eleven, M3's three and M4's six (T41); the others of Claude
/// Code's set arrive with the tasks in [`LATER_EVENTS`].
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
    /// Before the user changes a session model.
    PreModelSwitch,
    /// After a confirmed session model change.
    PostModelSwitch,
    /// Before creating an isolated worktree.
    WorktreeCreate,
    /// A configured hook removes its previously registered worktree.
    WorktreeRemove,
    /// The Auto reviewer refused a tool call.
    PermissionDenied,
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
    /// A subagent starts, before its first request (T38).
    SubagentStart,
    /// A subagent is about to finish its response (T38): its Stop.
    SubagentStop,
    /// Every tool call of one model response has its result, before the next request (T38).
    PostToolBatch,
    /// A slash command, skill or MCP prompt the user typed is about to become the input (T41).
    UserPromptExpansion,
    /// A memory file or rule entered the context (T41).
    InstructionsLoaded,
    /// A command changed the session's working directory (T41).
    CwdChanged,
    /// A watched file changed on disk (T41).
    FileChanged,
    /// A configuration file changed during the session (T41).
    ConfigChange,
    /// A turn ended with a model API error after its retries (T41).
    StopFailure,
    /// An MCP server requests information.
    Elicitation,
    /// Before an elicitation response is returned to its server.
    ElicitationResult,
}

/// A handler type (the `type` field) PiArc runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HandlerKind {
    /// A shell command or a program with arguments.
    Command,
    /// A POST of the input JSON to a URL.
    Http,
    /// One model call judging the input.
    Prompt,
    /// One tool call on a connected MCP server (T41).
    McpTool,
}

impl HandlerKind {
    /// The configuration value.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Http => "http",
            Self::Prompt => "prompt",
            Self::McpTool => "mcp_tool",
        }
    }
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
    /// `prompt` handlers without a `timeout`, on every event: 30 s.
    pub prompt: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            default: Duration::from_secs(600),
            user_prompt_submit: Duration::from_secs(30),
            session_end: Duration::from_millis(1500),
            session_end_max: Duration::from_secs(60),
            prompt: Duration::from_secs(30),
        }
    }
}

impl HookEvent {
    /// Every event, in Claude Code's documentation order.
    pub const ALL: [Self; 27] = [
        Self::SessionStart,
        Self::SessionEnd,
        Self::UserPromptSubmit,
        Self::PreToolUse,
        Self::PermissionRequest,
        Self::PermissionDenied,
        Self::PreModelSwitch,
        Self::PostModelSwitch,
        Self::WorktreeCreate,
        Self::WorktreeRemove,
        Self::PostToolUse,
        Self::PostToolUseFailure,
        Self::Stop,
        Self::PreCompact,
        Self::PostCompact,
        Self::Notification,
        Self::SubagentStart,
        Self::SubagentStop,
        Self::PostToolBatch,
        Self::UserPromptExpansion,
        Self::InstructionsLoaded,
        Self::CwdChanged,
        Self::FileChanged,
        Self::ConfigChange,
        Self::StopFailure,
        Self::Elicitation,
        Self::ElicitationResult,
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
            Self::PermissionDenied => "PermissionDenied",
            Self::PreModelSwitch => "PreModelSwitch",
            Self::PostModelSwitch => "PostModelSwitch",
            Self::WorktreeCreate => "WorktreeCreate",
            Self::WorktreeRemove => "WorktreeRemove",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
            Self::Stop => "Stop",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::Notification => "Notification",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::PostToolBatch => "PostToolBatch",
            Self::UserPromptExpansion => "UserPromptExpansion",
            Self::InstructionsLoaded => "InstructionsLoaded",
            Self::CwdChanged => "CwdChanged",
            Self::FileChanged => "FileChanged",
            Self::ConfigChange => "ConfigChange",
            Self::StopFailure => "StopFailure",
            Self::Elicitation => "Elicitation",
            Self::ElicitationResult => "ElicitationResult",
        }
    }

    /// The event called `name`.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|event| event.name() == name)
    }

    /// Whether the event's matcher filters anything. `UserPromptSubmit`, `Stop`,
    /// `PostToolBatch` and `CwdChanged` always fire: a matcher there is ignored. The subagent
    /// events match the agent type; the M4 events match the command name, the load reason, the
    /// file name, the configuration source and the error type.
    #[must_use]
    pub fn uses_matcher(self) -> bool {
        !matches!(
            self,
            Self::UserPromptSubmit
                | Self::Stop
                | Self::PostToolBatch
                | Self::CwdChanged
                | Self::WorktreeCreate
                | Self::WorktreeRemove
        )
    }

    /// Whether the event runs handlers of `kind` (Claude Code's table): `SessionStart` runs
    /// commands only; `prompt` handlers run on the events that decide something about the
    /// agent's work, not on session, compaction, notification or subagent-start events.
    #[must_use]
    pub fn supports(self, kind: HandlerKind) -> bool {
        match kind {
            HandlerKind::Command | HandlerKind::McpTool => true,
            HandlerKind::Http => self != Self::SessionStart,
            HandlerKind::Prompt => matches!(
                self,
                Self::PreToolUse
                    | Self::PermissionDenied
                    | Self::PermissionRequest
                    | Self::PostToolUse
                    | Self::PostToolUseFailure
                    | Self::Stop
                    | Self::SubagentStop
                    | Self::UserPromptSubmit
                    | Self::PostToolBatch
                    | Self::UserPromptExpansion
            ),
        }
    }

    /// Whether a handler's `if` condition applies: only on tool events. Elsewhere a handler with
    /// `if` never runs.
    #[must_use]
    pub fn is_tool_event(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PermissionDenied
                | Self::PermissionRequest
                | Self::PostToolUse
                | Self::PostToolUseFailure
        )
    }

    /// The timeout of a handler that sets none.
    #[must_use]
    pub fn default_timeout(self, timeouts: &Timeouts) -> Duration {
        match self {
            Self::UserPromptSubmit | Self::PreModelSwitch | Self::PostModelSwitch => {
                timeouts.user_prompt_submit
            }
            Self::SessionEnd => timeouts.session_end,
            _ => timeouts.default,
        }
    }

    /// The timeout of a handler of `kind`: its own, or the default (`prompt` handlers 30 s,
    /// others the event's). `SessionEnd` caps its own.
    #[must_use]
    pub fn timeout(
        self,
        kind: HandlerKind,
        own: Option<Duration>,
        timeouts: &Timeouts,
    ) -> Duration {
        match (self, own) {
            (Self::SessionEnd, Some(own)) => own.min(timeouts.session_end_max),
            (_, Some(own)) => own,
            (_, None) if kind == HandlerKind::Prompt => timeouts.prompt,
            (_, None) => self.default_timeout(timeouts),
        }
    }

    /// What plain stdout becomes.
    #[must_use]
    pub fn plain_stdout(self) -> PlainStdout {
        match self {
            Self::SessionStart
            | Self::UserPromptSubmit
            | Self::UserPromptExpansion
            | Self::PostModelSwitch => PlainStdout::Context,
            Self::PreCompact => PlainStdout::Instructions,
            _ => PlainStdout::Ignored,
        }
    }

    /// What exit code 2 does.
    #[must_use]
    pub fn exit_two(self) -> ExitTwo {
        match self {
            Self::PreToolUse
            | Self::UserPromptSubmit
            | Self::Stop
            | Self::SubagentStop
            | Self::PreCompact
            | Self::PostToolBatch
            | Self::UserPromptExpansion
            | Self::WorktreeCreate
            | Self::WorktreeRemove
            | Self::ConfigChange
            | Self::Elicitation
            | Self::PreModelSwitch
            | Self::ElicitationResult => ExitTwo::Blocks,
            Self::PostToolUse | Self::PostToolUseFailure => ExitTwo::ToModel,
            Self::SessionStart
            | Self::SessionEnd
            | Self::PostCompact
            | Self::SubagentStart
            | Self::InstructionsLoaded
            | Self::CwdChanged
            | Self::FileChanged
            | Self::PostModelSwitch => ExitTwo::ToUser,
            Self::PermissionRequest
            | Self::PermissionDenied
            | Self::Notification
            | Self::StopFailure => ExitTwo::Ignored,
        }
    }

    /// Whether the event uses the JSON output's `systemMessage` and `continue`. `SessionEnd`,
    /// `PreCompact`, `PostCompact` and `Notification` discard them.
    #[must_use]
    pub fn uses_common_fields(self) -> bool {
        !matches!(
            self,
            Self::SessionEnd
                | Self::PreCompact
                | Self::PostCompact
                | Self::Notification
                | Self::StopFailure
        )
    }

    /// Whether the event's JSON output may set `watchPaths` (T41): the files `FileChanged`
    /// watches next.
    #[must_use]
    pub fn sets_watch_paths(self) -> bool {
        matches!(
            self,
            Self::SessionStart | Self::CwdChanged | Self::FileChanged
        )
    }
}

/// Events of Claude Code's set that PiArc recognizes but does not run yet, with the task that
/// adds them ("unscheduled" when none does). Configuration naming them is reported, not run.
pub const LATER_EVENTS: &[(&str, &str)] = &[
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
        let command = HandlerKind::Command;
        assert_eq!(
            HookEvent::PreToolUse.timeout(command, None, &t),
            Duration::from_secs(600)
        );
        assert_eq!(
            HookEvent::PreToolUse.timeout(HandlerKind::Http, None, &t),
            Duration::from_secs(600)
        );
        assert_eq!(
            HookEvent::Stop.timeout(HandlerKind::Prompt, None, &t),
            Duration::from_secs(30)
        );
        assert_eq!(
            HookEvent::UserPromptSubmit.timeout(command, None, &t),
            Duration::from_secs(30)
        );
        assert_eq!(
            HookEvent::UserPromptSubmit.timeout(command, Some(Duration::from_secs(5)), &t),
            Duration::from_secs(5)
        );
        assert_eq!(
            HookEvent::SessionEnd.timeout(command, None, &t),
            Duration::from_millis(1500)
        );
        assert_eq!(
            HookEvent::SessionEnd.timeout(command, Some(Duration::from_secs(600)), &t),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn handler_types_follow_claude_codes_table() {
        use HandlerKind::{Command, Http, Prompt};
        assert!(HookEvent::SessionStart.supports(Command));
        assert!(!HookEvent::SessionStart.supports(Http));
        assert!(!HookEvent::SessionStart.supports(Prompt));
        for event in [
            HookEvent::SessionEnd,
            HookEvent::Notification,
            HookEvent::PreCompact,
            HookEvent::PostCompact,
            HookEvent::SubagentStart,
        ] {
            assert!(event.supports(Http) && !event.supports(Prompt), "{event:?}");
        }
        for event in [
            HookEvent::PreToolUse,
            HookEvent::PermissionRequest,
            HookEvent::PostToolUse,
            HookEvent::PostToolUseFailure,
            HookEvent::Stop,
            HookEvent::SubagentStop,
            HookEvent::UserPromptSubmit,
            HookEvent::PostToolBatch,
        ] {
            assert!(event.supports(Http) && event.supports(Prompt), "{event:?}");
        }
    }
}
