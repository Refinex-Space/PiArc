//! Exports of the session layer (T14, architecture section 7.6): workspaces, sessions, their
//! input queue and transcript. Every method validates its arguments synchronously, queues the
//! work on Core's runtime and returns a Promise of JSON text; nothing here waits on I/O.
//!
//! Events arrive through `onEvents`: `core/workspaces` and `core/sessions` snapshots (with a
//! `revision`) and every session's notifications on `session/<id>` (`{ method, params }` with
//! the Agent Host's `seq`).

use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::{Object, Uint8Array};
use napi_derive::napi;
use piarc_core::composer::UserInput;
use piarc_core::sessions::SessionPrefsChange;
use piarc_core::sessions::{CheckpointOp, ModelOp, Op, QueueOp};
use piarc_protocol::session::ModelRef;

use crate::boundary;
use crate::runtime::CoreRuntime;

type Settle = Box<dyn FnOnce(Env) -> napi::Result<String> + Send>;

fn settle(result: piarc_core::Result<serde_json::Value>) -> Settle {
    let encoded = result.and_then(|value| {
        serde_json::to_string(&value).map_err(|e| piarc_core::Error::Internal {
            reason: format!("cannot encode the result: {e}"),
        })
    });
    Box::new(move |env| encoded.map_err(|error| boundary::js_error(&env, &error.to_error_object())))
}

/// A model by provider and id.
#[napi(object)]
pub struct SessionModel {
    /// Provider id, for example `anthropic`.
    pub provider: String,
    /// Model id within the provider.
    pub id: String,
}

/// Options of `createSession`.
#[napi(object, object_to_js = false)]
pub struct CreateSessionOptions {
    /// Absolute working directory inside the workspace; the workspace itself when absent.
    pub cwd: Option<String>,
    /// The model to start with; the Agent Host's default when absent.
    pub model: Option<SessionModel>,
    /// Optional explicit M1 permission mode.
    pub permission_mode: Option<String>,
}

