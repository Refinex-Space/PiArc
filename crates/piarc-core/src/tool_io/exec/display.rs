//! The live view of a command's output (`exec/output`), moved out of `exec.rs` (R4 I165).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use piarc_exec::Stream;
use piarc_host::Peer;
use piarc_protocol::exec::{ExecOutput, ExecOutputParams, OutputStream};
use piarc_protocol::text::incomplete_utf8_suffix;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::DISPLAY_WINDOW;
use crate::tool_io::lock;

/// The live view of a command's output: chunks in the order they were read, at most
/// [`DISPLAY_WINDOW`] bytes waiting; older chunks are dropped and counted.
#[derive(Default)]
pub(in crate::tool_io) struct Display {
    state: Mutex<DisplayState>,
    notify: Notify,
}

#[derive(Default)]
struct DisplayState {
    queue: VecDeque<(Stream, Vec<u8>)>,
    bytes: usize,
    skipped: [u64; 2],
    closed: bool,
}

fn index(stream: Stream) -> usize {
    usize::from(stream == Stream::Stderr)
}

impl Display {
    pub(super) fn push(&self, stream: Stream, bytes: Vec<u8>) {
        {
            let mut state = lock(&self.state);
            state.bytes += bytes.len();
            state.queue.push_back((stream, bytes));
            while state.bytes > DISPLAY_WINDOW && state.queue.len() > 1 {
                if let Some((old, dropped)) = state.queue.pop_front() {
                    state.bytes -= dropped.len();
                    state.skipped[index(old)] += dropped.len() as u64;
                }
            }
        }
        self.notify.notify_one();
    }

    pub(super) fn close(&self) {
        lock(&self.state).closed = true;
        self.notify.notify_one();
    }

    /// Sends what arrives as `exec/output` until the capture is done; a connection that is
    /// gone stops the command.
    pub(super) async fn forward(
        self: Arc<Self>,
        peer: Peer,
        request_id: String,
        token: CancellationToken,
    ) {
        let mut seq = 0_u64;
        let mut carry: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
        loop {
            let (batch, skipped, closed) = {
                let mut state = lock(&self.state);
                state.bytes = 0;
                (
                    std::mem::take(&mut state.queue),
                    std::mem::take(&mut state.skipped),
                    state.closed,
                )
            };
            if batch.is_empty() && !closed {
                self.notify.notified().await;
                continue;
            }
            let mut skipped = skipped;
            for (stream, mut bytes) in batch {
                let i = index(stream);
                let mut gap = std::mem::take(&mut skipped[i]);
                if gap > 0 {
                    // The dropped chunks may have ended inside a character.
                    gap += carry[i].len() as u64;
                    carry[i].clear();
                    let partial = bytes.iter().take_while(|&&b| b & 0xC0 == 0x80).count();
                    bytes.drain(..partial);
                    gap += partial as u64;
                }
                carry[i].extend_from_slice(&bytes);
                let complete = carry[i].len() - incomplete_utf8_suffix(&carry[i]);
                let rest = carry[i].split_off(complete);
                let text = String::from_utf8_lossy(&carry[i]).into_owned();
                carry[i] = rest;
                self.send(&peer, &request_id, &token, &mut seq, stream, text, gap)
                    .await;
            }
            if closed {
                for stream in [Stream::Stdout, Stream::Stderr] {
                    let rest = std::mem::take(&mut carry[index(stream)]);
                    let text = String::from_utf8_lossy(&rest).into_owned();
                    self.send(&peer, &request_id, &token, &mut seq, stream, text, 0)
                        .await;
                }
                return;
            }
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one notification's fields and its counter"
    )]
    async fn send(
        &self,
        peer: &Peer,
        request_id: &str,
        token: &CancellationToken,
        seq: &mut u64,
        stream: Stream,
        data: String,
        skipped: u64,
    ) {
        if data.is_empty() && skipped == 0 {
            return;
        }
        *seq += 1;
        let params = ExecOutputParams {
            request_id: request_id.to_owned(),
            stream: match stream {
                Stream::Stdout => OutputStream::Stdout,
                Stream::Stderr => OutputStream::Stderr,
            },
            seq: *seq,
            data,
            skipped: (skipped > 0).then_some(skipped),
        };
        if peer.notify::<ExecOutput>(params).await.is_err() {
            token.cancel();
        }
    }
}
