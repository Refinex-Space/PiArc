//! The HTTP server: routing, scenario selection, step counting and recording.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderMap, HeaderValue, RETRY_AFTER};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::body::ScriptBody;
use crate::error::{Error, Result};
use crate::record::{Outcome, RequestLog, RequestRecord};
use crate::request::{Request, WireFormat};
use crate::rules::{Rule, Violation, validate};
use crate::scenario::{InjectedError, ScenarioLibrary, Script, Step};
use crate::{anthropic, openai};

/// Request header that selects a scenario: `<id>` or `<id>#<instance>`.
pub const SCENARIO_HEADER: &str = "x-piarc-scenario";
/// Opening of the first-user-message marker `[[piarc-scenario:<selector>]]`.
pub const SCENARIO_MARKER_OPEN: &str = "[[piarc-scenario:";
/// Closing of the first-user-message marker.
pub const SCENARIO_MARKER_CLOSE: &str = "]]";
/// Endpoint that returns the request log as a JSON array.
pub const REQUESTS_PATH: &str = "/_piarc/requests";

/// A running mock provider bound to `127.0.0.1`.
///
/// It serves until [`Self::shutdown`] is called or the value is dropped.
pub struct MockProvider {
    address: SocketAddr,
    log: RequestLog,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl MockProvider {
    /// Starts a provider on a free port. Must be called inside a tokio runtime, which
    /// then runs the server.
    ///
    /// # Errors
    ///
    /// [`Error::Bind`] when the socket cannot be bound.
    pub async fn start(library: ScenarioLibrary) -> Result<Self> {
        Self::start_on(library, 0).await
    }

    /// Starts a provider on `port` (0 picks a free port).
    ///
    /// # Errors
    ///
    /// [`Error::Bind`] when the socket cannot be bound.
    pub async fn start_on(library: ScenarioLibrary, port: u16) -> Result<Self> {
        let bind_error = |source| Error::Bind { port, source };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(bind_error)?;
        let address = listener.local_addr().map_err(bind_error)?;
        let log = RequestLog::default();
        let state = Arc::new(State {
            library,
            log: log.clone(),
            next_seq: AtomicUsize::new(0),
            steps_served: Mutex::new(HashMap::new()),
        });
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(accept_loop(listener, state, stopped));
        Ok(Self {
            address,
            log,
            stop: Some(stop),
            task: Some(task),
        })
    }

    /// The bound address (always `127.0.0.1`).
    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The bound port.
    #[must_use]
    pub fn port(&self) -> u16 {
        self.address.port()
    }

    /// Base URL for Anthropic clients (they append `/v1/messages`).
    #[must_use]
    pub fn anthropic_base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Base URL for OpenAI clients (they append `/chat/completions`).
    #[must_use]
    pub fn openai_base_url(&self) -> String {
        format!("http://{}/v1", self.address)
    }

    /// A handle to the request log.
    #[must_use]
    pub fn log(&self) -> RequestLog {
        self.log.clone()
    }

    /// Every recorded request so far, in arrival order.
    #[must_use]
    pub fn records(&self) -> Vec<RequestRecord> {
        self.log.snapshot()
    }

    /// Stops accepting connections and waits for the accept loop to end. Connections
    /// already open finish their current response.
    pub async fn shutdown(mut self) {
        self.stop_accepting();
        if let Some(task) = self.task.take() {
            // The accept loop only ends by returning; a join error would mean it panicked,
            // which the test that owns the provider already sees as missing responses.
            let _ = task.await;
        }
    }

    fn stop_accepting(&mut self) {
        if let Some(stop) = self.stop.take() {
            // The receiver is gone only if the loop already ended; nothing left to stop.
            let _ = stop.send(());
        }
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.stop_accepting();
    }
}

struct State {
    library: ScenarioLibrary,
    log: RequestLog,
    next_seq: AtomicUsize,
    steps_served: Mutex<HashMap<String, usize>>,
}

impl State {
    /// Takes the next step index of a scenario instance.
    fn take_step(&self, selector: &str) -> usize {
        let mut served = self
            .steps_served
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let counter = served.entry(selector.to_owned()).or_insert(0);
        let index = *counter;
        *counter += 1;
        index
    }
}

async fn accept_loop(listener: TcpListener, state: Arc<State>, mut stopped: oneshot::Receiver<()>) {
    loop {
        let stream = tokio::select! {
            _ = &mut stopped => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                // Accept errors (for example a connection reset before accept, or a
                // temporary descriptor shortage) affect one connection, not the server.
                Err(_) => continue,
            },
        };
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let service = service_fn(move |request| handle(Arc::clone(&state), request));
            // A connection error (client gone, scripted disconnect) ends only this
            // connection; the request log already holds what the test needs.
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

/// What the stream encoder needs besides the step.
pub(crate) struct StreamContext {
    /// Model id echoed back.
    pub(crate) model: String,
    /// Index of the step being streamed.
    pub(crate) step_index: usize,
    /// Unique per response; used in response ids.
    pub(crate) response_number: usize,
}

type Response = hyper::Response<ScriptBody>;

async fn handle(
    state: Arc<State>,
    request: hyper::Request<Incoming>,
) -> std::result::Result<Response, Infallible> {
    let seq = state.next_seq.fetch_add(1, Ordering::Relaxed);
    let (parts, incoming) = request.into_parts();
    if parts.method == Method::GET && parts.uri.path() == REQUESTS_PATH {
        return Ok(log_response(&state.log));
    }
    let body = match incoming.collect().await {
        Ok(collected) => String::from_utf8_lossy(&collected.to_bytes()).into_owned(),
        // The client closed the connection before sending the whole body; record what the
        // request line said with an empty body.
        Err(_) => String::new(),
    };
    let format = match (&parts.method, parts.uri.path()) {
        (&Method::POST, "/v1/messages") => Some(WireFormat::AnthropicMessages),
        (&Method::POST, "/v1/chat/completions") => Some(WireFormat::OpenaiChatCompletions),
        _ => None,
    };
    let mut record = RequestRecord {
        seq,
        method: parts.method.to_string(),
        path: parts
            .uri
            .path_and_query()
            .map_or_else(|| parts.uri.path().to_owned(), ToString::to_string),
        format,
        scenario: None,
        step_index: None,
        headers: record_headers(&parts.headers),
        body,
        violations: Vec::new(),
        outcome: Outcome::Rejected,
    };
    let reply = match format {
        Some(format) => serve(&state, format, &parts.headers, &mut record),
        None => {
            let violation = Violation::new(
                Rule::NotFound,
                format!("no endpoint {} {}", record.method, record.path),
                Some(record.path.clone()),
            );
            record.violations.push(violation.clone());
            reject(
                WireFormat::AnthropicMessages,
                StatusCode::NOT_FOUND,
                &[violation],
                seq,
            )
        }
    };
    state.log.push(record);
    Ok(reply)
}

fn record_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let value = String::from_utf8_lossy(value.as_bytes());
            (
                name.as_str().to_owned(),
                RequestRecord::redacted_header(name.as_str(), &value),
            )
        })
        .collect()
}

