//! Exports of T35: sessions in worktrees and their cleanup, full-text search, and the running
//! work the app asks about before quitting. Results are JSON text.

use std::path::PathBuf;

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use piarc_protocol::session::ModelRef;

use crate::boundary;
use crate::runtime::CoreRuntime;
use crate::sessions::{SessionModel, permission_mode};

/// Options of `createWorktreeSession`.
#[napi(object, object_to_js = false)]
pub struct WorktreeSessionOptions {
    /// The worktree's name (1–64 of `[A-Za-z0-9._-]`); the session id's start when absent.
    pub name: Option<String>,
    /// The branch or commit it starts from; the workspace's HEAD when absent.
    pub base: Option<String>,
    /// The model to start with; the Agent Host's default when absent.
    pub model: Option<SessionModel>,
    /// Optional explicit permission mode.
    pub permission_mode: Option<String>,
}

#[napi]
impl CoreRuntime {
    /// Creates a session in a new worktree `.piarc/worktrees/<name>/` of the workspace's
    /// repository on the branch `piarc/<name>`. Resolves like `createSession`, with
    /// `worktree: { name, path, branch, base, copied, ignored }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn create_worktree_session<'env>(
        &self,
        env: &'env Env,
        workspace: String,
        options: WorktreeSessionOptions,
    ) -> napi::Result<Object<'env>> {
        let mode = options
            .permission_mode
            .map(|v| permission_mode(env, &v))
            .transpose()?;
        let model = options.model.map(|m| ModelRef {
            provider: m.provider,
            id: m.id,
        });
        let request = piarc_core::sessions::WorktreeRequest {
            name: options.name,
            base: options.base,
        };
        self.queue(env, "CoreRuntime.createWorktreeSession", |core, done| {
            core.create_worktree_session(PathBuf::from(workspace), model, mode, request, done)
        })
    }

    /// The local branches of an opened workspace's repository:
    /// `{ repository, current?, branches? }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn worktree_branches<'env>(
        &self,
        env: &'env Env,
        workspace: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.worktreeBranches", |core, done| {
            core.worktree_branches(PathBuf::from(workspace), done)
        })
    }

    /// Appends `.piarc/worktrees/` to an opened workspace's `.gitignore`: `{ changed }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn ignore_worktrees<'env>(
        &self,
        env: &'env Env,
        workspace: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.ignoreWorktrees", |core, done| {
            core.ignore_worktrees(PathBuf::from(workspace), done)
        })
    }

    /// The uncommitted changes of a session's worktree:
    /// `{ path, branch?, exists, changes, files }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn session_worktree_status<'env>(
        &self,
        env: &'env Env,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.sessionWorktreeStatus", |core, done| {
            core.session_worktree_status(session_id, done)
        })
    }

    /// Removes a closed session's worktree (its branch stays); `discard` throws its
    /// uncommitted changes away. Without it, a worktree with changes is refused.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn remove_session_worktree<'env>(
        &self,
        env: &'env Env,
        session_id: String,
        discard: bool,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.removeSessionWorktree", |core, done| {
            core.remove_session_worktree(session_id, discard, done)
        })
    }

    /// Keeps an archived session's worktree for another retention period.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn keep_session_worktree<'env>(
        &self,
        env: &'env Env,
        session_id: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.keepSessionWorktree", |core, done| {
            core.keep_session_worktree(session_id, done)
        })
    }

    /// Runs one worktree cleanup now, as the timer does: `{ removed, waiting, failed }`.
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn sweep_worktrees<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.sweepWorktrees", |core, done| {
            core.sweep_worktrees(done)
        })
    }

    /// Sessions whose messages contain every term of `query`: `{ results: [{ sessionId,
    /// title?, workspace?, archived, updatedAt?, total, hits: [{ entryId?, role, at?, snippet,
    /// highlights: [[start, end]] }] }] }` (highlights in UTF-16 code units of the snippet).
    #[napi(ts_return_type = "Promise<string>", catch_unwind)]
    pub fn search_sessions<'env>(
        &self,
        env: &'env Env,
        query: String,
    ) -> napi::Result<Object<'env>> {
        self.queue(env, "CoreRuntime.searchSessions", |core, done| {
            core.search_sessions(query, done)
        })
    }

    /// Running sessions and background tasks now, as JSON `{ sessions, tasks }`: quitting asks
    /// first when there are some.
    #[napi(catch_unwind)]
    pub fn running_work(&self, env: Env) -> napi::Result<String> {
        boundary::call(&env, "CoreRuntime.runningWork", || {
            self.core.running_work().map(|v| v.to_string())
        })
    }
}
