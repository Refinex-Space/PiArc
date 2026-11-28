//! The NAPI boundary: every export runs its body through [`call`], so neither a Core error
//! nor a panic reaches JavaScript as anything but a structured error.
//!
//! The thrown value is an `Error` whose `message` is the human-readable text and whose own
//! properties `code` (number) and `data` (`{ kind, retryable, details? }`) follow
//! `piarc_protocol::ErrorObject`, the shape AHP uses as well. Callers branch on
//! `data.kind`.

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::{JsObjectValue, JsValue};
use napi::{Env, Status};
use piarc_protocol::ErrorObject;

/// Runs `body`, mapping its error and any panic to a thrown structured error. `location`
/// names the export in the panic message.
pub(crate) fn call<T>(
    env: &Env,
    location: &'static str,
    body: impl FnOnce() -> piarc_core::Result<T>,
) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(js_error(env, &error.to_error_object())),
        Err(payload) => Err(js_error(
            env,
            &piarc_core::Error::from_panic(location, &*payload).to_error_object(),
        )),
    }
}

/// Builds the JavaScript error for `object`. Must run on the JavaScript thread.
pub(crate) fn js_error(env: &Env, object: &ErrorObject) -> napi::Error {
    build_js_error(env, object).unwrap_or_else(|failure| {
        // Creating the object itself failed (the environment is shutting down): throw a
        // plain error that still carries the message.
        napi::Error::new(
            failure.status,
            format!("{} ({})", object.message, failure.reason),
        )
    })
}

fn build_js_error(env: &Env, object: &ErrorObject) -> napi::Result<napi::Error> {
    let mut error = env.create_error(napi::Error::new(
        Status::GenericFailure,
        object.message.clone(),
    ))?;
    error.set_named_property("code", object.code)?;
    error.set_named_property("data", env.to_js_value(&object.data)?)?;
    Ok(napi::Error::from(error.to_unknown()))
}