fn serve(
    state: &State,
    format: WireFormat,
    headers: &HeaderMap,
    record: &mut RequestRecord,
) -> Response {
    let seq = record.seq;
    let fail = |record: &mut RequestRecord, violations: Vec<Violation>| {
        let reply = reject(format, StatusCode::BAD_REQUEST, &violations, seq);
        record.violations = violations;
        reply
    };
    let parsed = match parse(format, &record.body) {
        Ok(parsed) => parsed,
        Err(violation) => return fail(record, vec![violation]),
    };
    if !parsed.stream {
        let violation = Violation::new(
            Rule::StreamingRequired,
            "the mock provider only serves streaming requests; set \"stream\": true",
            Some("stream".to_owned()),
        );
        return fail(record, vec![violation]);
    }
    let (selector, script) = match select_scenario(&state.library, headers, &parsed) {
        Ok(found) => found,
        Err(violation) => return fail(record, vec![violation]),
    };
    record.scenario = Some(selector.clone());
    let violations = validate(&parsed, &script.validation);
    if !violations.is_empty() {
        return fail(record, violations);
    }
    let step_index = state.take_step(&selector);
    let Some(step) = script.steps.get(step_index) else {
        let violation = Violation::new(
            Rule::ScenarioExhausted,
            format!(
                "scenario {selector:?} has {} steps and all of them were served",
                script.steps.len()
            ),
            None,
        );
        return fail(record, vec![violation]);
    };
    record.step_index = Some(step_index);
    let context = StreamContext {
        model: parsed.model.clone(),
        step_index,
        response_number: seq,
    };
    respond(format, step, &context, parsed.include_usage, record)
}

