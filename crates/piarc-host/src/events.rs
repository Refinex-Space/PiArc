//! What the supervisor reports to its owner (Core's session layer).

use std::time::Duration;

use piarc_ports::ExitStatus;
use piarc_protocol::session::SessionEventNotification;
use piarc_protocol::{Capability, ErrorObject};

use crate::ledger::CallRecord;

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
