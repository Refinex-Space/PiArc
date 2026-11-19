//! Runtime entry points for session commands and workspace actors.
use super::{CoreRuntime, encode_error};
use crate::error::{Error, Result};
use crate::sessions::{Hub, Op};
use std::{future::Future, path::PathBuf};
impl CoreRuntime {
    /// Runs `job` on the session layer and calls `on_done` with its result from a runtime
    /// thread. Validation that needs no I/O happens in `job` too, but the call itself only
    /// queues the work: nothing here blocks the caller (architecture section 7.2).
    fn on_sessions<F, Fut>(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
        job: F,
    ) -> Result<()>
    where
        F: FnOnce(Hub) -> Fut + Send + 'static,
        Fut: Future<Output = Result<serde_json::Value>> + Send + 'static,
    {
        self.ensure_running()?;
        let hub = self.services()?.sessions;
        self.shared
            .handle
            .spawn(async move { on_done(job(hub).await) });
        Ok(())
    }

    /// Opens a workspace: starts its Agent Host at once and answers once it is ready (the
    /// workspace as in `core/workspaces`).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`]; the rest goes to `on_done`.
    pub fn open_workspace(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            let view = hub.open_workspace(path).await?;
            serde_json::to_value(view).map_err(encode_error)
        })
    }

    /// Closes a workspace: its sessions and its Agent Host.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn close_workspace(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.close_workspace(path).await?;
            Ok(serde_json::Value::Null)
        })
    }

    /// Runs a provider setting operation through the dedicated settings Agent Host.
    ///
    /// # Errors
    /// As [`Self::open_workspace`].
    pub fn provider_op(
        &self,
        operation: crate::providers::Operation,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.provider_op(operation).await
        })
    }

    /// Lists models for a workspace, even before its first session.
    ///
    /// # Errors
    /// As [`Self::open_workspace`].
    pub fn workspace_models(
        &self,
        path: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.workspace_models(path).await
        })
    }

    /// Creates a session in `workspace` (opened when needed), working in `cwd` (default: the
    /// workspace), optionally with a model.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn create_session(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<piarc_protocol::session::ModelRef>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.create_session_with_mode(workspace, cwd, model, None, on_done)
    }

    /// Creates a session with an explicit starting permission mode.
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn create_session_with_mode(
        &self,
        workspace: PathBuf,
        cwd: Option<PathBuf>,
        model: Option<piarc_protocol::session::ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.create_session(workspace, cwd, model, mode).await
        })
    }

    /// Answers the request identified by its session, revision and connection epoch.
    ///
    /// # Errors
    /// As [`Self::session_op`].
    /// The configuration diagnostics of a workspace, the most recent one when `None` (T24).
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn config_diagnostics(
        &self,
        workspace: Option<PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.config_diagnostics(workspace).await
        })
    }

    /// The permission rules of a workspace by source (T23).
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn permission_rules(
        &self,
        workspace: Option<PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.permission_view(workspace).await
        })
    }

    /// Change one permission rule of a writable settings file (T23).
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn update_permission_rule(
        &self,
        change_json: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.update_permission_rule(change_json).await
        })
    }

    /// Permission audit events (T23).
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn audit_events(
        &self,
        query_json: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.audit_events(query_json).await
        })
    }

    /// Whether `rule` parses for `behavior` (`allow`, `ask`, `deny`) and whether it is broad.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] for an unknown list.
    pub fn check_permission_rule(&self, rule: &str, behavior: &str) -> Result<serde_json::Value> {
        let behavior = serde_json::from_value(serde_json::Value::String(behavior.to_owned()))
            .map_err(|_| Error::InvalidArgument {
                field: "behavior",
                reason: "behavior must be allow, ask or deny".into(),
            })?;
        Ok(crate::tool_io::policy::settings_view::check_rule(
            rule, behavior,
        ))
    }

    pub fn answer_approval(
        &self,
        answer: piarc_protocol::policy::ApprovalAnswer,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.answer_approval(answer).await
        })
    }

    /// Reopens a session from the index and its file.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn resume_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.resume_session(id).await },
        )
    }

    /// Opens a copy of a session (up to `entry_id`) as a new session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn fork_session(
        &self,
        id: String,
        entry_id: Option<String>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.fork_session(id, entry_id).await
        })
    }

    /// Closes an open session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn close_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.close_session(id).await },
        )
    }

    /// Runs `op` (prompt, steer, follow-up, abort, a queue change, mark read) on an open
    /// session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn session_op(
        &self,
        id: String,
        op: Op,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            match op {
                Op::MarkRead => hub.mark_read(id).await?,
                // Open or not: the hub writes the index for sessions that are not open.
                Op::Prefs(change) => hub.set_prefs(id, change).await?,
                op => return hub.op(id, op).await,
            }
            Ok(serde_json::Value::Null)
        })
    }

    /// The title and workspace recorded for the native deletion dialog.
    ///
    /// # Errors
    ///
    /// Invalid id or a failure reading the session index.
    pub fn session_deletion_target(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.ensure_running()?;
        let storage = self.storage()?;
        self.shared.handle.spawn(async move {
            let result = storage
                .run(move |db| {
                    let record = db.session(&id)?;
                    Ok::<_, piarc_store::Error>(serde_json::json!({
                        "title":record.as_ref().and_then(|r|r.title()),
                        "workspace":record.as_ref().and_then(|r|r.workspace_path.as_deref()),
                    }))
                })
                .await
                .and_then(|r| r.map_err(Error::from));
            on_done(result);
        });
        Ok(())
    }

    /// Deletes a session: closes it when open, then removes its Pi session file, its
    /// temporary directory and its index rows (architecture section 9.3). The client confirms
    /// first; Core does not ask.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn delete_session(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.delete_session(id).await?;
            Ok(serde_json::Value::Null)
        })
    }

    /// Items of a session's conversation: `start .. start + limit`, or the last `limit`.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn transcript_window(
        &self,
        id: String,
        start: Option<u64>,
        limit: u64,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.transcript_window(id, start, limit).await
        })
    }

    /// Stores an attachment for open session `id` and answers with its description (ADR-0030).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn store_attachment(
        &self,
        id: String,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.store_attachment(id, name, mime_type, bytes).await
        })
    }

    /// Searches the files below `root` for an `@` mention (ADR-0030).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn search_files(
        &self,
        search_id: String,
        root: PathBuf,
        query: String,
        limit: usize,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.search_files(search_id, root, query, limit).await
        })
    }

    /// Stops file search `search_id`; only queues.
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn cancel_file_search(&self, search_id: &str) -> Result<()> {
        self.ensure_running()?;
        self.services()?.sessions.cancel_file_search(search_id);
        Ok(())
    }

    /// Sends the workspace and session list snapshots again (a client subscribed anew).
    ///
    /// # Errors
    ///
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn resend_snapshots(&self) -> Result<()> {
        self.ensure_running()?;
        self.services()?.sessions.resend_snapshots();
        Ok(())
    }
}
