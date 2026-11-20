//! Hooks configuration: event → matcher groups → handlers, read from every settings layer and
//! merged (architecture section 6.3.1, ADR-0005).
//!
//! - Layers come highest precedence first. Each keeps its handlers; nothing is overridden.
//! - The same handler (same command, arguments, shell and condition) defined in more than one
//!   file runs once per event, with the settings of the highest-precedence copy.
//! - `disableAllHooks: true` (after merging) turns every hook off.
//! - What PiArc does not run is reported as a [`Diagnostic`] and never runs: events of later
//!   milestones, `http`, `prompt`, `mcp_tool` and `agent` handlers, `async` and `asyncRewake`
//!   handlers, and matchers its regular expressions cannot express.
//!
//! The caller decides which layers apply: an untrusted project's layers arrive without hooks
//! (`piarc-config` leaves them out of the merge).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::event::{HookEvent, LATER_EVENTS};
use crate::matcher::Matcher;

/// Where a handler is defined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    /// The settings layer id (`user`, `projectLocal`, `claudeProject`, …).
    pub layer: String,
    /// Its file.
    pub file: Option<PathBuf>,
}

/// One layer's `hooks` value.
#[derive(Debug, Clone)]
pub struct LayerHooks<'a> {
    /// The layer.
    pub source: Source,
    /// Its `hooks` object, when it has one.
    pub hooks: Option<&'a Value>,
}

/// Which shell runs a handler's command (the `shell` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Shell {
    /// `sh -c` on macOS, Git Bash on Windows (the default).
    Bash,
    /// PowerShell.
    PowerShell,
}

/// A `command` handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handler {
    /// The shell command, or the program in exec form.
    pub command: String,
    /// Exec form: arguments given to `command` without a shell.
    pub args: Option<Vec<String>>,
    /// `shell`, when set.
    pub shell: Option<Shell>,
    /// `timeout`.
    pub timeout: Option<Duration>,
    /// `if`: one permission rule a tool call must match.
    pub condition: Option<String>,
    /// `onFailure: "block"`: errors and timeouts block where the event can block.
    pub block_on_failure: bool,
    /// Where it is defined.
    pub source: Source,
    /// Its JSON Pointer in that file.
    pub pointer: String,
}

impl Handler {
    fn identity(&self) -> (&str, Option<&[String]>, Option<Shell>, Option<&str>) {
        (
            &self.command,
            self.args.as_deref(),
            self.shell,
            self.condition.as_deref(),
        )
    }
}

/// What a diagnostic is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticKind {
    /// An event PiArc runs from a later task.
    LaterEvent,
    /// An event name nobody defines.
    UnknownEvent,
    /// A handler type PiArc runs from a later task.
    UnsupportedType,
    /// A field PiArc does not honor; the handler does not run (`async`) or runs without it.
    UnsupportedField,
    /// A matcher that cannot be used; its group does not run.
    InvalidMatcher,
    /// A malformed group or handler; it does not run.
    Invalid,
}

/// A part of the configuration PiArc does not run as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// Where.
    pub source: Source,
    /// JSON Pointer in the file.
    pub pointer: String,
    /// What.
    pub kind: DiagnosticKind,
    /// Why, for the user.
    pub message: String,
}

#[derive(Debug, Clone)]
struct Entry {
    matcher: Matcher,
    handler: Arc<Handler>,
}

/// The parsed hooks of a workspace.
#[derive(Debug, Clone, Default)]
pub struct HookConfig {
    entries: BTreeMap<HookEvent, Vec<Entry>>,
    diagnostics: Vec<Diagnostic>,
    disabled: bool,
}

