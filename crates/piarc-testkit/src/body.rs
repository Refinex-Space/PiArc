//! The HTTP response body: a fixed list of chunks, optionally ending in an abort or a stall.

use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::body::{Body, Bytes, Frame, SizeHint};

/// The error that aborts a response, making hyper close the connection mid-body.
#[derive(Debug, thiserror::Error)]
#[error("scripted disconnect")]
pub(crate) struct ScriptedDisconnect;

/// How the body ends after its last chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    Complete,
    Abort,
    Stall,
}

/// Response body built from pre-encoded chunks.
///
/// With `Abort`, the body returns `Pending` once after its last chunk (waking itself at
/// once) so hyper flushes the chunks to the socket, and then fails; hyper reacts to the
/// failure by closing the connection without finishing the chunked encoding, which is what
/// a client sees when a stream breaks. With `Stall`, it returns `Pending` without ever
/// waking: hyper flushes the chunks and the response stays open until the client closes the
/// connection, which drops the body.
pub(crate) struct ScriptBody {
    chunks: VecDeque<Bytes>,
    ending: Ending,
    flushed: bool,
}

impl ScriptBody {
    pub(crate) fn complete(chunks: impl IntoIterator<Item = String>) -> Self {
        Self {
            chunks: chunks.into_iter().map(Bytes::from).collect(),
            ending: Ending::Complete,
            flushed: false,
        }
    }

    pub(crate) fn aborted(chunks: impl IntoIterator<Item = String>) -> Self {
        Self {
            ending: Ending::Abort,
            ..Self::complete(chunks)
        }
    }

    pub(crate) fn stalled(chunks: impl IntoIterator<Item = String>) -> Self {
        Self {
            ending: Ending::Stall,
            ..Self::complete(chunks)
        }
    }
}

impl Body for ScriptBody {
    type Data = Bytes;
    type Error = ScriptedDisconnect;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, ScriptedDisconnect>>> {
        let this = self.get_mut();
        if let Some(chunk) = this.chunks.pop_front() {
            return Poll::Ready(Some(Ok(Frame::data(chunk))));
        }
        match this.ending {
            Ending::Complete => return Poll::Ready(None),
            // Never woken: the connection stays open until the client closes it.
            Ending::Stall => return Poll::Pending,
            Ending::Abort => {}
        }
        if !this.flushed {
            this.flushed = true;
            context.waker().wake_by_ref();
            return Poll::Pending;
        }
        Poll::Ready(Some(Err(ScriptedDisconnect)))
    }

    fn is_end_stream(&self) -> bool {
        self.ending == Ending::Complete && self.chunks.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        if self.ending != Ending::Complete {
            return SizeHint::default();
        }
        let length = self.chunks.iter().map(Bytes::len).sum::<usize>();
        SizeHint::with_exact(u64::try_from(length).unwrap_or(u64::MAX))
    }
}
