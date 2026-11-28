//! The background task panel's requests on the session layer (T32, T33): stopping a task,
//! reading its output, opening a terminal for the user, and the task manager's way back in.

use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::{Ctx, Hub, Routes, lock};
use crate::error::{Error, Result};

impl Hub {
    /// The stop button of a background task (T32).
    pub async fn stop_task(&self, task_id: String) -> Result<Value> {
        let (task, stopped, tail) = self
            .ctx
            .tool_io
            .tasks()
            .stop(&task_id, crate::tasks::StopBy::User)
            .await
            .map_err(|e| Error::feature(&e))?;
        serde_json::to_value(piarc_protocol::tasks::TaskKillResult {
            task,
            stopped,
            tail,
        })
        .map_err(|e| Error::Internal {
            reason: format!("cannot encode the answer: {e}"),
        })
    }

    /// Opens a terminal for the user in open session `session_id` (T33): a background task
    /// of kind `terminal`; answers `{ terminalId, taskId, restored? }`.
    ///
    /// # Errors
    ///
    /// The session is not open; the terminal cannot start.
    pub async fn open_terminal(
        &self,
        session_id: String,
        request: crate::tool_io::UserTerminal,
    ) -> Result<Value> {
        let opened = self
            .ctx
            .tool_io
            .open_user_terminal(&session_id, request)
            .await
            .map_err(|e| Error::feature(&e))?;
        let restored = opened.restored.map(|how| match how {
            piarc_term::snapshot::Restored::Snapshot => "snapshot",
            piarc_term::snapshot::Restored::Replay => "replay",
            piarc_term::snapshot::Restored::Text => "text",
        });
        Ok(serde_json::json!({
            "terminalId": opened.terminal_id,
            "taskId": opened.task_id,
            "restored": restored,
        }))
    }

    /// Part of a background task's output (T32).
    pub async fn read_task_output(
        &self,
        task_id: String,
        offset: u64,
        length: Option<u64>,
    ) -> Result<Value> {
        let chunk = self
            .ctx
            .tool_io
            .tasks()
            .read(None, &task_id, offset, length)
            .await
            .map_err(|e| Error::feature(&e))?;
        serde_json::to_value(chunk).map_err(|e| Error::Internal {
            reason: format!("cannot encode the answer: {e}"),
        })
    }

    /// What the task manager reaches of the session layer (T32).
    pub(crate) fn task_outlet(&self) -> Arc<dyn crate::tasks::TaskOutlet> {
        Arc::new(HubOutlet {
            ctx: Arc::downgrade(&self.ctx),
            routes: Arc::downgrade(&self.routes),
        })
    }
}

/// The task manager's way into the session layer (T32): weak, so the manager the tool I/O
/// holds does not keep the hub alive.
struct HubOutlet {
    ctx: std::sync::Weak<Ctx>,
    routes: std::sync::Weak<Mutex<Routes>>,
}

impl crate::tasks::TaskOutlet for HubOutlet {
    fn notices_waiting(&self, session_id: &str) {
        let Some(routes) = self.routes.upgrade() else {
            return;
        };
        let session = lock(&routes).sessions.get(session_id).cloned();
        if let Some(session) = session {
            session.notices_waiting();
        }
    }

    fn stop_subagent(
        &self,
        owner: &str,
        child: &str,
    ) -> piarc_ports::BoxFuture<'static, std::result::Result<(), piarc_protocol::ErrorObject>> {
        let hub = match (self.ctx.upgrade(), self.routes.upgrade()) {
            (Some(ctx), Some(routes)) => Some(Hub { ctx, routes }),
            _ => None,
        };
        let (owner, child) = (owner.to_owned(), child.to_owned());
        Box::pin(async move {
            let Some(hub) = hub else {
                return Ok(());
            };
            hub.stop_subagent(owner, child)
                .await
                .map(drop)
                .map_err(|e| e.to_error_object())
        })
    }
}
