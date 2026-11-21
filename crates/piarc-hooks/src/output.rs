//! What one handler's exit code, stdout and stderr say (Claude Code's protocol):
//!
//! - exit 0: stdout that is exactly one JSON object (only whitespace around it) is read field by
//!   field; any other stdout is plain text. Output that starts with `{` and ends with `}` but is
//!   not valid JSON, or a `hookSpecificOutput` for another event, is an error.
//! - exit 2: a blocking error. The reason is stderr, unless stdout's JSON gives one; that JSON is
//!   still read.
//! - any other exit, a timeout, a start failure: a non-blocking error (the action continues and
//!   the user is told), unless the handler says `onFailure: "block"`.
//!
//! `http` and `prompt` handlers have no exit code: the runner gives their answer as the JSON
//! object a command would print ([`RunStatus::Replied`]) or as a non-blocking error
//! ([`RunStatus::Failed`]).

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::config::Handler;
use crate::event::HookEvent;
use crate::runner::{Detail, HandlerRun, RunStatus};

/// How the handler ended, as the protocol reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Exit 0.
    Success,
    /// Exit 2: the reason.
    Blocking(String),
    /// A non-blocking error: the message for the user.
    Error(String),
}

/// One handler's result.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// The handler.
    pub handler: Arc<Handler>,
    /// The protocol's reading.
    pub kind: Kind,
    /// Stdout's JSON object (exit 0 or 2).
    pub json: Option<Map<String, Value>>,
    /// Plain stdout (exit 0, not JSON, not empty).
    pub text: Option<String>,
    /// The exit code, when the process exited normally.
    pub exit_code: Option<i32>,
    /// Stopped at its timeout.
    pub timed_out: bool,
    /// Stopped because the event was cancelled.
    pub cancelled: bool,
    /// How long it ran, in milliseconds.
    pub duration_ms: u64,
    /// The `http` status or the `prompt` model, for the audit.
    pub detail: Detail,
}

impl Outcome {
    /// Reads `run` for `event`.
    #[must_use]
    pub fn read(event: HookEvent, run: HandlerRun) -> Self {
        let duration_ms = u64::try_from(run.duration.as_millis()).unwrap_or(u64::MAX);
        let mut outcome = Self {
            handler: run.handler,
            kind: Kind::Success,
            json: None,
            text: None,
            exit_code: None,
            timed_out: false,
            cancelled: false,
            duration_ms,
            detail: run.detail,
        };
        let name = event.name();
        match run.status {
            RunStatus::Exited(status) => {
                outcome.exit_code = status.code;
                match status.code {
                    Some(0) => outcome.read_stdout(event, &run.stdout),
                    Some(2) => {
                        let json = match parse_stdout(event, &run.stdout) {
                            Ok(Stdout::Json(json)) => Some(json),
                            _ => None,
                        };
                        let reason = json
                            .as_ref()
                            .and_then(|j| j.get("reason"))
                            .and_then(Value::as_str)
                            .filter(|r| !r.trim().is_empty())
                            .map_or_else(|| run.stderr.trim().to_owned(), str::to_owned);
                        outcome.json = json;
                        outcome.kind = Kind::Blocking(reason);
                    }
                    Some(code) => {
                        outcome.kind = Kind::Error(error_text(
                            name,
                            &format!("exited with code {code}"),
                            &run.stderr,
                        ));
                    }
                    None => {
                        let how = status
                            .signal
                            .map_or_else(|| "ended".to_owned(), |s| format!("ended by signal {s}"));
                        outcome.kind = Kind::Error(error_text(name, &how, &run.stderr));
                    }
                }
            }
            RunStatus::TimedOut(after) => {
                outcome.timed_out = true;
                outcome.kind = Kind::Error(format!(
                    "{name} hook error: timed out after {} s",
                    after.as_secs_f64()
                ));
            }
            RunStatus::Cancelled => {
                outcome.cancelled = true;
                outcome.kind =
                    Kind::Error(format!("{name} hook stopped: the session was interrupted"));
            }
            RunStatus::NotStarted(reason) | RunStatus::Failed(reason) => {
                outcome.kind = Kind::Error(format!("{name} hook error: {reason}"));
            }
            RunStatus::Answered(text) => outcome.read_stdout(event, &text),
            RunStatus::Replied(json) => {
                outcome.exit_code = None;
                outcome.json = (!json.is_empty()).then_some(json);
            }
        }
        outcome
    }

    /// Reads the stdout of a success (exit 0, or an `mcp_tool` handler's text).
    fn read_stdout(&mut self, event: HookEvent, stdout: &str) {
        match parse_stdout(event, stdout) {
            Ok(Stdout::Json(json)) => self.json = Some(json),
            Ok(Stdout::Text(text)) => self.text = text,
            Err(message) => {
                self.kind = Kind::Error(format!("{} hook error: {message}", event.name()));
            }
        }
    }

    /// The `hookSpecificOutput` object.
    #[must_use]
    pub fn specific(&self) -> Option<&Map<String, Value>> {
        self.json
            .as_ref()?
            .get("hookSpecificOutput")
            .and_then(Value::as_object)
    }

    /// A string field of the top-level JSON.
    #[must_use]
    pub fn field(&self, key: &str) -> Option<&str> {
        self.json.as_ref()?.get(key).and_then(Value::as_str)
    }

    /// A string field of `hookSpecificOutput`.
    #[must_use]
    pub fn specific_field(&self, key: &str) -> Option<&str> {
        self.specific()?.get(key).and_then(Value::as_str)
    }

