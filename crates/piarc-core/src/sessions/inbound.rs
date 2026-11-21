//! What answers one workspace's Agent Host: `trust/get` from the trust store, `secrets/*` from
//! Core's single vault service, `hooks/run` for working directories in this workspace,
//! `agents/list`, `subagent/start`, `subagent/finish` (T31), `mcp/servers` and an MCP server's
//! sign-in steps (`ui/loginInteraction`, T36), and `fs/*`, `exec/*` from the tool I/O, but only
//! for the sessions that belong to this workspace (R1-A13): an Agent Host cannot reach another
//! workspace's session scope by naming its id.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use piarc_host::{InboundHandler, Peer};
use piarc_ports::BoxFuture;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value};

use crate::secrets::SecretsService;
use crate::tool_io::ToolIo;
use crate::trust::TrustService;

/// The ids of a workspace's open sessions, shared with its actor.
pub(crate) type SessionSet = Arc<Mutex<HashSet<String>>>;

pub(crate) struct WorkspaceInbound {
    /// The workspace's root: `hooks/run` accepts working directories inside it only.
    pub workspace: std::path::PathBuf,
    pub trust: TrustService,
    pub secrets: SecretsService,
    pub tool_io: ToolIo,
    pub sessions: SessionSet,
    /// Running subagents keep the Agent Host from the idle timer (T31).
    pub activity: super::workspace::Activity,
    /// The workspace's MCP configuration (T36).
    pub mcp: crate::mcp::McpConfigSource,
    /// An MCP server's sign-in shows its steps like a provider's (T36).
    pub logins: Arc<super::login::Logins>,
    pub events: crate::events::EventSender,
}

impl WorkspaceInbound {
    fn ours(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(id)
    }

    /// `subagent/start` and `subagent/finish` (T31): a child joins this workspace's sessions
    /// under a parent of this workspace, and leaves when its run or its connection ends.
    fn subagent(
        &self,
        method: &str,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let named = if method == "subagent/start" {
            crate::tool_io::subagents::parent_of(&params)
        } else {
            params.get("sessionId").and_then(Value::as_str)
        }
        .unwrap_or_default()
        .to_owned();
        if !self.ours(&named) {
            let method = method.to_owned();
            return Box::pin(async move {
                Err(ErrorObject::new(
                    ErrorKind::SessionNotFound,
                    format!("{method}: no session {named} in this workspace"),
                    false,
                ))
            });
        }
        let (io, sessions, workspace, activity) = (
            self.tool_io.clone(),
            Arc::clone(&self.sessions),
            self.workspace.clone(),
            self.activity.clone(),
        );
        if method == "subagent/finish" {
            return Box::pin(async move {
                let answer = io.finish_request(&workspace, params).await;
                sessions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&named);
                activity.busy(&named, false);
                answer
            });
        }
        Box::pin(async move {
            let (child, result) = io.start_request(params).await?;
            sessions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(child.clone());
            // A background run goes on after its main session's turn: while it runs, the
            // Agent Host is busy.
            activity.busy(&child, true);
            // A child whose connection ends without `subagent/finish` (the Agent Host
            // stopped) is unregistered then; its row records the interruption.
            tokio::spawn(async move {
                peer.closed().await;
                let worktree = io.subagent_worktree(&child);
                if io.finish_subagent(&child) {
                    io.settle_worktree(worktree).await;
                    sessions
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&child);
                    activity.busy(&child, false);
                    io.index_subagent(&child, &workspace, "error").await;
                }
            });
            Ok(result)
        })
    }
}

impl WorkspaceInbound {
    /// `skills/list`, `skills/invoke`, `skills/match` (T37); a named session must be ours.
    fn skills(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        let ours = params
            .get("sessionId")
            .and_then(Value::as_str)
            .is_none_or(|id| {
                self.sessions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains(id)
            });
        let io = self.tool_io.clone();
        let workspace = self.workspace.clone();
        Box::pin(async move {
            if !ours {
                return Err(ErrorObject::new(
                    ErrorKind::SessionNotFound,
                    format!("{method}: the session is not in this workspace"),
                    false,
                ));
            }
            io.skills_request(&workspace, &method, params, &peer).await
        })
    }

    /// `mcp/servers` and an MCP server's sign-in steps (T36). Only a sign-in Core started
    /// (`mcp/login`) is shown: the id must be the active one.
    fn mcp(
        &self,
        method: &str,
        params: Map<String, Value>,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        if method == "mcp/servers" {
            let (mcp, workspace) = (self.mcp.clone(), self.workspace.clone());
            return Box::pin(async move {
                let result = mcp
                    .servers(&workspace)
                    .await
                    .map_err(|e| e.to_error_object())?;
                serde_json::to_value(result)
                    .map_err(|e| ErrorObject::new(ErrorKind::InternalError, e.to_string(), false))
            });
        }
        let (logins, events) = (Arc::clone(&self.logins), self.events.clone());
        Box::pin(async move {
            let p = serde_json::from_value(Value::Object(params)).map_err(|_| {
                ErrorObject::new(
                    ErrorKind::InvalidParams,
                    "malformed ui/loginInteraction",
                    false,
                )
            })?;
            logins.interact(&events, p).await
        })
    }
}

impl InboundHandler for WorkspaceInbound {
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        if TrustService::handles(&method) {
            let trust = self.trust.clone();
            return Box::pin(async move { trust.trust_get(params).await });
        }
        if SecretsService::handles(&method) {
            let secrets = self.secrets.clone();
            return Box::pin(async move { secrets.dispatch(&method, params, peer).await });
        }
        if method == "hooks/run" {
            // Also for a session Core already closed (its `SessionEnd`): the working directory
            // is checked against this workspace instead. An open session must be ours (R3).
            let ours = params
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| {
                    self.sessions
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .contains(id)
                });
            let io = self.tool_io.clone();
            let workspace = self.workspace.clone();
            return Box::pin(async move { io.hooks_run(&workspace, ours, params, &peer).await });
        }
        if method == "agents/list" {
            // Definitions found from a directory of this workspace (T31).
            let io = self.tool_io.clone();
            let workspace = self.workspace.clone();
            return Box::pin(async move { io.agents_request(&workspace, params).await });
        }
        if method.starts_with("skills/") {
            return self.skills(method, params, peer);
        }
        if method == "subagent/start" || method == "subagent/finish" {
            return self.subagent(&method, params, peer);
        }
        if method == "mcp/servers" || method == "ui/loginInteraction" {
            return self.mcp(&method, params);
        }
        if method == "exec/shells" {
            // Machine-wide, and asked while a session is being created (before it is ours).
            let io = self.tool_io.clone();
            return Box::pin(async move { io.dispatch(&method, params, peer).await });
        }
        if ToolIo::handles(&method) {
            let session = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let ours = self
                .sessions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&session);
            if !ours {
                return Box::pin(async move {
                    let mut error = ErrorObject::new(
                        ErrorKind::SessionNotFound,
                        format!("{method}: no session {session} in this workspace"),
                        false,
                    );
                    error.data.details = Some(serde_json::json!({ "sessionId": session }));
                    Err(error)
                });
            }
            let io = self.tool_io.clone();
            return Box::pin(async move { io.dispatch(&method, params, peer).await });
        }
        Box::pin(async move {
            Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not answer {method}"),
                false,
            ))
        })
    }
}
