//! The per-request log tests assert on.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::request::WireFormat;
use crate::rules::Violation;

/// Header names whose values are replaced by [`REDACTED`] in records.
const CREDENTIAL_HEADERS: [&str; 5] = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "cookie",
];

/// Value recorded in place of a credential header.
pub const REDACTED: &str = "<redacted>";

/// What the mock did with a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Streamed a complete response.
    Streamed,
    /// Streamed part of a response, then closed the connection (scripted).
    Disconnected,
    /// Answered with a scripted HTTP error.
    InjectedError,
    /// Answered 400 (or 404) without consuming a step; see `violations`.
    Rejected,
}

/// One recorded request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestRecord {
    /// Arrival order, from 0.
    pub seq: usize,
    /// HTTP method.
    pub method: String,
    /// Request path including the query string.
    pub path: String,
    /// Wire format of the endpoint; `None` for unknown endpoints.
    pub format: Option<WireFormat>,
    /// The scenario selector (`<id>` or `<id>#<instance>`), once resolved.
    pub scenario: Option<String>,
    /// Index of the step that answered, from 0; `None` when no step was used.
    pub step_index: Option<usize>,
    /// Request headers with lowercase names; credential values are [`REDACTED`].
    pub headers: BTreeMap<String, String>,
    /// The raw request body.
    pub body: String,
    /// Validation result: empty when the request passed every rule.
    pub violations: Vec<Violation>,
    /// What the mock answered.
    pub outcome: Outcome,
}

impl RequestRecord {
    /// The body parsed as JSON, when it is JSON.
    #[must_use]
    pub fn body_json(&self) -> Option<Value> {
        serde_json::from_str(&self.body).ok()
    }

    /// The request passed validation.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.violations.is_empty()
    }

    pub(crate) fn redacted_header(name: &str, value: &str) -> String {
        if CREDENTIAL_HEADERS.contains(&name) {
            REDACTED.to_owned()
        } else {
            value.to_owned()
        }
    }
}

/// Shared, ordered request log. Cloning gives another handle to the same log.
#[derive(Debug, Clone, Default)]
pub struct RequestLog {
    records: Arc<Mutex<Vec<RequestRecord>>>,
}

impl RequestLog {
    pub(crate) fn push(&self, record: RequestRecord) {
        self.lock().push(record);
    }

    /// Every record so far, in arrival order.
    #[must_use]
    pub fn snapshot(&self) -> Vec<RequestRecord> {
        let mut records = self.lock().clone();
        records.sort_by_key(|record| record.seq);
        records
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<RequestRecord>> {
        // A panic while holding the lock cannot leave the vector half-updated (push is the
        // only mutation), so a poisoned log is still consistent.
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
