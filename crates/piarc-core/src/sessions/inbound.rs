//! What answers one workspace's Agent Host: `trust/get` from the trust store, `secrets/*` from
//! Core's single vault service, and `fs/*`, `exec/*` from the tool I/O, but only for the
//! sessions that belong to this workspace (R1-A13): an Agent Host cannot reach another
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
    pub trust: TrustService,
    pub secrets: SecretsService,
    pub tool_io: ToolIo,
    pub sessions: SessionSet,
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