fn parse(format: WireFormat, body: &str) -> std::result::Result<Request, Violation> {
    let json: Value = serde_json::from_str(body).map_err(|error| {
        Violation::new(
            Rule::MalformedRequest,
            format!("the request body is not valid JSON: {error}"),
            None,
        )
    })?;
    match format {
        WireFormat::AnthropicMessages => anthropic::parse(&json),
        WireFormat::OpenaiChatCompletions => openai::parse(&json),
    }
}

fn select_scenario<'a>(
    library: &'a ScenarioLibrary,
    headers: &HeaderMap,
    request: &Request,
) -> std::result::Result<(String, &'a Script), Violation> {
    let from_header = headers
        .get(SCENARIO_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_owned());
    let selector = from_header
        .or_else(|| {
            request
                .first_user_text()
                .and_then(|text| marker_selector(&text))
        })
        .ok_or_else(|| {
            Violation::new(
                Rule::ScenarioNotSelected,
                format!(
                    "no scenario selected: send the {SCENARIO_HEADER} header or put \
                     {SCENARIO_MARKER_OPEN}<id>{SCENARIO_MARKER_CLOSE} in the first user message"
                ),
                None,
            )
        })?;
    let id = selector
        .split_once('#')
        .map_or(selector.as_str(), |(id, _)| id);
    let script = library.get(id).ok_or_else(|| {
        let known = library.ids().collect::<Vec<_>>().join(", ");
        Violation::new(
            Rule::ScenarioNotFound,
            format!("scenario {id:?} is not loaded (loaded: {known})"),
            None,
        )
    })?;
    Ok((selector, script))
}

/// Extracts the selector from `[[piarc-scenario:<selector>]]`.
pub(crate) fn marker_selector(text: &str) -> Option<String> {
    let start = text.find(SCENARIO_MARKER_OPEN)? + SCENARIO_MARKER_OPEN.len();
    let length = text[start..].find(SCENARIO_MARKER_CLOSE)?;
    let selector = text[start..start + length].trim();
    (!selector.is_empty()).then(|| selector.to_owned())
}

fn respond(
    format: WireFormat,
    step: &Step,
    context: &StreamContext,
    include_usage: bool,
    record: &mut RequestRecord,
) -> Response {
    if let Some(error) = &step.error {
        record.outcome = Outcome::InjectedError;
        return injected_error(format, error, context.response_number);
    }
    let events = match format {
        WireFormat::AnthropicMessages => anthropic::encode_stream(step, context),
        WireFormat::OpenaiChatCompletions => openai::encode_stream(step, context, include_usage),
    };
    let events = match events {
        Ok(events) => events,
        Err(problem) => {
            // Scripts are checked when loaded, so this only happens for a script built
            // around the checks; report it as a server error rather than a bad request.
            let violation = Violation::new(Rule::MalformedRequest, problem, None);
            return reject(
                format,
                StatusCode::INTERNAL_SERVER_ERROR,
                &[violation],
                context.response_number,
            );
        }
    };
    let body = match (step.disconnect_after_events, step.stall_after_events) {
        (Some(count), _) => {
            record.outcome = Outcome::Disconnected;
            ScriptBody::aborted(events.into_iter().take(count))
        }
        (None, Some(count)) => {
            record.outcome = Outcome::Stalled;
            ScriptBody::stalled(events.into_iter().take(count))
        }
        (None, None) => {
            record.outcome = Outcome::Streamed;
            ScriptBody::complete(events)
        }
    }
    .paced(step.chunk_delay());
    let mut response = hyper::Response::new(body);
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    insert_request_id(headers, format, context.response_number);
    response
}

