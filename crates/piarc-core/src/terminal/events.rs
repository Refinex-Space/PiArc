//! `piarc-term` events as the Core API's `term/<id>` events
//! ([`piarc_protocol::terminal::TerminalEvent`]).

use piarc_protocol::terminal::{
    TerminalCommand, TerminalCommandState, TerminalEvent, TerminalMatch, TerminalPoint,
};
use piarc_term::Event as TermEvent;
use piarc_term::commands::{CommandChange, CommandInfo, CommandState};
use piarc_term::vt::{ScreenPoint, SearchMatch};

/// The client's form of `event`.
pub(super) fn to_protocol(event: &TermEvent) -> TerminalEvent {
    match event {
        TermEvent::Title(title) => TerminalEvent::Title {
            title: title.clone(),
        },
        TermEvent::Pwd(path) => TerminalEvent::Pwd { path: path.clone() },
        TermEvent::Bell { count } => TerminalEvent::Bell { count: *count },
        TermEvent::Command(CommandChange::Started { seq, command }) => {
            TerminalEvent::CommandStarted {
                seq: *seq,
                command: command.clone(),
            }
        }
        TermEvent::Command(CommandChange::Finished { seq, exit_code }) => {
            TerminalEvent::CommandFinished {
                seq: *seq,
                exit_code: *exit_code,
            }
        }
        TermEvent::Clipboard(text) => TerminalEvent::Clipboard { text: text.clone() },
        TermEvent::ClipboardReadDenied => TerminalEvent::ClipboardReadDenied,
        TermEvent::Exited { code } => TerminalEvent::Exited { code: *code },
        TermEvent::Failed { reason } => TerminalEvent::Failed {
            reason: reason.clone(),
        },
        TermEvent::Output => TerminalEvent::Output,
    }
}

fn point(point: ScreenPoint) -> TerminalPoint {
    TerminalPoint {
        row: u64::from(point.y),
        col: u32::from(point.x),
    }
}

fn millis(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The Core API form of a command.
pub(super) fn command(info: CommandInfo) -> TerminalCommand {
    TerminalCommand {
        seq: info.seq,
        command: info.command,
        state: match info.state {
            CommandState::Running => TerminalCommandState::Running,
            CommandState::Finished => TerminalCommandState::Finished,
        },
        exit_code: info.exit_code,
        started_at: millis(info.started_at),
        ended_at: info.ended_at.map(millis),
        output_start: info.output_start.map(point),
        output_end: info.output_end.map(point),
        output: info.output,
        output_complete: info.output_complete,
    }
}

/// The Core API form of a search match.
pub(super) fn search_match(found: SearchMatch) -> TerminalMatch {
    TerminalMatch {
        start: point(found.start),
        end: point(found.end),
    }
}