impl HookConfig {
    /// Parses `layers` (highest precedence first). `disable_all` is the merged
    /// `disableAllHooks`.
    #[must_use]
    pub fn parse(layers: &[LayerHooks<'_>], disable_all: bool) -> Self {
        let mut config = Self {
            disabled: disable_all,
            ..Self::default()
        };
        for layer in layers {
            let Some(hooks) = layer.hooks else { continue };
            let Some(events) = hooks.as_object() else {
                config.report(
                    &layer.source,
                    "/hooks",
                    DiagnosticKind::Invalid,
                    "hooks must be an object of events",
                );
                continue;
            };
            for (name, groups) in events {
                let pointer = format!("/hooks/{}", escape(name));
                match HookEvent::parse(name) {
                    Some(event) => config.parse_groups(&layer.source, event, groups, &pointer),
                    None => config.unknown_event(&layer.source, name, &pointer),
                }
            }
        }
        config
    }

    fn unknown_event(&mut self, source: &Source, name: &str, pointer: &str) {
        match LATER_EVENTS.iter().find(|(event, _)| *event == name) {
            Some((_, task)) => self.report(
                source,
                pointer,
                DiagnosticKind::LaterEvent,
                &format!("{name} hooks are not run yet ({task})"),
            ),
            None => self.report(
                source,
                pointer,
                DiagnosticKind::UnknownEvent,
                &format!("{name} is not a hook event"),
            ),
        }
    }

    fn parse_groups(&mut self, source: &Source, event: HookEvent, groups: &Value, pointer: &str) {
        let Some(groups) = groups.as_array() else {
            self.report(
                source,
                pointer,
                DiagnosticKind::Invalid,
                "an event takes a list of matcher groups",
            );
            return;
        };
        for (g, group) in groups.iter().enumerate() {
            let pointer = format!("{pointer}/{g}");
            let matcher_text = group.get("matcher").and_then(Value::as_str);
            let matcher = match Matcher::parse(matcher_text) {
                Ok(m) => m,
                Err(message) => {
                    self.report(
                        source,
                        &format!("{pointer}/matcher"),
                        DiagnosticKind::InvalidMatcher,
                        &message,
                    );
                    continue;
                }
            };
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                self.report(
                    source,
                    &pointer,
                    DiagnosticKind::Invalid,
                    "a matcher group needs a list of hooks",
                );
                continue;
            };
            for (h, value) in handlers.iter().enumerate() {
                let pointer = format!("{pointer}/hooks/{h}");
                if let Some(handler) = self.parse_handler(source, event, value, pointer) {
                    self.entries.entry(event).or_default().push(Entry {
                        matcher: matcher.clone(),
                        handler: Arc::new(handler),
                    });
                }
            }
        }
    }

    fn parse_handler(
        &mut self,
        source: &Source,
        event: HookEvent,
        value: &Value,
        pointer: String,
    ) -> Option<Handler> {
        let invalid = |this: &mut Self, message: &str| {
            this.report(source, &pointer, DiagnosticKind::Invalid, message);
            None
        };
        let Some(fields) = value.as_object() else {
            return invalid(self, "a hook must be an object");
        };
        match fields.get("type").and_then(Value::as_str) {
            Some("command") => {}
            Some(kind @ ("http" | "prompt")) => {
                return self.unsupported_type(source, &pointer, kind, "T38");
            }
            Some(kind @ "mcp_tool") => return self.unsupported_type(source, &pointer, kind, "T41"),
            Some(kind @ "agent") => {
                return self.unsupported_type(source, &pointer, kind, "unscheduled");
            }
            Some(other) => return invalid(self, &format!("unknown hook type {other:?}")),
            None => return invalid(self, "a hook needs a type"),
        }
        let command = match fields.get("command").and_then(Value::as_str) {
            Some(c) if !c.trim().is_empty() => c.to_owned(),
            _ => return invalid(self, "a command hook needs a command"),
        };
        for flag in ["async", "asyncRewake"] {
            if fields.get(flag) == Some(&Value::Bool(true)) {
                self.report(
                    source,
                    &format!("{pointer}/{flag}"),
                    DiagnosticKind::UnsupportedField,
                    &format!("{flag} hooks are not supported; this hook does not run"),
                );
                return None;
            }
        }
        if fields.contains_key("once") {
            self.report(
                source,
                &format!("{pointer}/once"),
                DiagnosticKind::UnsupportedField,
                "once applies to skill hooks only; it is ignored here",
            );
        }
        let condition = fields.get("if").and_then(Value::as_str).map(str::to_owned);
        if condition.is_some() && !event.is_tool_event() {
            self.report(
                source,
                &format!("{pointer}/if"),
                DiagnosticKind::UnsupportedField,
                &format!(
                    "if applies to tool events only; on {} this hook never runs",
                    event.name()
                ),
            );
            return None;
        }
        let options = match options(fields) {
            Ok(options) => options,
            Err(message) => return invalid(self, &message),
        };
        Some(Handler {
            command,
            args: options.args,
            shell: options.shell,
            timeout: options.timeout,
            condition,
            block_on_failure: options.block_on_failure,
            source: source.clone(),
            pointer,
        })
    }

