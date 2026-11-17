//! Exports of the session layer (T14, architecture section 7.6): workspaces, sessions, their
//! input queue and transcript. Every method validates its arguments synchronously, queues the
//! work on Core's runtime and returns a Promise of JSON text; nothing here waits on I/O.
//!
//! Events arrive through `onEvents`: `core/workspaces` and `core/sessions` snapshots (with a
//! `revision`) and every session's notifications on `session/<id>` (`{ method, params }` with
//! the Agent Host's `seq`).

use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use piarc_core::sessions::{Op, QueueOp};
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
        });
        self.queue(env, "CoreRuntime.createSession", |core, done| {
            core.create_session(
                PathBuf::from(workspace),
                options.cwd.map(PathBuf::from),
                options.model.map(|m| ModelRef {
                    provider: m.provider,
                    id: m.id,
                }),
                done,
            )
        })
    }

    /// Reopens a session from its file (its workspace is opened when needed).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn resume_session<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.resumeSession", |core, done| {
            core.resume_session(id, done)
        })
    }

    /// Opens a copy of a session's conversation (up to `entryId`) as a new session.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn fork_session<'env>(
        &self,
        env: &'env Env,
        id: String,
        #[napi(ts_arg_type = "string | null")] entry_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.forkSession", |core, done| {
            core.fork_session(id, entry_id, done)
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
        self.op(env, "CoreRuntime.prompt", id, Op::Prompt(text))
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
        self.op(env, "CoreRuntime.steer", id, Op::Steer(text))
    }

    /// A follow-up for after the running turn (a new turn when idle); resolves like `steer`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn follow_up<'env>(
        &self,
        env: &'env Env,
        id: String,
        text: String,
    ) -> napi::Result<Object<'env>> {
        self.op(env, "CoreRuntime.followUp", id, Op::FollowUp(text))
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

    /// Sends the `core/workspaces` and `core/sessions` snapshots again (a window subscribed
    /// anew). Only queues.
    #[napi(catch_unwind)]
    pub fn resend_snapshots(&self, env: Env) -> napi::Result<()> {
        boundary::call(&env, "CoreRuntime.resendSnapshots", || {
            self.core.resend_snapshots()
        })
    }
}

impl CoreRuntime {
    fn queue<'env>(
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
