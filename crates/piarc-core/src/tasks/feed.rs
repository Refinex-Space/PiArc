//! What the model reads about background tasks (ADR-0049 rules 5 and 6): the completion notice
//! of a command, and a Monitor's batches of new lines with their limits. Pure functions and the
//! Monitor's line buffer; the task manager decides when they are sent.

use std::collections::VecDeque;
use std::time::Instant;

use piarc_protocol::tasks::{BackgroundTask, TaskStatus};

use super::limits::TaskLimits;

/// The `backgroundTask` reminder of a command that ended: id, command, how it ended, how long
/// it ran, where its output is and its last lines.
pub(super) fn completion_text(
    task: &BackgroundTask,
    tail: &[String],
    limits: &TaskLimits,
) -> String {
    let command = task.command.as_deref().unwrap_or(&task.title);
    let mut lines = vec![
        format!("Background task {} has ended.", task.task_id),
        format!("Command: {command}"),
        format!("Status: {}", status_words(task)),
    ];
    if let Some(ended) = task.ended_at {
        lines.push(format!(
            "Ran for: {}",
            duration_words(ended.saturating_sub(task.started_at))
        ));
    }
    if let Some(path) = &task.output_path {
        lines.push(format!(
            "Output: {path} ({} bytes); read it with Read.",
            task.output_bytes
        ));
    }
    let preview = preview(tail, limits.notice_tail_lines, limits.notice_tail_chars);
    if preview.is_empty() {
        lines.push("It printed nothing.".to_owned());
    } else {
        lines.push("Last lines:".to_owned());
        lines.push(preview);
    }
    lines.join("\n")
}

fn status_words(task: &BackgroundTask) -> String {
    let code = match (task.exit_code, task.signal) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        (None, None) => String::new(),
    };
    let detail = match (&task.meaning, code.is_empty()) {
        (Some(meaning), false) => format!(" ({code}: {meaning})"),
        (Some(meaning), true) => format!(" ({meaning})"),
        (None, false) => format!(" ({code})"),
        (None, true) => String::new(),
    };
    let words = match task.status {
        TaskStatus::Running => "still running",
        TaskStatus::Completed => "completed successfully",
        TaskStatus::Failed => "failed",
        TaskStatus::Killed => "stopped by the user",
        TaskStatus::Interrupted => "interrupted",
    };
    format!("{words}{detail}")
}

/// `ms` as seconds with one decimal below a minute, else minutes and seconds.
pub(super) fn duration_words(ms: u64) -> String {
    if ms < 60_000 {
        // Integer arithmetic: tenths of a second.
        let tenths = ms / 100;
        format!("{}.{} s", tenths / 10, tenths % 10)
    } else {
        let seconds = ms / 1000;
        format!("{} min {} s", seconds / 60, seconds % 60)
    }
}

/// The last lines of `tail` that fit in `max_lines` and `max_chars`, joined.
pub(super) fn preview(tail: &[String], max_lines: usize, max_chars: usize) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut chars = 0;
    for line in tail.iter().rev().take(max_lines) {
        let count = line.chars().count() + 1;
        if chars + count > max_chars && !kept.is_empty() {
            break;
        }
        chars += count;
        kept.push(line);
    }
    kept.reverse();
    let joined = kept.join("\n");
    match joined.char_indices().nth(max_chars) {
        Some((at, _)) => format!("…{}", &joined[at..]),
        None => joined,
    }
}

/// How a Monitor's command ended, for its last batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MonitorEnd {
    /// It exited (code, or signal).
    Exited(String),
    /// Its timeout passed.
    TimedOut(u64),
    /// `KillShell` or the stop button.
    Stopped,
}

/// One batch ready to send: its text, its reminder source and how far it reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Batch {
    pub text: String,
    /// `<task id>@<last line number>`, with `/end` when it carries the end.
    pub source: String,
    pub upto: u64,
    pub chars: usize,
    /// Delivering it reaches the total limit: the Monitor stops feeding afterwards.
    pub last: bool,
}

/// A Monitor's lines not yet delivered and its counters.
#[derive(Debug)]
pub(super) struct MonitorFeed {
    pub description: String,
    /// Undelivered lines with their numbers (1-based), oldest first.
    buffer: VecDeque<(u64, String)>,
    /// Lines seen so far.
    seen: u64,
    /// Lines up to this number reached the model (or were summarized as omitted).
    delivered: u64,
    delivered_chars: usize,
    /// The total limit was reached: nothing more is sent.
    pub stopped: bool,
    end: Option<MonitorEnd>,
    end_delivered: bool,
    /// When the session was last woken for this Monitor.
    pub last_wake: Option<Instant>,
    /// A wake is scheduled.
    pub wake_armed: bool,
    /// Batches sent and not yet acknowledged: source → (characters, reaches the limit).
    sent: std::collections::HashMap<String, (usize, bool)>,
}

