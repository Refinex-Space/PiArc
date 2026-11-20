//! One task's entry in the manager: its record, output log, control and Monitor feed.

use std::path::PathBuf;

use piarc_protocol::context::ReminderType;
use piarc_protocol::exec::CommandOutcome;
use piarc_protocol::tasks::{BackgroundTask, TaskStatus};
use tokio::sync::watch;

use super::{Ended, Entry, Notice, StopBy, TaskLimits, feed, lock, record};

impl Entry {
    pub(super) fn ended(
        task: BackgroundTask,
        file: Option<PathBuf>,
        done: watch::Sender<bool>,
    ) -> Self {
        Self {
            file,
            task,
            log: None,
            cancel: None,
            done,
            feed: None,
            stop_by: None,
        }
    }

    pub(super) fn running_subagent(task: BackgroundTask, done: watch::Sender<bool>) -> Self {
        Self {
            task,
            log: None,
            file: None,
            cancel: None,
            done,
            feed: None,
            stop_by: None,
        }
    }

    /// The task with its current size and last lines.
    pub(super) fn view(&self, lines: usize, chars: usize) -> BackgroundTask {
        let mut task = self.task.clone();
        if let Some(log) = &self.log {
            let log = lock(log);
            task.output_bytes = log.bytes();
            task.tail = log
                .tail(lines)
                .into_iter()
                .map(|line| match line.char_indices().nth(chars) {
                    Some((at, _)) => format!("{}…", &line[..at]),
                    None => line,
                })
                .collect();
        }
        task
    }

    pub(super) fn finish(&mut self, ended: &Ended) {
        let task = &mut self.task;
        task.ended_at = Some(record::now_ms());
        task.exit_code = ended.exit_code;
        task.signal = ended.signal;
        if let Some(log) = &self.log {
            task.output_bytes = lock(log).bytes();
        }
        let (status, outcome, meaning) = match self.stop_by {
            Some(StopBy::Shutdown) => (TaskStatus::Interrupted, CommandOutcome::Failure, None),
            Some(StopBy::Timeout) => (
                TaskStatus::Completed,
                CommandOutcome::Success,
                Some(format!(
                    "timed out after {} s",
                    task.timeout_ms.unwrap_or(0) / 1000
                )),
            ),
            Some(StopBy::Model | StopBy::User | StopBy::Session) => {
                (TaskStatus::Killed, CommandOutcome::Failure, None)
            }
            None if ended.error.is_some() => (
                TaskStatus::Failed,
                CommandOutcome::Failure,
                ended.error.clone(),
            ),
            None if ended.success => (
                TaskStatus::Completed,
                CommandOutcome::Success,
                ended.meaning.clone(),
            ),
            None => (TaskStatus::Failed, CommandOutcome::Failure, None),
        };
        task.status = status;
        task.outcome = Some(outcome);
        task.meaning = meaning;
    }

    pub(super) fn completion(&self, limits: &TaskLimits) -> Notice {
        let tail = self
            .log
            .as_ref()
            .map(|log| lock(log).tail(limits.notice_tail_lines))
            .unwrap_or_default();
        Notice {
            key: format!("task:{}", self.task.task_id),
            source: self.task.task_id.clone(),
            kind: ReminderType::BackgroundTask,
            text: feed::completion_text(&self.task, &tail, limits),
            wake: false,
        }
    }
}
