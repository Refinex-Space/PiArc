//! Command boundaries from OSC 133 (shell integration): which commands ran in a terminal, where
//! their prompt, input and output are on the screen, and how they ended.
//!
//! The shell reports four steps per command — prompt start (`A`), input start (`B`), output
//! start (`C`, optionally with the command line) and command end (`D`, optionally with the exit
//! code). Each step arrives as a [`SemanticMark`] with the cursor cell tracked by libghostty-vt,
//! so the boundaries keep pointing at the right rows while the content scrolls; a boundary that
//! scrolled out of the scrollback is gone, and the text before it with it.
//!
//! Shells differ (some skip steps or send no exit code), so every step is handled on its own:
//! `C` starts a command; `D` finishes the running one; a new prompt while a command still runs
//! finishes it without an exit code. The log keeps the last [`MAX_COMMANDS`] commands. It lives
//! next to the terminal behind the same lock: its tracked cells may only be used and dropped
//! while the terminal is locked.

use std::collections::VecDeque;
use std::time::SystemTime;

use crate::error::Result;
use crate::vt::{
    self, ScreenPoint, SemanticKind, SemanticMark, Terminal, TextOptions, TextRange, TrackedPoint,
};

/// Commands kept per terminal.
pub const MAX_COMMANDS: usize = 64;

/// What a command is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandState {
    /// Started (`C`) and not finished yet.
    Running,
    /// Finished: `D` arrived, or the next prompt did.
    Finished,
}

/// A change to the log, reported as an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandChange {
    /// A command started.
    Started {
        /// Its number in this terminal, from 1.
        seq: u64,
        /// The command line the shell reported, if any.
        command: Option<String>,
    },
    /// A command finished.
    Finished {
        /// Its number.
        seq: u64,
        /// The exit code, when the shell reported one.
        exit_code: Option<i32>,
    },
}

/// One command as callers see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInfo {
    /// Its number in this terminal, from 1.
    pub seq: u64,
    /// The command line: as the shell reported it, else as typed on the screen.
    pub command: String,
    /// Running or finished.
    pub state: CommandState,
    /// The exit code, when the shell reported one.
    pub exit_code: Option<i32>,
    /// When it started (wall clock).
    pub started_at: SystemTime,
    /// When it finished.
    pub ended_at: Option<SystemTime>,
    /// First row of its output, in screen coordinates; `None` once it left the scrollback.
    pub output_start: Option<ScreenPoint>,
    /// Where its output ended (the cursor when it finished); `None` while it runs or once it
    /// left the scrollback.
    pub output_end: Option<ScreenPoint>,
    /// Its output as plain text, lines unwrapped and trimmed. Output that already left the
    /// scrollback is missing from the start; `output_complete` says whether that happened.
    pub output: String,
    /// The whole output is still in the terminal.
    pub output_complete: bool,
}

struct Record {
    seq: u64,
    command: Option<String>,
    input: Option<TrackedPoint>,
    output: Option<TrackedPoint>,
    end: Option<TrackedPoint>,
    exit_code: Option<i32>,
    state: CommandState,
    started_at: SystemTime,
    ended_at: Option<SystemTime>,
}

/// The command log of one terminal.
#[derive(Default)]
pub struct CommandLog {
    records: VecDeque<Record>,
    next_seq: u64,
    /// Where the current prompt's input starts (`B`).
    input: Option<TrackedPoint>,
}

impl CommandLog {
    /// Applies one OSC 133 step; returns the changes it caused, in order.
    pub fn apply(&mut self, mark: SemanticMark) -> Vec<CommandChange> {
        let mut changes = Vec::new();
        match mark.kind {
            SemanticKind::PromptStart => {
                changes.extend(self.finish(None, None));
                self.input = None;
            }
            SemanticKind::InputStart => {
                self.input = mark.at;
            }
            SemanticKind::OutputStart => {
                // A `C` without `D` for the previous command (some shells skip it).
                changes.extend(self.finish(None, None));
                self.next_seq += 1;
                let seq = self.next_seq;
                changes.push(CommandChange::Started {
                    seq,
                    command: mark.command.clone(),
                });
                self.records.push_back(Record {
                    seq,
                    command: mark.command,
                    input: self.input.take(),
                    output: mark.at,
                    end: None,
                    exit_code: None,
                    state: CommandState::Running,
                    started_at: SystemTime::now(),
                    ended_at: None,
                });
                while self.records.len() > MAX_COMMANDS {
                    self.records.pop_front();
                }
            }
            SemanticKind::CommandEnd => {
                changes.extend(self.finish(mark.exit_code, mark.at));
            }
        }
        changes
    }

