//! The HTTP response body: a fixed list of chunks, optionally ending in an abort.

use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::body::{Body, Bytes, Frame, SizeHint};

/// The error that aborts a response, making hyper close the connection mid-body.
#[derive(Debug, thiserror::Error)]
#[error("scripted disconnect")]
pub(crate) struct ScriptedDisconnect;

/// Response body built from pre-encoded chunks.
///
/// With `abort` set, the body returns `Pending` once after its last chunk (waking itself
/// at once) so hyper flushes the chunks to the socket, and then fails; hyper reacts to
/// the failure by closing the connection without finishing the chunked encoding, which
/// is what a client sees when a stream breaks.
pub(crate) struct ScriptBody {
    chunks: VecDeque<Bytes>,
    abort: bool,
    flushed: bool,
}

impl ScriptBody {
    pub(crate) fn complete(chunks: impl IntoIterator<Item = String>) -> Self {
        Self {
            chunks: chunks.into_iter().map(Bytes::from).collect(),
            abort: false,
            flushed: false,
        }
    }

    pub(crate) fn aborted(chunks: impl IntoIterator<Item = String>) -> Self {
        Self {
            abort: true,
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
        if !this.abort {
            return Poll::Ready(None);
        }
        if !this.flushed {
            this.flushed = true;
            context.waker().wake_by_ref();
            return Poll::Pending;
        }
        Poll::Ready(Some(Err(ScriptedDisconnect)))
    }

    fn is_end_stream(&self) -> bool {
        !self.abort && self.chunks.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        if self.abort {
            return SizeHint::default();
        }
        let length = self.chunks.iter().map(Bytes::len).sum::<usize>();
        SizeHint::with_exact(u64::try_from(length).unwrap_or(u64::MAX))
    }
}
