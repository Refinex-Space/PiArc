//! Built-in slash commands (architecture section 8.2): the `/` palette lists what Core gives
//! here, so commands that later tasks register (files, skills, MCP prompts, T37) appear the
//! same way. Each command names the action the client performs; the client shows a localized
//! description for built-in commands and Core's text otherwise.

use serde::Serialize;

/// What running a command does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandAction {
    /// Starts a new session in the same workspace: the conversation so far no longer counts.
    NewSession,
    /// Compacts the conversation (`Op::Compact`).
    Compact,
    /// Shows the commands and keyboard shortcuts.
    Help,
    /// Opens the rewind dialog to choose a message to go back to (T28).
    Rewind,
}

/// A command the palette lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    /// The name after `/`.
    pub name: &'static str,
    /// One line about what it does.
    pub description: &'static str,
    /// Where it comes from: `builtin` for these.
    pub source: &'static str,
    /// What the client does.
    pub action: CommandAction,
}

/// The built-in commands, in palette order.
#[must_use]
pub fn builtin() -> Vec<Command> {
    vec![
        Command {
            name: "clear",
            description: "Start a new conversation in this folder",
            source: "builtin",
            action: CommandAction::NewSession,
        },
        Command {
            name: "compact",
            description: "Summarize the conversation to free up context",
            source: "builtin",
            action: CommandAction::Compact,
        },
        Command {
            name: "rewind",
            description: "Go back to an earlier message: restore code, conversation or both",
            source: "builtin",
            action: CommandAction::Rewind,
        },
        Command {
            name: "help",
            description: "Show commands and keyboard shortcuts",
            source: "builtin",
            action: CommandAction::Help,
        },
    ]
}