impl MonitorFeed {
    pub fn new(description: String) -> Self {
        Self {
            description,
            buffer: VecDeque::new(),
            seen: 0,
            delivered: 0,
            delivered_chars: 0,
            stopped: false,
            end: None,
            end_delivered: false,
            last_wake: None,
            wake_armed: false,
            sent: std::collections::HashMap::new(),
        }
    }

    /// `batch` is about to be sent; its delivery is acknowledged by its source.
    pub fn remember(&mut self, batch: &Batch) {
        self.sent
            .insert(batch.source.clone(), (batch.chars, batch.last));
    }

    /// The batch with `source` (reaching line `upto`, with the end when `end`) reached the
    /// model.
    pub fn acknowledge(&mut self, source: &str, upto: u64, end: bool) {
        let (chars, last) = self.sent.get(source).copied().unwrap_or((0, false));
        self.delivered(upto, end, chars, last);
        let delivered = self.delivered;
        self.sent
            .retain(|s, _| parse_source(s).is_some_and(|(_, n, _)| n > delivered));
    }

    /// Takes new lines; beyond `keep` undelivered lines the oldest are dropped (they count as
    /// omitted in the next batch).
    pub fn push(&mut self, lines: Vec<String>, keep: usize) {
        for line in lines {
            self.seen += 1;
            self.buffer.push_back((self.seen, line));
        }
        while self.buffer.len() > keep.max(1) {
            self.buffer.pop_front();
        }
    }

    pub fn ended(&mut self, end: MonitorEnd) {
        self.end = Some(end);
    }

    /// Whether something waits for the model.
    pub fn has_news(&self) -> bool {
        !self.stopped && (self.seen > self.delivered || (self.end.is_some() && !self.end_delivered))
    }

    /// The batch of everything undelivered, within the limits; `None` when nothing waits.
    pub fn batch(&self, task_id: &str, output: &str, limits: &TaskLimits) -> Option<Batch> {
        if !self.has_news() {
            return None;
        }
        let remaining = limits
            .monitor_total_chars
            .saturating_sub(self.delivered_chars);
        let budget = limits.monitor_batch_chars.min(remaining);
        let fresh: Vec<&(u64, String)> = self
            .buffer
            .iter()
            .filter(|(n, _)| *n > self.delivered)
            .collect();
        // The newest lines that fit; the ones before them are summarized.
        let mut kept: Vec<&str> = Vec::new();
        let mut chars = 0;
        for (_, line) in fresh.iter().rev().take(limits.monitor_batch_lines) {
            let count = line.chars().count() + 1;
            if chars + count > budget {
                break;
            }
            chars += count;
            kept.push(line);
        }
        kept.reverse();
        let new_lines = self.seen - self.delivered;
        let omitted = new_lines - kept.len() as u64;
        let mut text = vec![format!(
            "Monitor {task_id} ({}): {new_lines} new line{}.",
            self.description,
            if new_lines == 1 { "" } else { "s" }
        )];
        if omitted > 0 {
            text.push(format!(
                "[{omitted} earlier line{} left out; the full output is in {output}.]",
                if omitted == 1 { "" } else { "s" }
            ));
        }
        text.extend(kept.iter().map(|l| (*l).to_owned()));
        let last = self.delivered_chars + chars >= limits.monitor_total_chars
            || (omitted > 0 && remaining <= limits.monitor_batch_chars);
        let with_end = self.end.as_ref().filter(|_| !last);
        if let Some(end) = with_end {
            text.push(end_words(end));
        }
        if last {
            text.push(format!(
                "This Monitor reached its limit of {} characters for you; its further output is \
                 not sent. Task {task_id} keeps running until it ends (stop it with KillShell), \
                 and its output keeps going to {output}.",
                limits.monitor_total_chars
            ));
        }
        Some(Batch {
            text: text.join("\n"),
            source: format!(
                "{task_id}@{}{}",
                self.seen,
                if with_end.is_some() { "/end" } else { "" }
            ),
            upto: self.seen,
            chars,
            last,
        })
    }

    /// The batch ending at `upto` (and the end, when `end`) reached the model.
    pub fn delivered(&mut self, upto: u64, end: bool, chars: usize, last: bool) {
        if upto > self.delivered {
            self.delivered = upto;
            self.delivered_chars += chars;
        }
        while self
            .buffer
            .front()
            .is_some_and(|(n, _)| *n <= self.delivered)
        {
            self.buffer.pop_front();
        }
        if end {
            self.end_delivered = true;
        }
        if last {
            self.stopped = true;
        }
    }
}

fn end_words(end: &MonitorEnd) -> String {
    match end {
        MonitorEnd::Exited(how) => format!("The monitored command has ended ({how})."),
        MonitorEnd::TimedOut(seconds) => {
            format!("The Monitor reached its timeout of {seconds} s; its command was stopped.")
        }
        MonitorEnd::Stopped => "The Monitor was stopped.".to_owned(),
    }
}

