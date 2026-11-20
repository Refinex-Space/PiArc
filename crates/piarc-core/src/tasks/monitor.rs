//! Monitor's pace (ADR-0049 rule 6): new lines become the session's waiting `monitorOutput`
//! notice; an idle session is woken at most once per [`TaskLimits::monitor_wake_interval`].

use super::feed::MonitorEnd;
use super::{Notice, StopBy, TaskManager, lock};
use piarc_protocol::context::ReminderType;

impl TaskManager {
    /// New complete lines of Monitor `task_id`.
    pub(crate) fn monitor_lines(&self, task_id: &str, lines: Vec<String>) {
        if lines.is_empty() {
            return;
        }
        {
            let keep = self.limits().monitor_buffer_lines;
            let mut state = lock(&self.inner.state);
            let Some(feed) = state.tasks.get_mut(task_id).and_then(|e| e.feed.as_mut()) else {
                return;
            };
            feed.push(lines, keep);
        }
        self.refresh_monitor(task_id);
    }

    pub(super) fn monitor_ended(&self, task_id: &str, end: MonitorEnd) {
        let session_gone = {
            let mut state = lock(&self.inner.state);
            let Some(entry) = state.tasks.get_mut(task_id) else {
                return;
            };
            let gone = matches!(entry.stop_by, Some(StopBy::Session | StopBy::Shutdown));
            if let Some(feed) = entry.feed.as_mut() {
                feed.ended(end);
            }
            gone
        };
        if !session_gone {
            self.refresh_monitor(task_id);
        }
    }

    /// Rebuilds the Monitor's waiting notice from what is undelivered and decides whether it
    /// wakes the session.
    pub(super) fn refresh_monitor(&self, task_id: &str) {
        let limits = *self.limits();
        let now = self.clock().now();
        let (session, arm) = {
            let mut guard = lock(&self.inner.state);
            let state = &mut *guard;
            let running = {
                let Some(entry) = state.tasks.get(task_id) else {
                    return;
                };
                state.running.contains(&entry.task.session_id)
            };
            let Some(entry) = state.tasks.get_mut(task_id) else {
                return;
            };
            let session = entry.task.session_id.clone();
            let output = entry.task.output_path.clone().unwrap_or_default();
            let Some(feed) = entry.feed.as_mut() else {
                return;
            };
            let key = format!("monitor:{task_id}");
            let Some(batch) = feed.batch(task_id, &output, &limits) else {
                if let Some(notices) = state.notices.get_mut(&session) {
                    notices.remove(&key);
                }
                return;
            };
            let mut wake = false;
            let mut arm = None;
            if !running {
                let due = feed
                    .last_wake
                    .is_none_or(|last| now >= last + limits.monitor_wake_interval);
                if due {
                    wake = true;
                    feed.last_wake = Some(now);
                } else if !feed.wake_armed {
                    feed.wake_armed = true;
                    let last = feed.last_wake.unwrap_or(now);
                    arm =
                        Some((last + limits.monitor_wake_interval).saturating_duration_since(now));
                }
            }
            feed.remember(&batch);
            let notice = Notice {
                key: key.clone(),
                source: batch.source,
                kind: ReminderType::MonitorOutput,
                text: batch.text,
                wake,
            };
            state
                .notices
                .entry(session.clone())
                .or_default()
                .insert(key, notice);
            (session, arm)
        };
        if let Some(after) = arm {
            let sleep = self.clock().sleep(after);
            let (manager, task_id) = (self.clone(), task_id.to_owned());
            tokio::spawn(async move {
                sleep.await;
                if let Some(feed) = lock(&manager.inner.state)
                    .tasks
                    .get_mut(&task_id)
                    .and_then(|e| e.feed.as_mut())
                {
                    feed.wake_armed = false;
                }
                manager.refresh_monitor(&task_id);
            });
        }
        if let Some(outlet) = self.inner.outlet.get() {
            outlet.notices_waiting(&session);
        }
    }
}
