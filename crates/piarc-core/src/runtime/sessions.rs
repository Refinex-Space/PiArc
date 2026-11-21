//! Runtime entry points for session commands and workspace actors.
use super::{CoreRuntime, encode_error};
use crate::error::{Error, Result};
use crate::sessions::{Hub, Op};
use std::{future::Future, path::PathBuf};
impl CoreRuntime {
    /// Runs `job` on the session layer and calls `on_done` with its result from a runtime
    /// thread. Validation that needs no I/O happens in `job` too, but the call itself only
    /// queues the work: nothing here blocks the caller (architecture section 7.2).
    pub(super) fn on_sessions<F, Fut>(
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

    /// Signs in to `provider` (T29); settles once the credential is stored or the sign-in
    /// failed. Progress and questions go to `core/login`.
    ///
    /// # Errors
    /// As [`Self::open_workspace`].
    pub fn login(
        &self,
        provider: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move { hub.login(provider).await })
    }

    /// Answers the question of sign-in `id`; `None` cancels the sign-in (T29).
    ///
    /// # Errors
    /// No such sign-in in progress; Core is not running.
    pub fn answer_login(&self, id: &str, value: Option<String>) -> Result<()> {
        self.ensure_running()?;
        self.services()?.sessions.answer_login(id, value)
    }

    /// Signs out of `provider`: its stored credential is removed (T29).
    ///
    /// # Errors
    /// As [`Self::open_workspace`].
    pub fn logout(
        &self,
        provider: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            move |hub| async move { hub.logout(provider).await },
        )
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
            hub.create_session(workspace, cwd, model, mode, None).await
        })
    }

    /// Creates a session in a new worktree of `workspace`'s repository (T35): the answer of
    /// [`Self::create_session`] with a `worktree` object (name, path, branch, base, copied
    /// files, whether the repository ignores `.piarc/worktrees/`).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn create_worktree_session(
        &self,
        workspace: PathBuf,
        model: Option<piarc_protocol::session::ModelRef>,
        mode: Option<piarc_protocol::policy::PermissionMode>,
        worktree: crate::sessions::WorktreeRequest,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.create_session(workspace, None, model, mode, Some(worktree))
                .await
        })
    }

    /// The branches of `workspace`'s repository for the new-session form (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn worktree_branches(
        &self,
        workspace: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.worktree_branches(workspace).await
        })
    }

    /// Adds `.piarc/worktrees/` to `workspace`'s `.gitignore` (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn ignore_worktrees(
        &self,
        workspace: PathBuf,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.ignore_worktrees(workspace).await
        })
    }

    /// The uncommitted changes of session `id`'s worktree (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn session_worktree_status(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.session_worktree_status(id).await
        })
    }

    /// Removes closed session `id`'s worktree; `discard` throws its changes away (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn remove_session_worktree(
        &self,
        id: String,
        discard: bool,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.remove_session_worktree(id, discard).await
        })
    }

    /// Keeps archived session `id`'s worktree for another retention period (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn keep_session_worktree(
        &self,
        id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.keep_session_worktree(id).await
        })
    }

    /// Runs one worktree cleanup now, as the timer does (T35): `{ removed, waiting, failed }`.
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn sweep_worktrees(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            Ok(hub.sweep_worktrees().await)
        })
    }

    /// Full-text search over the sessions' messages (T35).
    ///
    /// # Errors
    /// As [`Self::create_session`].
    pub fn search_sessions(
        &self,
        query: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.search_sessions(query).await
        })
    }

    /// Running sessions and background tasks now: `{ sessions, tasks }` (T35).
    ///
    /// # Errors
    /// [`Error::NoDataDirectory`], [`Error::ShuttingDown`].
    pub fn running_work(&self) -> Result<serde_json::Value> {
        self.ensure_running()?;
        Ok(self.services()?.sessions.running_work())
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

    /// The sandbox settings page's view of a workspace (T39).
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn sandbox_settings(
        &self,
        workspace: Option<PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.sandbox_settings(workspace).await
        })
    }

    /// Writes the user's sandbox values (T39); answers the new view of `workspace`.
    ///
    /// # Errors
    /// As [`Self::session_op`].
    pub fn set_sandbox_settings(
        &self,
        workspace: Option<PathBuf>,
        change_json: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.set_sandbox_settings(workspace, change_json).await
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

    /// Opens a copy of a session (up to `at`) as a new session.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn fork_session(
        &self,
        id: String,
        at: crate::sessions::ForkPoint,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&id)?;
        self.on_sessions(
            on_done,
            move |hub| async move { hub.fork_session(id, at).await },
        )
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

    /// The subagent types of `workspace` from `cwd` (T31): definition files and built-in types
    /// with the model each resolves to.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn list_agents(
        &self,
        workspace: std::path::PathBuf,
        cwd: Option<std::path::PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.list_agents(workspace, cwd).await
        })
    }

    /// The slash commands and output styles of `workspace` from `cwd` (T37).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn list_commands(
        &self,
        workspace: std::path::PathBuf,
        cwd: Option<std::path::PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.list_commands(workspace, cwd).await
        })
    }

    /// The skills of `workspace` from `cwd` (T37).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn list_skills(
        &self,
        workspace: std::path::PathBuf,
        cwd: Option<std::path::PathBuf>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.list_skills(workspace, cwd).await
        })
    }

    /// Sets the output style of `workspace` (its `.piarc/settings.local.json`) or of the user
    /// (`None`); `name: None` removes the choice (T37).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn set_output_style(
        &self,
        workspace: Option<std::path::PathBuf>,
        name: Option<String>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.set_output_style(workspace, name).await
        })
    }

    /// The WebSearch settings: the chosen third-party backend and which backends have a key
    /// (T38).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn web_search_settings(
        &self,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.web_search_settings().await
        })
    }

    /// Chooses WebSearch's third-party backend in the user's settings; `None` chooses none
    /// (T38).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn set_web_search_backend(
        &self,
        backend: Option<String>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.set_web_search_backend(backend).await
        })
    }

    /// Saves `backend`'s API key in the vault, or removes it (`None`) (T38).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn set_web_search_key(
        &self,
        backend: String,
        key: Option<String>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.set_web_search_key(backend, key).await
        })
    }

    /// Stops subagent `child` of session `parent` (T31).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn stop_subagent(
        &self,
        parent: String,
        child: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&parent)?;
        crate::sessions::check_session_id(&child)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.stop_subagent(parent, child).await
        })
    }

    /// Stops background task `task_id` (the panel's stop button, T32): the same entry as
    /// `KillShell`, without its session check. Answers the task as it ended.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn stop_task(
        &self,
        task_id: String,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(
            on_done,
            move |hub| async move { hub.stop_task(task_id).await },
        )
    }

    /// A byte range of background task `task_id`'s output (T32): at most 64 KiB from
    /// `offset`, as text.
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn read_task_output(
        &self,
        task_id: String,
        offset: u64,
        length: Option<u64>,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        self.on_sessions(on_done, move |hub| async move {
            hub.read_task_output(task_id, offset, length).await
        })
    }

    /// A window of subagent `child`'s transcript, read through session `parent` (T31).
    ///
    /// # Errors
    ///
    /// As [`open_workspace`](Self::open_workspace).
    pub fn subagent_transcript(
        &self,
        parent: String,
        child: String,
        start: Option<u64>,
        limit: u64,
        on_done: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) -> Result<()> {
        crate::sessions::check_session_id(&parent)?;
        crate::sessions::check_session_id(&child)?;
        self.on_sessions(on_done, move |hub| async move {
            hub.subagent_transcript(parent, child, start, limit).await
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