    fn finish(
        &mut self,
        exit_code: Option<i32>,
        at: Option<TrackedPoint>,
    ) -> Option<CommandChange> {
        let record = self.records.back_mut()?;
        if record.state != CommandState::Running {
            return None;
        }
        record.state = CommandState::Finished;
        record.exit_code = exit_code;
        record.end = at;
        record.ended_at = Some(SystemTime::now());
        Some(CommandChange::Finished {
            seq: record.seq,
            exit_code,
        })
    }

    /// The program reset the terminal (RIS): the screen is gone, and with it every boundary.
    pub fn reset(&mut self) {
        for record in &mut self.records {
            record.input = None;
            record.output = None;
            record.end = None;
            if record.state == CommandState::Running {
                record.state = CommandState::Finished;
                record.ended_at = Some(SystemTime::now());
            }
        }
        self.input = None;
    }

    /// The number of the newest command, 0 before the first.
    #[must_use]
    pub fn last_seq(&self) -> u64 {
        self.next_seq
    }

    /// The newest command.
    ///
    /// # Errors
    ///
    /// [`crate::Error::Vt`] when the formatter fails.
    pub fn last(&self, terminal: &mut Terminal) -> Result<Option<CommandInfo>> {
        self.records
            .back()
            .map(|record| info(record, terminal))
            .transpose()
    }

    /// Command `seq`, if the log still has it.
    ///
    /// # Errors
    ///
    /// [`crate::Error::Vt`] when the formatter fails.
    pub fn get(&self, seq: u64, terminal: &mut Terminal) -> Result<Option<CommandInfo>> {
        self.records
            .iter()
            .find(|record| record.seq == seq)
            .map(|record| info(record, terminal))
            .transpose()
    }

    /// The first finished command numbered above `after`, if there is one.
    #[must_use]
    pub fn finished_after(&self, after: u64) -> Option<u64> {
        self.records
            .iter()
            .find(|r| r.seq > after && r.state == CommandState::Finished)
            .map(|r| r.seq)
    }
}

fn info(record: &Record, terminal: &mut Terminal) -> Result<CommandInfo> {
    let output_start = record.output.as_ref().and_then(|p| p.point(terminal));
    let output_end = record.end.as_ref().and_then(|p| p.point(terminal));
    let input_start = record.input.as_ref().and_then(|p| p.point(terminal));
    let command = match (&record.command, input_start, output_start) {
        (Some(command), _, _) => command.clone(),
        (None, Some(input), Some(output)) => typed_command(terminal, input, output)?,
        _ => String::new(),
    };
    let unwrapped = TextOptions {
        unwrap: true,
        trim: true,
    };
    let output = match (output_start, record.state) {
        (Some(start), CommandState::Running) => {
            let end = last_cell(terminal);
            if end < start {
                String::new()
            } else {
                vt::plain_text(terminal, TextRange::Between(start, end), unwrapped)?
            }
        }
        (Some(start), CommandState::Finished) => match output_end.and_then(before) {
            Some(end) if end >= start => {
                vt::plain_text(terminal, TextRange::Between(start, end), unwrapped)?
            }
            Some(_) => String::new(),
            None if record.end.is_none() => {
                // Finished by the next prompt: up to the end of the screen.
                vt::plain_text(
                    terminal,
                    TextRange::Between(start, last_cell(terminal)),
                    unwrapped,
                )?
            }
            // The end left the scrollback: so did all of the output.
            None => String::new(),
        },
        (None, _) => String::new(),
    };
    Ok(CommandInfo {
        seq: record.seq,
        command,
        state: record.state,
        exit_code: record.exit_code,
        started_at: record.started_at,
        ended_at: record.ended_at,
        output_start,
        output_end,
        output,
        output_complete: output_start.is_some(),
    })
}

/// The command line as typed: from the input start to the cell before the output start.
fn typed_command(
    terminal: &mut Terminal,
    input: ScreenPoint,
    output: ScreenPoint,
) -> Result<String> {
    let Some(end) = before(output) else {
        return Ok(String::new());
    };
    if end < input {
        return Ok(String::new());
    }
    let text = vt::plain_text(
        terminal,
        TextRange::Between(input, end),
        TextOptions {
            unwrap: true,
            trim: true,
        },
    )?;
    Ok(text.trim().to_owned())
}

/// The cell before `point` in reading order; `None` before the first cell.
fn before(point: ScreenPoint) -> Option<ScreenPoint> {
    if point.x > 0 {
        return Some(ScreenPoint {
            y: point.y,
            x: point.x - 1,
        });
    }
    point
        .y
        .checked_sub(1)
        .map(|y| ScreenPoint { y, x: u16::MAX })
}

fn last_cell(terminal: &Terminal) -> ScreenPoint {
    let total = u32::try_from(terminal.total_rows()).unwrap_or(u32::MAX);
    ScreenPoint {
        y: total.saturating_sub(1),
        x: terminal.cols().saturating_sub(1),
    }
}

#[cfg(test)]
mod tests;