    fn unsupported_type(
        &mut self,
        source: &Source,
        pointer: &str,
        kind: &str,
        task: &str,
    ) -> Option<Handler> {
        self.report(
            source,
            &format!("{pointer}/type"),
            DiagnosticKind::UnsupportedType,
            &format!("{kind} hooks are not run yet ({task})"),
        );
        None
    }

    fn report(&mut self, source: &Source, pointer: &str, kind: DiagnosticKind, message: &str) {
        self.diagnostics.push(Diagnostic {
            source: source.clone(),
            pointer: pointer.to_owned(),
            kind,
            message: message.to_owned(),
        });
    }

    /// The handlers to run for `event` with `value` as the matcher's subject (`None` for events
    /// without a matcher), in precedence order, each handler once.
    #[must_use]
    pub fn select(&self, event: HookEvent, value: Option<&str>) -> Vec<Arc<Handler>> {
        if self.disabled {
            return Vec::new();
        }
        let mut selected: Vec<Arc<Handler>> = Vec::new();
        for entry in self.entries.get(&event).into_iter().flatten() {
            let subject = value.unwrap_or("");
            // A `Bash` matcher also takes Monitor's commands (T32, Claude Code's semantics).
            let matched = !event.uses_matcher()
                || entry.matcher.matches(subject)
                || (event.is_tool_event() && subject == "Monitor" && entry.matcher.matches("Bash"));
            if matched
                && !selected
                    .iter()
                    .any(|h| h.identity() == entry.handler.identity())
            {
                selected.push(Arc::clone(&entry.handler));
            }
        }
        selected
    }

    /// Whether any handler is configured for `event` (before matching).
    #[must_use]
    pub fn has(&self, event: HookEvent) -> bool {
        !self.disabled && self.entries.get(&event).is_some_and(|e| !e.is_empty())
    }

    /// What PiArc does not run as written.
    #[must_use]
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Whether `disableAllHooks` turned everything off.
    #[must_use]
    pub fn disabled(&self) -> bool {
        self.disabled
    }
}

/// A command handler's optional fields.
struct Options {
    args: Option<Vec<String>>,
    shell: Option<Shell>,
    timeout: Option<Duration>,
    block_on_failure: bool,
}

fn options(fields: &serde_json::Map<String, Value>) -> Result<Options, String> {
    let args = match fields.get("args") {
        None => None,
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => Some(
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ),
        Some(_) => return Err("args must be a list of strings".into()),
    };
    let shell = match fields.get("shell").and_then(Value::as_str) {
        None => None,
        Some("bash") => Some(Shell::Bash),
        Some("powershell") => Some(Shell::PowerShell),
        Some(other) => return Err(format!("unknown shell {other:?}")),
    };
    let timeout = match fields.get("timeout") {
        None => None,
        Some(v) => match v.as_f64() {
            Some(secs) if secs.is_finite() && secs > 0.0 => {
                Some(Duration::from_secs_f64(secs.min(86_400.0)))
            }
            _ => return Err("timeout must be a positive number of seconds".into()),
        },
    };
    let block_on_failure = match fields.get("onFailure").and_then(Value::as_str) {
        None | Some("continue") => false,
        Some("block") => true,
        Some(other) => return Err(format!("unknown onFailure {other:?}")),
    };
    Ok(Options {
        args,
        shell,
        timeout,
        block_on_failure,
    })
}

