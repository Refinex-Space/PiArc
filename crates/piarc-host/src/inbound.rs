//! Requests the Agent Host sends to Core (`trust/get`, later `policy/evaluate`, `fs/*`, ...).

use std::sync::Arc;

use piarc_ports::BoxFuture;
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value};

/// Answers requests from the Agent Host. Core's session layer implements it; the supervisor
/// only transports the requests.
pub trait InboundHandler: Send + Sync {
    /// Handles `method` with `params`; the result or error goes back to the Agent Host.
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>>;
}

/// A handler that knows no method: every request gets `methodNotFound`, which the Agent Host
/// treats as a refusal.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoInbound;

impl InboundHandler for NoInbound {
    fn handle(
        &self,
        method: String,
        _params: Map<String, Value>,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>> {
        Box::pin(async move {
            Err(ErrorObject::new(
                ErrorKind::MethodNotFound,
                format!("Core does not handle {method}"),
                false,
            ))
        })
    }
}

/// Shared handler handle.
pub type SharedInbound = Arc<dyn InboundHandler>;