#[napi]
impl CoreRuntime {
    /// Opens a workspace (an absolute directory): starts its Agent Host at once and resolves
    /// when it is ready, with the workspace as `core/workspaces` lists it (JSON).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn open_workspace<'env>(&self, env: &'env Env, path: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.openWorkspace", |core, done| {
            core.open_workspace(PathBuf::from(path), done)
        })
    }

    /// Closes a workspace: its sessions and its Agent Host. Resolves with `null`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn close_workspace<'env>(
        &self,
        env: &'env Env,
        path: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.closeWorkspace", |core, done| {
            core.close_workspace(PathBuf::from(path), done)
        })
    }

    /// Creates a session in a workspace (opened when needed). Resolves with
    /// `{ sessionId, workspace, cwd, restoredMessages }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn create_session<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        #[napi(ts_arg_type = "CreateSessionOptions | null")] options: Option<CreateSessionOptions>,
    ) -> napi::Result<Object<'env>> {
        let options = options.unwrap_or(CreateSessionOptions {
            cwd: None,
            model: None,
            permission_mode: None,
        });
        let mode = options
            .permission_mode
            .map(|v| permission_mode(env, &v))
            .transpose()?;
        self.queue(env, "CoreRuntime.createSession", |core, done| {
            core.create_session_with_mode(
                PathBuf::from(workspace),
                options.cwd.map(PathBuf::from),
                options.model.map(|m| ModelRef {
                    provider: m.provider,
                    id: m.id,
                }),
                mode,
                done,
            )
        })
    }

    /// Lists non-secret provider settings and the built-in provider choices.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn provider_settings<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.providerSettings", |core, done| {
            core.provider_op(piarc_core::providers::Operation::List, done)
        })
    }

    /// Saves a provider. Omit the secret to retain its existing key.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn save_provider<'env>(
        &self,
        env: &'env Env,
        config_json: String,
        #[napi(ts_arg_type = "string | null")] secret_json: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let op = boundary::call(env, "CoreRuntime.saveProvider", || {
            piarc_core::providers::Operation::save(&config_json, secret_json.as_deref())
        })?;
        self.queue(env, "CoreRuntime.saveProvider", |core, done| {
            core.provider_op(op, done)
        })
    }

    /// Deletes a provider with its stored credentials.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn delete_provider<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.deleteProvider", |core, done| {
            core.provider_op(piarc_core::providers::Operation::Delete(id), done)
        })
    }

    /// Changes the user's catalog refresh preference.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_catalog_refresh<'env>(
        &self,
        env: &'env Env,
        enabled: bool,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setCatalogRefresh", |core, done| {
            core.provider_op(piarc_core::providers::Operation::Refresh(enabled), done)
        })
    }

    /// Saves the per-model settings and the auxiliary model (T29); the JSON is
    /// `{ models: { "<provider>/<model>": {...} }, auxiliary?: { provider, id } }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_model_preferences<'env>(
        &self,
        env: &'env Env,
        preferences_json: String,
    ) -> napi::Result<Object<'env>> {
        let op = boundary::call(env, "CoreRuntime.setModelPreferences", || {
            piarc_core::providers::Operation::preferences(&preferences_json)
        })?;
        self.queue(env, "CoreRuntime.setModelPreferences", |core, done| {
            core.provider_op(op, done)
        })
    }

    /// Signs in to a provider (OAuth or device code, T29). Resolves when the credential is in
    /// the vault; progress and questions arrive on the `core/login` route.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn start_login<'env>(
        &self,
        env: &'env Env,
        provider: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.startLogin", |core, done| {
            core.login(provider, done)
        })
    }

    /// Answers the current question of a sign-in; `null` cancels the sign-in.
    #[napi(catch_unwind)]
    pub fn answer_login(
        &self,
        env: Env,
        login_id: String,
        #[napi(ts_arg_type = "string | null")] value: Option<String>,
    ) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.answerLogin", || {
            self.core.answer_login(&login_id, value)
        })
    }

    /// Signs out of a provider (removes its stored credential).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn logout_provider<'env>(
        &self,
        env: &'env Env,
        provider: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.logoutProvider", |core, done| {
            core.logout(provider, done)
        })
    }

    /// Lists models before a session is created.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn workspace_models<'env>(
        &self,
        env: &'env Env,
        workspace: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.workspaceModels", |core, done| {
            core.workspace_models(workspace.into(), done)
        })
    }

    /// Lists the models and current session selection.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn session_models<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.sessionModels",
            id,
            Op::Model(ModelOp::List),
        )
    }

    /// Estimates context and cache effects without changing the session.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn preview_model_switch<'env>(
        &self,
        env: &'env Env,
        id: String,
        provider: String,
        model: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.previewModelSwitch",
            id,
            Op::Model(ModelOp::Preview(ModelRef {
                provider,
                id: model,
            })),
        )
    }

    /// Applies a confirmed switch, optionally with a specific target effort.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_session_model<'env>(
        &self,
        env: &'env Env,
        id: String,
        provider: String,
        model: String,
        #[napi(ts_arg_type = "string | null")] effort: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let effort = effort.map(|v| effort_level(env, v)).transpose()?;
        self.op(
            env,
            "CoreRuntime.setSessionModel",
            id,
            Op::Model(ModelOp::Set(
                ModelRef {
                    provider,
                    id: model,
                },
                effort,
            )),
        )
    }

    /// Sets the session's effort.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_session_effort<'env>(
        &self,
        env: &'env Env,
        id: String,
        effort: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.setSessionEffort",
            id,
            Op::Model(ModelOp::Effort(effort_level(env, effort)?)),
        )
    }

    /// Answers a pending permission request and returns its status as JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn answer_approval<'env>(
        &self,
        env: &'env Env,
        answer: String,
    ) -> napi::Result<Object<'env>> {
        let parsed = boundary::call(env, "CoreRuntime.answerApproval", || {
            serde_json::from_str(&answer).map_err(|e| piarc_core::Error::InvalidArgument {
                field: "answer",
                reason: e.to_string(),
            })
        })?;
        self.queue(env, "CoreRuntime.answerApproval", |core, done| {
            core.answer_approval(parsed, done)
        })
    }

    /// The configuration diagnostics of a workspace (JSON), the most recent workspace when
    /// null (T24): every settings file with its load state and applied, overridden and
    /// ignored keys.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn config_diagnostics<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.configDiagnostics", |core, done| {
            core.config_diagnostics(workspace.map(Into::into), done)
        })
    }

    /// The permission rules of a workspace by source, the most recent workspace when null
    /// (T23).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn permission_rules<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.permissionRules", |core, done| {
            core.permission_rules(workspace.map(Into::into), done)
        })
    }

    /// Whether a rule parses for `allow`, `ask` or `deny`, and whether it is broad (JSON).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn check_permission_rule<'env>(
        &self,
        env: &'env Env,
        rule: String,
        behavior: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.checkPermissionRule", |core, done| {
            done(core.check_permission_rule(&rule, &behavior));
            Ok(())
        })
    }

    /// Changes one rule of a writable settings file and returns the new view (JSON).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn update_permission_rule<'env>(
        &self,
        env: &'env Env,
        change: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.updatePermissionRule", |core, done| {
            core.update_permission_rule(change, done)
        })
    }

    /// Permission audit events matching the JSON query, newest first (JSON).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn audit_events<'env>(&self, env: &'env Env, query: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.auditEvents", |core, done| {
            core.audit_events(query, done)
        })
    }

    /// Changes the mode and appends its entry to the session before resolving.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_permission_mode<'env>(
        &self,
        env: &'env Env,
        id: String,
        mode: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.setPermissionMode",
            id,
            Op::SetPermissionMode(permission_mode(env, &mode)?),
        )
    }

    /// Reopens a session from its file (its workspace is opened when needed).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn resume_session<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.resumeSession", |core, done| {
            core.resume_session(id, done)
        })
    }

    /// Opens a copy of a session's conversation (up to `entryId`, or up to where the turn
    /// `beforeTurn` started) as a new session.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn fork_session<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] entry_id: Option<String>,
        #[napi(ts_arg_type = "string | null")] before_turn: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let at = match before_turn {
            Some(turn) => piarc_core::sessions::ForkPoint::BeforeTurn(turn),
            None => piarc_core::sessions::ForkPoint::Entry(entry_id),
        };
        self.queue(env, "CoreRuntime.forkSession", |core, done| {
            core.fork_session(id, at, done)
        })
    }

    /// Closes an open session.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn close_session<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.closeSession", |core, done| {
            core.close_session(id, done)
        })
    }

    /// Starts a turn on an idle session; resolves with `{ turnId }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn prompt<'env>(
        &self,
        env: &'env Env,
        id: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.prompt",
            id,
            Op::Prompt(UserInput::text(text)),
        )
    }

    /// A steering message for the running turn (a new turn when idle); resolves with
    /// `{ disposition: "queued", itemId }` or `{ disposition: "started", turnId }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn steer<'env>(
        &self,
        env: &'env Env,
        id: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.steer",
            id,
            Op::Steer(UserInput::text(text)),
        )
    }

    /// A follow-up for after the running turn (a new turn when idle); resolves like `steer`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn follow_up<'env>(
        &self,
        env: &'env Env,
        id: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.followUp",
            id,
            Op::FollowUp(UserInput::text(text)),
        )
    }

    /// Starts a turn on an idle session; resolves with `{ turnId }`. `input` is JSON:
    /// `{ requestId?, text, mentions?, attachments? }` (ADR-0030); the same `requestId` sent
    /// again returns the turn it already started.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn prompt_input<'env>(
        &self,
        env: &'env Env,
        id: String,
        input: String,
    ) -> napi::Result<Object<'env>> {
        let input = boundary::call(env, "CoreRuntime.promptInput", || {
            UserInput::from_json(&input)
        })?;
        self.op(env, "CoreRuntime.promptInput", id, Op::Prompt(input))
    }

    /// A steering message for the running turn (a new turn when idle); `input` as for
    /// `prompt`. Resolves with `{ disposition: "queued", itemId }` or `{ disposition:
    /// "started", turnId }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn steer_input<'env>(
        &self,
        env: &'env Env,
        id: String,
        input: String,
    ) -> napi::Result<Object<'env>> {
        let input = boundary::call(env, "CoreRuntime.steerInput", || {
            UserInput::from_json(&input)
        })?;
        self.op(env, "CoreRuntime.steerInput", id, Op::Steer(input))
    }

    /// A follow-up for after the running turn (a new turn when idle); resolves like `steer`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn follow_up_input<'env>(
        &self,
        env: &'env Env,
        id: String,
        input: String,
    ) -> napi::Result<Object<'env>> {
        let input = boundary::call(env, "CoreRuntime.followUpInput", || {
            UserInput::from_json(&input)
        })?;
        self.op(env, "CoreRuntime.followUpInput", id, Op::FollowUp(input))
    }

    /// Compacts the conversation as a turn of its own (`/compact [focus]`); `instructions` is
    /// what the summary should focus on. Resolves with `{ turnId }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn compact<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] instructions: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.op(env, "CoreRuntime.compact", id, Op::Compact(instructions))
    }

    /// The session's context usage by category (T27); resolves with the `ContextUsage` JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn context_usage<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.op(env, "CoreRuntime.contextUsage", id, Op::ContextUsage)
    }

    /// What rewinding the files to before turn `turnId` would do (T28); resolves with the
    /// `RewindPreview` JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn rewind_preview<'env>(
        &self,
        env: &'env Env,
        id: String,
        turn_id: String,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Checkpoint(CheckpointOp::Preview(turn_id));
        self.op(env, "CoreRuntime.rewindPreview", id, op)
    }

    /// Rewinds the session: `request` is the `RewindRequest` JSON (`{ turnId, scope, choices?
    /// }`); resolves with the `RewindReport` JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn rewind<'env>(
        &self,
        env: &'env Env,
        id: String,
        request: String,
    ) -> napi::Result<Object<'env>> {
        let request = boundary::call(env, "CoreRuntime.rewind", || {
            serde_json::from_str(&request).map_err(|e| piarc_core::Error::InvalidArgument {
                field: "request",
                reason: e.to_string(),
            })
        })?;
        let op = Op::Checkpoint(CheckpointOp::Rewind(request));
        self.op(env, "CoreRuntime.rewind", id, op)
    }

    /// Undoes the files of the rewind `restoreId`; resolves with the `RewindReport` JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn undo_rewind<'env>(
        &self,
        env: &'env Env,
        id: String,
        restore_id: String,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Checkpoint(CheckpointOp::Undo(restore_id));
        self.op(env, "CoreRuntime.undoRewind", id, op)
    }

    /// The session's changed files, or the file `path` alone with its diff; resolves with the
    /// `ChangesView` JSON.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn session_changes<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] path: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Checkpoint(CheckpointOp::Changes(path));
        self.op(env, "CoreRuntime.sessionChanges", id, op)
    }

    /// Discards a file's change or one hunk: `request` is the `DiscardRequest` JSON; resolves
    /// with the file's `ChangesView` afterwards.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn discard_change<'env>(
        &self,
        env: &'env Env,
        id: String,
        request: String,
    ) -> napi::Result<Object<'env>> {
        let request = boundary::call(env, "CoreRuntime.discardChange", || {
            serde_json::from_str(&request).map_err(|e| piarc_core::Error::InvalidArgument {
                field: "request",
                reason: e.to_string(),
            })
        })?;
        let op = Op::Checkpoint(CheckpointOp::Discard(request));
        self.op(env, "CoreRuntime.discardChange", id, op)
    }

    /// Continues the session on the branch whose last entry is `entryId`; resolves with the
    /// reopened session (`SessionRewound` JSON).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn switch_branch<'env>(
        &self,
        env: &'env Env,
        id: String,
        entry_id: String,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Checkpoint(CheckpointOp::SwitchBranch(entry_id));
        self.op(env, "CoreRuntime.switchBranch", id, op)
    }

    /// Stores an attachment (image or PDF bytes) for an open session; resolves with the
    /// attachment to put in an input (`{ kind, name, mimeType, blob, pageCount? }`). The bytes
    /// are copied; the caller's buffer is not kept.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn store_attachment<'env>(
        &self,
        env: &'env Env,
        id: String,
        name: String,
        mime_type: String,
        data: Uint8Array,
    ) -> napi::Result<Object<'env>> {
        let bytes = data.to_vec();
        self.queue(env, "CoreRuntime.storeAttachment", |core, done| {
            core.store_attachment(id, name, mime_type, bytes, done)
        })
    }

    /// Fuzzy-searches the files below `root` (inside a workspace) for an `@` mention; at most
    /// `limit` matches. A newer search with the same `searchId` cancels this one, which then
    /// rejects with kind `cancelled`. Resolves with `{ root, results: [{ path, name,
    /// positions }], truncated }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn search_files<'env>(
        &self,
        env: &'env Env,
        search_id: String,
        root: String,
        query: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.searchFiles", |core, done| {
            core.search_files(
                search_id,
                PathBuf::from(root),
                query,
                usize::try_from(limit).unwrap_or(usize::MAX),
                done,
            )
        })
    }

    /// Stops a file search. Only queues.
    #[napi(catch_unwind)]
    pub fn cancel_file_search(&self, env: Env, search_id: String) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.cancelFileSearch", || {
            self.core.cancel_file_search(&search_id)
        })
    }

    /// The composer's configuration (JSON): built-in commands, attachment limits, search cap.
    #[napi(catch_unwind)]
    pub fn composer_info(&self) -> String {
        piarc_core::composer::info().to_string()
    }

    /// Interrupts the running turn; resolves with `{ sessionId, interruptedTurnId?,
    /// returnedQueue? }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn abort<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.op(env, "CoreRuntime.abort", id, Op::Abort)
    }

    /// Changes a queued item's text; resolves with the queue (`{ items }`).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn edit_queue_item<'env>(
        &self,
        env: &'env Env,
        id: String,
        item_id: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Queue(QueueOp::Edit { item_id, text });
        self.op(env, "CoreRuntime.editQueueItem", id, op)
    }

    /// Removes a queued item; resolves with the queue.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn delete_queue_item<'env>(
        &self,
        env: &'env Env,
        id: String,
        item_id: String,
    ) -> napi::Result<Object<'env>> {
        let op = Op::Queue(QueueOp::Delete { item_id });
        self.op(env, "CoreRuntime.deleteQueueItem", id, op)
    }

    /// Reorders the queue (every item's id once); resolves with the queue.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn reorder_queue<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string[]")] item_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.op(
            env,
            "CoreRuntime.reorderQueue",
            id,
            Op::Queue(QueueOp::Reorder(item_ids)),
        )
    }

    /// Clears a session's unread flag; resolves with `null`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn mark_session_read<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.op(env, "CoreRuntime.markSessionRead", id, Op::MarkRead)
    }

    /// Gives a session a title (`null` removes it: the derived title shows again); resolves
    /// with `null`. Works on sessions that are not open.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn rename_session<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] title: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let change = SessionPrefsChange {
            custom_title: Some(title),
            ..SessionPrefsChange::default()
        };
        self.op(env, "CoreRuntime.renameSession", id, Op::Prefs(change))
    }

    /// Pins or unpins a session; resolves with `null`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_session_pinned<'env>(
        &self,
        env: &'env Env,
        id: String,
        pinned: bool,
    ) -> napi::Result<Object<'env>> {
        let change = SessionPrefsChange {
            pinned: Some(pinned),
            ..SessionPrefsChange::default()
        };
        self.op(env, "CoreRuntime.setSessionPinned", id, Op::Prefs(change))
    }

    /// Archives a session (closing it when open and removing its temporary directory) or
    /// brings it back; resolves with `null`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_session_archived<'env>(
        &self,
        env: &'env Env,
        id: String,
        archived: bool,
    ) -> napi::Result<Object<'env>> {
        let change = SessionPrefsChange {
            archived: Some(archived),
            ..SessionPrefsChange::default()
        };
        self.op(env, "CoreRuntime.setSessionArchived", id, Op::Prefs(change))
    }

    /// The indexed title and workspace of the session shown in a native deletion dialog.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn session_deletion_target<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.sessionDeletionTarget", |core, done| {
            core.session_deletion_target(id, done)
        })
    }

    /// Deletes a session: closes it when open, then removes its Pi session file, its temporary
    /// directory and its index rows. Irreversible; the caller confirms with the user first.
    /// Resolves with `null`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn delete_session<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.deleteSession", |core, done| {
            core.delete_session(id, done)
        })
    }

    /// Items of a session's conversation (open or not): `start .. start + limit`, or the last
    /// `limit` without `start`. Resolves with `{ start, total, items: [{ entryId, item }] }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn transcript_window<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "number | null")] start: Option<u32>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.transcriptWindow", |core, done| {
            core.transcript_window(id, start.map(u64::from), u64::from(limit), done)
        })
    }

    /// The subagent types of `workspace` from `cwd` (the workspace root when null), as JSON
    /// text (T31).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn list_agents<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        #[napi(ts_arg_type = "string | null")] cwd: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.listAgents", |core, done| {
            core.list_agents(workspace.into(), cwd.map(Into::into), done)
        })
    }

    /// The slash commands and output styles of `workspace` from `cwd` (the workspace root when
    /// null), as JSON text (T37).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn list_commands<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        #[napi(ts_arg_type = "string | null")] cwd: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.listCommands", |core, done| {
            core.list_commands(workspace.into(), cwd.map(Into::into), done)
        })
    }

    /// The skills of `workspace` from `cwd` (the workspace root when null), as JSON text (T37).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn list_skills<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        #[napi(ts_arg_type = "string | null")] cwd: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.listSkills", |core, done| {
            core.list_skills(workspace.into(), cwd.map(Into::into), done)
        })
    }

    /// Sets the output style of `workspace` (its `.piarc/settings.local.json`), or the user's
    /// when null; a null name removes the choice (T37).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_output_style<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] workspace: Option<String>,
        #[napi(ts_arg_type = "string | null")] name: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setOutputStyle", |core, done| {
            core.set_output_style(workspace.map(Into::into), name, done)
        })
    }

    /// The WebSearch settings, JSON text `{ backend, backends: [{ id, name, hasKey }] }` (T38).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn web_search_settings<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.webSearchSettings", |core, done| {
            core.web_search_settings(done)
        })
    }

    /// Chooses WebSearch's third-party backend; null chooses none (T38).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_web_search_backend<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string | null")] backend: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setWebSearchBackend", |core, done| {
            core.set_web_search_backend(backend, done)
        })
    }

    /// Saves a WebSearch backend's API key in the vault; null removes it (T38).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn set_web_search_key<'env>(
        &self,
        env: &'env Env,
        backend: String,
        #[napi(ts_arg_type = "string | null")] key: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.setWebSearchKey", |core, done| {
            core.set_web_search_key(backend, key, done)
        })
    }

    /// Stops subagent `child` of session `parent`; JSON text `{ stopped }` (T31).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn stop_subagent<'env>(
        &self,
        env: &'env Env,
        parent: String,
        child: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.stopSubagent", |core, done| {
            core.stop_subagent(parent, child, done)
        })
    }

    /// A window of subagent `child`'s transcript, read through session `parent`, as JSON text
    /// (T31).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn subagent_transcript<'env>(
        &self,
        env: &'env Env,
        parent: String,
        child: String,
        #[napi(ts_arg_type = "number | null")] start: Option<u32>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.subagentTranscript", |core, done| {
            core.subagent_transcript(parent, child, start.map(u64::from), u64::from(limit), done)
        })
    }

    /// Stops background task `taskId` (the panel's stop button, T32); JSON text
    /// `{ task, stopped, tail }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn stop_task<'env>(&self, env: &'env Env, task_id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.stopTask", |core, done| {
            core.stop_task(task_id, done)
        })
    }

    /// At most 64 KiB of background task `taskId`'s output from byte `offset`, as JSON text
    /// (`TaskOutputChunk`, T32).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn read_task_output<'env>(
        &self,
        env: &'env Env,
        task_id: String,
        offset: f64,
        #[napi(ts_arg_type = "number | null")] length: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        // JavaScript numbers: whole, non-negative byte counts below 2^53.
        let bytes = |value: f64| {
            if value.is_finite() && value >= 0.0 {
                // The value is a whole number of bytes well inside u64.
                #[expect(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "checked finite and non-negative; fractions are dropped"
                )]
                Some(value as u64)
            } else {
                None
            }
        };
        let offset = bytes(offset).unwrap_or(0);
        let length = length.and_then(bytes);
        self.queue(env, "CoreRuntime.readTaskOutput", |core, done| {
            core.read_task_output(task_id, offset, length, done)
        })
    }

    /// Sends the `core/workspaces`, `core/sessions` and `core/tasks` snapshots again (a window
    /// subscribed anew). Only queues.
    #[napi(catch_unwind)]
    pub fn resend_snapshots(&self, env: Env) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.resendSnapshots", || {
            self.core.resend_snapshots()
        })
    }
}