/// A JSON Pointer token.
fn escape(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn source(layer: &str) -> Source {
        Source {
            layer: layer.into(),
            file: Some(PathBuf::from(format!("{layer}.json"))),
        }
    }

    fn parse(layers: &[(&str, Value)]) -> HookConfig {
        let layers: Vec<LayerHooks<'_>> = layers
            .iter()
            .map(|(layer, hooks)| LayerHooks {
                source: source(layer),
                hooks: Some(hooks),
            })
            .collect();
        HookConfig::parse(&layers, false)
    }

    fn commands(handlers: &[Arc<Handler>]) -> Vec<&str> {
        handlers.iter().map(|h| h.command.as_str()).collect()
    }

    #[test]
    fn layers_merge_and_a_handler_in_two_files_runs_once() {
        let shared = json!({"type": "command", "command": "lint.sh"});
        let config = parse(&[
            (
                "projectLocal",
                json!({"PreToolUse": [{"matcher": "Bash", "hooks": [shared.clone(), {"type": "command", "command": "local.sh", "timeout": 5}]}]}),
            ),
            (
                "user",
                json!({"PreToolUse": [{"matcher": "Bash|Edit", "hooks": [shared, {"type": "command", "command": "user.sh"}]}]}),
            ),
        ]);
        let bash = config.select(HookEvent::PreToolUse, Some("Bash"));
        assert_eq!(commands(&bash), ["lint.sh", "local.sh", "user.sh"]);
        assert_eq!(bash[0].source.layer, "projectLocal");
        assert_eq!(bash[1].timeout, Some(Duration::from_secs(5)));
        assert_eq!(
            commands(&config.select(HookEvent::PreToolUse, Some("Edit"))),
            ["lint.sh", "user.sh"]
        );
        assert!(
            config
                .select(HookEvent::PostToolUse, Some("Bash"))
                .is_empty()
        );
        assert!(config.diagnostics().is_empty());
    }

    #[test]
    fn events_without_a_matcher_ignore_it_and_disable_all_turns_everything_off() {
        let hooks =
            json!({"Stop": [{"matcher": "never", "hooks": [{"type": "command", "command": "a"}]}]});
        let config = parse(&[("user", hooks.clone())]);
        assert_eq!(commands(&config.select(HookEvent::Stop, None)), ["a"]);
        let off = HookConfig::parse(
            &[LayerHooks {
                source: source("user"),
                hooks: Some(&hooks),
            }],
            true,
        );
        assert!(off.select(HookEvent::Stop, None).is_empty());
        assert!(!off.has(HookEvent::Stop));
    }

    #[test]
    fn unsupported_parts_are_reported_and_do_not_run() {
        let config = parse(&[(
            "claudeProject",
            json!({
                "PreToolUse": [{"matcher": "^(?!Read)", "hooks": [{"type": "command", "command": "x"}]},
                    {"hooks": [
                        {"type": "command", "command": "bg", "async": true},
                        {"type": "http", "url": "https://example.invalid"},
                        {"type": "prompt", "prompt": "ok?"},
                        {"type": "mcp_tool", "server": "s", "tool": "t"},
                        {"type": "agent", "prompt": "check"},
                        {"type": "command", "command": "sync", "async": false, "once": true}
                    ]}],
                "SubagentStop": [],
                "BeforeEverything": [],
                "Stop": [{"hooks": [{"type": "command", "command": "c", "if": "Bash(*)"}]}]
            }),
        )]);
        assert_eq!(
            commands(&config.select(HookEvent::PreToolUse, Some("Bash"))),
            ["sync"]
        );
        assert!(config.select(HookEvent::Stop, None).is_empty());
        let kinds: Vec<(DiagnosticKind, &str)> = config
            .diagnostics()
            .iter()
            .map(|d| (d.kind, d.pointer.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (DiagnosticKind::UnknownEvent, "/hooks/BeforeEverything"),
                (
                    DiagnosticKind::InvalidMatcher,
                    "/hooks/PreToolUse/0/matcher"
                ),
                (
                    DiagnosticKind::UnsupportedField,
                    "/hooks/PreToolUse/1/hooks/0/async"
                ),
                (
                    DiagnosticKind::UnsupportedType,
                    "/hooks/PreToolUse/1/hooks/1/type"
                ),
                (
                    DiagnosticKind::UnsupportedType,
                    "/hooks/PreToolUse/1/hooks/2/type"
                ),
                (
                    DiagnosticKind::UnsupportedType,
                    "/hooks/PreToolUse/1/hooks/3/type"
                ),
                (
                    DiagnosticKind::UnsupportedType,
                    "/hooks/PreToolUse/1/hooks/4/type"
                ),
                (
                    DiagnosticKind::UnsupportedField,
                    "/hooks/PreToolUse/1/hooks/5/once"
                ),
                (DiagnosticKind::UnsupportedField, "/hooks/Stop/0/hooks/0/if"),
                (DiagnosticKind::LaterEvent, "/hooks/SubagentStop"),
            ]
        );
        assert!(config.diagnostics()[0].message.contains("not a hook event"));
        assert!(config.diagnostics()[1].message.contains("look-ahead"));
    }

    #[test]
    fn handler_fields_are_read() {
        let config = parse(&[(
            "user",
            json!({"PostToolUse": [{"matcher": "Write", "hooks": [{
                "type": "command", "command": "node", "args": ["fmt.js", "--fix"],
                "shell": "powershell", "timeout": 2.5, "if": "Write(src/**)", "onFailure": "block",
                "statusMessage": "Formatting"
            }]}]}),
        )]);
        let selected = config.select(HookEvent::PostToolUse, Some("Write"));
        let h = &selected[0];
        assert_eq!(
            h.args.as_deref(),
            Some(&["fmt.js".to_owned(), "--fix".to_owned()][..])
        );
        assert_eq!(h.shell, Some(Shell::PowerShell));
        assert_eq!(h.timeout, Some(Duration::from_millis(2500)));
        assert_eq!(h.condition.as_deref(), Some("Write(src/**)"));
        assert!(h.block_on_failure);
        assert_eq!(h.pointer, "/hooks/PostToolUse/0/hooks/0");
        let bad = parse(&[(
            "user",
            json!({"Stop": [{"hooks": [{"type": "command", "command": "x", "timeout": 0}, {"type": "command"}, "text"]}], "PreCompact": {}}),
        )]);
        assert!(bad.select(HookEvent::Stop, None).is_empty());
        assert_eq!(bad.diagnostics().len(), 4);
        assert!(
            bad.diagnostics()
                .iter()
                .all(|d| d.kind == DiagnosticKind::Invalid)
        );
    }

    #[test]
    fn a_bash_matcher_takes_monitor_commands_on_tool_events() {
        let config = parse(&[(
            "user",
            json!({
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash-hook"}]},
                    {"matcher": "Monitor", "hooks": [{"type": "command", "command": "monitor-hook"}]},
                    {"matcher": "Edit", "hooks": [{"type": "command", "command": "edit-hook"}]}
                ],
                "SessionStart": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "start-hook"}]}
                ]
            }),
        )]);
        assert_eq!(
            commands(&config.select(HookEvent::PreToolUse, Some("Monitor"))),
            ["bash-hook", "monitor-hook"]
        );
        assert_eq!(
            commands(&config.select(HookEvent::PreToolUse, Some("Bash"))),
            ["bash-hook"]
        );
        assert!(config.select(HookEvent::SessionStart, Some("Monitor")).is_empty());
    }
}