    /// Whether the JSON says `continue: false`.
    #[must_use]
    pub fn stops(&self) -> bool {
        self.json.as_ref().and_then(|j| j.get("continue")) == Some(&Value::Bool(false))
    }
}

/// The first line of stderr, after what happened.
fn error_text(event: &str, what: &str, stderr: &str) -> String {
    match stderr.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => format!("{event} hook error: {what}: {line}"),
        None => format!("{event} hook error: {what}"),
    }
}

enum Stdout {
    Json(Map<String, Value>),
    Text(Option<String>),
}

/// A `hookSpecificOutput` must name `event`.
pub(crate) fn check_specific(event: HookEvent, json: &Map<String, Value>) -> Result<(), String> {
    if let Some(specific) = json.get("hookSpecificOutput") {
        let name = specific
            .as_object()
            .and_then(|s| s.get("hookEventName"))
            .and_then(Value::as_str);
        if name != Some(event.name()) {
            return Err(format!(
                "hookSpecificOutput.hookEventName must be {:?}",
                event.name()
            ));
        }
    }
    Ok(())
}

fn parse_stdout(event: HookEvent, stdout: &str) -> Result<Stdout, String> {
    let trimmed = stdout.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        let json: Map<String, Value> = serde_json::from_str(trimmed)
            .map_err(|e| format!("its output is not valid JSON: {e}"))?;
        check_specific(event, &json)?;
        return Ok(Stdout::Json(json));
    }
    Ok(Stdout::Text(
        (!trimmed.is_empty()).then(|| stdout.trim_end().to_owned()),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use piarc_ports::ExitStatus;

    use super::*;
    use crate::config::Source;

    pub(crate) fn handler() -> Arc<Handler> {
        Arc::new(Handler {
            action: crate::config::Action::Command(crate::config::Command {
                command: "hook".into(),
                args: None,
                shell: None,
            }),
            timeout: None,
            condition: None,
            block_on_failure: false,
            source: Source {
                layer: "user".into(),
                file: Some(PathBuf::from("settings.json")),
            },
            pointer: "/hooks/Stop/0/hooks/0".into(),
        })
    }

    fn exited(code: i32, stdout: &str, stderr: &str) -> HandlerRun {
        HandlerRun {
            handler: handler(),
            status: RunStatus::Exited(ExitStatus {
                code: Some(code),
                signal: None,
            }),
            stdout: stdout.into(),
            stderr: stderr.into(),
            duration: Duration::from_millis(7),
            detail: crate::runner::Detail::Process,
        }
    }

    #[test]
    fn exit_zero_reads_one_json_object_or_plain_text() {
        let json = Outcome::read(
            HookEvent::Stop,
            exited(0, "  {\"decision\":\"block\",\"reason\":\"r\"}\n", ""),
        );
        assert_eq!(json.kind, Kind::Success);
        assert_eq!(json.field("decision"), Some("block"));
        let text = Outcome::read(HookEvent::SessionStart, exited(0, "[1, 2]\n", ""));
        assert_eq!(text.text.as_deref(), Some("[1, 2]"));
        let partial = Outcome::read(HookEvent::SessionStart, exited(0, "{ not closed", ""));
        assert_eq!(partial.text.as_deref(), Some("{ not closed"));
        let empty = Outcome::read(HookEvent::SessionStart, exited(0, " \n", ""));
        assert_eq!(empty.text, None);
        assert_eq!(empty.duration_ms, 7);
    }

    #[test]
    fn invalid_json_and_a_foreign_event_name_are_errors() {
        let broken = Outcome::read(HookEvent::Stop, exited(0, "{ \"a\": }", ""));
        assert!(
            matches!(&broken.kind, Kind::Error(m) if m.starts_with("Stop hook error: its output is not valid JSON"))
        );
        let foreign = Outcome::read(
            HookEvent::PreToolUse,
            exited(
                0,
                r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse"}}"#,
                "",
            ),
        );
        assert!(matches!(&foreign.kind, Kind::Error(m) if m.contains("\"PreToolUse\"")));
    }

    #[test]
    fn exit_two_blocks_with_stderr_unless_json_gives_a_reason() {
        let plain = Outcome::read(HookEvent::PreToolUse, exited(2, "", "  no rm\n"));
        assert_eq!(plain.kind, Kind::Blocking("no rm".into()));
        let json = Outcome::read(
            HookEvent::Stop,
            exited(2, r#"{"reason":"from json"}"#, "from stderr"),
        );
        assert_eq!(json.kind, Kind::Blocking("from json".into()));
    }

    #[test]
    fn other_exits_timeouts_and_start_failures_are_errors_for_the_user() {
        let one = Outcome::read(HookEvent::PostToolUse, exited(1, "", "\nlint failed\nmore"));
        assert_eq!(
            one.kind,
            Kind::Error("PostToolUse hook error: exited with code 1: lint failed".into())
        );
        let timeout = Outcome::read(
            HookEvent::UserPromptSubmit,
            HandlerRun {
                status: RunStatus::TimedOut(Duration::from_secs(30)),
                ..exited(0, "", "")
            },
        );
        assert!(timeout.timed_out);
        assert_eq!(
            timeout.kind,
            Kind::Error("UserPromptSubmit hook error: timed out after 30 s".into())
        );
        let missing = Outcome::read(
            HookEvent::Stop,
            HandlerRun {
                status: RunStatus::NotStarted("no such shell".into()),
                ..exited(0, "", "")
            },
        );
        assert_eq!(
            missing.kind,
            Kind::Error("Stop hook error: no such shell".into())
        );
    }
}