fn injected_error(format: WireFormat, error: &InjectedError, seq: usize) -> Response {
    let status =
        StatusCode::from_u16(error.kind.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let message = error.message.clone().unwrap_or_else(|| {
        format!(
            "{} (injected by the PiArc mock provider)",
            status.canonical_reason().unwrap_or("Overloaded")
        )
    });
    let body = match format {
        WireFormat::AnthropicMessages => anthropic::error_body(
            anthropic::injected_error_type(error.kind),
            &message,
            &[],
            &request_id(seq),
        ),
        WireFormat::OpenaiChatCompletions => {
            let (error_type, code) = openai::injected_error_type(error.kind);
            openai::error_body(error_type, code, &message, &[])
        }
    };
    let mut response = json_response(status, &body, format, seq);
    if error.kind == crate::scenario::InjectedErrorKind::RateLimit {
        let seconds = error.retry_after_secs.unwrap_or(1);
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from(seconds));
    }
    response
}

fn reject(
    format: WireFormat,
    status: StatusCode,
    violations: &[Violation],
    seq: usize,
) -> Response {
    let message = violations
        .iter()
        .map(|violation| match &violation.location {
            Some(location) => format!(
                "{}: {} (at {location})",
                violation.rule.id(),
                violation.message
            ),
            None => format!("{}: {}", violation.rule.id(), violation.message),
        })
        .collect::<Vec<_>>()
        .join("; ");
    let body = match format {
        WireFormat::AnthropicMessages => {
            let error_type = if status == StatusCode::NOT_FOUND {
                "not_found_error"
            } else if status.is_server_error() {
                "api_error"
            } else {
                "invalid_request_error"
            };
            anthropic::error_body(error_type, &message, violations, &request_id(seq))
        }
        WireFormat::OpenaiChatCompletions => {
            let error_type = if status.is_server_error() {
                "server_error"
            } else {
                "invalid_request_error"
            };
            let code = violations.first().map(|violation| violation.rule.id());
            openai::error_body(error_type, code, &message, violations)
        }
    };
    json_response(status, &body, format, seq)
}

fn json_response(status: StatusCode, body: &Value, format: WireFormat, seq: usize) -> Response {
    let mut response = hyper::Response::new(ScriptBody::complete([body.to_string()]));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    insert_request_id(response.headers_mut(), format, seq);
    response
}

fn log_response(log: &RequestLog) -> Response {
    let records = serde_json::to_string(&log.snapshot())
        .expect("records hold only strings, numbers, maps and enums, which always serialize");
    let mut response = hyper::Response::new(ScriptBody::complete([records]));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn request_id(seq: usize) -> String {
    format!("req_mock_{seq}")
}

fn insert_request_id(headers: &mut HeaderMap, format: WireFormat, seq: usize) {
    let name = match format {
        WireFormat::AnthropicMessages => "request-id",
        WireFormat::OpenaiChatCompletions => "x-request-id",
    };
    if let Ok(value) = HeaderValue::from_str(&request_id(seq)) {
        headers.insert(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::marker_selector;

    #[test]
    fn finds_the_selector_inside_the_marker() {
        assert_eq!(
            marker_selector("please [[piarc-scenario: edit-file#a1 ]] now").as_deref(),
            Some("edit-file#a1")
        );
        assert_eq!(marker_selector("[[piarc-scenario:]]"), None);
        assert_eq!(marker_selector("no marker"), None);
    }
}
