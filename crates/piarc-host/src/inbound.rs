//! Requests the Agent Host sends to Core (`trust/get`, `fs/*`, `exec/*`, later
//! `policy/evaluate`, ...).

use std::sync::Arc;

use piarc_ports::BoxFuture;
use piarc_protocol::method::{NotificationMessage, NotificationMethod};
use piarc_protocol::{ErrorKind, ErrorObject};
use serde_json::{Map, Value};
use tokio::sync::mpsc;

use crate::connection::encode;

/// Answers requests from the Agent Host. Core's session layer implements it; the supervisor
/// only transports the requests.
pub trait InboundHandler: Send + Sync {
    /// Handles `method` with `params`; the result or error goes back to the Agent Host.
    /// `peer` is the connection the request came on: notifications sent through it reach the
    /// Agent Host before the response (`exec/output` before the `exec/run` result).
    fn handle(
        &self,
        method: String,
        params: Map<String, Value>,
        peer: Peer,
    ) -> BoxFuture<'static, Result<Value, ErrorObject>>;
}

/// The connection an inbound request arrived on.
#[derive(Debug, Clone)]
pub struct Peer {
    writer: mpsc::Sender<Vec<u8>>,
    epoch: u64,
}

/// The connection ended: nothing sent through a [`Peer`] reaches the Agent Host any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the connection to the Agent Host ended")]
pub struct PeerClosed;

impl Peer {
    pub(crate) fn new(writer: mpsc::Sender<Vec<u8>>, epoch: u64) -> Self {
        Self { writer, epoch }
    }

    /// A peer whose frames go to the returned receiver, for driving a handler without an
    /// Agent Host (tests, benchmarks).
    #[must_use]
    pub fn channel(capacity: usize) -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (writer, frames) = mpsc::channel(capacity);
        (Self::new(writer, 0), frames)
    }

    /// The connection epoch the request belongs to.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Sends notification `M` on the connection's write queue, waiting while the queue is full.
    ///
    /// # Errors
    ///
    /// [`PeerClosed`] when the connection ended.
    pub async fn notify<M: NotificationMethod>(&self, params: M::Params) -> Result<(), PeerClosed> {
        let frame = encode(&NotificationMessage::<M>::new(params));
        self.writer.send(frame).await.map_err(|_| PeerClosed)
    }

    /// Completes when the connection ended.
    pub async fn closed(&self) {
        self.writer.closed().await;
    }
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
        _peer: Peer,
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
