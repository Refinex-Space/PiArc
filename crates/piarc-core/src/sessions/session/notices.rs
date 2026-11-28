//! Sends a session's waiting background-task notices to its Agent Host (T32, ADR-0049 rule 5):
//! each as `session/remind` with its key, so a resend replaces or is recognized as delivered.

use piarc_host::HostSupervisor;
use piarc_protocol::context::{SessionRemind, SessionRemindParams};
use piarc_protocol::session::SessionId;

use serde_json::Value;

use super::{SessionActor, SessionMsg};
use crate::tool_io::ToolIo;

/// Sends every notice waiting for session `id`; stops at the first failure (the session is not
/// open in the Agent Host yet, or the connection ended: the next open or restart sends them).
pub(crate) async fn deliver(supervisor: &HostSupervisor, id: &str, io: &ToolIo) {
    for notice in io.tasks().pending(id) {
        let wake = notice.wake && io.monitor_wake_allowed(id).await;
        let params = SessionRemindParams {
            session_id: SessionId(id.to_owned()),
            kind: notice.kind,
            source: notice.source.clone(),
            text: notice.text,
            key: Some(notice.key),
            wake,
        };
        match supervisor
            .session_call::<SessionRemind>(&SessionId(id.to_owned()), None, params)
            .await
        {
            Ok(result) if result.delivered => io.tasks().delivered(id, notice.kind, &notice.source),
            Ok(_) => {}
            Err(error) => {
                tracing::debug!(target: "piarc_core::sessions", session = %id,
                    "a background task notice waits: {error}");
                return;
            }
        }
    }
}

impl SessionActor {
    /// A reminder item reached the client: the background-task notices it carried were
    /// delivered (T32).
    pub(super) fn reminders_delivered(&self, item: &Value) {
        use piarc_protocol::context::ReminderType;
        let refs = item
            .get("reminders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for reminder in refs {
            let kind = match reminder.get("type").and_then(Value::as_str) {
                Some("backgroundTask") => ReminderType::BackgroundTask,
                Some("monitorOutput") => ReminderType::MonitorOutput,
                Some("browserState") => ReminderType::BrowserState,
                Some("browserVerify") => ReminderType::BrowserVerify,
                _ => continue,
            };
            if let Some(source) = reminder.get("source").and_then(Value::as_str) {
                self.ctx.tool_io.tasks().delivered(&self.id, kind, source);
            }
        }
    }

    /// Sends the waiting background-task notices, one round at a time.
    pub(super) fn send_notices(&mut self) {
        if self.notifying {
            self.notify_again = true;
            return;
        }
        if self.ctx.tool_io.tasks().pending(&self.id).is_empty() {
            return;
        }
        self.notifying = true;
        let (ws, tx, id, io) = (
            self.ws.clone(),
            self.tx.clone(),
            self.id.clone(),
            self.ctx.tool_io.clone(),
        );
        self.ctx.handle.spawn(async move {
            if let Some(supervisor) = ws.peek().await {
                deliver(&supervisor, &id, &io).await;
            }
            let _ = tx.send(SessionMsg::NoticesSent).await;
        });
    }
}
