//! What the supervisor reports to its owner (Core's session layer), and the channel it
//! reports on.
//!
//! One ordered channel carries every event. Session notifications and frame errors (the
//! high-volume events the Agent Host produces) each hold one of `event_queue` permits until
//! the consumer receives them: a slow consumer stops the reader, which stops reading stdout
//! and pushes back on the Agent Host. The supervisor's own lifecycle events (connected,
//! exited, uncertain calls, restarts) take no permit, so restarts and shutdown never wait for
//! the consumer; there are only a handful of them per connection.

use std::sync::Arc;
use std::time::Duration;

use piarc_ports::ExitStatus;
use piarc_protocol::session::SessionEventNotification;
use piarc_protocol::{Capability, ErrorObject};

use crate::ledger::CallRecord;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

/// Why a connection ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// The process could not be started.
    SpawnFailed,
    /// No `host/hello` within the handshake timeout; the process was killed.
    HandshakeTimeout,
    /// Core refused the handshake (for example a different major protocol version).
    HandshakeRejected,
    /// The process exited without being asked to.
    Crashed,
    /// Heartbeats went unanswered; the process was killed.
    Hung,
    /// Core killed the process on request (`HostSupervisor::kill`).
    Killed,
    /// The process exited after `shutdown`.
    Shutdown,
}

/// An event of the supervised Agent Host, in the order it happened.
#[derive(Debug, Clone, PartialEq)]
pub enum HostEvent {
    /// A connection completed its handshake.
    Connected {
        /// Connection number, from 1, incremented on every (re)start.
        epoch: u64,
        /// Pi version the Agent Host runs.
        pi_version: String,
        /// Capabilities enabled for the connection.
        enabled: Vec<Capability>,
        /// Process id of the Agent Host.
        pid: Option<u32>,
    },
    /// A session notification (`turn/*`, `item/*`, ...).
    Notification {
        /// Connection the notification arrived on.
        epoch: u64,
        /// The notification with its `sessionId`, `seq` and `ts`.
        notification: SessionEventNotification,
    },
    /// A session open before a restart was reopened.
    SessionRestored {
        /// Connection it was reopened on.
        epoch: u64,
        /// The session.
        session_id: String,
        /// Messages restored from its file.
        restored_messages: u64,
    },
    /// A session open before a restart could not be reopened; it is forgotten.
    SessionRestoreFailed {
        /// Connection the attempt was made on.
        epoch: u64,
        /// The session.
        session_id: String,
        /// Why.
        error: ErrorObject,
    },
    /// A frame from the Agent Host was invalid and dropped; the connection continues.
    FrameError {
        /// Connection the frame arrived on.
        epoch: u64,
        /// What was wrong (`parseError`, `frameTooLarge`, `invalidRequest`).
        error: ErrorObject,
    },
    /// Core refused the handshake; the Agent Host is not restarted.
    HandshakeRejected {
        /// Connection that was refused.
        epoch: u64,
        /// The error sent to the Agent Host (for example `protocolVersionMismatch`).
        error: ErrorObject,
    },
    /// The connection ended. Calls it left open follow as [`HostEvent::Uncertain`].
    Exited {
        /// Connection that ended.
        epoch: u64,
        /// Why.
        reason: ExitReason,
        /// The exit status, when the process was started.
        status: Option<ExitStatus>,
    },
    /// Calls left open by an ended connection; they are not replayed.
    Uncertain {
        /// Connection that ended.
        epoch: u64,
        /// The calls, in `uncertain` state.
        calls: Vec<CallRecord>,
    },
    /// A restart is scheduled.
    Restarting {
        /// Restart number within the restart window, from 1.
        attempt: u32,
        /// Delay before the restart.
        delay: Duration,
    },
    /// Too many restarts within the window: the supervisor stopped and needs attention.
    GaveUp {
        /// Restarts within the window.
        restarts: u32,
    },
    /// The supervisor stopped (after `shutdown`, a rejected handshake or giving up).
    Stopped,
}

type Delivery = (HostEvent, Option<OwnedSemaphorePermit>);

/// The receiving end of a supervisor's events.
#[derive(Debug)]
pub struct HostEvents {
    rx: mpsc::UnboundedReceiver<Delivery>,
}

impl HostEvents {
    /// The next event, in the order it happened; `None` once the supervisor is gone.
    pub async fn recv(&mut self) -> Option<HostEvent> {
        // Dropping the permit lets the reader deliver the next notification.
        self.rx.recv().await.map(|(event, _permit)| event)
    }
}

/// The sending end, shared by the supervisor and its connections.
pub(crate) struct EventSender {
    tx: mpsc::UnboundedSender<Delivery>,
    permits: Arc<Semaphore>,
}

impl EventSender {
    /// A channel admitting at most `queue` undelivered notifications.
    pub fn channel(queue: usize) -> (Self, HostEvents) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                tx,
                permits: Arc::new(Semaphore::new(queue.max(1))),
            },
            HostEvents { rx },
        )
    }

    /// Sends a high-volume event, waiting while `queue` of them are undelivered.
    pub async fn bounded(&self, event: HostEvent) {
        let Ok(permit) = Arc::clone(&self.permits).acquire_owned().await else {
            return; // the semaphore is never closed
        };
        // A dropped receiver means nobody listens any more.
        let _ = self.tx.send((event, Some(permit)));
    }

    /// Sends a lifecycle event without waiting.
    pub fn lifecycle(&self, event: HostEvent) {
        // A dropped receiver means nobody listens any more.
        let _ = self.tx.send((event, None));
    }
}
