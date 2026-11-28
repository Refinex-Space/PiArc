//! `piarc-term` events as the Core API's `term/<id>` events
//! ([`piarc_protocol::terminal::TerminalEvent`]).

use piarc_protocol::terminal::{TerminalEvent, TerminalMatch, TerminalPoint};
use piarc_term::Event as TermEvent;
use piarc_term::commands::CommandChange;
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

/// The Core API form of a search match.
pub(super) fn search_match(found: SearchMatch) -> TerminalMatch {
    TerminalMatch {
        start: point(found.start),
        end: point(found.end),
    }
}
