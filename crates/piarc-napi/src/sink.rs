//! The production [`EventSink`]: a strong `ThreadsafeFunction` around the `onEvents`
//! listener passed to `CoreRuntime.create`.
//!
//! # Lifecycle
//!
//! - The function holds a reference that keeps Node's event loop alive. It is released when
//!   the coalescer drops the sink, which is step 4 of the ordered shutdown
//!   (`piarc_core::CoreRuntime`), so an app that awaits `shutdown()` can exit.
//! - Each delivery is queued with `call_with_return_value`; the completion closure owns the
//!   [`DeliveryDone`] and drops it after the listener returned, which lets the coalescer
//!   deliver the next batches. The queue therefore never holds more than one delivery.
//! - A listener that throws does not take the process down and does not stall delivery: the
//!   exception is printed to stderr and the delivery counts as done.
//! - When the JavaScript environment is gone the call fails with `Closing`; the sink reports
//!   [`SinkClosed`] and Core stops delivering.

use napi::Status;
use napi::bindgen_prelude::Uint8Array;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use napi_derive::napi;
use piarc_core::{DeliveryDone, EventBatch, EventSink, SinkClosed};

/// One batch as JavaScript receives it.
#[napi(object, object_from_js = false)]
pub struct CoreEventBatch {
    /// Route key: the topic the main process forwards the batch under.
    pub route: String,
    /// Per-route batch number, starting at 1 and consecutive.
    pub seq: i64,
    /// UTF-8 JSON array of the batch's events. Opaque to the main process.
    pub payload: Uint8Array,
}

/// The `onEvents` listener as a threadsafe function: called with one array of batches, its
/// return value ignored, no error-first argument.
pub(crate) type EventListener =
    ThreadsafeFunction<Vec<CoreEventBatch>, UnknownReturnValue, Vec<CoreEventBatch>, Status, false>;

pub(crate) struct JsEventSink {
    listener: EventListener,
}

impl JsEventSink {
    pub(crate) fn new(listener: EventListener) -> Self {
        Self { listener }
    }
}

impl EventSink for JsEventSink {
    fn deliver(&self, batches: Vec<EventBatch>, done: DeliveryDone) -> Result<(), SinkClosed> {
        let batches = batches
            .into_iter()
            .map(|batch| CoreEventBatch {
                route: batch.route.as_str().to_owned(),
                seq: i64::try_from(batch.seq).unwrap_or(i64::MAX),
                payload: Uint8Array::from(batch.payload),
            })
            .collect();
        let status = self.listener.call_with_return_value(
            batches,
            ThreadsafeFunctionCallMode::NonBlocking,
            move |returned, _env| {
                if let Err(thrown) = returned {
                    eprintln!(
                        "[piarc-napi] the onEvents listener threw: {}",
                        thrown.reason
                    );
                }
                drop(done);
                Ok(())
            },
        );
        if status == Status::Ok {
            Ok(())
        } else {
            Err(SinkClosed)
        }
    }
}
