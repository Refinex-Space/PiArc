//! Terminals in the Core API (ADR-0017, T33): the events of the route `term/<id>` and the
//! values the terminal calls return. Frames are binary and have their own module,
//! [`crate::term_frame`]; terminals the model uses are background tasks ([`crate::tasks`],
//! ADR-0050).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// What a terminal reports on its route `term/<id>`, one JSON object per event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    /// The program set the title (OSC 0/2); empty after a reset.
    Title {
        /// The new title.
        title: String,
    },
    /// The shell reported its working directory (OSC 7): a local path, or the URL as sent
    /// when it is not a file URL; empty after a reset.
    Pwd {
        /// The directory.
        path: String,
    },
    /// The program rang the bell.
    Bell {
        /// Bells in one chunk of output.
        #[schemars(with = "u64")]
        count: u32,
    },
    /// A command started (OSC 133 `C`).
    CommandStarted {
        /// Its number in this terminal, from 1.
        seq: u64,
        /// The command line, when the shell sent it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
    },
    /// A command finished (OSC 133 `D`, or the next prompt).
    CommandFinished {
        /// Its number.
        seq: u64,
        /// The exit code, when the shell sent it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    /// The program put text on the clipboard (OSC 52); the client writes the system
    /// clipboard. Only sent while the setting allows it.
    Clipboard {
        /// The text.
        text: String,
    },
    /// The program asked to read the clipboard and got an empty answer.
    ClipboardReadDenied,
    /// The program exited and its output was read.
    Exited {
        /// The exit code, `null` when unknown.
        #[serde(deserialize_with = "Option::deserialize")]
        #[schemars(required, with = "Option<u64>")]
        code: Option<u32>,
    },
    /// The terminal stopped working (a thread of it failed).
    Failed {
        /// What failed.
        reason: String,
    },
    /// New output arrived after a frame the viewer pulled with `park` (T34): a viewer that
    /// stopped pulling while nothing changed pulls again. Sent once per parking.
    Output,
}

/// Where to move a terminal's viewport (T34).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalScroll {
    /// The top of the scrollback.
    Top,
    /// The active area, where the program writes.
    Bottom,
    /// By `rows`; up is negative.
    Delta {
        /// Rows to move.
        rows: i64,
    },
    /// So that `row` (from the top of the scrollback, the frame scrollbar's row space) is the
    /// first visible row.
    Row {
        /// The row.
        row: u64,
    },
}

/// A hyperlink (OSC 8) on a viewport row (T34).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLink {
    /// The URI as the program sent it.
    pub uri: String,
    /// Viewport row.
    #[schemars(with = "u64")]
    pub row: u32,
    /// First column.
    #[schemars(with = "u64")]
    pub start: u32,
    /// Last column (included).
    #[schemars(with = "u64")]
    pub end: u32,
}

/// Which text of a terminal to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalTextRange {
    /// The active area (the bottom rows, where the program writes).
    Screen,
    /// What the viewport shows (it may be scrolled into the scrollback).
    Viewport,
    /// The scrollback and the active area.
    All,
    /// The last `count` lines, after the blank rows at the bottom.
    LastLines {
        /// How many lines.
        #[schemars(with = "u64")]
        count: u32,
    },
}

/// What a terminal shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    /// The terminal's handle.
    #[schemars(with = "u64")]
    pub terminal_id: u32,
    /// Columns.
    #[schemars(with = "u64")]
    pub cols: u32,
    /// Rows.
    #[schemars(with = "u64")]
    pub rows: u32,
    /// The title the program set, empty when none.
    pub title: String,
    /// The working directory the shell reported, empty when none.
    pub pwd: String,
    /// A full-screen program shows its alternate screen.
    pub alternate_screen: bool,
    /// The number of the newest command, 0 before the first.
    pub last_command: u64,
    /// The session it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Its background task (terminals of a session).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The user shares it with the model.
    pub shared: bool,
}

/// Running or finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCommandState {
    /// Started and not finished.
    Running,
    /// Finished.
    Finished,
}

/// A position in a terminal's text: row from the top of the scrollback, column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPoint {
    /// Row from the top of the scrollback.
    pub row: u64,
    /// Column.
    #[schemars(with = "u64")]
    pub col: u32,
}

/// One command a shell ran in a terminal (OSC 133).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommand {
    /// Its number in the terminal, from 1.
    pub seq: u64,
    /// The command line.
    pub command: String,
    /// Running or finished.
    pub state: TerminalCommandState,
    /// The exit code, when the shell reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// When it started, Unix milliseconds.
    pub started_at: u64,
    /// When it finished, Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Where its output starts; absent once it left the scrollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_start: Option<TerminalPoint>,
    /// Where its output ends; absent while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_end: Option<TerminalPoint>,
    /// The output as plain text (lines unwrapped and trimmed).
    pub output: String,
    /// The whole output is still in the terminal.
    pub output_complete: bool,
}

/// One search match: first and last cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMatch {
    /// First cell.
    pub start: TerminalPoint,
    /// Last cell.
    pub end: TerminalPoint,
}

/// What a paste did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TerminalPasteOutcome {
    /// The text went to the program.
    Pasted,
    /// The text could run commands by itself; ask the user, then paste with `allowUnsafe`.
    Unsafe,
    /// Nothing to paste.
    Empty,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_have_a_type_tag() {
        let event = TerminalEvent::CommandFinished {
            seq: 3,
            exit_code: Some(1),
        };
        assert_eq!(
            serde_json::to_value(&event).expect("json"),
            serde_json::json!({ "type": "commandFinished", "seq": 3, "exitCode": 1 })
        );
        let exited = TerminalEvent::Exited { code: None };
        assert_eq!(
            serde_json::to_value(&exited).expect("json"),
            serde_json::json!({ "type": "exited", "code": null })
        );
        assert_eq!(
            serde_json::to_value(TerminalEvent::Output).expect("json"),
            serde_json::json!({ "type": "output" })
        );
        let scroll: TerminalScroll =
            serde_json::from_value(serde_json::json!({ "kind": "delta", "rows": -3 }))
                .expect("scroll");
        assert_eq!(scroll, TerminalScroll::Delta { rows: -3 });
        let range: TerminalTextRange =
            serde_json::from_value(serde_json::json!({ "kind": "lastLines", "count": 5 }))
                .expect("range");
        assert_eq!(range, TerminalTextRange::LastLines { count: 5 });
    }
}