/// Parses a reminder source `<task id>@<line>[/end]`.
pub(super) fn parse_source(source: &str) -> Option<(&str, u64, bool)> {
    let (task, rest) = source.split_once('@')?;
    let (number, end) = match rest.strip_suffix("/end") {
        Some(number) => (number, true),
        None => (rest, false),
    };
    Some((task, number.parse().ok()?, end))
}

#[cfg(test)]
mod tests {
    use piarc_protocol::tasks::TaskKind;

    use super::*;

    fn limits() -> TaskLimits {
        TaskLimits {
            monitor_batch_lines: 3,
            monitor_batch_chars: 40,
            monitor_total_chars: 100,
            ..TaskLimits::default()
        }
    }

    fn lines(range: std::ops::RangeInclusive<u32>) -> Vec<String> {
        range.map(|i| format!("line {i}")).collect()
    }

    #[test]
    fn a_batch_carries_the_newest_lines_and_counts_the_rest_as_omitted() {
        let mut feed = MonitorFeed::new("日志".into());
        feed.push(lines(1..=2), 100);
        let first = feed.batch("bg-1", "/o.log", &limits()).expect("batch");
        assert_eq!(
            first.text,
            "Monitor bg-1 (日志): 2 new lines.\nline 1\nline 2"
        );
        assert_eq!(
            (first.source.as_str(), first.upto, first.last),
            ("bg-1@2", 2, false)
        );
        feed.delivered(first.upto, false, first.chars, first.last);
        assert!(!feed.has_news());
        feed.push(lines(3..=9), 100);
        let second = feed.batch("bg-1", "/o.log", &limits()).expect("batch");
        assert_eq!(
            second.text,
            "Monitor bg-1 (日志): 7 new lines.\n\
             [4 earlier lines left out; the full output is in /o.log.]\nline 7\nline 8\nline 9"
        );
        assert_eq!(second.source, "bg-1@9");
    }

    #[test]
    fn the_total_limit_ends_the_feed_with_a_note() {
        let mut feed = MonitorFeed::new("ci".into());
        let mut sent = 0;
        for round in 0..10_u32 {
            feed.push(lines(round * 3 + 1..=round * 3 + 3), 100);
            let Some(batch) = feed.batch("bg-2", "/o.log", &limits()) else {
                break;
            };
            sent += 1;
            feed.delivered(batch.upto, false, batch.chars, batch.last);
            if batch.last {
                assert!(batch.text.contains("reached its limit of 100 characters"));
                break;
            }
        }
        assert!(feed.stopped, "after {sent} batches");
        feed.push(lines(100..=101), 100);
        assert_eq!(feed.batch("bg-2", "/o.log", &limits()), None);
    }

    #[test]
    fn the_end_is_told_once_and_the_buffer_is_bounded() {
        let mut feed = MonitorFeed::new("watch".into());
        feed.push(lines(1..=10), 4);
        feed.ended(MonitorEnd::Exited("exit code 0".into()));
        let batch = feed.batch("bg-3", "/o.log", &limits()).expect("batch");
        assert!(
            batch
                .text
                .ends_with("The monitored command has ended (exit code 0).")
        );
        assert!(batch.text.contains("[7 earlier lines left out"));
        assert_eq!(parse_source(&batch.source), Some(("bg-3", 10, true)));
        feed.delivered(10, true, batch.chars, batch.last);
        assert!(!feed.has_news());
    }

    #[test]
    fn completion_text_names_the_task_status_and_output() {
        let task = BackgroundTask {
            task_id: "bg-0a".into(),
            session_id: "s".into(),
            owner_session_id: "s".into(),
            workspace: "/w".into(),
            kind: TaskKind::Command,
            title: "make".into(),
            command: Some("make test".into()),
            agent_type: None,
            subagent_session_id: None,
            tool_call_id: None,
            cwd: "/w".into(),
            status: TaskStatus::Failed,
            started_at: 1_000,
            ended_at: Some(3_500),
            exit_code: Some(3),
            signal: None,
            outcome: None,
            meaning: None,
            timeout_ms: None,
            output_path: Some("/d/tasks/bg-0a.log".into()),
            output_bytes: 12,
            tail: Vec::new(),
        };
        let text = completion_text(&task, &["ok".into(), "boom".into()], &TaskLimits::default());
        assert_eq!(
            text,
            "Background task bg-0a has ended.\nCommand: make test\nStatus: failed (exit code 3)\n\
             Ran for: 2.5 s\nOutput: /d/tasks/bg-0a.log (12 bytes); read it with Read.\n\
             Last lines:\nok\nboom"
        );
        assert_eq!(duration_words(125_000), "2 min 5 s");
        assert_eq!(
            preview(&["a".repeat(30)], 10, 10),
            format!("…{}", "a".repeat(20))
        );
    }
}