impl CoreRuntime {
    pub(crate) fn queue<'env>(
        &self,
        env: &'env Env,
        location: &'static str,
        call: impl FnOnce(
            &piarc_core::CoreRuntime,
            Box<dyn FnOnce(piarc_core::Result<serde_json::Value>) + Send>,
        ) -> piarc_core::Result<()>,
    ) -> napi::Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<String, Settle>()?;
        boundary::call(env, location, || {
            call(
                &self.core,
                Box::new(move |result| deferred.resolve(settle(result))),
            )
        })?;
        Ok(promise)
    }

    fn op<'env>(
        &self,
        env: &'env Env,
        location: &'static str,
        id: String,
        op: Op,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, location, |core, done| core.session_op(id, op, done))
    }
}

pub(crate) fn permission_mode(
    env: &Env,
    mode: &str,
) -> napi::Result<piarc_protocol::policy::PermissionMode> {
    boundary::call(env, "permissionMode", || {
        serde_json::from_value(serde_json::Value::String(mode.into())).map_err(|_| {
            piarc_core::Error::InvalidArgument {
                field: "permissionMode",
                reason: "expected default, acceptEdits, plan or bypassPermissions".into(),
            }
        })
    })
}

fn effort_level(env: &Env, level: String) -> napi::Result<piarc_protocol::models::EffortLevel> {
    boundary::call(env, "effort", || {
        serde_json::from_value(serde_json::Value::String(level)).map_err(|_| {
            piarc_core::Error::InvalidArgument {
                field: "effort",
                reason: "unsupported effort level".into(),
            }
        })
    })
}
